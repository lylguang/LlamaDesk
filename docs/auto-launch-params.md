# 本地模型启动参数自动规划

自动推算 llama.cpp 的上下文长度与启动参数：读模型自身的 GGUF 元数据 + 机器的显存/内存，
算出「这台机器上这个模型最大能开多大窗口」，并给出一份可解释的启动计划。

设计思路参考了 Unsloth Studio 的行为（AGPL-3.0，**只借鉴算法与决策逻辑，代码为本项目自行实现**），
公式则用本机真实 llama.cpp 的分配量做过校准 —— 校准数据见文末。

## 分层

| 层 | 文件 | 职责 |
|---|---|---|
| 纯解析 | `shared/gguf.ts` | GGUF 二进制头 → `GgufModelMeta`。无任何 IO，webview 侧也能 import |
| 文件 IO | `bun/gguf-meta.ts` | 增量扩读（1 MiB 起，上限 96 MiB）、分片归一、mtime+size 缓存、失败落 `app.log` |
| 纯计算 | `shared/launch-planner.ts` | KV / compute buffer 估算、预算、二分拟合、`planLlamaLaunch` |
| 适配（待做） | `bun/` | 硬件快照 → planner → `RuntimeOverrides` → `llama.ts buildArgs` |

把规划器做成纯函数是刻意的：CI 没有 GPU，只有这样才能对「24 GB 卡 + 7B Q4 + GQA 应该开多大窗口」
写回归测试；UI 也能用同一个函数渲染「为什么是这个数」，避免页面与真实行为漂移。

## GGUF 元数据

`parseGguf` 按 GGUF v2/v3 规范解析，13 种 value type 全支持，超大数组（词表）跳过内容但在
`arrayLengths` 里保留长度（`vocabSize` 的回退来源）。防御上限：字符串 64 MiB、数组 1e8 项、
KV 10 万条、张量 1000 万个。

`ggufModelMeta` 归一出约 35 个字段，其中影响显存估算的关键项：

- `blockCount` / `headCount` / `headCountKv`（可为逐层数组）/ `keyLength` / `valueLength`
- **`headDim` 以 `keyLength` 为准**，不要用 `embeddingLength / headCount` 推 ——
  Qwen3.8-27B 是 5120/24，除不尽；两个真实模型都显式给了 `key_length=256`
- MLA：`kvLoraRank` / `keyLengthMla`
- 滑窗：`slidingWindow` / `slidingWindowPattern` / `keyLengthSwa` / `valueLengthSwa`
- 混合架构：`fullAttentionInterval` / `ssm*`
- 推测解码：`nextnPredictLayers`

`slidingWindowPattern` 是标量时表示**周期**（每 period 层里最后一层是全局层），展开成 `boolean[]`。
**周期不是窗口长度**：`slidingWindow` 只认 `attention.sliding_window`，缺失就是 `null`。
把周期（4~6）当成窗口（512~4096）会让滑窗层的 KV 算成只缓存几个 token，显存低估到离谱。

真实模型的元数据区比想象的大：Qwen3.8-27B 是 **10,945,338 字节**、Spark-4B 是 **5,370,453 字节**
（词表撑的），所以「读前 1 MB 就够」是错的，必须增量扩读。

## KV cache 估算

cell 布局（对齐粒度 **256**）：

```
paddedCtx      = pad256(ctxTokens)
streams        = kvUnified ? 1 : slots
cellsPerStream = kvUnified ? paddedCtx : pad256(floor(paddedCtx / slots))
totalCells     = cellsPerStream * streams
```

按架构分五支，先匹配先用：

