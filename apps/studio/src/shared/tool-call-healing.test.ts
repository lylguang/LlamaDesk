import { describe, expect, test } from "bun:test";
import {
  healToolCalls,
  parseInlineToolCalls,
  MAX_HEAL_INPUT_CHARS,
} from "./tool-call-healing";

const FC = "</" + "function>";

describe("tool-call-healing", () => {
    test("1a. hermes format", () => {
    const text =
      'Sure! <tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call> done';
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read_file");
    expect(calls[0]!.arguments).toBe('{"path":"a.txt"}');
    expect(calls[0]!.format).toBe("hermes");
    const { text: healed } = healToolCalls(text, ["read_file"]);
    expect(healed).toBe("Sure!  done");
  });

  test("1b. function-tag well-formed", () => {
    const text =
      'before <function=grep>{"path":"b.txt"}' + FC + ' after';
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("grep");
    expect(calls[0]!.arguments).toBe('{"path":"b.txt"}');
    expect(calls[0]!.format).toBe("function-tag");
    const { text: healed } = healToolCalls(text, ["grep"]);
    expect(healed).toBe("before  after");
  });

  test("1c. function-tag missing '>'", () => {
    const text = 'before <function=grep{"path":"c.txt"}' + FC + ' after';
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("grep");
    expect(calls[0]!.arguments).toBe('{"path":"c.txt"}');
  });

  test("1d. bracket-tool-calls", () => {
    const text =
      'x [TOOL_CALLS][{"name":"read_file","arguments":{"path":"a.txt"}},{"name":"ls","arguments":{}}] y';
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe("read_file");
    expect(calls[0]!.format).toBe("bracket-tool-calls");
    expect(calls[1]!.name).toBe("ls");
    const { text: healed } = healToolCalls(text, ["read_file", "ls"]);
    expect(healed).toBe("x  y");
  });

  test("1e. gemma shape A", () => {
    const text =
      'g <|tool_call|>{"name":"calc","arguments":{"x":1}}<|/tool_call|> h';
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calc");
    expect(calls[0]!.format).toBe("gemma");
  });

  test("1f. gemma shape B (fenced)", () => {
    const text =
      'g ```tool_code\n{"name":"calc","arguments":{"x":2}}\n``` h';
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calc");
    expect(calls[0]!.format).toBe("gemma");
  });

  test("2. two formats + prose mixed", () => {
    const text =
      "Let me look.\n" +
      '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' +
      "\nthen grep.\n" +
      "<function=grep>{\"q\":\"foo\"}" + FC +
      "\nfinished.";
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe("read_file");
    expect(calls[1]!.name).toBe("grep");
    const { text: healed } = healToolCalls(text, ["read_file", "grep"]);
    expect(healed).toBe("Let me look.\n\nthen grep.\n\nfinished.");
  });

  test("3. missing close tag (hermes truncated)", () => {
    const text = 'start <tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}';
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read_file");
    const { text: healed } = healToolCalls(text, ["read_file"]);
    expect(healed).toBe("start ");
  });

  test("4. allowedNames filter: disallowed call stays in text", () => {
    const text =
      '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' +
      '<tool_call>{"name":"rm_rf","arguments":{"dir":"x"}}</tool_call>';
    const res = healToolCalls(text, ["read_file"]);
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]!.name).toBe("read_file");
    expect(res.text).toBe(
      '<tool_call>{"name":"rm_rf","arguments":{"dir":"x"}}</tool_call>',
    );
  });

  test("5. broken JSON -> no throw, empty calls, text unchanged", () => {
    const text =
      'before <tool_call>{"name":"read_file","arguments":{BAD}}</tool_call> after';
    const res = healToolCalls(text, ["read_file"]);
    expect(res.calls).toHaveLength(0);
    expect(res.text).toBe(text);
  });

  test("6. plain text with no calls -> strict equality (toBe)", () => {
    const text = "just a normal reply, nothing fancy here.";
    const res = healToolCalls(text, ["read_file"]);
    expect(res.calls).toHaveLength(0);
    expect(res.text).toBe(text);
  });

  test("7. arguments as string form", () => {
    const text =
      '<tool_call>{"name":"run","arguments":"{\\"a\\":1}"}</tool_call>';
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toBe('{"a":1}');
  });

  test("8. over MAX_HEAL_INPUT_CHARS -> returned verbatim, no calls", () => {
    const text = "a".repeat(MAX_HEAL_INPUT_CHARS + 1);
    const res = healToolCalls(text, ["read_file"]);
    expect(res.calls).toHaveLength(0);
    expect(res.text).toBe(text);
  });

  test("9. multiple calls: spans non-overlapping, in order", () => {
    const text =
      '<tool_call>{"name":"a1","arguments":{}}</tool_call>' +
      " middle " +
      "<function=b2>{\"x\":1}" + FC;
    const calls = parseInlineToolCalls(text);
    expect(calls).toHaveLength(2);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.start).toBeGreaterThanOrEqual(calls[i - 1]!.end);
    }
    expect(calls[0]!.start).toBeLessThan(calls[1]!.start);
    expect(calls[0]!.name).toBe("a1");
    expect(calls[1]!.name).toBe("b2");
  });

  test("invariant: heal never alters non-promoted bytes (hermes + prose)", () => {
    const prose = "The model says: ";
    const call = '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
    const tail = " and that is it.";
    const text = prose + call + tail;
    const res = healToolCalls(text, ["read_file"]);
    expect(res.text).toBe(prose + tail);
  });
});
