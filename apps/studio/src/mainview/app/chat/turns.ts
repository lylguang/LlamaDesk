import type { ChatMessage } from "../../../bun/chat";

/** 一轮对话：一条用户消息 + 它引出的全部助手消息。 */
export type ChatTurn = {
  /** React 列表 key：一轮的身份就是它第一条消息。 */
  key: string;
  messages: ChatMessage[];
};

/**
 * 把平铺的消息列按「轮」分组。
 *
 * 消息列的排版是轮内紧、轮间松 —— 这个间距差就是"上一轮说到哪儿、这一轮从哪儿开始"
 * 的分隔符。平铺渲染时两者间距相同，一屏十几条消息读下来要自己找边界。
 *
 * 规则只有两条：
 *   · 助手消息紧跟在用户消息之后 → 归进那一轮（重新生成、多模型并答都算同一轮，
 *     不会被拆成"两个回答"）；
 *   · 其余情况（用户消息、开场就是助手消息）→ 自己开一轮。
 */
export function groupChatTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    const current = turns[turns.length - 1];
    if (message.role === "assistant" && current?.messages[0]?.role === "user") {
      current.messages.push(message);
      continue;
    }
    turns.push({ key: `${message.role}-${message.id}`, messages: [message] });
  }
  return turns;
}
