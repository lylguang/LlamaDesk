/**
 * 「让 Agent 解决」带过去的那一段话的格式 —— 这就是这个按钮的全部价值：
 * 带齐了，Agent 第一轮就能动手；带漏了，它只能先反问。
 */
import { expect, test } from "bun:test";

import { buildDiagnosisPrompt } from "./agent-diagnose-prompt";

test("说明 → 报错 → 环境 → 日志末尾，按这个顺序", () => {
  const prompt = buildDiagnosisPrompt({
    intro: "本地模型起不来，请诊断并修好。",
    error: "E gguf_init_from_reader: failed to read magic",
    context: ["引擎：llama.cpp", "模型：/models/Qwopus3.5-4B-Coder-MTP-GGUF"],
    logs: ["I load_model: loading model '/models/Qwopus3.5-4B-Coder-MTP-GGUF'", "E llama_server: exiting due to model loading error"],
  });
  const at = (s: string) => prompt.indexOf(s);
  expect(at("本地模型起不来")).toBe(0);
  expect(at("报错：E gguf_init_from_reader")).toBeGreaterThan(0);
  expect(at("引擎：llama.cpp")).toBeGreaterThan(at("报错："));
  expect(at("日志（末尾 2 行）")).toBeGreaterThan(at("模型："));
  expect(prompt).toContain("exiting due to model loading error");
});

test("日志只带末尾 40 行，空行不算", () => {
  const logs = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).concat(["", "   "]);
  const prompt = buildDiagnosisPrompt({ intro: "x", error: "y", logs });
  expect(prompt).toContain("日志（末尾 40 行）");
  expect(prompt).toContain("line 100");
  expect(prompt).toContain("line 61");
  expect(prompt).not.toContain("line 60\n");
});

test("没有日志就不出现日志段", () => {
  expect(buildDiagnosisPrompt({ intro: "x", error: "y" })).not.toContain("日志");
});

test("日志里的 ANSI 颜色码与控制字符剥干净（真机第一次点时满屏 ⌧[34m）", () => {
  const prompt = buildDiagnosisPrompt({
    intro: "x",
    error: "y",
    logs: [
      "\x1b[0m\x1b[34m0.00.065.576\x1b[0m \x1b[32mI \x1b[0msrv  operator(): cleaning up before exit...\r",
      "\x1b[34m0.00.065.874\x1b[0m \x1b[31mE srv  llama_server: exiting due to model loading error",
      "\x1b[0m",
    ],
  });
  expect(prompt).not.toContain("\x1b");
  expect(prompt).not.toContain("\r");
  expect(prompt).toContain("0.00.065.874 E srv  llama_server: exiting due to model loading error");
  // 只剩颜色码的那一行清完就是空行，不该占一行。
  expect(prompt).toContain("日志（末尾 2 行）");
});
