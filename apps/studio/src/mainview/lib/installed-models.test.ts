import { describe, expect, test } from "bun:test";

import { installedFilesForRepo } from "./installed-models";

/**
 * 市场页的"这个文件在**这个仓库**里下过没有"。
 *
 * vLLM / SGLang / MLX 的仓库在已安装列表里只有一条目录记录，成员文件必须能命中，
 * 否则仓库里的每个分片都会显示成"还没下载"（点一下又下一遍）。
 *
 * 反过来更要紧：判定不能跨仓库。`model-00001-of-00002.safetensors` 这种分片名在几乎
 * 每个 safetensors 仓库里都一样，只看文件名会让「下载整个模型」把它们当成已下载 ——
 * 落盘只剩 config / tokenizer，模型既跑不了、也不会出现在「运行模型」的列表里
 * （权重文件不存在，仓库目录根本不算一个模型；真机上就是这么丢的模型）。
 */
describe("installedFilesForRepo", () => {
  test("把整仓库条目的成员文件摊平进去", () => {
    const names = installedFilesForRepo(
      [
        {
          repo: "mlx-community/LFM2.5-2.6B-MLX",
          fileName: "LFM2.5-2.6B-MLX",
          files: ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"],
        },
      ],
      "mlx-community/LFM2.5-2.6B-MLX",
    );
    expect(names.has("model-00001-of-00002.safetensors")).toBe(true);
    expect(names.has("model-00002-of-00002.safetensors")).toBe(true);
  });

  test("别的仓库里的同名分片不算这个仓库已下载", () => {
    const models = [
      {
        repo: "mlx-community/Qwen3.5-4B-MLX-bf16",
        fileName: "Qwen3.5-4B-MLX-bf16",
        files: ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"],
      },
    ];
    const names = installedFilesForRepo(models, "mlx-community/K2-Horizon-7B-Uno-oQ6e");
    expect(names.size).toBe(0);
    expect(names.has("model-00001-of-00002.safetensors")).toBe(false);
  });

  test("斜杠与 __ 两种写法指向同一个仓库（市场 repo id vs 落盘目录名）", () => {
    const models = [
      {
        repo: "pipenetwork__DeepSeek-V4.1-Flash-MLX-mixed-4_8bit",
        fileName: "DeepSeek-V4.1-Flash-MLX-mixed-4_8bit",
        files: ["model-layers-01.safetensors"],
      },
    ];
    expect(
      installedFilesForRepo(models, "pipenetwork/DeepSeek-V4.1-Flash-MLX-mixed-4_8bit").has(
        "model-layers-01.safetensors",
      ),
    ).toBe(true);
    // 目录名写法自己也能命中（两条数据同源，不能只认一种）
    expect(
      installedFilesForRepo(models, "pipenetwork__DeepSeek-V4.1-Flash-MLX-mixed-4_8bit").has(
        "model-layers-01.safetensors",
      ),
    ).toBe(true);
  });

  test("HF 缓存条目（org/repo）与市场 repo id 对得上", () => {
    const names = installedFilesForRepo(
      [
        {
          repo: "mlx-community/Qwen3.5-4B-MLX-bf16",
          fileName: "Qwen3.5-4B-MLX-bf16",
          files: ["model-00001-of-00002.safetensors"],
        },
      ],
      "mlx-community/Qwen3.5-4B-MLX-bf16",
    );
    expect([...names]).toEqual(["model-00001-of-00002.safetensors"]);
  });

  test("分批 GGUF 用真实分片名命中（展示名不是磁盘上的文件）", () => {
    const names = installedFilesForRepo(
      [
        {
          repo: "unsloth__GLM-5.2-GGUF",
          fileName: "GLM-5.2-UD-Q3_K_M.gguf",
          files: ["GLM-5.2-UD-Q3_K_M-00001-of-00003.gguf", "GLM-5.2-UD-Q3_K_M-00002-of-00003.gguf"],
        },
      ],
      "unsloth/GLM-5.2-GGUF",
    );
    expect(names.has("GLM-5.2-UD-Q3_K_M-00001-of-00003.gguf")).toBe(true);
    expect(names.has("GLM-5.2-UD-Q3_K_M-00002-of-00003.gguf")).toBe(true);
    expect(names.has("GLM-5.2-UD-Q3_K_M.gguf")).toBe(false);
  });

  test("没有 files 的老条目退回到 fileName（向后兼容）", () => {
    const names = installedFilesForRepo(
      [{ repo: "imported", fileName: "old-model.gguf" }],
      "imported",
    );
    expect([...names]).toEqual(["old-model.gguf"]);
  });

  test("成员文件带子目录路径时取 basename（仓库里的 BF16/xxx.gguf）", () => {
    const names = installedFilesForRepo(
      [{ repo: "org/repo", fileName: "repo", files: ["BF16/Model-Q4_K_M.gguf"] }],
      "org/repo",
    );
    expect(names.has("Model-Q4_K_M.gguf")).toBe(true);
  });

  test("没下过的仓库返回空集合（调用方据此把权重排进下载队列）", () => {
    expect(installedFilesForRepo([], "rapid-mlx/Qwen3.8-27B-4bit-MTP-MLX").size).toBe(0);
  });

  test("同目录的 config / tokenizer 也算下过（否则「已下载」永远差几个文件）", () => {
    const names = installedFilesForRepo(
      [
        {
          repo: "org/repo",
          fileName: "repo",
          files: ["model-00001-of-00002.safetensors"],
          supportFiles: ["config.json", "tokenizer.json", "chat_template.jinja"],
        },
      ],
      "org/repo",
    );
    expect(names.has("config.json")).toBe(true);
    expect(names.has("tokenizer.json")).toBe(true);
    expect(names.has("chat_template.jinja")).toBe(true);
  });

  test("配置文件同样不跨仓库：别的仓库目录里的 config.json 不算数", () => {
    const names = installedFilesForRepo(
      [{ repo: "org/other", fileName: "other", supportFiles: ["config.json"] }],
      "org/repo",
    );
    expect(names.size).toBe(0);
  });

  /**
   * GGUF 仓库里投影文件（mmproj）是权重之外的第二个下载目标：它由扫描登记在
   * 同目录模型条目的 supportFiles 上（见 model-scan.tests.ts）。这里没算上它，
   * 「下载这个模型」按钮就会永远差这一个文件、亮不起「已下载」。
   */
  test("同目录的 mmproj 投影文件也算下过（GGUF 的多模态视觉塔）", () => {
    const names = installedFilesForRepo(
      [
        {
          repo: "unsloth__Qwen3.8-27B-GGUF",
          fileName: "Qwen3.8-27B-Q4_K_M.gguf",
          files: ["Qwen3.8-27B-Q4_K_M.gguf"],
          supportFiles: ["mmproj-Qwen3.8-27B-BF16.gguf"],
        },
      ],
      "unsloth/Qwen3.8-27B-GGUF",
    );
    expect(names.has("Qwen3.8-27B-Q4_K_M.gguf")).toBe(true);
    expect(names.has("mmproj-Qwen3.8-27B-BF16.gguf")).toBe(true);
  });
});
