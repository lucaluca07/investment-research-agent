import type { ChatMessage } from "../lib/chat-api.js";
export function MessageList({ messages }: { messages: ChatMessage[] }) {
  return <section aria-label="消息时间线">{messages.length === 0 ? <p>开始一项研究</p> : messages.map((message) => <article key={message.id} data-role={message.role}><strong>{message.role === "user" ? "你" : "研究助手"}</strong><p>{message.content}</p></article>)}</section>;
}
