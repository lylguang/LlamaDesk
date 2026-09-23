import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 引导页「URL 模式」的回归：内置厂商只填 Key，地址不给填，落库落进厂商表。
 *
 * 三件事：
 *   1. 内置厂商的 Base URL 是只读文本（不是输入框）—— 地址由应用维护；
 *   2. 「开始使用」走 `cloudProviderConfigure`（带 providerId / key / model），
 *      而不是只往 VLLM_* 老槽位写一份 —— 只写槽位的话，用户在引导页填过的 Key
 *      到了「模型云服务」页看起来仍是"没配过"，得重填第二遍；
 *   3. 落库/校验失败时把原因显出来、不进入应用（按钮不能像没反应一样）。
 *
 * 另外钉住一条走不通的路：选「自定义」时地址是在**下一步**填的，第一步的「下一步」
 * 不能因为地址为空就禁用 —— 那样选了自定义就再也点不动，只有"跳过"能出去。
 */
const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "SVGElement",
  "DOMRect",
  "CustomElementRegistry",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "InputEvent",
  "MutationObserver",
  "ResizeObserver",
  "NodeFilter",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "matchMedia",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 落库结果：单个用例可改成失败。 */
let configureResult: { ok: boolean; id?: string; error?: string } = { ok: true, id: "deepseek" };
const configureCalls: Record<string, unknown>[] = [];
const settingsWrites: Record<string, string>[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    checkConnection: async () => ({ connected: true }),
    cloudProviderConfigure: async (params: Record<string, unknown>) => {
      configureCalls.push(params);
      return configureResult;
    },
    updateSettings: async ({ settings }: { settings: Record<string, string> }) => {
      settingsWrites.push(settings);
      return { ok: true };
    },
    openGatewayDocs: async () => ({ ok: true }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RemoteFlow } = await import("./remote-flow");

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

afterEach(() => {
  document.body.innerHTML = "";
  configureCalls.length = 0;
  settingsWrites.length = 0;
  configureResult = { ok: true, id: "deepseek" };
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickText(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`找不到按钮「${text}」`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickProviderRow(label: string) {
  const row = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find((el) =>
    el.textContent?.includes(label),
  );
  if (!row) throw new Error(`找不到服务商「${label}」`);
  await act(async () => {
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 填密码框（React 的 value tracker 会吞掉直接赋值，得走原生 setter）。 */
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderFlow() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let completed = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RemoteFlow, { onComplete: () => (completed += 1), onSwitchToLocal: () => {} }),
      ),
    );
  });
  await settle();
  return {
    completed: () => completed,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("内置厂商：地址只读、模型按预设带出，「开始使用」落进厂商表", async () => {
  const view = await renderFlow();

  // 选一家内置厂商（列表直接摆着，不用先"添加"）
  await clickProviderRow("DeepSeek");
  await clickText("下一步：填入 API Key");

  // 地址是只读文本：页面上没有哪个输入框里装着这个地址
  const base = "https://api.deepseek.com/v1";
  expect(document.body.textContent).toContain(base);
  const editable = [...document.querySelectorAll<HTMLInputElement>("input")].filter(
    (i) => i.value === base,
  );
  expect(editable).toHaveLength(0);
  // 模型按预设带出：只要填 Key 就能走完
  expect(document.body.textContent).toContain("deepseek-chat");

  const key = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  await typeInto(key, "sk-setup");
  await clickText("下一步：测试连接");
  await clickText("测试连接");
  await settle();
  await clickText("开始使用");
  await settle();

  // 落进厂商表（内置厂商用预设行）+ 校验密钥 + 激活
  expect(configureCalls).toEqual([
    { providerId: "deepseek", baseUrl: base, apiKey: "sk-setup", model: "deepseek-chat" },
  ]);
  // 流程不再自己写 VLLM_* 槽位（激活时由主进程写回），这里只留模型后处理档位
  expect(settingsWrites).toEqual([{ VLLM_MODEL_PROFILE: "none" }]);
  expect(view.completed()).toBe(1);
  await view.cleanup();
});

test("自定义服务商：地址要自己填，落库时带上地址（没有 providerId）", async () => {
  const view = await renderFlow();

  await clickProviderRow("自定义");
  await clickText("下一步：填入 API Key");

  const inputs = [...document.querySelectorAll<HTMLInputElement>("input")];
  const baseInput = inputs.find((i) => i.placeholder === "http://your-server/v1")!;
  expect(baseInput).toBeDefined();
  await typeInto(baseInput, "https://relay.example/v1");
  await typeInto(document.querySelector<HTMLInputElement>('input[type="password"]')!, "sk-relay");
  const modelInput = document.querySelector<HTMLInputElement>("#modelName")!;
  await typeInto(modelInput, "qwen-max");

  await clickText("下一步：测试连接");
  await clickText("测试连接");
  await settle();
  await clickText("开始使用");
  await settle();

  expect(configureCalls).toEqual([
    { providerId: undefined, baseUrl: "https://relay.example/v1", apiKey: "sk-relay", model: "qwen-max" },
  ]);
  expect(view.completed()).toBe(1);
  await view.cleanup();
});

test("落库失败：把原因显示出来，不进入应用（按钮不能像没反应）", async () => {
  configureResult = { ok: false, error: "密钥无效或没有权限（HTTP 401）" };
  const view = await renderFlow();

  await clickProviderRow("DeepSeek");
  await clickText("下一步：填入 API Key");
  await typeInto(document.querySelector<HTMLInputElement>('input[type="password"]')!, "sk-bad");
  await clickText("下一步：测试连接");
  await clickText("测试连接");
  await settle();
  await clickText("开始使用");
  await settle();

  expect(view.completed()).toBe(0);
  expect(document.body.textContent).toContain("密钥无效或没有权限（HTTP 401）");
  await view.cleanup();
});
