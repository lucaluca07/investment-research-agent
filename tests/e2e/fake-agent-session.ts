export type FakePiEvent = { type: string; assistantMessageEvent?: { type: string; delta?: string } };

export class FakeAgentSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  promptCalls = 0;
  private listener?: (event: FakePiEvent) => void;
  private aborted = false;

  constructor(sessionId: string) { this.sessionId = sessionId; this.sessionFile = `${sessionId}/session.jsonl`; }
  subscribe(listener: (event: FakePiEvent) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  async prompt(): Promise<void> { this.promptCalls += 1; if (!this.aborted) this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Victory Giant" } }); }
  async abort(): Promise<void> { this.aborted = true; }
  dispose(): void { this.listener = undefined; }
}
