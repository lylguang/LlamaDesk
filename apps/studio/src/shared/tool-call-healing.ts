/**
 * tool-call-healing — parses tool calls that small local models emit as
 * plain text instead of structured tool_calls.
 *
 * Pure functions only: no IO, no node:* / bun / electrobun imports.
 *
 * Invariants:
 *   1. Only functions whose name is in allowedNames are promoted.
 *   2. Only the promoted spans are removed from the text.
 *   3. Any parse failure means "never saw it": skip, never throw.
 */

export type InlineToolCall = {
  name: string;
  arguments: string;
  start: number;
  end: number;
  format: "hermes" | "function-tag" | "bracket-tool-calls" | "gemma";
};

export type HealResult = {
  text: string;
  calls: InlineToolCall[];
};

export const MAX_HEAL_INPUT_CHARS = 256 * 1024;

/* ---------------- JSON helpers (unknown narrowing, no any) -------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJsonObject(s: string): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  return isRecord(v) ? v : null;
}

function parseJsonArray(s: string): unknown[] | null {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  return Array.isArray(v) ? v : null;
}

type RawCall = { name: string; arguments: string };

function rawCallFromObject(obj: Record<string, unknown>): RawCall | null {
  if (typeof obj.name !== "string" || obj.name.length === 0) return null;
  const args = obj.arguments;
  let argumentsStr: string;
  if (typeof args === "string") {
    argumentsStr = args;
  } else if (args === undefined) {
    argumentsStr = "";
  } else if (isRecord(args) || Array.isArray(args)) {
    argumentsStr = JSON.stringify(args);
  } else {
    return null;
  }
  return { name: obj.name, arguments: argumentsStr };
}

/* ---------------- Format 1: hermes ------------------------------- */

const HERMES_OPEN = "<tool_call>";
const HERMES_CLOSE = "</tool_call>";

function parseHermes(text: string): InlineToolCall[] {
  const out: InlineToolCall[] = [];
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(HERMES_OPEN, from);
    if (idx === -1) break;
    const bodyStart = idx + HERMES_OPEN.length;
    const closeIdx = text.indexOf(HERMES_CLOSE, bodyStart);
    const nextOpen = text.indexOf(HERMES_OPEN, bodyStart);
    // end = where this call ends in the source (spans include the close tag);
    // bodyEnd = where the JSON body ends (excludes the close tag).
    let end: number;
    let bodyEnd: number;
    if (closeIdx !== -1 && (nextOpen === -1 || closeIdx < nextOpen)) {
      bodyEnd = closeIdx;
      end = closeIdx + HERMES_CLOSE.length;
    } else {
      bodyEnd = nextOpen === -1 ? text.length : nextOpen;
      end = bodyEnd;
    }
    const raw = text.slice(bodyStart, bodyEnd).trim();
    const obj = raw.startsWith("{") ? parseJsonObject(raw) : null;
    from = end; // always advance, even when parsing fails
    if (obj) {
      const call = rawCallFromObject(obj);
      if (call) out.push({ ...call, start: idx, end, format: "hermes" });
    }
  }
  return out;
}

/* ---------------- Format 2: function-tag ------------------------- */

const FUNC_OPEN_RE = /<function=([A-Za-z0-9_.-]+)(?:>|\s|(?=\{))/g;
const FUNC_CLOSE = "</" + "function>";
const FUNC_OPEN_MARKER = "<function=";

function parseFunctionTag(text: string): InlineToolCall[] {
  const out: InlineToolCall[] = [];
  for (let m = FUNC_OPEN_RE.exec(text); m !== null; m = FUNC_OPEN_RE.exec(text)) {
    const start = m.index;
    const tagName = m[1]!;
    const bodyStart = m.index + m[0].length;
    const closeIdx = text.indexOf(FUNC_CLOSE, bodyStart);
    let nextOpenIdx = -1;
    let probe = bodyStart;
    for (;;) {
      const t = text.indexOf(FUNC_OPEN_MARKER, probe);
      if (t === -1) break;
      const c = text[t + FUNC_OPEN_MARKER.length];
      if (c !== undefined && /^[A-Za-z0-9_.-]/.test(c)) { nextOpenIdx = t; break; }
      probe = t + 1;
    }
    // end = where this call ends in the source (spans include the close tag);
    // bodyEnd = where the JSON body ends (excludes the close tag).
    let end: number;
    let bodyEnd: number;
    if (closeIdx !== -1 && (nextOpenIdx === -1 || closeIdx < nextOpenIdx)) {
      bodyEnd = closeIdx;
      end = closeIdx + FUNC_CLOSE.length;
    } else {
      bodyEnd = nextOpenIdx === -1 ? text.length : nextOpenIdx;
      end = bodyEnd;
    }
    const raw = text.slice(bodyStart, bodyEnd).trim();
    const obj = raw.startsWith("{") ? parseJsonObject(raw) : null;
    // In function-tag the braces ARE the arguments: the name is already in
    // the tag, so the whole object is the call's arguments JSON. If a model
    // does wrap it with an "arguments" field, use that instead.
    let argumentsStr: string | undefined;
    if (obj) {
      if ("arguments" in obj) {
        const args = obj.arguments;
        if (typeof args === "string") {
          argumentsStr = args;
        } else if (isRecord(args) || Array.isArray(args)) {
          argumentsStr = JSON.stringify(args);
        }
      } else {
        argumentsStr = JSON.stringify(obj);
      }
    }
    if (argumentsStr != undefined) {
      out.push({ name: tagName, arguments: argumentsStr, start, end, format: "function-tag" });
    }
    // advance past this tag: on a zero-length match the regex cursor does
    // not move past m.index, which would spin forever on a malformed tag
    FUNC_OPEN_RE.lastIndex = Math.max(FUNC_OPEN_RE.lastIndex, start + FUNC_OPEN_MARKER.length + 1);
  }
  return out;
}

/* ---------------- Format 3: bracket-tool-calls -------------------- */

const BRACKET_MARKER = "[TOOL_CALLS]";

function parseBracketToolCalls(text: string): InlineToolCall[] {
  const out: InlineToolCall[] = [];
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(BRACKET_MARKER, from);
    if (idx === -1) break;
    const bodyStart = idx + BRACKET_MARKER.length;
    let depth = 0;
    let i = bodyStart;
    let found = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) { found = true; break; }
      } else if (depth === 0) {
        if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") break;
      }
    }
    if (!found) {
      // unterminated: the body extends to the end of the text
      from = idx + BRACKET_MARKER.length;
      break;
    }
    const end = i + 1;
    const raw = text.slice(bodyStart, end).trim();
    const arr = parseJsonArray(raw);
    from = end; // always advance, even if the array fails to parse
    for (const entry of arr ?? []) {
      if (!isRecord(entry)) continue;
      const call = rawCallFromObject(entry);
      if (!call) continue;
      out.push({ ...call, start: idx, end, format: "bracket-tool-calls" });
    }
  }
  return out;
}

