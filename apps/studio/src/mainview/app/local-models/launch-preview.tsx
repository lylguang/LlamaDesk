import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import type { LaunchPlan, PlanReason } from "@/shared/launch-planner";

/**
 * 自动启动参数预览卡片（`SERVER_AUTO_TUNE === "1"` 时在参数面板上方显示）。
 *
 * 数据来自 RPC `getLaunchPlanPreview`：主进程用与 llama.ts 启动时**同一个**
 * key 构造函数现算一份 `LaunchPlan`，所以这里预览到的就是真正会发出去的那条命令
 * 背后的计划。query key 里带模型路径与所有影响计划的设置，任何一项变了就重新取。
 */

/** 字节 → GiB 字符串，保留一位小数（界面与日志的统一口径）。 */
export function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes)) return "0.0";
  return (bytes / (1024 ** 3)).toFixed(1);
}

/** 界面侧的 reason 翻译函数签名（与 stores 里的 useT 返回值一致）。 */
export type TFn = (key: string, params?: Record<string, string>) => string;

/**
 * `PlanReason.code` → 人话。
 *
 * **显式分支、字面量 key**：这里不用模板字符串拼 key（`t(\`models.plan.reason.${code}\`)`
 * 会绕过 i18n 测试的静态扫描，以后少一条文案谁都发现不了）。加新 code 时必须在这里
 * 加一个 case，`launch-preview.test.ts` 会对全部 16 个 code 各断言一条非空、不等于 key
 * 的文案。
 */
export function reasonText(t: TFn, r: PlanReason): string {
  switch (r.code) {
    case "ctx.user":
      return t("models.plan.reason.ctxUser");
    case "ctx.native":
      return t("models.plan.reason.ctxNative");
    case "ctx.reduced":
      return t("models.plan.reason.ctxReduced");
    case "ctx.floor":
      return t("models.plan.reason.ctxFloor");
    case "ctx.no-metadata":
      return t("models.plan.reason.ctxNoMetadata");
    case "budget.vram":
      return t("models.plan.reason.budgetVram");
    case "budget.unified":
      return t("models.plan.reason.budgetUnified");
    case "budget.system":
      return t("models.plan.reason.budgetSystem");
    case "budget.overflow-to-system":
      return t("models.plan.reason.budgetOverflowToSystem");
    case "fa.forced-on":
      return t("models.plan.reason.faForcedOn");
    case "fa.budget-conservative":
      return t("models.plan.reason.faBudgetConservative");
    case "kv.unified":
      return t("models.plan.reason.kvUnified");
    case "kv.split-per-slot":
      return t("models.plan.reason.kvSplitPerSlot");
    case "batch.raised":
      return t("models.plan.reason.batchRaised");
    case "gpu.partial-offload":
      return t("models.plan.reason.gpuPartialOffload");
    case "gpu.none":
      return t("models.plan.reason.gpuNone");
  }
}

/** 计划行里「GPU 层数」那一格的短文案（null = 引擎自决 = 全部卸载）。 */
function gpuLayersText(t: TFn, plan: LaunchPlan): string {
  const blockCount: number = (plan.reasons.find((r) => r.code === "gpu.partial-offload")?.detail
    ?.blockCount as number | undefined) ?? 0;
  if (plan.gpuLayers === null) return t("models.plan.gpuAll");
  if (plan.gpuLayers === 0) return t("models.plan.gpuZero");
  return blockCount > 0 ? t("models.plan.gpuLayersSome", { n: String(plan.gpuLayers), total: String(blockCount) })
    : String(plan.gpuLayers);
}

export function LaunchPlanPreviewCard({
  modelPath,
  settings,
}: {
  modelPath: string;
  settings: Record<string, string>;
}) {
  const t = useT();
  const res = useQuery({
    queryKey: [
      "launch-plan-preview",
      modelPath,
      settings.SERVER_AUTO_TUNE,
      settings.SERVER_PARALLEL,
      settings.SERVER_BATCH_SIZE,
      settings.SERVER_UBATCH_SIZE,
      settings.SERVER_CACHE_TYPE_K,
      settings.SERVER_CACHE_TYPE_V,
      settings.SERVER_FLASH_ATTN,
      settings.SERVER_FLASH_ATTN_EFFECTIVE,
      settings.SERVER_AUTO_TUNE_MIN_CTX,
    ],
    queryFn: () => rpcClient.getLaunchPlanPreview({ path: modelPath }),
    enabled: modelPath !== "",
  });

  const d = res.data;
  const loading = res.isPending && d === undefined;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs font-medium">
        <span>{t("models.plan.title")}</span>
        {loading && <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {loading && (
        <p className="text-[11px] text-muted-foreground">{t("models.plan.loading")}</p>
      )}

      {!loading && d !== undefined && d.ok === false && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("models.plan.unavailable", { reason: d.reason })}
        </p>
      )}

      {!loading && d !== undefined && d.ok && (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <span>
              {t("models.plan.ctx")}: {d.plan.ctxTokens}
              {"  ·  "}
              {t("models.plan.ctxPerSlot", { n: String(d.plan.ctxPerSlot), p: String(d.plan.parallel) })}
            </span>
            <span>
              {t("models.plan.mem", {
                kv: formatGiB(d.plan.estimates.kvBytes),
                buf: formatGiB(d.plan.estimates.computeBufferBytes + d.plan.estimates.ctxComputeBytes),
                budget: formatGiB(d.plan.estimates.budgetBytes),
              })}
            </span>
            <span>
              {t("models.plan.gpuLabel")}: {gpuLayersText(t, d.plan)}
            </span>
          </div>

          {!d.plan.fits && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                {t("models.plan.notFits")}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{t("models.plan.why")}</span>
            <ul className="flex flex-col gap-1">
              {d.plan.reasons.map((r, i) => (
                <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <span aria-hidden="true">·</span>
                  <span>{reasonText(t, r)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
