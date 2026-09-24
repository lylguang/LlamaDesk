/**
 * 左栏顶部的「判定引擎」切换 + 对应配置 —— 位置与交互对齐语音合成页的「推理引擎」：
 * 一排分段按钮，选中项下方给一句人话说明，再往下是该引擎要配的东西。
 *
 * 两个引擎的区别值得写清楚，因为它不是"本地/云端"那么对称：
 * - 本地运行：免费的离线权重（laya-mlx）。要装引擎、下权重、启动模型，慢一点但完全离线；
 * - 云端接入：打 TypeSafe 官方（或任何同协议的地址），要配 Key，不占本机内存。
 *
 * 本地这侧的模型行就是"下载这个模型、下载这个引擎、启动这个模型"三件事的落点。
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  CpuIcon,
  CloudIcon,
  DownloadIcon,
  Loader2Icon,
  PlayIcon,
  SearchIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { useJevStore } from "@stores/jev";
import { useJevMetrics } from "@stores/jev-metrics";
import { useSystemOneInstallStore } from "@stores/systemone-install";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { cn } from "@/mainview/lib/utils";
import { AgentDiagnoseButton } from "@/mainview/components/agent-diagnose-button";
import type { SystemOneAvailability, SystemOneDiscovery } from "../../../bun/systemone";

type EngineTab = "local" | "cloud";

/** tab → 设置值：选哪个 tab 就走哪条后端，不再让 `auto` 偷偷改写用户的选择。 */
const BACKEND_FOR_TAB: Record<EngineTab, string> = { local: "local", cloud: "cloud" };

/** 设置值 → tab：`auto`（用户还没选过）时按当前解析结果落在实际会用的那侧。 */
function tabForBackend(backend: string, resolved: string | null): EngineTab {
  if (backend === "local" || backend === "cloud") return backend;
  return resolved === "cloud" ? "cloud" : "local";
}

export function EngineSelector() {
  const t = useT();
  const queryClient = useQueryClient();
  const tab = useJevStore((s) => s.engineTab);
  const setTab = useJevStore((s) => s.setEngineTab);
  const status = useQuery({
    queryKey: ["systemone", "status"],
    queryFn: () => rpcClient.systemoneStatus(undefined),
    // 只在"正在装/正在下"时轮询：状态查询会起 worker 探缓存，空转不值得。
    refetchInterval: (query) => (isBusy(query.state.data) ? 1500 : false),
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => rpcClient.getSettings(undefined) });
  const storedBackend = settings.data?.settings.SYSTEMONE_BACKEND ?? "";
  const resolved = status.data?.resolved ?? null;
  const [backendError, setBackendError] = useState<string | null>(null);
  // 首次拿到设置时决定停在哪个 tab（auto / 未设置 → 按当前解析结果落在实际会用的那侧）；
  // 之后不再跟着设置回写，免得后台刷新把用户刚点的 tab 拨回去。
  const decided = useRef(false);
  /*
   * tab 就是后端选择本身。
   *
   * 之前 tab 只是个"视图"，真正走哪条由 `SYSTEMONE_BACKEND`（默认 auto）决定 —— 于是
   * 用户在「云端接入」里填好 Key，请求仍然被 auto 的"本地优先"截走（本地服务地址一配，
   * 云端就永远轮不到）。用户看到的就是"我配了但它没调用我的后端"。
   * 现在切 tab 就写设置：本地运行 → local，云端接入 → cloud。
   */
  const pickBackend = useMutation({
    mutationFn: (patch: Record<string, string>) => rpcClient.updateSettings({ settings: patch }),
    onSuccess: () => {
      setBackendError(null);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["systemone", "status"] });
    },
    /*
     * 写失败必须把 tab 拨回去。
     *
     * 这一页的整个教训就是"界面说的后端"和"真正被调用的后端"会分家 —— 如果设置没写进去
     * 而 tab 停在云端，用户看到的就是同一个 bug 换了个样子（我选了云端、它还在走本地）。
     * 所以退回原选择并明说，而不是留一个乐观的假象。
     */
    onError: (error) => {
      setTab(tabForBackend(storedBackend, resolved));
      setBackendError(error instanceof Error ? error.message : String(error));
    },
  });
  useEffect(() => {
    if (decided.current || !storedBackend) return;
    decided.current = true;
    setTab(tabForBackend(storedBackend, resolved));
  }, [storedBackend, resolved, setTab]);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground">{t("jev.engine")}</span>
      <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist">
        {(["local", "cloud"] as EngineTab[]).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors",
              tab === value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => {
              setTab(value);
              // 只在真的变了的时候写，省一次设置写库 + 一轮状态重查。
              if (storedBackend !== BACKEND_FOR_TAB[value]) pickBackend.mutate({ SYSTEMONE_BACKEND: BACKEND_FOR_TAB[value] });
            }}
          >
            {value === "local" ? <CpuIcon className="size-3.5" aria-hidden /> : <CloudIcon className="size-3.5" aria-hidden />}
            {t(value === "local" ? "jev.engine.local" : "jev.engine.cloud")}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {t(tab === "local" ? "jev.engine.local.desc" : "jev.engine.cloud.desc")}
      </p>
      {backendError ? (
        <p className="jev-note error">{t("jev.backend.saveFailed", { message: backendError })}</p>
      ) : null}
      {tab === "local" ? <LocalPanel status={status.data} /> : <CloudPanel status={status.data} />}
    </div>
  );
}

