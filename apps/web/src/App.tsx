import { useEffect, useState } from "react";
import { Composer } from "./components/Composer.js";
import { MessageList } from "./components/MessageList.js";
import { ResearchTrace } from "./components/ResearchTrace.js";
import { createChatApi, type ChatApi, type ChatEvent, type ChatMessage } from "./lib/chat-api.js";
import "./styles.css";

export function App({ api = createChatApi() }: { api?: ChatApi }) {
  const [chatId, setChatId] = useState<string>(); const [messages, setMessages] = useState<ChatMessage[]>([]); const [draft, setDraft] = useState(""); const [active, setActive] = useState(false); const [connected, setConnected] = useState(true); const [trace, setTrace] = useState<string[]>([]); const [citations, setCitations] = useState<Array<{ title: string; publishedAt: string; href: string }>>([]); const [error, setError] = useState("");
  const ensureChat = async () => { if (chatId) return chatId; const chat = await api.createChat(); setChatId(chat.id); return chat.id; };
  useEffect(() => { let dispose: (() => void) | undefined; if (chatId) { api.getMessages(chatId).then((result) => setMessages(result.messages)).catch(() => setError("无法加载消息")); dispose = api.subscribe(chatId, (event) => handleEvent(event), setConnected); } return () => dispose?.(); }, [chatId]);
  const handleEvent = (event: ChatEvent) => { if (event.type === "run.started" || event.type === "tool.started") { setActive(true); setTrace((items) => [...items, String(event.data.label ?? event.data.tool_name ?? "研究中")]); } if (event.type === "message.delta") setMessages((items) => { const last = items[items.length - 1]; if (last?.role === "assistant") return [...items.slice(0, -1), { ...last, content: last.content + String(event.data.delta ?? "") }]; return [...items, { id: `stream-${event.id}`, role: "assistant", content: String(event.data.delta ?? "") }]; }); if (event.type === "message.completed") setActive(false); if (event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.failed") setActive(false); if (event.type === "citation") setCitations((items) => [...items, event.data as never]); if (event.type === "run.failed") setError("研究失败"); };
  const send = async () => { if (!draft.trim()) return; try { const id = await ensureChat(); setMessages((items) => [...items, { id: `local-${Date.now()}`, role: "user", content: draft }]); setActive(true); await api.sendMessage(id, draft, crypto.randomUUID()); setDraft(""); } catch { setError("发送失败"); setActive(false); } };
  const stop = async () => { if (chatId) await api.stop(chatId); setActive(false); };
  return <main><header><h1>投资研究助手</h1><button onClick={() => { setChatId(undefined); setMessages([]); setTrace([]); }}>新建 chat</button></header>{!connected && <p role="status">连接已断开，正在重连…</p>}{error && <p role="alert">{error}</p>}<MessageList messages={messages} /><ResearchTrace items={trace} citations={citations} /><Composer value={draft} onChange={setDraft} onSend={send} onStop={stop} active={active} /></main>;
}
