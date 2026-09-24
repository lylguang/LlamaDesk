#!/usr/bin/env python3
"""MLX 生图模型的权重预下载 / 检测脚本。

由主进程（mlx-gen.ts）以 venv 内的 python3 调用。复用 mflux 自身的
ModelConfig + WeightDefinition 解析出模型对应的 HuggingFace 仓库与文件规则，
从而保证与当前安装的 mflux 版本完全一致。

策略：**本地优先**。模型权重是否就绪、能否复用，一律先看本地 HF 缓存
（~/.cache/huggingface/hub），完全离线也能给出正确结论、秒级返回；
只有确认本地缺文件时才联网拿远端文件清单 / 下载。下载走国内镜像
hf-mirror.com（失败自动回退官方 huggingface.co），并按文件断点续传
（huggingface_hub 原生支持，中断后遗留的 .incomplete 会被继续下载，
孤儿 .incomplete 会被先清理）。

协议（stdout 机器可读，tqdm 进度走 stderr）：
  download <model>:
    REPO <org/model>
    TOTAL <总字节>
    FILE <path> <起始累计字节> <size>
    DONE <path>
    OK
  check <model>:
    OK <总字节>        # 已完整缓存
    NOT_DOWNLOADED     # 尚未完整缓存
  出错时打印 ERROR <msg> 并退出码 1。
"""

import os
import re
import sys

# 国内访问 huggingface.co 不稳定，默认走镜像；下载单个文件失败会自动回退官方。
HF_MIRROR = "https://hf-mirror.com"
HF_OFFICIAL = "https://huggingface.co"
os.environ.setdefault("HF_ENDPOINT", HF_MIRROR)

_HF_CACHE = os.path.join(
    os.path.expanduser("~"), ".cache", "huggingface", "hub", "models--%s"
)


def _weight_def(repo: str):
    if repo.startswith("black-forest-labs/FLUX.1-"):
        from mflux.models.flux.weights.flux_weight_definition import (
            FluxWeightDefinition as D,
        )
        return D
    if repo.startswith("black-forest-labs/FLUX.2-"):
        from mflux.models.flux2.weights.flux2_weight_definition import (
            Flux2KleinWeightDefinition as D,
        )
        return D
    if repo.startswith("Tongyi-MAI"):
        from mflux.models.z_image.weights.z_image_weight_definition import (
            ZImageWeightDefinition as D,
        )
        return D
    if repo.startswith("Qwen/"):
        # Qwen-Image-2.1 需要较新的 mflux（0.7.x+，CLI 入口 mflux-generate-qwen-2.1）。
        # 老版本没有这类，导入失败时给出明确提示而不是裸 traceback ——
        # 否则用户面对“不知道要升级 mflux”的报错无从下手。
        try:
            from mflux.models.qwen21.weights.qwen21_weight_definition import (
                Qwen21WeightDefinition as D,
            )
            return D
        except ImportError:
            raise ValueError(
                "Qwen-Image-2.1 需要新版 mflux（含 Qwen21WeightDefinition）。"
                "请到「设置 → 模型引擎 → mflux」升级引擎后重试。"
            )
    raise ValueError(f"不支持的模型仓库：{repo}")


def _download_patterns(repo, defs):
    patterns = list(defs.get_download_patterns())
    # tokenizer 子目录可能不在 get_download_patterns 中（FLUX 即如此），补上。
    for td in defs.get_tokenizers():
        for p in td.download_patterns:
            if p not in patterns:
                patterns.append(p)
    return patterns


def _match(pattern: str, path: str):
    import fnmatch

    if "/" in pattern:
        base, rest = pattern.split("/", 1)
        if path.startswith(base + "/"):
            return fnmatch.fnmatch(path[len(base) + 1 :], rest) or fnmatch.fnmatch(
                path[len(base) + 1 :], rest.lstrip("*")
            )
        return False
    return fnmatch.fnmatch(os.path.basename(path), pattern)


def _repo_cache_dir(repo: str) -> str:
    return _HF_CACHE % repo.replace("/", "--")


def _repo_blobs_dir(repo: str) -> str:
    return os.path.join(_repo_cache_dir(repo), "blobs")


def _repo_snapshots(repo: str) -> list:
    root = os.path.join(_repo_cache_dir(repo), "snapshots")
    if not os.path.isdir(root):
        return []
    try:
        return [os.path.join(root, d) for d in sorted(os.listdir(root))]
    except OSError:
        return []


