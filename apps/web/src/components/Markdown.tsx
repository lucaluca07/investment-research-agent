import type React from "react";
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n"); const nodes: React.ReactNode[] = []; let code = false; let buffer: string[] = [];
  for (const [index, line] of lines.entries()) { if (line.startsWith("```")) { if (code) nodes.push(<pre key={`code-${index}`}><code>{buffer.join("\n")}</code></pre>); code = !code; buffer = []; } else if (code) buffer.push(line); else if (line.startsWith("# ")) nodes.push(<h2 key={index}>{line.slice(2)}</h2>); else if (line) nodes.push(<p key={index}>{line.split(/(`[^`]+`)/g).map((part, i) => part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part)}</p>); }
  return <div>{nodes}</div>;
}
