#!/usr/bin/env python3
"""OmniStudio SystemOne 本地 worker —— laya-mlx（MLX，Apple Silicon）常驻进程。

协议：JSON-lines，stdin 收请求、stdout 回响应，**stdout 只走协议**
（第三方库的 print 一律被重定向到 stderr，否则会污染协议流）。

请求（一行一个 JSON）：
    {"id": "r1", "model": "laya-latest", "weights": "aac6fef/laya-mlx",
     "state": <string|object|array>, "questions": {名字: {type, instructions?, criteria}}}

响应：
    {"id": "r1", "ok": true, "response": {model, answers, usage}}
    {"id": "r1", "ok": false, "error": "…", "traceback": "…"}

其它控制行：
    {"msg": "quit"}                      正常退出
    {"type": "ready"}                    启动握手（import 成功后发出）
    {"type": "phase", "phase": "…"}      加载 / 下载权重时的进度提示

为什么要有这个 worker：官方 JEV 是 TypeSafe 的托管服务，而 Laya 是同一套
"typed decisions" 开放权重（choice / score / noul 三原语）。laya-mlx 把上游
权重搬到 MLX 上本地跑，于是同一个 /v1/systemone 契约既能走云端、也能完全离线。
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any

# ---------------------------------------------------------------------------
# stdout 归协议所有：先把真正的 stdout 抓在手里，把 sys.stdout 指到 stderr。
# 之后 emit() 才往协议流写 —— 这样哪怕 mlx / huggingface_hub 里有 print，
# 也只是混进日志，不会把 JSON 行拆坏。
# ---------------------------------------------------------------------------
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr


def emit(payload: dict[str, Any]) -> None:
    _PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


# ---------------------------------------------------------------------------
# 官方契约 ↔ laya-mlx 的差异，只在 worker 内部抹平
# ---------------------------------------------------------------------------

# laya-mlx 要求每个问题都带 instructions（它据此构造 prompt），而官方 API 允许省略。
# 省略时给一句中性问法：**不提问题名**（官方明确说"模型看不到问题 id"），
# 真正的判定依据留给 criteria。
FALLBACK_INSTRUCTIONS = {
    "choice": "Which option best describes the state?",
    "score": "How does the state rate against these levels?",
    "noul": "Is the statement true of the state?",
}


# laya-mlx 自己在 `resolve_model` 里用这组 allow_patterns 判断"这个 repo 够不够加载"。
# 这里保持一致：只有这几个文件齐了，才叫"已下载"—— 拿 config 当完整权重是最容易犯的
# 错，表现是"界面说已下载，一点运行才发现要下一整个模型"。
WEIGHT_PATTERNS = [
    "model.safetensors",
    "rl_agent_config.json",
    "encoder/config.json",
    "tokenizer/*",
    "mlx_config.json",
]


# 权重走 Hugging Face（laya-mlx 权重只挂 HF）。国内网络 huggingface.co 常直接不可达：
# 直连时 snapshot_download 会一直卡在连接上，界面看着就是「一点反应没有、0% 不动」。
# 与 mlx-worker.py 同一策略：默认走 hf-mirror 镜像，主进程显式传的 HF_ENDPOINT 优先
# （置空则在系统环境里回落到本默认值）。
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")


def dir_size(path: Any) -> int:
    """一个目录（含软链接指向的目标）的总字节数。"""
    from pathlib import Path

    total = 0
    for item in Path(path).rglob("*"):
        try:
            if item.is_file():
                total += item.stat().st_size
        except OSError:
            # 下载中途的文件可能刚好消失，跳过即可。
            continue
    return total


def cache_dir_size(weights: str) -> int:
    """Hugging Face 缓存里某个 repo 当前已落盘的字节数（下载中途的进度来源）。"""
    try:
        from huggingface_hub.constants import HF_HUB_CACHE

        return dir_size(Path(HF_HUB_CACHE) / ("models--" + weights.replace("/", "--")))
    except Exception:  # noqa: BLE001 —— 纯展示用，取不到就报 0
        return 0


def normalize_questions(questions: dict[str, Any]) -> dict[str, Any]:
    """把官方形状的问题转成 laya-mlx 能吃的形状（补 instructions，字段名不变）。"""
    out: dict[str, Any] = {}
    for qid, question in questions.items():
        if not isinstance(question, dict):
            raise ValueError(f'question "{qid}" must be an object')
        kind = question.get("type")
        if kind not in FALLBACK_INSTRUCTIONS:
            raise ValueError(f'question "{qid}" has unsupported type {kind!r}')
        instructions = question.get("instructions")
        if instructions is None or (isinstance(instructions, str) and not instructions.strip()):
            instructions = FALLBACK_INSTRUCTIONS[kind]
        q: dict[str, Any] = {"type": kind, "instructions": instructions}
        criteria = question.get("criteria")
        if criteria is not None:
            q["criteria"] = criteria
        out[qid] = q
    return out


def to_official_answer(answer: dict[str, Any]) -> dict[str, Any]:
    """laya-mlx 的结果 → 官方 answer 形状。

    两处刻意的裁剪：
    - 丢掉 `action.act_probability`（上游内部字段，官方响应里没有）；
    - noul 丢掉 `confidence`（官方明确"noul 没有单独的 confidence"）。
    概率保留 laya 的四位小数，与上游一致。
    """
    kind = answer.get("type")
    if kind == "choice":
        return {
            "type": "choice",
            "choice": answer["choice"],
            "confidence": answer["confidence"],
            "probabilities": answer["probabilities"],
        }
    if kind == "score":
        return {
            "type": "score",
            "score": answer["score"],
            "confidence": answer["confidence"],
            "legend": answer["legend"],
            "probabilities": answer["probabilities"],
        }
    return {"type": "noul", "noul": answer["noul"]}


# ---------------------------------------------------------------------------
# 引擎：按 weights 懒加载，最多常驻 MAX_LOADED 个（内存换命中率）
# ---------------------------------------------------------------------------

MAX_LOADED = int(os.environ.get("LAYA_MAX_LOADED", "2"))


class Runtime:
    def __init__(self) -> None:
        self._agents: dict[str, Any] = {}
        self._laya: Any = None

    def _import(self) -> Any:
        if self._laya is None:
            import laya_mlx as laya  # noqa: PLC0415 —— 首次加载才付出 import 成本

            self._laya = laya
        return self._laya

    def agent(self, weights: str) -> Any:
        cached = self._agents.get(weights)
        if cached is not None:
            return cached
        laya = self._import()
        dtype = os.environ.get("LAYA_DTYPE", "float16")
        emit({"type": "phase", "phase": "loading", "weights": weights})
        agent = laya.load(weights, dtype=dtype)
        emit({"type": "phase", "phase": "loaded", "weights": weights})
        # 超出上限就丢最早加载的那个（dict 保序），避免常驻内存无限增长。
        while len(self._agents) >= MAX_LOADED:
            oldest = next(iter(self._agents))
            self._agents.pop(oldest, None)
        self._agents[weights] = agent
        return agent

    def predict(self, request: dict[str, Any]) -> dict[str, Any]:
        weights = request.get("weights") or "aac6fef/laya-mlx"
        model_label = request.get("model") or weights
        questions = normalize_questions(request.get("questions") or {})
        if not questions:
            raise ValueError("at least one question is required")
        agent = self.agent(str(weights))
        # laya 的 system_one 就是官方接口的同名方法；predict 是它的别名。
        result = agent.system_one(request.get("state"), questions)
        return {
            "model": str(model_label),
            "answers": {
                qid: to_official_answer(answer) for qid, answer in result["answers"].items()
            },
            "usage": {
                "input_tokens": int(result["usage"]["input_tokens"]),
                "output_tokens": int(result["usage"]["output_tokens"]),
            },
        }

    # -----------------------------------------------------------------------
    # 引擎页要的三件事：权重在不在（占多少盘）、下载权重、把权重装进内存
    # -----------------------------------------------------------------------

    def model_states(self, repos: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """每个 repo 在本机的缓存状态。只用 `local_files_only` 探测，不会触发下载。"""
        from huggingface_hub import snapshot_download
        from huggingface_hub.errors import LocalEntryNotFoundError

        items: list[dict[str, Any]] = []
        for repo in repos:
            weights = str(repo.get("weights") or "")
            if not weights:
                continue
            try:
                path = snapshot_download(weights, allow_patterns=WEIGHT_PATTERNS, local_files_only=True)
            except (LocalEntryNotFoundError, FileNotFoundError, OSError, ValueError):
                items.append({"weights": weights, "downloaded": False, "bytes": 0})
                continue
            items.append(
                {
                    "weights": weights,
                    "downloaded": True,
                    "bytes": dir_size(path),
                    "path": path,
                }
            )
        return items

    def download(self, request: dict[str, Any]) -> dict[str, Any]:
        """把权重拉进 Hugging Face 缓存。

        huggingface_hub 不暴露字节级进度，所以在**后台线程**里下载、主线程轮询缓存目录
        体积 —— 得到的是真实的已落盘字节（含断点续传的既有分片），比"假装 50%"诚实。
        """
        import threading
        import time
        from huggingface_hub import snapshot_download

        weights = str(request.get("weights") or "")
        if not weights:
            raise ValueError("weights is required")
        request_id = request.get("id")
        box: dict[str, Any] = {}

        def run() -> None:
            try:
                box["path"] = snapshot_download(weights, allow_patterns=WEIGHT_PATTERNS)
            except Exception as exc:  # noqa: BLE001 —— 后台线程的异常要带回主线程
                box["error"] = f"{type(exc).__name__}: {exc}"

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        while thread.is_alive():
            emit(
                {
                    "type": "progress",
                    "requestId": request_id,
                    "weights": weights,
                    "phase": "downloading",
                    "bytes": cache_dir_size(weights),
                }
            )
            time.sleep(0.5)
        thread.join()
        if "error" in box:
            raise RuntimeError(box["error"])
        path = box.get("path")
        emit(
            {
                "type": "progress",
                "requestId": request_id,
                "weights": weights,
                "phase": "done",
                "bytes": dir_size(path) if path else cache_dir_size(weights),
            }
        )
        return {"weights": weights, "path": path}

    def load(self, request: dict[str, Any]) -> dict[str, Any]:
        """把权重加载成常驻实例（引擎页的「启动」）。**不跑推理**，只付出加载成本。"""
        weights = str(request.get("weights") or "")
        if not weights:
            raise ValueError("weights is required")
        self.agent(weights)
        return {"weights": weights, "loaded": True}

    def unload(self, request: dict[str, Any]) -> dict[str, Any]:
        weights = str(request.get("weights") or "")
        if weights in self._agents:
            self._agents.pop(weights, None)
        return {"weights": weights, "loaded": False}

    def loaded(self) -> list[str]:
        return list(self._agents)


def dispatch(runtime: "Runtime", request: dict[str, Any]) -> dict[str, Any]:
    """按 `msg` 选动作；没有 `msg` 就当一次判定请求（保持首版协议兼容）。"""
    msg = request.get("msg")
    if msg is None or msg == "predict":
        return runtime.predict(request)
    if msg == "models":
        return {"items": runtime.model_states(list(request.get("repos") or [])), "loaded": runtime.loaded()}
    if msg == "download":
        return runtime.download(request)
    if msg == "load":
        return runtime.load(request)
    if msg == "unload":
        return runtime.unload(request)
    raise ValueError(f"unknown msg {msg!r}")


def main() -> int:
    runtime = Runtime()
    try:
        # import 失败（非 Apple Silicon / 未装 mlx）要立刻暴露，而不是等第一个请求。
        runtime._import()
    except Exception as exc:  # noqa: BLE001 —— 启动失败必须原样报给主进程
        emit({"type": "fatal", "error": f"{type(exc).__name__}: {exc}"})
        return 2
    emit({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"type": "log", "level": "error", "message": f"bad request line: {exc}"})
            continue
        if request.get("msg") == "quit":
            return 0
        request_id = request.get("id")
        try:
            response = dispatch(runtime, request)
            emit({"id": request_id, "ok": True, "response": response})
        except Exception as exc:  # noqa: BLE001 —— 单个请求失败不能带崩常驻进程
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc()[-4000:],
                }
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