function isBusy(status: SystemOneAvailability | undefined): boolean {
  if (!status) return false;
  return status.localRuntimePhase === "installing" || status.localRuntimePhase === "loading";
}

// ---------------------------------------------------------------------------
// 本地运行：引擎（laya-mlx）+ 三个权重
// ---------------------------------------------------------------------------

function LocalPanel({ status }: { status: SystemOneAvailability | undefined }) {
  const t = useT();
  const queryClient = useQueryClient();
  const installLog = useSystemOneInstallStore((s) => s.logs);
  // 一次订阅整张进度表，且**必须在下面两个提前 return 之前** ——
  // 钩子数量随 status 的有无而变会直接触发 React #310（"渲染的钩子比上次多"）。
  const progressMap = useSystemOneInstallStore((s) => s.progress);
  /*
   * 正在下哪个权重：只看 `download.isPending` 分不出来（三行共用一个 mutation），
   * 而推送可能在窗口刚起来时还没接上 —— 两条路都要能显示"下载中"。
   * 和其它钩子一样，必须在下面的提前 return **之前**（顺序一变就是 React #310）。
   */
  const [downloading, setDownloading] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["systemone", "status"] });

  const install = useMutation({ mutationFn: () => rpcClient.systemoneInstallRuntime(undefined), onSuccess: refresh });
  const uninstall = useMutation({ mutationFn: () => rpcClient.systemoneUninstallRuntime(undefined), onSuccess: refresh });
  const download = useMutation({
    mutationFn: (weights: string) => {
      setDownloading(weights);
      return rpcClient.systemoneDownloadModel({ weights });
    },
    // 成功/失败都要清掉：留着会让那一行一直显示"下载中"。
    onSettled: () => {
      setDownloading(null);
      refresh();
    },
  });
  const start = useMutation({
    mutationFn: (weights: string) => rpcClient.systemoneStartModel({ weights }),
    onSuccess: refresh,
  });
  const stop = useMutation({
    mutationFn: (weights: string) => rpcClient.systemoneStopModel({ weights }),
    onSuccess: refresh,
  });
  /**
   * 一键补依赖：装 uv（它再按需取合规的解释器）。
   *
   * 这条路是踩出来的：这台机器只有 macOS 自带的 Python 3.9，引擎装不了，而报错只说
   * "请先安装 Python 3.11–3.13" —— 用户还得自己去查怎么装。装完直接接着装引擎。
   *
   * 和这个组件里其它钩子一样，**必须在下面那两个提前 return 之前** —— 顺序一变
   * 就是 React #310（"渲染的钩子比上次多"），这一页已经栽过一次。
   */
  const installDeps = useMutation({
    mutationFn: () => rpcClient.systemoneInstallDeps(undefined),
    onSuccess: (result) => {
      refresh();
      if (result.ok) install.mutate();
    },
  });

  if (!status) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" aria-hidden /> {t("jev.local.checking")}
      </p>
    );
  }

  if (!status.localRuntimeSupported) {
    return (
      <p className="jev-note error">
        <TriangleAlertIcon className="mr-1 inline size-3" aria-hidden />
        {t("systemone.runtime.unsupported")}
      </p>
    );
  }

  const busy = download.isPending || start.isPending || stop.isPending;
  const failure = download.data && !download.data.ok ? download.data.error : start.data && !start.data.ok ? start.data.error : null;

  return (
    <div className="flex flex-col gap-2">
      {/* 引擎本体 */}
      <div className="flex items-center gap-2 rounded-lg border p-2">
        <span className="min-w-0 flex-1 truncate text-[11px]">
          {status.localRuntimeInstalled ? (
            <>
              <CheckCircle2Icon className="mr-1 inline size-3 text-emerald-600" aria-hidden />
              {t("jev.local.engineReady", { version: status.localRuntimeVersion || "?" })}
            </>
          ) : (
            t("jev.local.engineMissing")
          )}
        </span>
        {status.localRuntimeInstalled ? (
          <Button size="sm" variant="outline" className="gap-1" disabled={uninstall.isPending} onClick={() => uninstall.mutate()}>
            <Trash2Icon className="size-3" aria-hidden />
            {t("systemone.runtime.uninstall")}
          </Button>
        ) : (
          <Button size="sm" className="gap-1" disabled={install.isPending} onClick={() => install.mutate()}>
            {install.isPending ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : <DownloadIcon className="size-3" aria-hidden />}
            {t("jev.local.installEngine")}
          </Button>
        )}
      </div>
      {status.localRuntimePhase === "installing" && status.localRuntimePhaseMessage ? (
        <p className="text-[11px] text-muted-foreground">
          <Loader2Icon className="mr-1 inline size-3 animate-spin" aria-hidden />
          {status.localRuntimePhaseMessage}
        </p>
      ) : null}
      {installDeps.data && !installDeps.data.ok ? <p className="jev-note error">{installDeps.data.error}</p> : null}
      {install.data && !install.data.ok ? (
        <div className="flex flex-col gap-1.5">
          <p className="jev-note error">{install.data.error}</p>
          <div className="flex flex-wrap gap-2">
            {/* 缺解释器是最常见的那种失败，直接给一键补齐，不让用户去查怎么装 Python。 */}
            {!status.localRuntimeInstalled ? (
              <Button size="sm" variant="outline" className="gap-1" disabled={installDeps.isPending} onClick={() => installDeps.mutate()}>
                {installDeps.isPending ? (
                  <Loader2Icon className="size-3 animate-spin" aria-hidden />
                ) : (
                  <DownloadIcon className="size-3" aria-hidden />
                )}
                {t("jev.local.installDeps")}
              </Button>
            ) : null}
            <DiagnoseButton status={status} error={install.data.error ?? ""} logs={installLog} />
          </div>
        </div>
      ) : null}

      {/* 权重 */}
      {status.localRuntimeInstalled ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium">{t("jev.local.models")}</span>
          {status.localModels.map((model) => {
            const progress = progressMap[model.weights];
            // 推送与"点了下载、请求还没回来"两种来源合并成一个展示态。
            const downloadingThis = downloading === model.weights;
            const inFlight = downloadingThis || progress?.phase === "downloading";
            const bytes = Math.max(progress?.bytes ?? 0, downloadingThis ? model.bytes : 0);
            const percent = model.approxBytes > 0 ? Math.min(99, Math.round((bytes / model.approxBytes) * 100)) : null;
            return (
              <div key={model.name} className="flex items-center gap-2 rounded-lg border p-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] font-medium">{model.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {model.loaded
                      ? t("jev.local.state.running")
                      : model.downloaded
                        ? t("jev.local.state.downloaded", { size: formatBytes(model.bytes) })
                        : inFlight
                          ? percent === null
                            ? t("jev.local.state.downloading", { size: formatBytes(bytes) })
                            : t("jev.local.state.downloadingPct", {
                                percent: String(percent),
                                size: formatBytes(bytes),
                                total: formatBytes(model.approxBytes),
                              })
                          : t("jev.local.state.missing")}
                  </span>
                  {inFlight ? (
                    // 进度条：宽度按百分比；没有分母时走"不确定"动画（条纹滚动），
                    // 总之要让用户看到"在动"，而不是一个静止的按钮。
                    <span className="jev-prob-track mt-1 block w-full">
                      <span
                        className={cn("jev-prob-fill block", percent === null && "animate-pulse")}
                        style={{ width: percent === null ? "100%" : `${percent}%` }}
                      />
                    </span>
                  ) : null}
                </span>
                {model.loaded ? (
                  <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={() => stop.mutate(model.weights)}>
                    <SquareIcon className="size-3" aria-hidden />
                    {t("jev.local.stop")}
                  </Button>
                ) : model.downloaded ? (
                  <Button size="sm" className="gap-1" disabled={busy} onClick={() => start.mutate(model.weights)}>
                    {start.isPending ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : <PlayIcon className="size-3" aria-hidden />}
                    {t("jev.local.start")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    // 按钮状态跟着**同一个**判据（inFlight），否则会出现"行里写着下载中、
                    // 按钮还写着下载"这种自相矛盾的画面（推送到了、但点的人不是这一处）。
                    disabled={busy || inFlight}
                    onClick={() => download.mutate(model.weights)}
                  >
                    {inFlight ? (
                      <Loader2Icon className="size-3 animate-spin" aria-hidden />
                    ) : (
                      <DownloadIcon className="size-3" aria-hidden />
                    )}
                    {inFlight ? t("jev.local.downloading") : t("jev.local.download")}
                  </Button>
                )}
              </div>
            );
          })}
          <p className="text-[10px] leading-4 text-muted-foreground">{t("jev.local.hint")}</p>
        </div>
      ) : null}

      {failure ? (
        <div className="flex flex-col gap-1.5">
          <p className="jev-note error">{failure}</p>
          <DiagnoseButton status={status} error={failure} logs={installLog} />
        </div>
      ) : null}
      {installLog.length > 0 && !status.localRuntimeInstalled ? (
        <pre className="jev-log max-h-28">{installLog.slice(-8).join("\n")}</pre>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

// ---------------------------------------------------------------------------
// 云端接入：Base URL + Key + 模型
// ---------------------------------------------------------------------------

function CloudPanel({ status }: { status: SystemOneAvailability | undefined }) {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => rpcClient.getSettings(undefined) });
  const [base, setBase] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  /** 此刻光标在哪个框里（那个框不跟随外部设置）。 */
  const [editing, setEditing] = useState<"base" | "model" | null>(null);

  const savedBase = settings.data?.settings.SYSTEMONE_CLOUD_BASE_URL ?? "";
  const savedModel = settings.data?.settings.SYSTEMONE_CLOUD_MODEL ?? "";
  /*
   * 跟随已保存的设置 —— 但**正在输入的那个框不动**。
   *
   * 侧栏的模型选择改的是同一份设置（选另一条路径上的模型会连 Base URL 一起换），
   * 如果这里只在首次回填，用户在侧栏选完之后，这两个框还停在上一台的地址和模型，
   * 看起来就像"选了没生效"。`editing` 记的是此刻光标在哪个框里，只让那一个保持
   * 用户正在敲的内容。
   */
  useEffect(() => {
    if (savedBase && editing !== "base") setBase(savedBase);
    if (savedModel && editing !== "model") setModel(savedModel);
  }, [savedBase, savedModel, editing]);

  const save = useMutation({
    mutationFn: (patch: Record<string, string>) => rpcClient.updateSettings({ settings: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["systemone", "status"] });
    },
  });
  const test = useMutation({
    mutationFn: async () => {
      const result = await rpcClient.systemoneTest(undefined);
      // 「测试连接」跑的是一次真判定，延迟同样算数。
      useJevMetrics.getState().record({
        at: Date.now(),
        ms: result.ok ? result.latencyMs : 0,
        ok: result.ok,
        backend: result.ok ? result.backend : null,
        source: "test",
      });
      return result;
    },
  });
  /**
   * 自动发现：把正在编辑的地址与 Key 直接送过去（用户很可能刚粘完还没失焦保存）。
   * 只读不写 —— 填哪个模型、换不换地址，由下面的结果里用户自己点。
   */
  const discover = useMutation({
    mutationFn: (override?: { baseUrl: string }) =>
      rpcClient.systemoneDiscover({ baseUrl: override?.baseUrl ?? base.trim(), apiKey: key.trim() }),
  });

  const pickModel = (name: string) => {
    setModel(name);
    save.mutate({ SYSTEMONE_CLOUD_MODEL: name });
  };

  /** 判定服务在子路径上时，把地址换成那一条，并就着新地址再读一遍。 */
  const pickBase = (next: string) => {
    setBase(next);
    save.mutate({ SYSTEMONE_CLOUD_BASE_URL: next });
    discover.mutate({ baseUrl: next });
  };

  const inputClass = "h-8 text-xs";

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">{t("systemone.field.cloudBase")}</span>
        <Input
          className={inputClass}
          value={base}
          placeholder="https://api.typesafe.ai"
          spellCheck={false}
          onFocus={() => setEditing("base")}
          onChange={(event) => {
            setBase(event.target.value);
          }}
          onBlur={() => {
            setEditing(null);
            save.mutate({ SYSTEMONE_CLOUD_BASE_URL: base.trim() });
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">{t("systemone.field.cloudKey")}</span>
        <Input
          className={inputClass}
          type="password"
          value={key}
          placeholder={status?.cloudConfigured ? "••••••••" : "sk-…"}
          spellCheck={false}
          onChange={(event) => {
            setKey(event.target.value);
          }}
          onBlur={() => {
            if (!key.trim()) return;
            save.mutate({ SYSTEMONE_CLOUD_API_KEY: key.trim() });
            setKey("");
          }}
        />
        <span className="text-[10px] text-muted-foreground">
          {status?.cloudConfigured ? t("systemone.field.cloudKeySet") : t("systemone.field.cloudKeyHint")}
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">{t("jev.cloud.model")}</span>
        <Input
          className={inputClass}
          value={model}
          placeholder="jev-latest"
          spellCheck={false}
          onFocus={() => setEditing("model")}
          onChange={(event) => {
            setModel(event.target.value);
          }}
          onBlur={() => {
            setEditing(null);
            save.mutate({ SYSTEMONE_CLOUD_MODEL: model.trim() || "jev-latest" });
          }}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          disabled={discover.isPending}
          onClick={() => discover.mutate(undefined)}
        >
          {discover.isPending ? (
            <Loader2Icon className="size-3 animate-spin" aria-hidden />
          ) : (
            <SearchIcon className="size-3" aria-hidden />
          )}
          {t("systemone.discover")}
        </Button>
        <Button size="sm" variant="outline" className="gap-1" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : null}
          {t("systemone.test")}
        </Button>
      </div>
      <p className="text-[10px] leading-4 text-muted-foreground">{t("systemone.discover.hint")}</p>
      {discover.data ? <DiscoveryResult data={discover.data} onPickModel={pickModel} onPickBase={pickBase} /> : null}
      {test.data && !test.data.ok ? <p className="jev-note error">{t("systemone.test.failed", { message: test.data.message })}</p> : null}
      {test.data?.ok ? (
        <p className="jev-note ok">
          {t("systemone.test.ok", {
            model: test.data.model,
            backend: t(`systemone.backend.${test.data.backend}`),
            ms: String(test.data.latencyMs),
            noul: test.data.noul.toFixed(3),
          })}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 自动发现的结果
// ---------------------------------------------------------------------------

/** 把 token 数写短（1000000 → 1M）：模型行要在一行里放得下。 */
function formatTokens(value: number | undefined): string {
  if (!value) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function DiscoveredModelRow({
  model,
  onPick,
}: {
  model: SystemOneDiscovery["models"]["jev"][number];
  onPick: (name: string) => void;
}) {
  const t = useT();
  const hasContext = model.max_input_tokens !== undefined || model.max_output_tokens !== undefined;
  const detail = [model.description, model.release_date, model.owned_by].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className="flex w-full flex-col gap-0.5 rounded border px-2 py-1 text-left hover:bg-accent"
      onClick={() => onPick(model.name)}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px]">{model.name}</span>
        {hasContext ? (
          <span className="text-[10px] text-muted-foreground">
            {t("systemone.discover.context", {
              input: formatTokens(model.max_input_tokens),
              output: formatTokens(model.max_output_tokens),
            })}
          </span>
        ) : null}
      </span>
      {detail ? <span className="text-[10px] leading-4 text-muted-foreground">{detail}</span> : null}
    </button>
  );
}

/**
 * 发现结果，从"这地址到底能不能判定"往下读：
 *   1. 判定端点在不在 —— 模型清单再长，没有 `/v1/systemone` 也跑不了判定；
 *   2. 模型清单：判定模型在前，其它模型（多半是聊天模型）灰一档并写明未必能判定；
 *   3. 端点不在根路径上时列出候选子路径 —— 网关常把判定服务转发到 `/jev/<名字>`，
 *      一键换过去比让用户自己猜路径靠谱。
 * 点模型只填模型框，点候选只换地址，都不会自己改别的设置。
 */
function DiscoveryResult({
  data,
  onPickModel,
  onPickBase,
}: {
  data: SystemOneDiscovery;
  onPickModel: (name: string) => void;
  onPickBase: (base: string) => void;
}) {
  const t = useT();
  const endpointNote =
    data.systemone === "yes" ? "jev-note ok" : data.systemone === "forbidden" ? "jev-note" : "jev-note error";
  const endpointText =
    data.systemone === "unknown"
      ? t("systemone.discover.endpoint.unknown", { base: data.base, message: data.message || "—" })
      : t(`systemone.discover.endpoint.${data.systemone}`, { base: data.base });
  const jev = data.models.jev;
  const others = data.models.others;
  const nothing = jev.length === 0 && others.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <p className={endpointNote}>{endpointText}</p>

      {jev.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground">
            {t("systemone.discover.models", { n: String(jev.length) })}
          </span>
          {jev.map((model) => (
            <DiscoveredModelRow key={model.name} model={model} onPick={onPickModel} />
          ))}
        </div>
      ) : null}

      {others.length > 0 ? (
        <div className="flex flex-col gap-1 opacity-80">
          <span className="text-[10px] text-muted-foreground">
            {t("systemone.discover.others", { n: String(others.length) })}
          </span>
          {others.map((model) => (
            <DiscoveredModelRow key={model.name} model={model} onPick={onPickModel} />
          ))}
        </div>
      ) : null}

      {nothing ? (
        <p className="text-[10px] text-muted-foreground">
          {t("systemone.discover.empty", {
            note: data.message ? t("systemone.discover.note", { note: data.message }) : "",
          })}
        </p>
      ) : null}

      {data.candidates.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground">{t("systemone.discover.candidates")}</span>
          {data.candidates.map((candidate) => (
            <div key={candidate.base} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
              <span className="flex min-w-0 flex-col">
                {/* 地址长，列里放不下就截断 —— 悬停看全的那一份放 title 里。 */}
                <span className="truncate font-mono text-[11px]" title={candidate.base}>
                  {candidate.base}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {t(`systemone.discover.endpoint.${candidate.systemone}`, {
                    base: candidate.base,
                    message: candidate.note || "—",
                  })}
                </span>
              </span>
              <Button size="sm" variant="outline" className="h-6 shrink-0 text-[10px]" onClick={() => onPickBase(candidate.base)}>
                {t("systemone.discover.use")}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** JEV 本地运行时的现场：运行时状态 + 安装日志（按钮本身是共用的 `AgentDiagnoseButton`）。 */
function DiagnoseButton({
  status,
  error,
  logs,
}: {
  status: SystemOneAvailability;
  error: string;
  logs: string[];
}) {
  const t = useT();
  return (
    <AgentDiagnoseButton
      intro={t("jev.local.diagnosePrompt")}
      label={t("jev.local.diagnose")}
      error={error}
      context={[
        `平台：${navigator.platform || "macOS"}`,
        `本地运行时：${status.localRuntimeInstalled ? `已安装 ${status.localRuntimeVersion}` : "未安装"}`,
        `平台支持：${status.localRuntimeSupported ? "是" : "否"}`,
        `当前阶段：${status.localRuntimePhase}${status.localRuntimePhaseMessage ? ` (${status.localRuntimePhaseMessage})` : ""}`,
      ]}
      logs={logs}
    />
  );
}