def _local_targets(repo, defs):
    """从本地 HF 缓存枚举已下载（完整 blob）的文件：{path: size}。

    只包含真实落盘、非 .incomplete 的完整文件；完全不联网。
    """
    patterns = _download_patterns(repo, defs)
    out = {}
    for rev in _repo_snapshots(repo):
        for dirpath, _dirs, files in os.walk(rev):
            for f in files:
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, rev)
                real = os.path.realpath(full)
                # 悬空软链、还在下载中的 .incomplete 都视为未完成。
                if ".incomplete" in real or not os.path.isfile(real):
                    continue
                try:
                    size = os.path.getsize(real)
                except OSError:
                    continue
                if not size:
                    continue
                if any(_match(p, rel) for p in patterns):
                    out.setdefault(rel, size)
    return out


def _remote_targets(repo, defs, timeout=10):
    """联网拿仓库文件清单（镜像 + 官方都拉，取**并集**，带超时），失败返回 None。

    返回 [(path, size), ...]（已排序）；联网不可用时调用方回退本地枚举。

    关键：两个端点取并集，而不是「镜像通了就只用镜像的」。hf-mirror.com 的
    `list_repo_tree` 对文件很多 / 单文件很大的仓库可能只回一小部分文件（分页
    截断 / 迟迟不出全量）。若只信它一份，`run_download` 就会只下那几份就打印 OK，
    表现成「下载只有两个文件、然后启动报错」。官方 + 镜像并存，彼此兜底。
    """
    import concurrent.futures

    from huggingface_hub import HfApi

    patterns = _download_patterns(repo, defs)
    merged: dict = {}

    def _list(endpoint):
        api = HfApi(endpoint=endpoint)
        out = {}
        for f in api.list_repo_tree(repo, recursive=True):
            path = getattr(f, "path", None)
            size = int(getattr(f, "size", 0) or 0)
            if not path or not size:
                continue
            for p in patterns:
                pat = p if not p.endswith("/**") else p[:-3] + "*"
                if _match(pat, path):
                    out[path] = size
                    break
        return out

    def _run(endpoint):
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(_list, endpoint).result(timeout=timeout)

    for endpoint in (HF_MIRROR, HF_OFFICIAL):
        try:
            merged.update(_run(endpoint))
        except Exception:
            continue

    if not merged:
        return None
    return sorted((p, s) for p, s in merged.items())


def _clean_orphan_incomplete(repo):
    """清理孤儿 .incomplete 文件（其完整 blob 已存在，永远不会被续传）。

    典型场景：上次下载在中途换了 etag 重下，旧的那份 .incomplete 就永远
    残留在这里占磁盘。删除不影响任何进行中的下载（那些还在跑，blob 缺失）。
    """
    blobdir = _repo_blobs_dir(repo)
    if not os.path.isdir(blobdir):
        return 0
    removed = 0
    for name in os.listdir(blobdir):
        if not name.endswith(".incomplete"):
            continue
        # 形如 <hash>.incomplete 或 <hash>.<etag>.incomplete → 完整版是 <hash>。
        core = name[: -len(".incomplete")]
        full_hash = re.sub(r"\.[0-9a-zA-Z]+$", "", core)
        full = os.path.join(blobdir, full_hash)
        if os.path.isfile(full) and os.path.getsize(full) > 0:
            try:
                os.remove(os.path.join(blobdir, name))
                removed += 1
            except OSError:
                pass
    return removed


# App 侧的模型 id -> mflux 解析用的别名（mflux 不认识 flux-schnell/flux-dev）。
_MODEL_ALIAS = {
    "flux-schnell": "schnell",
    "flux-dev": "dev",
    "z-image-turbo": "z-image-turbo",
    "flux2-klein-9b": "flux2-klein-9b",
    "qwen-image-2.1": "qwen-image-2.1",
}


def _resolve(name):
    from mflux.models.common.config.model_config import ModelConfig

    alias = _MODEL_ALIAS.get(name, name)
    mc = ModelConfig.from_name(alias)
    defs = _weight_def(mc.model_name)
    return mc.model_name, defs


def _check_targets_complete(local, patterns):
    """本地是否已覆盖全部下载规则（每个 pattern 至少有一个完整文件）。

    注意这是**粗粒度**判定：一个 `transformer/*.safetensors` pattern 只要有一份
    shard 就算过，多个分片缺几份也看不出来。只用于离线快速拦截「明显没下完」，
    权威判定必须走 `_verify_local`（逐文件对清单、对大小）。
    """
    for p in patterns:
        if not any(_match(p, path) for path in local):
            return False
    return True


def _verify_local(repo, targets):
    """对每个远端目标做 local-only 逐文件校验，返回缺失 / 损坏的文件名列表。

    一个目标既可能根本没下、也可能下成 `.incomplete`、还可能下下来但大小对不上，
    三种都算缺失。离线可用（`local_files_only=True`）。这是「模型真的下全了」的
    唯一权威判定 —— 下载完必须过这一关才能打印 OK。
    """
    from huggingface_hub import hf_hub_download

    missing = []
    for path, size in targets:
        try:
            f = hf_hub_download(repo_id=repo, filename=path, local_files_only=True)
        except Exception:
            missing.append(path)
            continue
        if not f or ".incomplete" in f:
            missing.append(path)
            continue
        try:
            if os.path.getsize(f) != size:
                missing.append(path)
        except OSError:
            missing.append(path)
    return missing