| 分支 | 触发条件 | 要点 |
|---|---|---|
| `mla` | `kvLoraRank != null` | 只缓存一路 K；`headCountKv` 缺失时回退 **1** 而不是 `headCount`（DeepSeek 那类写的是 1，回退到 128 会放大两个数量级） |
| `hybrid-ssm` | `ssmInnerSize` + `fullAttentionInterval` | 只有 `ceil(blockCount / interval)` 层有 KV。Qwen3.8-27B 是 65 层里只有 17 层 |
| `swa` | `slidingWindow > 0` | 每层**二选一**：全局层用 `totalCells`，滑窗层用 `pad256(min(cellsPerStream, slidingWindow + ubatch)) × streams` |
| `gqa` | key/value length 齐全 | 逐层求和，支持逐层不同的 KV 头数 |
| `legacy` | 兜底 | `headDim = embeddingLength / headCount` |

V 的定价有一条容易漏的规则：**关掉 flash attention 时 llama.cpp 不接受量化的 V cache，会退回 f16**，
所以 `bpeV = flashAttn ? bpe(V) : max(bpe(V), 2.0)`。

## compute buffer

分两部分。常量部分：

```
outputBuffer = vocabSize * parallel * 4     // 每个 slot 一个输出 token 的 logits
actScratch   = 8 * embeddingLength * ubatch * 4
```

`outputBuffer` **不乘 ubatch** —— llama.cpp 按「需要输出 logits 的 token 数」分配，
聊天场景就是每 slot 一个。实测 `output buffer size = 0.50 MiB`，正好是 `vocab × 1 × 4`。

随上下文线性增长的部分，**flash attention 的开关是数量级差异**：

```
FA 关：perTok = headCount * ubatch * 5      // 注意力分数矩阵 [heads, ubatch, n_kv] 要完整物化
FA 开：perTok = ubatch * 2 * 3.5            // 只有一个 KQ mask
量化 KV 再加：rate * embeddingLength * (ubatch / 512)，rate = MLA 1.25 / 常规 2.25
跨卡按层切分再加：3 × (ubatch × 2 × 1.5)     // KQ mask 被复制 4 份，是台阶不是斜坡
```

实测同一组参数下两者相差 **11.4 倍**。这意味着在没有 FA 的机器上（本机 ROCm + CPU 层就是），
大上下文的瓶颈不是 KV 而是 compute buffer。

## 预算与拟合

```
usableDeviceBytes(free, total) = total > 0 ? free - (1 - 0.97) * total : free * 0.97
```

用**绝对预留**而不是按总量打折：卡上已经有别的进程时，只有这个口径是对的。
3% 的余量覆盖显存碎片、CUDA context、MoE 路由这些估不准的部分。

预算来源三选一：独显空闲显存 → 统一内存（× 0.75）→ 系统空闲内存（× 0.6）。
显存装不下时，会把系统内存作为**二级预算**再拟合一次（`budget.overflow-to-system`），
因为放不进显存的层和 KV 会落到内存里，拿显存预算去判定一个部分卸载的配置没有意义。

上下文拟合是二分搜索，结果向下对齐 256，下限 4096。**用户显式填了窗口就绝不自动缩小**，
只在计划里标 `fits: false` 让 UI 去提示。

`gpuLayers` 按「每层权重 + 每层 KV」估算显存能放几层，只有在装不下时才给出建议值；
装得下时返回 `null`（不发 `--n-gpu-layers`，交给引擎）。

## 实测校准

方法可复现：`scratchpad/probe-llama.sh`（启动真实 llama-server，`-lv 5` 读它自己打印的分配量）。

模型 Spark-X2.5-4B（36 层 = 9 全局 + 27 滑窗，embd 2560、16 heads、4 KV heads、
key/value length 256、ffn 10240、vocab 131072），f16 KV，parallel 1，纯 CPU：

