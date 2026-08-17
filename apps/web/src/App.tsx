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
  const handleEvent = (event: ChatEvent) => { if (event.type === "run.status" || event.type === "tool.started") { setActive(event.type === "tool.started" || event.data.status === "running"); setTrace((items) => [...items, String(event.data.label ?? event.data.tool_name ?? event.data.status ?? "研究中")]); } if (event.type === "message.delta") setMessages((items) => { const id = `stream-${event.data.run_id ?? "current"}`; const index = items.findIndex((item) => item.id === id); if (index >= 0) return items.map((item, i) => i === index ? { ...item, content: item.content + String(event.data.delta ?? "") } : item); return [...items, { id, role: "assistant", content: String(event.data.delta ?? "") }]; }); if (event.type === "message.completed") setMessages((items) => { const runId = String(event.data.run_id ?? ""); const streamId = `stream-${runId}`; const completed = { id: String(event.data.message_id ?? streamId), role: "assistant" as const, content: String(event.data.content ?? "") }; const index = items.findIndex((item) => item.id === streamId || item.id === completed.id); return index >= 0 ? items.map((item, i) => i === index ? completed : item) : [...items, completed]; }); if (event.type === "message.completed") setActive(false); if (event.type === "run.status" && event.data.status !== "running") setActive(false); if (event.type === "citation") { const id = String(event.data.document_id ?? "unknown"); const citation = { id, title: String(event.data.title ?? id ?? "来源"), publishedAt: String(event.data.published_at ?? ""), href: `#citation-${encodeURIComponent(id)}` }; setCitations((items) => [...items, citation]); setInspectorRecords((items) => upsertInspectorRecord(items, { kind: "evidence", id, title: citation.title, href: citation.href, content: String(event.data.content ?? event.data.excerpt ?? citation.publishedAt) })); } if (event.type === "tool.completed") { const id = String(event.data.tool_call_id ?? event.id); setInspectorRecords((items) => upsertInspectorRecord(items, { kind: "tool", id, name: String(event.data.tool_name ?? "工具调用"), parameters: event.data.parameters, result: event.data.result, durationMs: typeof event.data.duration_ms === "number" ? event.data.duration_ms : undefined, error: typeof event.data.error === "string" ? event.data.error : undefined })); } if (event.type === "error") setError(String(event.data.message ?? "研究失败")); };
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