/* ---------------- Format 4: gemma -------------------------------- */

const GEMMA_OPEN = "<|tool_call|>";
const GEMMA_CLOSE = "<|/tool_call|>";
const GEMMA_FENCE_OPEN = "```tool_code";
const GEMMA_FENCE_CLOSE = "```";

function parseGemma(text: string): InlineToolCall[] {
  const out: InlineToolCall[] = [];

  // Shape A: <|tool_call|> ... (close may be missing)
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(GEMMA_OPEN, from);
    if (idx === -1) break;
    const bodyStart = idx + GEMMA_OPEN.length;
    const closeIdx = text.indexOf(GEMMA_CLOSE, bodyStart);
    // end = 这段调用在原文里的结束位置（含闭合标签）；
    // bodyEnd = JSON 正文的结束位置（不含闭合标签）—— 与 parseHermes 同一套区分。
    let end: number;
    let bodyEnd: number;
    if (closeIdx !== -1) {
      bodyEnd = closeIdx;
      end = closeIdx + GEMMA_CLOSE.length;
    } else {
      const fence = text.indexOf(GEMMA_FENCE_OPEN, bodyStart);
      bodyEnd = fence !== -1 ? fence : text.length;
      end = bodyEnd;
    }
    const raw = text.slice(bodyStart, bodyEnd).trim();
    const obj = raw.startsWith("{") ? parseJsonObject(raw) : null;
    if (obj) {
      const call = rawCallFromObject(obj);
      if (call) out.push({ ...call, start: idx, end, format: "gemma" });
    }
    // an open tag can only be followed by another open tag when there is
    // no close/fence in between (handled above), so end >= bodyStart here
    from = Math.max(end, bodyStart + 1);
  }

  // Shape B: fenced tool_code blocks
  let f = 0;
  while (f < text.length) {
    const o = text.indexOf(GEMMA_FENCE_OPEN, f);
    if (o === -1) break;
    const bodyStart = text.indexOf("\n", o);
    const realStart = bodyStart === -1 ? o + GEMMA_FENCE_OPEN.length : bodyStart + 1;
    const closeFence = text.indexOf(GEMMA_FENCE_CLOSE, realStart);
    const end = closeFence === -1 ? text.length : closeFence + GEMMA_FENCE_CLOSE.length;
    const raw = text.slice(realStart, closeFence === -1 ? text.length : closeFence).trim();
    const obj = raw.startsWith("{") ? parseJsonObject(raw) : null;
    if (obj) {
      const call = rawCallFromObject(obj);
      if (call) out.push({ ...call, start: o, end, format: "gemma" });
    }
    // never let a zero-width / zero-length fence stop the loop
    f = Math.max(end, o + 1);
  }

  return out;
}

/* ---------------- Top-level API ---------------------------------- */

export function parseInlineToolCalls(text: string): InlineToolCall[] {
  if (text.length > MAX_HEAL_INPUT_CHARS) return [];
  const calls: InlineToolCall[] = [
    ...parseHermes(text),
    ...parseFunctionTag(text),
    ...parseBracketToolCalls(text),
    ...parseGemma(text),
  ];
  calls.sort((a, b) => a.start - b.start || a.end - b.end);
  return calls;
}

export function healToolCalls(
  text: string,
  allowedNames: readonly string[],
): HealResult {
  if (text.length > MAX_HEAL_INPUT_CHARS) {
    return { text, calls: [] };
  }
  const allowed = new Set(allowedNames);
  const all = parseInlineToolCalls(text);
  const promoted = all.filter((c) => allowed.has(c.name));

  if (promoted.length === 0) {
    return { text, calls: [] };
  }

  let out = "";
  let cursor = 0;
  for (const c of promoted) {
    if (c.start < cursor) continue;
    out += text.slice(cursor, c.start);
    cursor = c.end;
  }
  out += text.slice(cursor);

  return { text: out, calls: promoted };
}
