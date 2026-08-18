import { useEffect, useState } from "react";
import { Composer } from "./components/Composer.js";
import { MessageList } from "./components/MessageList.js";
import { ResearchTrace } from "./components/ResearchTrace.js";
import { createChatApi, type ChatApi, type ChatEvent, type ChatMessage } from "./lib/chat-api.js";
import "./styles.css";
import { ResearchWorkbench } from "./app/research-workbench.js";
import type { InspectorTarget } from "./features/inspector/inspector-state.js";
export { ResearchWorkbench } from "./app/research-workbench.js";

type ResolvePayload = Record<string, unknown> & { approved: boolean; reason?: string };
export type WorkbenchRuntime = {
  threadId: string;
  inspectorRecords?: Exclude<InspectorTarget, null>[];
  interrupts?: unknown[];
  onResolveInterrupt: (interrupt: unknown, payload: ResolvePayload) => Promise<void> | void;
  onCancelInterrupt: (interrupt: unknown) => Promise<void> | void;
  onRefreshInterrupts: () => Promise<void> | void;
  onSaveArtifact?: (id: string) => void;
  onVersionChange?: (id: string, version: string) => void;
};

export function App({ api = createChatApi(), runtime }: { api?: ChatApi; runtime?: WorkbenchRuntime }) {
  const [chatId, setChatId] = useState<string>(); const [chats, setChats] = useState<Array<{ id: string; pi_session_id: string }>>([]); const [messages, setMessages] = useState<ChatMessage[]>([]); const [draft, setDraft] = useState(""); const [active, setActive] = useState(false); const [connected, setConnected] = useState(true); const [loading, setLoading] = useState(true); const [trace, setTrace] = useState<string[]>([]); const [citations, setCitations] = useState<Array<{ id: string; title: string; publishedAt: string; href: string }>>([]); const [inspectorRecords, setInspectorRecords] = useState<Exclude<InspectorTarget, null>[]>([]); const [error, setError] = useState(""); const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const ensureChat = async () => { if (chatId) return chatId; const chat = await api.createChat(); setChatId(chat.id); setChats((items) => [...items, chat]); return chat.id; };
  useEffect(() => { api.listChats().then((items) => { setChats(items); if (items[0]) setChatId(items[0].id); }).catch(() => setError("无法加载 chat 列表")).finally(() => setLoading(false)); }, []);
  useEffect(() => { let dispose: (() => void) | undefined; if (chatId) { api.getMessages(chatId).then((result) => setMessages((old) => mergeMessages(old, result.messages))).catch(() => setError("无法加载消息")); dispose = api.subscribe(chatId, (event) => handleEvent(event), (online) => { setConnected(online); if (online) api.getMessages(chatId).then((result) => setMessages((old) => mergeMessages(old, result.messages))); }); } return () => dispose?.(); }, [chatId]);
  const handleEvent = (event: ChatEvent) => { const type = event.type.toUpperCase(); if (type === "RUN_STARTED" || type === "TOOL_CALL_START") { setActive(true); setTrace((items) => [...items, String(event.data.toolCallName ?? event.data.tool_name ?? "研究中")]); } if (type === "TEXT_MESSAGE_CONTENT") setMessages((items) => { const id = String(event.data.messageId ?? event.data.message_id ?? `stream-${event.data.runId ?? event.data.run_id ?? "current"}`); const index = items.findIndex((item) => item.id === id); const content = String(event.data.delta ?? event.data.content ?? ""); if (index >= 0) return items.map((item, i) => i === index ? { ...item, content: item.content + content } : item); return [...items, { id, role: "assistant", content }]; }); if (type === "TEXT_MESSAGE_END" || type === "RUN_FINISHED" || type === "RUN_ERROR") setActive(false); if (type === "RUN_ERROR") setError(String(event.data.message ?? "研究失败")); if (type === "TOOL_CALL_RESULT") { const id = String(event.data.toolCallId ?? event.data.tool_call_id ?? event.id); setInspectorRecords((items) => upsertInspectorRecord(items, { kind: "tool", id, name: String(event.data.toolCallName ?? event.data.tool_name ?? "工具调用"), parameters: event.data.parameters ?? event.data.args, result: event.data.result ?? event.data.content })); } };
  const send = async () => { if (!draft.trim()) return; try { const id = await ensureChat(); setActive(true); await api.sendMessage(id, draft, idempotencyKey); const history = await api.getMessages(id); setMessages((old) => mergeMessages(old, history.messages)); setDraft(""); setIdempotencyKey(crypto.randomUUID()); } catch { setError("发送失败"); setActive(false); } };
  const stop = async () => { if (!chatId) return; try { await api.stop(chatId); setActive(false); } catch { setError("停止失败"); setActive(false); } };
  const selectChat = (id: string) => { setChatId(id); setMessages([]); setTrace([]); setCitations([]); setInspectorRecords([]); setError(""); setActive(false); };
  const newChat = async () => { try { const chat = await api.createChat(); setChats((items) => [...items, chat]); selectChat(chat.id); setConnected(true); setIdempotencyKey(crypto.randomUUID()); } catch { setError("新建 chat 失败"); } };
  if (loading) return <main><p role="status">加载中…</p></main>;
  const unavailableApproval = async () => { setError("审批运行时尚未连接"); };
  const activeRuntime = runtime?.threadId === chatId ? runtime : undefined;
  const combinedRecords = [...(activeRuntime?.inspectorRecords ?? []), ...inspectorRecords].reduce<Exclude<InspectorTarget, null>[]>((items, record) => upsertInspectorRecord(items, record), []);
  return <ResearchWorkbench messages={messages.filter((m) => m.role !== "tool").map((m) => ({ id: m.id, role: m.role as "user" | "assistant", content: m.content }))} draft={draft} onDraftChange={setDraft} onSend={send} onStop={stop} running={active} threads={chats.map((chat) => ({ id: chat.id, title: chat.id }))} onSelectThread={selectChat} onNewThread={newChat} error={error} connected={connected} citations={citations} inspectorRecords={combinedRecords} interrupts={activeRuntime?.interrupts ?? []} onResolveInterrupt={activeRuntime?.onResolveInterrupt ?? unavailableApproval} onCancelInterrupt={activeRuntime?.onCancelInterrupt ?? unavailableApproval} onRefreshInterrupts={activeRuntime?.onRefreshInterrupts ?? unavailableApproval} onSaveArtifact={activeRuntime?.onSaveArtifact} onVersionChange={activeRuntime?.onVersionChange} />;
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]) { const map = new Map(existing.map((message) => [message.id, message])); incoming.forEach((message) => { if (message.role === "assistant") for (const key of map.keys()) if (key.startsWith("stream-")) map.delete(key); map.set(message.id, message); }); return [...map.values()]; }
function upsertInspectorRecord(records: Exclude<InspectorTarget, null>[], next: Exclude<InspectorTarget, null>) { return [...records.filter((record) => record.kind !== next.kind || record.id !== next.id), next]; }
