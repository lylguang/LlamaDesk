import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  XCircleIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  GlobeIcon,
  MonitorIcon,
  PlusIcon,
  Building2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Spinner } from "@ui/spinner";

import { REMOTE_PROVIDERS } from "./constants";
import { SetupHeader, ModeCard, SummaryRow } from "./shared";

type RemoteStep = "provider" | "credentials" | "test";

const CUSTOM_ID = "custom";

export function RemoteFlow({
  onComplete,
  onSwitchToLocal,
}: {
  onComplete: () => void;
  onSwitchToLocal: () => void;
}) {
  const [step, setStep] = useState<RemoteStep>("provider");
  // 选中的服务商 id：默认第一个国内服务商，仍可一键自定义。
  const [providerId, setProviderId] = useState<string>(REMOTE_PROVIDERS[0]!.id);
  const [baseUrl, setBaseUrl] = useState<string>(REMOTE_PROVIDERS[0]!.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [saveError, setSaveError] = useState("");
  const provider = REMOTE_PROVIDERS.find((p) => p.id === providerId);
  const isCustom = providerId === CUSTOM_ID;

  const pickProvider = (id: string) => {
    const chosen = REMOTE_PROVIDERS.find((p) => p.id === id);
    setProviderId(id);
    setBaseUrl(chosen?.baseUrl ?? "");
    // 只在用户还没填模型名时预填该服务商的第一个常见模型。
    if (chosen && chosen.models[0] && !modelName.trim()) {
      setModelName(chosen.models[0]);
    }
  };

  const testConnection = useMutation({
    mutationFn: () => rpcClient.checkConnection({ baseUrl, apiKey: apiKey || "EMPTY" }),
  });

  /**
   * 收尾：写进「模型云服务」的厂商表（内置厂商用预设行、自定义按地址复用），
   * 校验密钥后启用并激活。激活会把 baseUrl / apiKey / models 写回 VLLM_* 槽位，
   * 网关、CLI 与集成模型选择器照旧读旧键 —— 所以这里不再单独写那几个键。
   *
   * 从前只写 VLLM_* 的话，用户在引导页填过的 Key 到了设置页看起来仍是"没配过"，
   * 得重填第二遍：同一份凭据两个页面各存一份，就必然对不上。
   */
  const saveSettings = useMutation({
    mutationFn: async () => {
      setSaveError("");
      const res = await rpcClient.cloudProviderConfigure({
        providerId: isCustom ? undefined : providerId,
        baseUrl,
        apiKey,
        model: modelName.trim() || undefined,
      });
      if (!res.ok) return res;
      await rpcClient.updateSettings({ settings: { VLLM_MODEL_PROFILE: "none" } });
      return res;
    },
    onSuccess: (res) => {
      if (!res.ok) {
        setSaveError(res.error ?? "配置失败");
        return;
      }
      onComplete();
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : String(e)),
  });

  // 「下一步」在这一步不该有前置条件：自定义服务商的地址是在**下一步**填的，
  // 这里按 baseUrl 是否为空来禁用，等于选了自定义就再也点不动（只有一个"跳过"能出去）。
  const canProceedToTest = baseUrl.trim().length > 0 && modelName.trim().length > 0;
  const steps: RemoteStep[] = ["provider", "credentials", "test"];

  return (
    <>
      <SetupHeader
        title={
          step === "provider"
            ? "选择服务商"
            : step === "credentials"
              ? "填写 API Key"
              : "测试连接"
        }
        subtitle={
          step === "provider"
            ? "选择服务商后只需填入 API Key；自定义需手动填写 URL。"
            : step === "credentials"
              ? "填入服务商的 API Key（在服务商控制台获取）。"
              : "验证服务器是否可达。"
        }
        steps={steps}
        currentStep={step}
      />

      {step === "provider" && (
        <div className="flex flex-col gap-3">
          {/* 顶部仍是 Local / URL 的模式切换，保持入口一致 */}
          <div className="grid grid-cols-2 gap-2">
            <ModeCard
              icon={<MonitorIcon className="size-4" />}
              label="Local"
              description="Run llama-server locally"
              selected={false}
              onClick={onSwitchToLocal}
            />
            <ModeCard
              icon={<GlobeIcon className="size-4" />}
              label="URL"
              description="Connect to an API"
              selected
              onClick={() => {}}
            />
          </div>

          <div className="grid max-h-[42vh] grid-cols-1 gap-2 overflow-y-auto pr-1">
            {REMOTE_PROVIDERS.map((p) => {
              const selected = providerId === p.id;
              const isCustomOpt = p.id === CUSTOM_ID;
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-muted-foreground/40"
                  }`}
                  onClick={() => pickProvider(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") pickProvider(p.id);
                  }}
                >
                  <div
                    className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${
                      selected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isCustomOpt ? (
                      <PlusIcon className="size-4" />
                    ) : (
                      <Building2Icon className="size-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p.label}</span>
                      {p.vendor && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {p.vendor}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
                      {isCustomOpt ? "手动填写完整 Base URL" : p.baseUrl}
                    </p>
                    {p.note && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground/70">{p.note}</p>
                    )}
                  </div>
                  {selected && <CheckCircle2Icon className="mt-1 size-4 shrink-0 text-primary" />}
                </div>
              );
            })}
          </div>

          <Button onClick={() => setStep("credentials")}>
            下一步：填入 API Key
            <ArrowRightIcon />
          </Button>
          <Button variant="ghost" size="sm" className="self-center" onClick={onComplete}>
            跳过 — 直接进入应用
          </Button>
        </div>
      )}

      {step === "credentials" && (
        <div className="flex flex-col gap-3">
          {/* Base URL：只有自定义才需要手动输入 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider" className="text-xs">
              服务商
            </Label>
            <Select
              value={providerId}
              onValueChange={(v) => pickProvider(v)}
            >
              <SelectTrigger id="provider" className="h-8 w-full text-sm">
                <SelectValue placeholder="选择服务商" />
              </SelectTrigger>
              <SelectContent>
                {REMOTE_PROVIDERS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isCustom && (
              <p className="text-[11px] text-muted-foreground">
                已自动填入 {provider?.label} 的接口地址，可直接填写 Key。
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="apiKey" className="text-xs">
              API Key
              {/* 直达控制台的密钥页：别让用户自己去翻厂商官网找"API Key 在哪"} */}
              {!isCustom && provider?.apiKeyUrl && (
                <button
                  type="button"
                  className="ml-1.5 font-normal text-primary hover:underline"
                  onClick={() => void rpcClient.openGatewayDocs({ url: provider.apiKeyUrl! })}
                >
                  获取密钥
                </button>
              )}
            </Label>
            <Input
              id="apiKey"
              type="password"
              placeholder={isCustom ? "服务商的 API Key（可选）" : "粘贴你的 API Key"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="baseUrl" className="text-xs">
              Base URL
              {!isCustom && (
                <span className="ml-1 font-normal text-muted-foreground">（自动带出，不可修改）</span>
              )}
            </Label>
            {isCustom ? (
              <Input
                id="baseUrl"
                placeholder="http://your-server/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="h-8 text-sm font-mono"
              />
            ) : (
              <div
                className="flex h-8 items-center rounded-md border bg-muted/40 px-3 font-mono text-sm text-muted-foreground"
                title={baseUrl}
              >
                <span className="truncate">{baseUrl}</span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="modelName" className="text-xs">
              Model Name
            </Label>
            {!isCustom && provider!.models.length > 0 ? (
              <Select value={modelName} onValueChange={setModelName}>
                <SelectTrigger id="modelName" className="h-8 w-full text-sm">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {provider!.models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="modelName"
                placeholder="e.g. deepseek-chat"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                className="h-8 text-sm"
              />
            )}
            {isCustom && (
              <p className="text-[11px] text-muted-foreground">
                直接输入模型 ID，下拉选项适用于预置服务商。
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep("provider")}>
              <ArrowLeftIcon data-icon="inline-start" />
              上一步
            </Button>
            <Button className="flex-1" size="sm" disabled={!canProceedToTest} onClick={() => setStep("test")}>
              下一步：测试连接
              <ArrowRightIcon />
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="self-center" onClick={onComplete}>
            跳过 — 直接进入应用
          </Button>
        </div>
      )}

      {step === "test" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5 rounded-md bg-muted/50 px-3 py-2.5">
            <SummaryRow label="服务商" value={provider?.label ?? "自定义"} />
            <SummaryRow label="URL" value={baseUrl} />
            <SummaryRow label="Model" value={modelName} />
            <SummaryRow label="API Key" value={apiKey ? "••••••••" : "None"} />
          </div>

          {testConnection.isSuccess && (
            <div
              className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ${
                testConnection.data?.connected
                  ? "bg-primary/10 text-primary"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {testConnection.data?.connected ? (
                <>
                  <CheckCircle2Icon className="size-3.5 shrink-0" />
                  连接成功
                </>
              ) : (
                <>
                  <XCircleIcon className="size-3.5 shrink-0" />
                  连接失败 — 请检查 URL、Key 与服务商状态
                </>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep("credentials")}>
              <ArrowLeftIcon data-icon="inline-start" />
              上一步
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => testConnection.mutate()}
              disabled={testConnection.isPending}
            >
              {testConnection.isPending ? <Spinner data-icon="inline-start" /> : null}
              测试连接
            </Button>
          </div>

          <Button
            size="sm"
            onClick={() => saveSettings.mutate()}
            disabled={
              saveSettings.isPending || !testConnection.isSuccess || !testConnection.data?.connected
            }
          >
            {saveSettings.isPending && <Spinner data-icon="inline-start" />}
            开始使用
          </Button>
          {/* 收尾失败（密钥校验没过 / 写库出错）：把原因摆出来，别让按钮像没反应一样 */}
          {saveError && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <XCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">{saveError}</span>
            </p>
          )}
          <Button variant="ghost" size="sm" className="self-center" onClick={onComplete}>
            跳过 — 直接进入应用
          </Button>
        </div>
      )}
    </>
  );
}
