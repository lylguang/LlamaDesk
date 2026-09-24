import { join } from "path";
import { existsSync } from "fs";
import { Database } from "bun:sqlite";
import { findLiveDataDir, resolveDataDir } from "./data-dir";

type AppModules = {
  modelStore: typeof import("../bun/model-store");
  settings: typeof import("../bun/db/settings");
  cloudProviders: typeof import("../bun/cloud-providers");
};

let loaded: AppModules | null = null;

/**
 * 跳过迁移后，"库还没建好"就不再被自动修好 —— 与其让调用方拿到一句
 * `no such table: settings`，不如在这里说清楚该做什么。
 */
function assertDbReady(dataDir: string): void {
  const dbFile = join(dataDir, "omni-studio.db");
  if (!existsSync(dbFile)) {
    throw new Error(
      `这个数据目录还没有数据库：${dbFile}\n` +
        `先启动一次 OmniStudio（数据库由应用创建并迁移），\`omi\` 不会替它建库。`,
    );
  }
  let tables = 0;
  try {
    const probe = new Database(dbFile, { readonly: true });
    const row = probe
      .query("select count(*) as c from sqlite_master where type='table' and name='settings'")
      .get() as { c?: number } | null;
    tables = Number(row?.c ?? 0);
    probe.close();
  } catch {
    // 打不开（被锁 / 损坏）时把问题留给后面的读取报错，这里不回滚成"没建库"。
    return;
  }
  if (tables === 0) {
    throw new Error(
      `数据库还没有初始化（${dbFile}）。请先启动一次 OmniStudio 完成建库与迁移 —— ` +
        `\`omi\` 只读这份库，不会替应用跑迁移。`,
    );
  }
}

/**
 * 应用未运行时的本地兜底：直接 import 主进程的 bun 模块读写同一份 SQLite。
 * 必须先设置 `OMNI_DATA_DIR` / `OMNI_DB_PATH`，这样 `db/index.ts` 不会去
 * 触碰 electrobun 的 `Utils.paths`（这正是路径抽象预留给独立进程的用法）。
 *
 * 数据目录优先取**正在运行的那个实例**（真的 ping 出来的），
 * 否则取显式指定 / 最近用过的那份。
 */
async function appModules(): Promise<AppModules> {
  if (loaded) return loaded;
  const dataDir = (await findLiveDataDir()) ?? resolveDataDir();
  process.env.OMNI_DATA_DIR = dataDir;
process.env.OMNI_DB_PATH = join(dataDir, "llama-desk.db");
  // 关键：CLI 只是"读设置 / 模型"，**不迁移**这个库。
  // 迁移的判定标准是"库里已应用的 when" vs "当前构建 journal 的 when"，而同一个库会被
  // 安装版和你仓库里这份源码分别打开，两份 journal 的时间戳并不一致（历史上有一批迁移
  // 被写成伪造的递增戳）—— 任一方跑一次迁移，另一方下次启动就会重跑建表并崩在
  // `table already exists`，也就是"跑过一次 omi / 更新完之后再也打不开"。
  // 迁移与自愈是**应用**的职责（它知道自己是哪一版，起不来时也该由它提示）——
  // 见 bun/db/index.ts 的 OMNI_SKIP_MIGRATIONS。
  process.env.OMNI_SKIP_MIGRATIONS ??= "1";
  assertDbReady(dataDir);
  const [modelStore, settings, cloudProviders] = await Promise.all([
    import("../bun/model-store"),
    import("../bun/db/settings"),
    import("../bun/cloud-providers"),
  ]);
  // 数据层已经加载了，顺手按设置接上代理：CLI 的远端备份 / 版本检查等请求也认它
  // （见 bun/proxy.ts）。放在这里而不是入口，是为了不把数据层拖进 `omi backup`。
  const { installProxy } = await import("../bun/proxy");
  installProxy();
  loaded = { modelStore, settings, cloudProviders };
  return loaded;
}

export async function listInstalledModelsFallback(): Promise<ReturnType<typeof import("../bun/model-store")["listInstalledModels"]>> {
  const { modelStore } = await appModules();
  return modelStore.listInstalledModels();
}

export async function getAllSettingsFallback(): Promise<Record<string, string>> {
  const { settings } = await appModules();
  return settings.getAllSettings();
}

export async function updateSettingsFallback(values: Record<string, string>): Promise<void> {
  const { settings } = await appModules();
  settings.updateSettings(values);
}

export async function setActiveModelFallback(path: string): Promise<{ ok: boolean; error?: string }> {
  const { modelStore } = await appModules();
  const r = modelStore.setActiveModel(path);
  return { ok: r.ok, error: r.error };
}

export async function activeModelPathFallback(): Promise<string> {
  const { modelStore } = await appModules();
  return modelStore.getActiveModelPath();
}

/** 本地模型路径 → 服务名：与主进程 setActiveModel 写入 LOCAL_MODEL_NAME 的解析一致。 */
export async function servedNameForModelPathFallback(path: string): Promise<string> {
  const { modelStore } = await appModules();
  return modelStore.servedNameForModelPath(path);
}

/** 云服务商全表 + 当前激活项（与控制通道 `cloudProviders` 同一份数据）。 */
export async function cloudProvidersFallback(): Promise<
  ReturnType<typeof import("../bun/cloud-providers")["listCloudProviders"]>
> {
  const { cloudProviders } = await appModules();
  return cloudProviders.listCloudProviders();
}

/** 切换默认（激活）云服务商：网关只往它发云端请求。 */
export async function activateCloudProviderFallback(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const { cloudProviders } = await appModules();
  return cloudProviders.activateCloudProvider(id);
}
