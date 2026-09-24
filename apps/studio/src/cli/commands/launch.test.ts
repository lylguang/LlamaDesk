import { describe, expect, test } from "bun:test";

import {
  chatgptConfigText,
  chatgptModelsJson,
  codexCatalogJson,
  codexProfileToml,
  pickCloudModelFor,
  pickInstructionsTemplate,
  stripChatgptConfig,
} from "./launch";
import type { CloudModelRef } from "./models";

const ref = (
  id: string,
  providerId: string,
  opts: Partial<CloudModelRef> = {},
): CloudModelRef => ({
  id,
  providerId,
  providerName: opts.providerName ?? providerId,
  enabled: opts.enabled ?? true,
  active: opts.active ?? false,
  hasKey: opts.hasKey ?? true,
});

/**
 * `omi launch <工具> --model <云模型 id>` 挑厂商的决策表。
 *
 * 真实现场：`deepseek-v4.1` 属于已启用的「Omin」，但默认厂商是「OmniLabs」——
 * 旧实现只比对默认厂商的模型槽位（`CLOUD_MODELS`），直接报「未找到模型」，
 * 而 GUI 的模型选择器里这个模型明明列着、选一下就能用。
 */
describe("--model 指定云模型时挑哪一家", () => {
  test("模型属于默认厂商：直接命中，不用切", () => {
    const refs = [ref("deepseek-v4-flash", "omnilabs", { active: true }), ref("deepseek-v4.1", "omin")];
    expect(pickCloudModelFor(refs, "deepseek-v4.1")).toEqual({
      hit: ref("deepseek-v4.1", "omin"),
      disabled: undefined,
    });
  });

  test("模型属于已启用但不是默认的厂商：命中（调用方据此把默认厂商切过去）", () => {
    const refs = [ref("deepseek-v4-flash", "omnilabs", { active: true }), ref("deepseek-v4.1", "omin")];
    expect(pickCloudModelFor(refs, "deepseek-v4-flash").hit?.providerId).toBe("omnilabs");
    expect(pickCloudModelFor(refs, "deepseek-v4.1").hit?.active).toBe(false);
  });

  test("同名模型在多家：默认厂商优先", () => {
    const refs = [
      ref("gpt-5", "a", { active: true }),
      ref("gpt-5", "b"),
    ];
    expect(pickCloudModelFor(refs, "gpt-5").hit?.providerId).toBe("a");
  });

  test("默认厂商没有、已启用厂商有：选已启用的那家", () => {
    const refs = [
      ref("gpt-5", "disabled-one", { enabled: false }),
      ref("gpt-5", "enabled-one", { active: false }),
    ];
    expect(pickCloudModelFor(refs, "gpt-5").hit?.providerId).toBe("enabled-one");
  });

  test("厂商已停用：不命中，但把厂商带出来 —— 报错要说清「模型在，只是该厂商没启用」", () => {
    const refs = [ref("deepseek-v4.1", "omin", { enabled: false, providerName: "Omin" })];
    const picked = pickCloudModelFor(refs, "deepseek-v4.1");
    expect(picked.hit).toBeUndefined();
    expect(picked.disabled?.providerName).toBe("Omin");
  });

  test("完全没有这个模型：既没命中也没有停用线索（走「未找到」分支）", () => {
    const refs = [ref("deepseek-v4-flash", "omnilabs", { active: true })];
    expect(pickCloudModelFor(refs, "no-such-model")).toEqual({ hit: undefined, disabled: undefined });
    expect(pickCloudModelFor([], "deepseek-v4.1")).toEqual({ hit: undefined, disabled: undefined });
  });
});

/** 真实 ~/.codex/config.toml 的形状：顶部 notify + 桌面端自己写的一堆区块。 */
const CODEX_CONFIG = [
  'notify = ["/usr/local/bin/notify", "turn-ended"]',
  "",
  "[marketplaces.openai-bundled]",
  'source_type = "local"',
  "",
  "[mcp_servers.node_repl]",
  'command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"',
  "",
  "[desktop]",
  'followUpQueueMode = "steer"',
  "",
].join("\n");