def run_check(name):
    repo, defs = _resolve(name)
    patterns = _download_patterns(repo, defs)

    # 一) 本地优先：粗判「每个 pattern 至少有一份」就秒回 OK，完全不联网。
    #     这只做快速拦截；真正的「是否全」由下面联网清单逐文件核对兜底。
    local = _local_targets(repo, defs)
    if _check_targets_complete(local, patterns):
        print(f"OK {sum(local.values())}", flush=True)
        return 0

    # 二) 本地确有缺漏时才联网拿权威清单（镜像 + 官方并集）做逐文件核对。
    targets = _remote_targets(repo, defs)
    if targets is None:
        print("NOT_DOWNLOADED", flush=True)
        return 0
    if _verify_local(repo, targets):
        print("NOT_DOWNLOADED", flush=True)
        return 0

    print("OK", flush=True)
    return 0


def _download_file(repo, path):
    """单个文件下载：镜像优先，失败自动回退官方（huggingface_hub 原生断点续传）。"""
    from huggingface_hub import hf_hub_download

    try:
        hf_hub_download(repo_id=repo, filename=path, endpoint=HF_MIRROR)
    except Exception as mirror_err:
        try:
            hf_hub_download(repo_id=repo, filename=path, endpoint=HF_OFFICIAL)
        except Exception:
            raise mirror_err


def run_download(name):
    repo, defs = _resolve(name)
    patterns = _download_patterns(repo, defs)
    removed = _clean_orphan_incomplete(repo)
    if removed:
        print(f"已清理 {removed} 个残留的未完成下载文件", flush=True)

    # 本地已有哪些完整文件；粗判「每个 pattern 至少一份」只是快速拦截，不当最终结论。
    local = _local_targets(repo, defs)
    # 权威清单（镜像 + 官方并集）：这份才决定「这个模型到底有哪些文件」。
    remote = _remote_targets(repo, defs)

    # 联网可用 → 以权威清单为准：本地真全才复用（不断网），缺哪个下哪个。
    if remote is not None:
        if not _verify_local(repo, remote):
            total = sum(s for _, s in remote)
            print(f"REPO {repo}", flush=True)
            print(f"TOTAL {total}", flush=True)
            done = 0
            for path, size in remote:
                print(f"FILE {path} {done} {size}", flush=True)
                _download_file(repo, path)
                done += size
                print(f"DONE {path}", flush=True)
            print("OK", flush=True)
            return 0
        # 权威清单在但不全 → 扫尾那里统一补，这里只是打个招呼。
        print("本地权重不完整，继续从远端下载…", flush=True)
    elif _check_targets_complete(local, patterns):
        # 完全离线且本地已粗判完整：只能信粗判（拿不到权威清单），复用本地下网不打了。
        total = sum(local.values())
        print(f"REPO {repo}", flush=True)
        print(f"TOTAL {total}", flush=True)
        done = 0
        for path, size in sorted(local.items()):
            print(f"FILE {path} {done} {size}", flush=True)
            _download_file(repo, path)
            done += size
            print(f"DONE {path}", flush=True)
        print("OK", flush=True)
        return 0
    else:
        print(
            "ERROR 本地缺少部分权重且无法联网获取文件清单（huggingface.co / hf-mirror.com 均不可达），请检查网络后重试",
            flush=True,
        )
        return 1

    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "0"
    total = sum(s for _, s in remote)
    print(f"REPO {repo}", flush=True)
    print(f"TOTAL {total}", flush=True)
    done = 0
    for path, size in remote:
        print(f"FILE {path} {done} {size}", flush=True)
        try:
            _download_file(repo, path)
        except Exception as e:
            print(f"ERROR 下载 {path} 失败：{e}", flush=True)
            return 1
        done += size
        print(f"DONE {path}", flush=True)

    # 收尾再做一次 local-only 逐文件校验（大小一致、非 .incomplete）。
    # 清单是镜像 + 官方并集，正常情况下全覆盖；这里把「下载一半卡住 / 大小对不上」的
    # 情况当场揪出来，绝不假报成功 —— 修复「只有两个文件却显示下好了、一启动就报错」。
    missing = _verify_local(repo, remote)
    if missing:
        print(f"ERROR 以下权重文件未完整下载，请点「继续下载」重试：{', '.join(missing)}", flush=True)
        return 1
    print("OK", flush=True)
    return 0


