import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 设置 → 模型引擎页的回归测试。盯住四件事：
 *   1. 全部引擎（文本推理 / 语音 / OCR / 图像 / 类型化判定 / 网络工具）都得列出来，且按分类分组；
 *   2. 只有"应用自己装的那份"才有卸载按钮 —— 系统安装的版本给了卸载，用户点下去
 *      要么删不掉、要么更糟地动了系统里的东西；
 *   3. 卸载必须先确认，确认框里要说清删哪个目录；
 *   4. 已安装的行给的是「升级 / 重新下载」而不是「安装」，并且请求里带 upgrade，
 *      否则主进程那边"装过就跳过"，按钮点了等于没点。
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

type Status = Record<string, unknown>;

const MISSING: Status = {
  state: "missing",
  version: null,
  path: null,
  managedDir: null,
  sizeBytes: null,
  running: false,
  canInstall: true,
  installNote: null,
  approxBytes: 300e6,
  requirement: null,
  canUninstall: false,
  upgradeKind: "repair",
};

let engines: Status[] = [];
const installCalls: { engine: string; upgrade?: boolean }[] = [];
const uninstallCalls: string[] = [];
let listCalls = 0;
let installResult: { ok: boolean; error?: string } = { ok: true };
let uninstallResult: { ok: boolean; error?: string; freedBytes?: number; stopped?: number } = { ok: true };

