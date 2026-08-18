export type ChatMessage = { id: string; role: "user" | "assistant" | "tool"; content: string; created_at?: string };
export type ChatEvent = { id: number; type: string; data: Record<string, unknown> };
export interface ChatApi {
  listChats(): Promise<Array<{ id: string; pi_session_id: string }>>;
  createChat(): Promise<{ id: string; pi_session_id: string }>;
  getMessages(chatId: string): Promise<{ messages: ChatMessage[] }>;
  sendMessage(chatId: string, content: string, idempotencyKey: string): Promise<{ runId: string }>;
  stop(chatId: string): Promise<void>;
  subscribe(chatId: string, onEvent: (event: ChatEvent) => void, onConnection: (connected: boolean) => void): () => void;
}

const AG_UI_EVENT_TYPES = [
  "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "STEP_STARTED", "STEP_FINISHED",
  "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
  "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT",
  "STATE_SNAPSHOT", "STATE_DELTA", "MESSAGES_SNAPSHOT", "RAW",
] as const;

export function createChatApi(fetcher = globalThis.fetch, sourceFactory = (url: string) => new EventSource(url)): ChatApi {
  const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(url, { headers: { "content-type": "application/json" }, ...init });
    if (!response.ok) throw new Error(`请求失败 (${response.status})`);
    return response.json() as Promise<T>;
  };
  return {
    listChats: async () => (await request<Array<{ id: string }>>("/v1/threads")).map((thread) => ({ id: thread.id, pi_session_id: thread.id })),
    createChat: async () => { const thread = await request<{ id: string }>("/v1/threads", { method: "POST", body: "{}" }); return { id: thread.id, pi_session_id: thread.id }; },
    getMessages: async (chatId) => ({ messages: [] }),
    sendMessage: async (chatId, content, idempotencyKey) => { const result = await request<{ run: { id: string } }>(`/v1/threads/${encodeURIComponent(chatId)}/runs`, { method: "POST", body: JSON.stringify({ input: content, idempotency_key: idempotencyKey }) }); return { runId: result.run.id }; },
    stop: async (chatId) => { await request(`/v1/threads/${encodeURIComponent(chatId)}/stop`, { method: "POST" }); },
    subscribe: (chatId, onEvent, onConnection) => {
      let lastId = 0;
      let source: EventSource | undefined;
      let stopped = false;
      const connect = () => {
        if (stopped) return;
        source = sourceFactory(`/v1/threads/${encodeURIComponent(chatId)}/events${lastId ? `?after=${lastId}` : ""}`);
        source.onopen = () => onConnection(true);
        source.onerror = () => { onConnection(false); source?.close(); setTimeout(connect, 250); };
        const handleMessage = (message: MessageEvent) => {
          let data: Record<string, unknown>;
          try { data = JSON.parse(message.data) as Record<string, unknown>; } catch { return; }
          const event = { id: Number(message.lastEventId), type: message.type || "message", data };
          if (Number.isFinite(event.id) && event.id > lastId) { lastId = event.id; onEvent(event); }
        };
        source.onmessage = handleMessage;
        for (const type of AG_UI_EVENT_TYPES) source.addEventListener?.(type, handleMessage as EventListener);
      };
      connect();
      return () => { stopped = true; source?.close(); };
    },
  };
}
