/**
 * 对话 / Agent 的上下文窗口解析。
 *
 * 为什么要单独一个模块：`SERVER_CTX_SIZE` 是 **llama.cpp 本地引擎的 KV 旋钮**
 * （设置页在「本地模型 → 启动参数」，改完重启推理服务器才生效），但历史上
 * 云端模式也读它 —— 没设置时就回落 8192。云端模型的真实窗口动辄 128k+，
 * 按 8192 算会让 pi-ai 的 `clampMaxTokensToContext` 把 `max_tokens` 钳到下限 1：
 * 模型只被允许生成 1 个 token 就 `finish_reason=length`，界面上表现为
 * 「模型本轮没有给出正文，也没有再调用工具」的空回合，怎么提醒都一样空
 * （2026-09 MiniMax-M3 云端空回合事故，根因即此）。
 *
 * 规则：
 * - **本地模式**：沿用 `SERVER_CTX_SIZE || 8192`（它就是为本地引擎准备的）；
 * - **云端模式**：不读 `SERVER_CTX_SIZE`。窗口按模型 id 定，优先级见
 *   `shared/model-context.ts`：**用户手填的覆盖值**（设置 → 云端模型 → 上下文列）
 *   → id 自带尺寸后缀 → 已知型号目录 → 256K 兜底。这里从 `CLOUD_MODELS`
 *   槽位取覆盖值 —— 它是激活厂商模型清单的镜像（`syncActiveSlot` 写入），
 *   与界面上那一列是同一份数据。
 */
import { contextLengthForModel } from "../shared/cloud-providers";
import {
  LOCAL_CTX_DEFAULT,
  contextWindowFromModelId,
  resolveCloudContextWindow,
} from "../shared/model-context";
import { getSetting } from "./db/settings";

// 尺寸后缀解析器挪进了 `shared/model-context.ts`（界面也要用同一个数），
// 这里转出去，`bun` 侧的既有调用方与单测不用改导入路径。
export { contextWindowFromModelId };

/**
 * 当前对话 / Agent 该按多大的上下文窗口算账（压缩预算、占用展示、max_tokens 钳制）。
 * 语义见模块注释：本地看引擎旋钮，云端看模型（手填覆盖 → 后缀 → 目录 → 256K）。
 */
export function chatContextWindow(): number {
  if (getSetting("SERVER_MODE") === "local") {
    return Number(getSetting("SERVER_CTX_SIZE")) || LOCAL_CTX_DEFAULT;
  }
  const modelId = getSetting("VLLM_MODEL_NAME") ?? "";
  // 覆盖值住在云端模型清单条目上；激活厂商的清单被镜像到 CLOUD_MODELS 槽位。
  // 查找逻辑与 `omi launch` 共用 contextLengthForModel，避免两边各写一份。
  return resolveCloudContextWindow(modelId, contextLengthForModel(getSetting("CLOUD_MODELS"), modelId));
}
