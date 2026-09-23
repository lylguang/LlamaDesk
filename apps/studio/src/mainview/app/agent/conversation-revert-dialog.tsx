import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangleIcon, Loader2Icon, Undo2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { useT } from "@stores/ui-lang";

/**
 * 「回退到这里」的确认弹窗（对话版的撤销本轮，对齐 `RevertTurnDialog` 的做法）。
 *
 * 与「撤销本轮」（还原工作区文件）互补：这个只动对话，**一行文件都不碰**，
 * 所以确认文案里必须把这件事说明白 —— 用户点的是「回退」，很容易以为文件也回去了。
 *
 * 删除边界按角色分（见 `Agent.revertAgentSession`）：落在用户消息上连它一起删
 * （正文回填输入框，让用户改一改再问），落在助手消息上只删它后面的。
 * 执行完把删了几条留在弹窗里，不是一闪而过的提示：用户需要核对"到底动了什么"。
 */
export function ConversationRevertDialog({
  open,
  onOpenChange,
  conversationId,
  messageId,
  isUserMessage,
  onReverted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: number;
  messageId: number;
  isUserMessage: boolean;
  /** `prompt` 是被删掉的那条用户消息正文（助手消息时为空）。 */
  onReverted?: (prompt: string) => void;
}) {
  const t = useT();
  const [result, setResult] = useState<{ removed: number } | null>(null);

  // 每次重新打开都是一次新的动作，带上一次的"删了 5 条"会让人以为这次也删了。
  useEffect(() => {
    if (open) setResult(null);
  }, [open, messageId]);

  const mutation = useMutation({
    mutationFn: () => rpcClient.revertAgentSession({ conversationId, messageId }),
  });

  const confirm = () => {
    mutation.mutate(undefined, {
      onSuccess: (data) => {
        if (!data.ok) return;
        setResult({ removed: data.removed ?? 0 });
        onReverted?.(data.prompt ?? "");
      },
    });
  };

  const close = (next: boolean) => {
    if (mutation.isPending) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2Icon className="size-4" />
            {t("agent.conversationRevert.title")}
          </DialogTitle>
          <DialogDescription>
            {isUserMessage ? t("agent.conversationRevert.bodyUser") : t("agent.conversationRevert.bodyKeep")}
          </DialogDescription>
        </DialogHeader>

        <p className="flex items-start gap-1.5 rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
          <span>{t("agent.conversationRevert.filesUntouched")}</span>
        </p>

        {result && (
          <p className="text-xs text-muted-foreground">
            {t("agent.conversationRevert.done", { n: String(result.removed) })}
          </p>
        )}
        {mutation.isError && (
          <p className="text-xs text-destructive">{String(mutation.error)}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={mutation.isPending}>
            {result ? t("common.close") : t("common.cancel")}
          </Button>
          {!result && (
            <Button variant="destructive" onClick={confirm} disabled={mutation.isPending}>
              {mutation.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <Undo2Icon data-icon="inline-start" />
              )}
              {t("agent.conversationRevert.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
