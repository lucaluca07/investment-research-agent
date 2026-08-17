import { useCallback, useRef, useState } from "react";

export type ResearchMessage = { id: string; role: "user" | "assistant"; content: string };
export type RunEvent = { type: string; sequence?: number; data?: Record<string, unknown> };

export interface ResearchRunClient {
  runAgent(input: { threadId: string; messages: ResearchMessage[]; idempotencyKey: string; after?: number }): Promise<void>;
  cancelAgent(input: { threadId: string; idempotencyKey: string }): Promise<void>;
}

export function useResearchRun(client: ResearchRunClient, threadId: string, initialMessages: ResearchMessage[] = []) {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [connectionState, setConnectionState] = useState<"connected" | "reconnecting" | "disconnected">("connected");
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [lastEventSeq, setLastEventSeq] = useState(0);
  const keyRef = useRef(crypto.randomUUID());
  const seenSeqRef = useRef(new Set<number>());
  const inFlightRef = useRef(false);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || running || inFlightRef.current) return;
    inFlightRef.current = true;
    const message: ResearchMessage = { id: crypto.randomUUID(), role: "user", content };
    setMessages((items) => [...items, message]);
    setDraft(""); setRunning(true); setCancelled(false);
    try {
      await client.runAgent({ threadId, messages: [...messages, message], idempotencyKey: keyRef.current });
      keyRef.current = crypto.randomUUID();
    } catch (error) {
      if ((error as { code?: string }).code === "run_cancelled") setCancelled(true); else throw error;
    } finally { inFlightRef.current = false; setRunning(false); }
  }, [client, draft, messages, running, threadId]);

  const stop = useCallback(async () => {
    if (!running) return;
    await client.cancelAgent({ threadId, idempotencyKey: keyRef.current });
    setCancelled(true); setRunning(false);
  }, [client, running, threadId]);

  const hydrate = useCallback((snapshot: ResearchMessage[], cursor = 0) => { seenSeqRef.current.clear(); setLastEventSeq(cursor); setMessages(snapshot); }, []);
  const replay = useCallback((events: RunEvent[]) => {
    for (const event of events) {
      if (event.sequence !== undefined) {
        if (seenSeqRef.current.has(event.sequence)) continue;
        seenSeqRef.current.add(event.sequence); setLastEventSeq((seq) => Math.max(seq, event.sequence!));
      }
      if (event.type === "MESSAGES_SNAPSHOT") {
        const snapshot = event.data?.messages;
        if (Array.isArray(snapshot)) setMessages(snapshot as ResearchMessage[]);
      }
      if (event.type === "RUN_STARTED") setRunning(true);
      if (event.type === "RUN_FINISHED" || event.type === "RUN_CANCELLED") { setRunning(false); if (event.type === "RUN_CANCELLED") setCancelled(true); }
      if (event.type === "TEXT_MESSAGE_CONTENT") {
        const id = String(event.data?.message_id ?? "assistant"); const delta = String(event.data?.delta ?? "");
        setMessages((items) => { const index = items.findIndex((item) => item.id === id); if (index < 0) return [...items, { id, role: "assistant", content: delta }]; return items.map((item, i) => i === index ? { ...item, content: item.content + delta } : item); });
      }
    }
  }, [hydrate]);
  const reconnect = useCallback(async (snapshot: { messages: ResearchMessage[]; last_event_seq: number }, events: RunEvent[]) => { hydrate(snapshot.messages, snapshot.last_event_seq); replay(events.filter((event) => (event.sequence ?? 0) > snapshot.last_event_seq)); }, [hydrate, replay]);
  return { messages, draft, setDraft, connectionState, setConnectionState, running, cancelled, lastEventSeq, send, stop, hydrate, replay, reconnect, idempotencyKey: keyRef.current };
}
