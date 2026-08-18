type Listener = (event: unknown) => void;

/**
 * Deterministic Pi-shaped session used only by the process-boundary E2E stack.
 * It is selected only when NODE_ENV=test, so production always creates Pi.
 */
export class E2eSession {
  private listener?: Listener;

  subscribe(listener: Listener): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  async prompt(): Promise<void> {
    const message = { role: "assistant", content: [] };
    this.listener?.({ type: "turn_start" });
    this.listener?.({ type: "message_start", message });
    this.listener?.({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Victory Giant",
        partial: message,
      },
    });
    this.listener?.({ type: "message_end", message });
    this.listener?.({ type: "turn_end", message: {}, toolResults: [] });
  }
}
