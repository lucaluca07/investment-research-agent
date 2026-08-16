export type ChatMessage = { id: string; role: "user" | "assistant" | "tool"; content: string; created_at?: string };
export type ChatEvent = { id: number; type: string; data: Record<string, unknown> };
export interface ChatApi {
  createChat(): Promise<{ id: string; pi_session_id: string }>;
  getMessages(chatId: string): Promise<{ messages: ChatMessage[] }>;
  sendMessage(chatId: string, content: string, idempotencyKey: string): Promise<{ runId: string }>;
  stop(chatId: string): Promise<void>;
  subscribe(chatId: string, onEvent: (event: ChatEvent) => void, onConnection: (connected: boolean) => void): () => void;
}

export function createChatApi(fetcher = globalThis.fetch, sourceFactory = (url: string) => new EventSource(url)): ChatApi {
  const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(url, { headers: { "content-type": "application/json" }, ...init });
    if (!response.ok) throw new Error(`请求失败 (${response.status})`);
    return response.json() as Promise<T>;
  };
  return {
    createChat: () => request("/v1/chats", { method: "POST", body: "{}" }),
    getMessages: (chatId) => request(`/v1/chats/${encodeURIComponent(chatId)}/messages`),
    sendMessage: (chatId, content, idempotencyKey) => request(`/v1/chats/${encodeURIComponent(chatId)}/messages`, { method: "POST", body: JSON.stringify({ content, idempotency_key: idempotencyKey }) }),
    stop: async (chatId) => { await request(`/v1/chats/${encodeURIComponent(chatId)}/stop`, { method: "POST" }); },
    subscribe: (chatId, onEvent, onConnection) => {
      let lastId = 0;
      let source: EventSource | undefined;
      let stopped = false;
      const connect = () => {
        if (stopped) return;
        source = sourceFactory(`/v1/chats/${encodeURIComponent(chatId)}/events${lastId ? `?lastEventId=${lastId}` : ""}`);
        source.onopen = () => onConnection(true);
        source.onerror = () => { onConnection(false); source?.close(); setTimeout(connect, 250); };
        source.onmessage = (message) => { const event = { id: Number(message.lastEventId), type: message.type, data: JSON.parse(message.data) }; if (event.id > lastId) { lastId = event.id; onEvent(event); } };
      };
      connect();
      return () => { stopped = true; source?.close(); };
    },
  };
}
