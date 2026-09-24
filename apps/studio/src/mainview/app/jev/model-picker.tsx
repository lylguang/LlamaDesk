/**
 * 侧栏顶部的判定模型选择：本地部署 / 云端 API，以及具体用哪个模型。
 *
 * 为什么放侧栏而不是只留在主区的「判定引擎」面板里：判定台和游乐场都在用同一个
 * 模型，而"现在跑的是哪个模型"是看结果时最先要确认的事 —— 尤其是同一台网关后面
 * 挂着好几个判定服务（实测过同一套请求在不同模型上，一个 8 步走到终点、一个 20 步
 * 全撞墙）。选择写的就是 `SYSTEMONE_BACKEND` / `SYSTEMONE_*_MODEL`，和主区面板
 * 改的是同一份设置，两处永远一致。
 *
 * 云端的模型清单来自「自动发现」：读一遍 Base URL 上的 `/v1/models`。发现不到
 * （地址没配、Key 没放行）就退回内置的官方模型名，至少不会只剩一个空下拉。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudIcon, CpuIcon, Loader2Icon, SearchIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useJevStore, type JevEngineTab } from "@stores/jev";
import { useT } from "@stores/ui-lang";
import { Button } from "@ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { cn } from "@/mainview/lib/utils";

/**
 * 地址 → 一句能分辨的出处。
 *
 * 取路径（`http://host:38003/jev/openjev-27b` → `/jev/openjev-27b`）：同一台网关
 * 上的几个判定服务只有路径不同，而 host 每条都一样，写出来反而把真正的差别挤掉。
 * 根路径上的服务没有路径可取，那就退回 host。
 */
export function pathHint(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "");
    return path && path !== "/" ? path : url.host;
  } catch {
    return trimmed;
  }
}

/** tab → 后端设置值（和主区面板同一套映射）。 */
const BACKEND_FOR_TAB: Record<JevEngineTab, string> = { local: "local", cloud: "cloud" };

