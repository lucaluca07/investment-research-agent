import type { ResearchMessage } from "./use-research-run.js";
import { ApprovalInterruptView } from "../interrupts/approval-interrupt.js";

export function ConversationPanel({ messages, draft, onDraftChange, onSend, onStop, running, interrupts, onResolveInterrupt, onCancelInterrupt, onRefreshInterrupts }: {
  messages: ResearchMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  interrupts?: unknown[];
  onResolveInterrupt: (interrupt: unknown, payload: Record<string, unknown> & { approved: boolean; reason?: string }) => Promise<void> | void;
  onCancelInterrupt: (interrupt: unknown) => Promise<void> | void;
  onRefreshInterrupts: () => Promise<void> | void;
}) {
  const pendingInterrupts = interrupts ?? [];
  const hasInterrupt = pendingInterrupts.length > 0;
  return <section aria-label="研究对话">
    <div role="log">{messages.length === 0 && <p>开始一项研究</p>}{messages.map((message) => <p key={message.id} data-role={message.role}>{message.content}</p>)}</div>
    {hasInterrupt && <div aria-label="待处理审批">{pendingInterrupts.map((interrupt, index) => <ApprovalInterruptView key={getInterruptKey(interrupt, index)} interrupt={interrupt} actions={{ resolve: (payload) => onResolveInterrupt(interrupt, payload), cancel: () => onCancelInterrupt(interrupt), refresh: onRefreshInterrupts }} />)}</div>}
    <form onSubmit={(event) => { event.preventDefault(); if (!hasInterrupt) onSend(); }}>
      <textarea aria-label="研究问题" value={draft} onChange={(event) => onDraftChange(event.target.value)} disabled={running || hasInterrupt} />
      {running ? <button type="button" onClick={onStop}>停止</button> : <button type="submit" disabled={!draft.trim() || hasInterrupt}>发送</button>}
    </form>
  </section>;
}

function getInterruptKey(value: unknown, index: number) { return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).interruptId === "string" ? String((value as Record<string, unknown>).interruptId) : `interrupt-${index}`; }
