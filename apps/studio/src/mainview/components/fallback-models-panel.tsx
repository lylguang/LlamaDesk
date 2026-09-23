import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoyIcon, PlusIcon, XIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { classifyModelName, MODEL_CATEGORY_SETS, type ModelCategory } from "@/shared/modelscope";

/**
 * 备选模型链（PERF-03）的控制台入口。
 *
 * 默认模型起不来时（架构不认识 / 权重没下完 / 显存不够）应用会自动改用这里的下一个，
 * 并在通知中心说明；这张卡片就是那条链的编辑处。
 *
 * 单独一张卡而不是塞进「启动参数」里，是因为它不是一个参数：它管的是**多挂一个模型**
 * 当保险，顺序有意义（从上往下试），而且只在失败时才起作用。
 */
export function FallbackModelsPanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const [pick, setPick] = useState("");

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const { data: modelsData } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  const chain = useMemo(() => {
    const raw = settingsData?.settings?.SERVER_FALLBACK_MODELS ?? "";
    return raw
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }, [settingsData]);

  // 只有对话类的 GGUF / safetensors 能当推理服务器跑（和启动器同一套过滤）。
  const options = useMemo(
    () =>
      (modelsData?.models ?? []).filter((m) => {
        const category: ModelCategory = m.category ?? classifyModelName(m.fileName);
        const isChat = MODEL_CATEGORY_SETS.chat.includes(category) || category === "other";
        return isChat && (m.kind === "gguf" || m.kind === "safetensors");
      }),
    [modelsData],
  );

  const save = useMutation({
    mutationFn: (next: string[]) =>
      rpcClient.updateSettings({ settings: { SERVER_FALLBACK_MODELS: next.join(",") } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const add = (value: string) => {
    const target = value.trim();
    if (!target || chain.includes(target)) return;
    save.mutate([...chain, target]);
    setPick("");
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <LifeBuoyIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        <span className="text-xs font-medium">{t("console.fallback.title")}</span>
        <span className="text-[11px] text-muted-foreground/70">{t("console.fallback.hint")}</span>
      </div>

      {chain.length > 0 && (
        <ol className="flex flex-col gap-1">
          {chain.map((item, index) => (
            <li key={item} className="flex items-center gap-2 text-[11px]">
              <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground/60">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 break-all font-mono text-muted-foreground">
                {item}
              </span>
              <Button
                variant="ghost"
                size="xs"
                tooltip={t("console.fallback.remove")}
                disabled={save.isPending}
                onClick={() => save.mutate(chain.filter((entry) => entry !== item))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={pick} onValueChange={setPick}>
          <SelectTrigger className="h-8 max-w-[320px] text-xs">
            <SelectValue placeholder={t("console.fallback.pick")} />
          </SelectTrigger>
          <SelectContent>
            {options.map((m) => (
              <SelectItem key={m.path} value={m.path}>
                {m.fileName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="xs" disabled={!pick || save.isPending} onClick={() => add(pick)}>
          <PlusIcon data-icon="inline-start" />
          {t("console.fallback.add")}
        </Button>
      </div>
    </div>
  );
}