const PROVIDER_BLOCK = [
  "[model_providers.omni]",
  'name = "LlamaDesk"',
  'base_url = "http://127.0.0.1:10000/v1"',
  'wire_api = "responses"',
  'experimental_bearer_token = "key-1"',
].join("\n");

describe("omi launch chatgpt：改写 ~/.codex/config.toml", () => {
  test("顶部目标键插在第一个区块之前，原有键与区块逐字保留", () => {
    const out = chatgptConfigText(CODEX_CONFIG, "http://127.0.0.1:10000/v1", "key-1", "qwen3-4b");
    expect(out).toContain('notify = ["/usr/local/bin/notify", "turn-ended"]');
    expect(out.indexOf('model = "qwen3-4b"')).toBeLessThan(out.indexOf("[marketplaces.openai-bundled]"));
    expect(out).toContain('model_provider = "omni"');
    expect(out).toContain("[desktop]\nfollowUpQueueMode = \"steer\"");
    expect(out).toContain(PROVIDER_BLOCK);
  });

  test("已有的 model / model_provider 原地替换，不会写两遍", () => {
    const withKeys = `model = "gpt-5"\nmodel_provider = "openai"\n\n[features]\njs_repl = false\n`;
    const out = chatgptConfigText(withKeys, "http://x/v1", "k", "qwen3-4b");
    expect(out.match(/^model = /gm)?.length).toBe(1);
    expect(out.match(/^model_provider = /gm)?.length).toBe(1);
    expect(out).toContain('model = "qwen3-4b"');
    expect(out).not.toContain('"openai"');
  });

  /**
   * 回归：旧实现只丢 provider 区块的节头、不丢正文，于是 name / base_url /
   * experimental_bearer_token 留在了上一个区块（[desktop]）里 —— 上一轮的密钥
   * 就这么一直留在配置里，而且每改写一次多留一份。
   */
  test("改写两次：旧 provider 区块连正文一起丢掉，上一轮的 token 不残留", () => {
    const once = chatgptConfigText(CODEX_CONFIG, "http://127.0.0.1:10000/v1", "key-1", "model-a");
    const twice = chatgptConfigText(once, "http://127.0.0.1:10000/v1", "key-2", "model-b");
    expect(twice.match(/\[model_providers\.omni\]/g)?.length).toBe(1);
    expect(twice.match(/^name = "LlamaDesk"$/gm)?.length).toBe(1);
    expect(twice).not.toContain("key-1");
    expect(twice).not.toContain("model-a");
    expect(twice).toContain("[desktop]\nfollowUpQueueMode = \"steer\"");
  });

  test("迭代改写是幂等的：文件不再增长（区块正文不会被重复追加）", () => {
    let text = CODEX_CONFIG;
    for (let i = 0; i < 3; i++) text = chatgptConfigText(text, "http://x/v1", "k", "m");
    const fourth = chatgptConfigText(text, "http://x/v1", "k", "m");
    expect(fourth).toBe(text);
  });

  test("会劫持流量、或与目录声明矛盾的残留键被删掉", () => {
    const polluted = [
      'profile = "work"',
      'openai_base_url = "https://evil.example/v1"',
      "model_context_window = 400000",
      'model_verbosity = "high"',
      "",
      "[features]",
      "js_repl = false",
      "",
    ].join("\n");
    const out = chatgptConfigText(polluted, "http://x/v1", "k", "m");
    for (const key of ["profile", "openai_base_url", "model_context_window", "model_verbosity"]) {
      expect(out).not.toContain(key);
    }
    expect(out).toContain("js_repl = false");
  });
});

