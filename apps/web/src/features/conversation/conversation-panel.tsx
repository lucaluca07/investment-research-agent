import type { ResearchMessage } from "./use-research-run.js";

export function ConversationPanel({ messages, draft, onDraftChange, onSend, onStop, running }: {
  messages: ResearchMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
}) {
  return <section aria-label="研究对话">
    <div role="log">{messages.map((message) => <p key={message.id} data-role={message.role}>{message.content}</p>)}</div>
    <form onSubmit={(event) => { event.preventDefault(); onSend(); }}>
      <textarea aria-label="研究问题" value={draft} onChange={(event) => onDraftChange(event.target.value)} disabled={running} />
      {running ? <button type="button" onClick={onStop}>停止</button> : <button type="submit" disabled={!draft.trim()}>发送</button>}
    </form>
  </section>;
}
