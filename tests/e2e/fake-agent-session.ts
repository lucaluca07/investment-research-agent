export type FakePiEvent = { type: string; assistantMessageEvent?: { type: string; delta?: string } };

export class FakeAgentSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  promptCalls = 0;
  private readonly mode: "success" | "hang" | "error";
  private release?: () => void;
  private listener?: (event: FakePiEvent) => void;
  private aborted = false;

  constructor(sessionId: string, mode: "success" | "hang" | "error" = "success") { this.sessionId = sessionId; this.sessionFile = `${sessionId}/session.jsonl`; this.mode = mode; }
  subscribe(listener: (event: FakePiEvent) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  async prompt(): Promise<void> {
    this.promptCalls += 1;
    if (this.mode === "error") throw new Error("fake model failure");
    if (this.aborted) return;
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Victory Giant" } });
    if (this.mode === "hang") await new Promise<void>((resolve) => { this.release = resolve; });
  }
  async abort(): Promise<void> { this.aborted = true; this.release?.(); }
  dispose(): void { this.listener = undefined; }
}