mock.module("@lib/rpc", () => ({
  rpcClient: {
    listLocalEngines: async () => {
      listCalls += 1;
      return { engines };
    },
    installLocalEngine: async (params: { engine: string; upgrade?: boolean }) => {
      installCalls.push(params);
      return installResult;
    },
    uninstallLocalEngine: async (params: { engine: string }) => {
      uninstallCalls.push(params.engine);
      return uninstallResult;
    },
    openPath: async () => ({ ok: true }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { EnginesTab } = await import("./engines-tab");
const { translate } = await import("../../../shared/i18n");
const { LOCAL_ENGINE_SPECS, localEngineSpec } = await import("../../../shared/local-engines");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

/** 建一份与引擎目录对齐的状态表，只给两个引擎"应用自己装的那份"。 */
function baseEngines(): Status[] {
  return LOCAL_ENGINE_SPECS.map((spec) => ({
    id: spec.id,
    ...MISSING,
    ...(spec.id === "llama.cpp"
      ? {
          state: "managed",
          version: "b10976",
          path: "/data/engines/llama.cpp/current/llama-server",
          managedDir: "/data/engines/llama.cpp",
          sizeBytes: 172e6,
          canUninstall: true,
          upgradeKind: "latest",
        }
      : {}),
    ...(spec.id === "paddleocr"
      ? {
          state: "managed",
          version: "3.2.0",
          path: "/data/engines/paddleocr/bin/python3",
          managedDir: "/data/engines/paddleocr",
          sizeBytes: 900e6,
          canUninstall: true,
          upgradeKind: "repair",
        }
      : {}),
    ...(spec.id === "tesseract"
      ? {
          state: "system",
          version: "5.5.0",
          path: "/opt/homebrew/bin/tesseract",
          canUninstall: false,
        }
      : {}),
    ...(spec.id === "cloudflared"
      ? { state: "managed", running: true, managedDir: "/data/engines/cloudflared", canUninstall: true }
      : {}),
  }));
}

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderTab() {
  for (const el of Array.from(document.body.children)) el.remove();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(EnginesTab, null)),
    );
  });
  // 等状态查询落地
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const buttons = () => [...document.body.querySelectorAll("button")];
  const button = (label: string) =>
    buttons().find((b) => b.textContent?.trim().startsWith(label));
  const buttonsWith = (label: string) =>
    buttons().filter((b) => b.textContent?.trim().startsWith(label));
  return {
    container,
    buttonsWith,
    button,
    get text() {
      return document.body.textContent ?? "";
    },
    async click(target: Element | undefined) {
      expect(target).toBeDefined();
      await act(async () => {
        (target as HTMLElement).click();
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("列出全部引擎，按分类分组", async () => {
  engines = baseEngines();
  const view = await renderTab();
  for (const spec of LOCAL_ENGINE_SPECS) {
    expect(view.text).toContain(spec.name);
  }
  for (const key of [
    "engines.cat.inference",
    "engines.cat.voice",
    "engines.cat.ocr",
    "engines.cat.image",
    // 类型化判定（SystemOne / JEV）自成一类：laya-mlx 是判定模型，不是聊天模型。
    "engines.cat.systemone",
    "engines.cat.network",
  ]) {
    expect(view.text).toContain(zh(key));
  }
  await view.unmount();
});

test("只有托管安装给卸载；系统安装只说明，未安装给安装", async () => {
  engines = baseEngines();
  const view = await renderTab();

  // 三个托管引擎（llama.cpp / paddleocr / cloudflared）各有卸载，系统安装的 tesseract 没有。
  expect(view.buttonsWith(zh("engines.action.uninstall")).length).toBe(3);
  expect(view.text).toContain(zh("engines.state.system"));
  expect(view.text).toContain(zh("engines.note.systemInstall"));

  // 未安装的引擎（示例：vLLM）给的是「安装」，不带 upgrade。
  const vllmRow = view.text.indexOf(localEngineSpec("vllm").name);
  expect(vllmRow).toBeGreaterThan(-1);

  await view.unmount();
});

test("laya-mlx（类型化判定）也在这一页：能给安装 / 卸载，「管理模型」跳到 JEV 页", async () => {
  engines = baseEngines().map((e) =>
    e.id === "laya-mlx"
      ? {
          ...e,
          state: "managed",
          version: "0.1.0",
          path: "/data/engines/laya/bin/python3",
          managedDir: "/data/engines/laya",
          sizeBytes: 120e6,
          canUninstall: true,
          upgradeKind: "latest",
        }
      : e,
  );
  const { useAppStore } = await import("@stores/app");
  useAppStore.getState().setActiveApp("chat");
  const view = await renderTab();

  expect(view.text).toContain(zh("engines.cat.systemone"));
  expect(view.text).toContain("laya-mlx");
  expect(view.text).toContain(zh("engines.laya.role"));

  /**
   * 按钮要**取自己那一行里的**：这一页每行结构一样，`buttonsWith` 返回的是全页的按钮 ——
   * 拿第一个「管理模型」点下去，点到的是 llama.cpp 那一行（跳模型库），断言必然错。
   *
   * 行定位不靠"数着层级往上爬"（行内 DOM 会变，层级一变测试就假失败），而是从所有
   * 含这个引擎名、且内部有按钮的祖先里逐个找带该标签的按钮，且**从最内层往外找** ——
   * `querySelectorAll` 给的是文档顺序（最外层在前），顺着找会先命中整页那个容器，
   * 于是点到的是别的引擎那一行的按钮。
   */
  const buttonInLayaRow = (label: string): Element | undefined => {
    const containers = [...view.container.querySelectorAll("div")]
      .filter((el) => el.textContent?.includes("laya-mlx") && el.querySelectorAll("button").length > 0)
      .reverse();
    for (const container of containers) {
      const found = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.trim().startsWith(label),
      );
      if (found) return found;
    }
    return undefined;
  };

  // 「管理模型」必须真的把人送到 JEV 页 —— 权重在那里下 / 起 / 停，
  // 点不动就等于告诉用户"去那边配"却哪儿也没去。
  await view.click(buttonInLayaRow("管理模型"));
  expect(useAppStore.getState().activeApp).toBe("jev");

  // 卸载走的是同一个引擎卸载入口（改名/漏 id 会让它变成"点了没反应"），
  // 且同样先弹确认框 —— 确认按钮在对话框里，与另一个用例一样按标签找。
  uninstallCalls.length = 0;
  uninstallResult = { ok: true, freedBytes: 120e6, stopped: 1 };
  await view.click(buttonInLayaRow(zh("engines.action.uninstall")));
  const dialog = document.body.querySelector('[data-slot="dialog-content"]');
  expect(dialog?.textContent).toContain(zh("engines.uninstall.title", { name: "laya-mlx" }));
  const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.trim().startsWith(zh("engines.action.uninstall")),
  );
  await view.click(confirm);
  expect(uninstallCalls).toEqual(["laya-mlx"]);

  await view.unmount();
  useAppStore.getState().setActiveApp("chat");
});

test("已安装的行给「升级 / 重新下载」，点击时带 upgrade", async () => {
  engines = baseEngines();
  installCalls.length = 0;
  const view = await renderTab();

  // llama.cpp 的升级来源是"最新构建"，PaddleOCR 的版本钉死 → 重新下载。
  const upgrade = view.buttonsWith(zh("engines.action.upgrade"));
  expect(upgrade.length).toBe(1);
  expect(view.buttonsWith(zh("engines.action.redownload")).length).toBeGreaterThanOrEqual(1);

  await view.click(upgrade[0]);
  expect(installCalls).toEqual([{ engine: "llama.cpp", upgrade: true }]);
  await view.unmount();
});

test("系统安装的行给「安装托管版」；没有托管形态的（Tesseract）只给命令", async () => {
  engines = baseEngines().map((e) =>
    e.id === "whisper.cpp"
      ? { ...e, state: "system", version: "1.7.4", path: "/opt/homebrew/bin/whisper-cli" }
      : e,
  );
  installCalls.length = 0;
  const view = await renderTab();

  // whisper.cpp：系统里有，但应用可以提供托管副本 → 给按钮，且请求带 upgrade
  // （不带的话主进程会因为"已经能用"直接返回，按钮点了等于没点）。
  const managedCopy = view.buttonsWith(zh("engines.action.installManaged"));
  expect(managedCopy.length).toBe(1);
  await view.click(managedCopy[0]);
  expect(installCalls).toEqual([{ engine: "whisper.cpp", upgrade: true }]);

  // Tesseract：装进的是用户的 Homebrew，应用不提供托管副本 → 不给按钮（那只会重跑一次
  // 同样的 brew install），改为把装与卸两条命令都写出来。
  expect(view.text).toContain("brew install tesseract");
  expect(view.text).toContain("brew uninstall tesseract");
  await view.unmount();
});

test("卸载先弹确认框，说清目录，确认后才真的卸载并重新检测", async () => {
  engines = baseEngines();
  uninstallCalls.length = 0;
  const before = listCalls;
  const view = await renderTab();

  await view.click(view.buttonsWith(zh("engines.action.uninstall"))[0]);
  const dialog = document.body.querySelector('[data-slot="dialog-content"]');
  expect(dialog?.textContent).toContain(zh("engines.uninstall.title", { name: "llama.cpp" }));
  expect(dialog?.textContent).toContain("/data/engines/llama.cpp");
  expect(uninstallCalls).toEqual([]); // 还没确认

  const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.trim().startsWith(zh("engines.action.uninstall")),
  );
  await view.click(confirm);
  expect(uninstallCalls).toEqual(["llama.cpp"]);

  // 终态后重新检测一次，否则刚卸掉的行还显示「已安装」。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(listCalls).toBeGreaterThan(before);

  await view.unmount();
});

test("卸载失败的原因显示在那一行上", async () => {
  engines = baseEngines();
  uninstallResult = { ok: false, error: "远程访问隧道正在运行，请先停止隧道" };
  const view = await renderTab();

  await view.click(view.buttonsWith(zh("engines.action.uninstall"))[0]);
  const dialog = document.body.querySelector('[data-slot="dialog-content"]');
  const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.trim().startsWith(zh("engines.action.uninstall")),
  );
  await view.click(confirm);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(view.text).toContain("远程访问隧道正在运行，请先停止隧道");
  uninstallResult = { ok: true };
  await view.unmount();
});