describe("omi launch chatgpt：models.json 目录项", () => {
  const entry = (
    JSON.parse(chatgptModelsJson("qwen3-4b", 65536, "PROMPT")) as {
      models: Record<string, any>[];
    }
  ).models[0]!;

  /**
   * 客户端的硬性要求：两处提示词都缺会让整份 config.toml 解析失败 ——
   *   failed to parse model_catalog_json …: model `X` is missing both
   *   base_instructions and model_messages.instructions_template
   */
  test("带 base_instructions 与 model_messages.instructions_template", () => {
    expect(entry.base_instructions).toBe("PROMPT");
    expect(entry.model_messages.instructions_template).toBe("PROMPT");
  });

  test("选择器可见（visibility=list），并声明真实的上下文窗口", () => {
    expect(entry.visibility).toBe("list");
    expect(entry.context_window).toBe(65536);
    expect(entry.max_context_window).toBe(65536);
  });

  test("推理档位覆盖 config.toml 写死的 model_reasoning_effort=high", () => {
    expect(entry.supported_reasoning_levels.map((l: { effort: string }) => l.effort)).toContain("high");
  });

  test("声明不支持思考摘要（网关只回正文，声明支持会等一段不会来的摘要）", () => {
    expect(entry.supports_reasoning_summaries).toBe(false);
    expect(entry.default_reasoning_summary).toBe("none");
  });
});

describe("从客户端自带目录里取提示词", () => {
  test("取第一份非空模板；空串的条目跳过，退回 base_instructions", () => {
    const json = JSON.stringify({
      models: [
        { slug: "a", base_instructions: "" },
        { slug: "b", model_messages: { instructions_template: "  " }, base_instructions: "B" },
      ],
    });
    expect(pickInstructionsTemplate(json)).toBe("B");
  });

  test("目录为空 / 不是 JSON / 没有 models 键：返回 null，由调用方兜底", () => {
    expect(pickInstructionsTemplate(JSON.stringify({ models: [] }))).toBeNull();
    expect(pickInstructionsTemplate("not json at all")).toBeNull();
    expect(pickInstructionsTemplate("{}")).toBeNull();
  });
});

describe("omi launch chatgpt --restore：安装前没有 config.toml 时的摘除", () => {
  test("摘掉本工具写的键与 provider 区块，桌面端自己加的区块原样保留", () => {
    const written = chatgptConfigText("", "http://127.0.0.1:10000/v1", "key-1", "m");
    const withAppSection = `${written}\n\n[plugins."browser@openai-bundled"]\nenabled = true\n`;
    const out = stripChatgptConfig(withAppSection);
    expect(out).not.toContain("model_providers.omni");
    expect(out).not.toContain("LlamaDesk");
    expect(out).not.toContain("base_url");
    expect(out).toContain('[plugins."browser@openai-bundled"]\nenabled = true');
  });
});

describe("omi launch codex：CLI 侧的 profile 与目录", () => {
  const toml = codexProfileToml("http://127.0.0.1:10000/v1/", "m", "/tmp/model.json", false);

  /**
   * 实测（本地起个回显服务器看请求头）：自定义 provider 不声明 env_key 时，codex 连
   * Authorization 头都不发 —— 网关一开密钥就是 401「Invalid or missing API key」。
   * Codex 只对内置 openai provider 自动读 OPENAI_API_KEY。
   */
  test("provider 声明 env_key，否则不会带上密钥", () => {
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
  });

  test("记忆关闭时不挂 omni-memory MCP，开启时才挂", () => {
    expect(toml).not.toContain("mcp_servers.omni-memory");
    const withMemory = codexProfileToml("http://x/v1/", "m", "/tmp/model.json", true);
    expect(withMemory).toContain("mcp_servers.omni-memory");
  });

  test("目录项带 base_instructions 且在选择器可见（缺失/隐藏会让客户端不认这个模型）", () => {
    const entry = (JSON.parse(codexCatalogJson("m", 32768)) as { models: Record<string, unknown>[] })
      .models[0]!;
    expect(entry).toHaveProperty("base_instructions");
    expect(entry.visibility).toBe("list");
    expect(entry.slug).toBe("m");
  });

  /**
   * 目录里写死 128k 会让 8k 的本地模型报大、1M 的云端模型报小 —— Codex 拿这个数当
   * 自动压缩基准，报小了就过早丢历史。窗口必须由调用方传进来。
   */
  test("context_window 用传进来的真实窗口，不再写死 128k", () => {
    const entry = (JSON.parse(codexCatalogJson("m", 1_048_576)) as {
      models: Record<string, unknown>[];
    }).models[0]!;
    expect(entry.context_window).toBe(1_048_576);
  });
});