| ctx | ubatch | FA | llama.cpp 实际 KV | 本文公式 | llama.cpp 实际 compute buffer | 本文公式 |
|---|---|---|---|---|---|---|
| 4096 | 512 | off | 144 + 108 = **252 MiB** | 252 MiB ✓ | **203 MiB** | 206.6 MiB（1.02×） |
| 16384 | 512 | off | 576 + 108 = **684 MiB** | 684 MiB ✓ | **691 MiB** | 686.6 MiB（0.99×） |
| 16384 | 1024 | off | 576 + 162 = **738 MiB** | 738 MiB ✓ | **1288 MiB** | 1372.6 MiB（1.07×） |
| 16384 | 512 | on | 576 + 108 = **684 MiB** | 684 MiB ✓ | **92 MiB** | 102.6 MiB（1.11×） |

KV 是**逐字节精确**，包括滑窗 cell 数随 ubatch 变化（512+512=1024、512+1024=1536，
证实 `slidingWindow + ubatch` 这个公式）以及 9/27 的层数划分。
compute buffer 误差在 ±11% 以内且一律略偏保守。

另有两条从真实实例读到的事实：

- 某个线上实例跑的是 `--ctx-size 196608 --parallel 3`，而 `/props` 报 `n_ctx = 65536` ——
  **llama-server 报的是每 slot 的窗口**（196608 / 3）。`--ctx-size` 是 KV 总量，会被 slot 均分，
  所以「用户想要 32K 单请求窗口」必须写入 `32768 × parallel`。
- 本机是 AMD Ryzen AI MAX+ 395（Strix Halo APU）：`rocm-smi` 报 VRAM 512 MiB，
  而 llama.cpp 报 `ROCm0: 125000 MiB, 124400 MiB free`。统一内存 APU 上这两个数都不能直接当预算，
  需要按「统一内存」口径处理 —— 项目现有的 `bun/hardware.ts` 目前不探测 ROCm，这是接入时要补的。

## 接入现状

- **硬件探测**：`bun/hardware.ts` 现在也认 AMD/ROCm（读 `/sys/class/drm/card*/device/mem_info_*`，
  退化时用 `rocm-smi --json`），并判定统一内存（GTT 远大于 VRAM 分区，或 VRAM 分区小于 2 GiB）。
  统一内存下 `vramBytes` 给 `null`，让预算走系统内存口径。
  空闲显存取自 `bun/gpu-stats.ts`（`hardware.ts` 的 `vramBytes` 是**总量**，别拿它当空闲用）。
- **计划缓存**：`bun/launch-plan.ts` 按 `LaunchPlanKey` 缓存（最多 4 条），文件指纹存在条目里、
  命中时用 `statSync` 校验。`start()` 异步算一次，`buildCommandLine()` 同步读同一份 ——
  否则「复制命令」显示的参数和真正启动的会不一致。
- **开关**：`SERVER_AUTO_TUNE`（默认 `"0"`，**关闭时行为与接入前逐字节相同**）、
  `SERVER_FLASH_ATTN`（`auto`/`on`/`off`，按二进制探测决定发三态值、布尔 flag 还是不发）、
  `SERVER_FLASH_ATTN_EFFECTIVE`（程序写回）。
- **回读闭环**：健康检查通过后拉一次 `/props` 拿实际 `n_ctx × total_slots`，
  并从启动日志解析 flash attention 实际状态（`shared/llama-log.ts`）写回 `SERVER_FLASH_ATTN_EFFECTIVE`，
  下次规划就能按真实状态计价。预测与实测一起记进 `app.log` 的 `launch_plan.measured`，
  两者相差超过 5% 再补一条 `launch_plan.mismatch`（warn）。

FA 状态从「未知」变成「已知开启」的收益是实测过的：同一台 8 GiB 卡、同一个 Spark-4B、q8_0 KV，
**ctx 从 72704 涨到 189696（2.61 倍）**。

## 待做

- 运行模型页的开关与计划预览卡片（16 个 reason code 的中英文案）
- 多卡：现在只取最大的那张卡，`planner-hardware.ts` 里有注释标出了这个简化
- 目录形式的模型仓库（非单文件 GGUF）暂不走自动推算
