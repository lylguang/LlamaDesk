import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../../bun/chat";
import { groupChatTurns } from "./turns";

let seq = 0;
const msg = (role: ChatMessage["role"], content = ""): ChatMessage => {
  seq += 1;
  return { id: seq, conversationId: 1, role, content, createdAt: seq };
};

describe("groupChatTurns", () => {
  test("一问一答算一轮", () => {
    const turns = groupChatTurns([msg("user", "你好"), msg("assistant", "在的")]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("多轮依次分组，key 取本轮第一条消息", () => {
    const a = msg("user", "1");
    const b = msg("assistant", "1");
    const c = msg("user", "2");
    const d = msg("assistant", "2");
    const turns = groupChatTurns([a, b, c, d]);
    expect(turns.map((t) => t.key)).toEqual([`user-${a.id}`, `user-${c.id}`]);
    expect(turns.map((t) => t.messages.length)).toEqual([2, 2]);
  });

  test("一轮里的多条助手消息（重新生成 / 多模型并答）不被拆开", () => {
    const turns = groupChatTurns([
      msg("user", "问"),
      msg("assistant", "答一"),
      msg("assistant", "答二"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  });

  test("开场就是助手消息（无提问）时自己开一轮", () => {
    const early = msg("assistant", "启动失败");
    const user = msg("user", "问");
    const turns = groupChatTurns([early, user, msg("assistant", "答")]);
    expect(turns.map((t) => t.key)).toEqual([`assistant-${early.id}`, `user-${user.id}`]);
  });

  test("连续两条用户消息各自开一轮（第二条不吞并前一轮）", () => {
    const turns = groupChatTurns([msg("user", "1"), msg("user", "2")]);
    expect(turns).toHaveLength(2);
    expect(turns.every((t) => t.messages.length === 1)).toBe(true);
  });

  test("空列表返回空", () => {
    expect(groupChatTurns([])).toEqual([]);
  });

  test("不改动入参", () => {
    const list = [msg("user", "1"), msg("assistant", "2")];
    const copy = [...list];
    groupChatTurns(list);
    expect(list).toEqual(copy);
  });
});