def run_selftest():
    """纯本地逻辑自测：不联网、不依赖 mflux/HF，验证核心判定逻辑。

    覆盖：本地缓存枚举（排除 .incomplete / 悬空软链）、pattern 完整性判定、
    孤儿 .incomplete 清理（完整 blob 已存在才删）。
    """
    import shutil
    import tempfile

    global _HF_CACHE  # noqa: PLW0603
    failures = []

    def check(name, cond):
        print(("PASS " if cond else "FAIL ") + name)
        if not cond:
            failures.append(name)

    class FakeDefs:
        def __init__(self, patterns, tokenizers=()):
            self._p = patterns
            self._t = tokenizers

        def get_download_patterns(self):
            return list(self._p)

        def get_tokenizers(self):
            return [type("T", (), {"download_patterns": list(self._t)})()]

    # _match：子目录与 basename 规则
    check("match 子目录规则", _match("vae/*.safetensors", "vae/ae.safetensors"))
    check("match 子目录失败", not _match("vae/*.safetensors", "transformer/a.safetensors"))
    check("match basename 规则", _match("*.json", "tokenizer/config.json"))
    check("match 不匹配", not _match("*.safetensors", "tokenizer/vocab.json"))

    tmp = tempfile.mkdtemp(prefix="mlx-model-selftest-")
    try:
        old_cache = _HF_CACHE
        _HF_CACHE = os.path.join(tmp, "models--%s")
        try:
            repo = "org/fake"
            base = _repo_cache_dir(repo)
            snap = os.path.join(base, "snapshots", "rev1")
            blobs = os.path.join(base, "blobs")
            os.makedirs(snap, exist_ok=True)
            os.makedirs(blobs, exist_ok=True)
            for sub in ("transformer", "text_encoder", "tokenizer"):
                os.makedirs(os.path.join(snap, sub), exist_ok=True)
            for name in ("aaa", "bbb", "ccc", "eee"):
                with open(os.path.join(blobs, name), "wb") as fh:
                    fh.write(b"x" * 10)
            # 孤儿 .incomplete：完整 blob 存在
            with open(os.path.join(blobs, "aaa.etag1.incomplete"), "wb") as fh:
                fh.write(b"x" * 5)
            # 孤儿 .incomplete：完整 blob 不存在（应保留）
            with open(os.path.join(blobs, "ddd.etag2.incomplete"), "wb") as fh:
                fh.write(b"x" * 5)
            os.symlink("../../../blobs/aaa", os.path.join(snap, "transformer/a.safetensors"))
            os.symlink("../../../blobs/bbb", os.path.join(snap, "text_encoder/b.safetensors"))
            os.symlink("../../../blobs/ccc", os.path.join(snap, "tokenizer/vocab.json"))
            # 软链指向 .incomplete → 应视为未完成
            os.symlink(
                "../../../blobs/aaa.etag1.incomplete",
                os.path.join(snap, "transformer/partial.safetensors"),
            )
            # 悬空软链 → 应忽略
            os.symlink(
                "../../../blobs/missing",
                os.path.join(snap, "text_encoder/dangling.safetensors"),
            )

            defs = FakeDefs(
                ["transformer/*.safetensors", "text_encoder/*.safetensors", "tokenizer/*"]
            )
            local = _local_targets(repo, defs)
            check("本地枚举排除 .incomplete/悬空", sorted(local) == [
                "text_encoder/b.safetensors",
                "tokenizer/vocab.json",
                "transformer/a.safetensors",
            ])
            patterns = _download_patterns(repo, defs)
            check("完整缓存判定 OK", _check_targets_complete(local, patterns))
            check(
                "缺文件判定 NOT_DOWNLOADED",
                not _check_targets_complete({k: v for k, v in local.items() if "tokenizer" not in k}, patterns),
            )

            removed = _clean_orphan_incomplete(repo)
            check("孤儿清理只删有完整 blob 的", removed == 1)
            check(
                "清理后保留无完整 blob 的 .incomplete",
                os.path.exists(os.path.join(blobs, "ddd.etag2.incomplete")),
            )
            check(
                "清理后删除有完整 blob 的 .incomplete",
                not os.path.exists(os.path.join(blobs, "aaa.etag1.incomplete")),
            )
        finally:
            _HF_CACHE = old_cache
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print(f"\nSELFTEST FAILED: {len(failures)} 项未通过")
        return 1
    print("\nSELFTEST OK")
    return 0


def main():
    if len(sys.argv) < 2:
        print("ERROR usage: mlx-model.py <download|check|selftest> [model]")
        return 2
    cmd = sys.argv[1]
    try:
        if cmd == "selftest":
            return run_selftest()
        if len(sys.argv) < 3:
            print("ERROR usage: mlx-model.py <download|check> <model>")
            return 2
        name = sys.argv[2]
        if cmd == "download":
            return run_download(name)
        if cmd == "check":
            return run_check(name)
        print(f"ERROR 未知命令 {cmd}")
        return 2
    except Exception as e:
        print(f"ERROR {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