export function JevModelPicker() {
  const t = useT();
  const queryClient = useQueryClient();
  const tab = useJevStore((s) => s.engineTab);
  const setTab = useJevStore((s) => s.setEngineTab);
  const status = useQuery({ queryKey: ["systemone", "status"], queryFn: () => rpcClient.systemoneStatus(undefined) });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => rpcClient.getSettings(undefined) });

  const cloudBaseSetting = settings.data?.settings.SYSTEMONE_CLOUD_BASE_URL ?? "";

  const save = useMutation({
    mutationFn: (patch: Record<string, string>) => rpcClient.updateSettings({ settings: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["systemone", "status"] });
    },
  });
  /*
   * 发现改成**进这一页就自动跑**（以前要手动点按钮）。
   *
   * 不自动跑的时候，清单里只剩内置的那三个官方模型名，小字一律是「内置清单」——
   * 三条长得一模一样，等于没写；而真正能分辨的路径（/jev/openjev、/jev/laya…）
   * 要点一下按钮才出现。地址变了就重新发现（地址在 queryKey 里），结果缓存五分钟，
   * 按钮留着做手动刷新。
   */
  const discover = useQuery({
    queryKey: ["systemone", "discover", cloudBaseSetting],
    queryFn: () => rpcClient.systemoneDiscover(undefined),
    enabled: tab === "cloud" && !!cloudBaseSetting,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const cloudModel = settings.data?.settings.SYSTEMONE_CLOUD_MODEL ?? "";
  const localModel = settings.data?.settings.SYSTEMONE_LOCAL_MODEL ?? "";
  const cloudBase = cloudBaseSetting;
  const current = tab === "cloud" ? cloudModel : localModel;

  /**
   * 候选清单。每条都带一句**出处**，因为模型名撞车是常态：同一台网关后面挂着
   * 三个判定服务，它们全都自称 `jev-latest` —— 只看名字根本分不出点的是哪一个。
   * 出处取地址里的路径（`/jev/openjev-27b`），它正好是这几个服务之间唯一的差别。
   *
   * 选了别的地址下的模型，就连地址一起切过去：不然点了个"看起来对"的名字，
   * 跑的还是原来那台服务。
   */
  const options = (() => {
    const out: { key: string; name: string; hint: string; base?: string }[] = [];
    const seen = new Set<string>();
    const add = (name: string, hint: string, base?: string) => {
      const key = `${base ?? ""}|${name}`;
      if (!name || seen.has(key)) return;
      seen.add(key);
      out.push({ key, name, hint, base });
    };
    if (tab === "cloud") {
      // 当前地址上发现到的（不带 base：就是现在这台，不用切）。
      const here = pathHint(discover.data?.base ?? cloudBase);
      for (const model of discover.data?.models.jev ?? []) add(model.name, here);
      for (const model of discover.data?.models.others ?? []) add(model.name, here);
      // 同一台网关上别的子路径：带 base，选中就一起切过去。
      for (const candidate of discover.data?.candidates ?? []) {
        for (const model of candidate.models) add(model.name, pathHint(candidate.base), candidate.base);
      }
      /*
       * 内置的官方模型名只在**发现不出东西**时兜底（地址没配、Key 没放行、这台
       * 机器不认这套协议）。发现成功还混进来的话，清单里会多出三条小字一律写着
       * 「内置清单」的同名条目 —— 那正是分不清模型的由来。
       */
      if (out.length === 0) {
        for (const model of status.data?.models ?? []) {
          if (model.backend === "cloud") add(model.name, t("jev.picker.builtin"));
        }
      }
      if (current) add(current, here);
    } else {
      for (const model of status.data?.localModels ?? []) add(model.name, model.weights);
      for (const model of status.data?.models ?? []) {
        if (model.backend === "local") add(model.name, model.weights ?? t("jev.picker.builtin"));
      }
      if (current) add(current, t("jev.picker.builtin"));
    }
    return out;
  })();

  const currentKey = options.find((option) => option.name === current && !option.base)?.key ?? `|${current}`;

  const pickModel = async (key: string) => {
    const option = options.find((item) => item.key === key);
    if (!option) return;
    if (tab !== "cloud") {
      save.mutate({ SYSTEMONE_LOCAL_MODEL: option.name });
      return;
    }
    await save.mutateAsync({
      SYSTEMONE_CLOUD_MODEL: option.name,
      // 选的是别的子路径上的模型：地址也得跟着换，否则等于没换。
      ...(option.base ? { SYSTEMONE_CLOUD_BASE_URL: option.base } : {}),
    });
    // 地址在 queryKey 里，换了地址会自己重新发现，这里不用手动触发。
  };

  const pickTab = (next: JevEngineTab) => {
    setTab(next);
    save.mutate({ SYSTEMONE_BACKEND: BACKEND_FOR_TAB[next] });
  };

  return (
    <div className="flex flex-none flex-col gap-1.5 px-2 pt-2">
      <span className="px-0.5 text-[11px] font-semibold text-muted-foreground">{t("jev.picker.title")}</span>

      <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist">
        {(["local", "cloud"] as JevEngineTab[]).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={cn(
              "flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors",
              tab === value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => pickTab(value)}
          >
            {value === "local" ? <CpuIcon className="size-3" aria-hidden /> : <CloudIcon className="size-3" aria-hidden />}
            {t(value === "local" ? "jev.picker.local" : "jev.picker.cloud")}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <Select value={current ? currentKey : undefined} onValueChange={(key) => void pickModel(key)}>
          <SelectTrigger className="h-7 min-w-0 flex-1 text-[11px]">
            <SelectValue placeholder={t("jev.picker.placeholder")} />
          </SelectTrigger>
          <SelectContent className="max-w-80">
            {options.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-mono text-[11px]">{option.name}</span>
                  {/* 出处：同名模型之间唯一分得开的东西。 */}
                  <span className="truncate font-mono text-[10px] text-muted-foreground">{option.hint}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {tab === "cloud" ? (
          <Button
            size="sm"
            variant="outline"
            className="size-7 flex-none p-0"
            title={t("systemone.discover")}
            aria-label={t("systemone.discover")}
            disabled={discover.isFetching}
            onClick={() => void discover.refetch()}
          >
            {discover.isFetching ? (
              <Loader2Icon className="size-3 animate-spin" aria-hidden />
            ) : (
              <SearchIcon className="size-3" aria-hidden />
            )}
          </Button>
        ) : null}
      </div>

      {/* 当前打的是哪台：模型名分不出来，地址分得出来。 */}
      {tab === "cloud" && cloudBase ? (
        <span className="truncate px-0.5 font-mono text-[10px] text-muted-foreground" title={cloudBase}>
          {pathHint(cloudBase)}
        </span>
      ) : null}

      {/* 选了云端却还没配 Key，这里先说一声 —— 否则要等到跑出 403 才知道。 */}
      {tab === "cloud" && status.data && !status.data.cloudConfigured ? (
        <span className="px-0.5 text-[10px] leading-4 text-muted-foreground">{t("jev.picker.needKey")}</span>
      ) : null}
    </div>
  );
}
