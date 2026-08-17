import { useRef, useState } from "react";
import { ConversationPanel } from "../features/conversation/conversation-panel.js";
import { ResearchInspector } from "../features/inspector/research-inspector.js";
import type { InspectorTarget } from "../features/inspector/inspector-state.js";
import type { ResearchMessage } from "../features/conversation/use-research-run.js";

export function ResearchWorkbench({
  messages = [],
  draft = "",
  onDraftChange = () => {},
  onSend = () => {},
  onStop = () => {},
  running = false,
  threads = [],
  onSelectThread = () => {},
  onNewThread = () => {},
  inspector: initialInspector = null,
  error,
  connected = true,
  citations = [],
  inspectorRecords = [],
  interrupts = [],
  onResolveInterrupt,
  onCancelInterrupt,
  onRefreshInterrupts,
  onSaveArtifact,
  onVersionChange,
}: {
  messages?: ResearchMessage[];
  draft?: string;
  onDraftChange?: (value: string) => void;
  onSend?: () => void;
  onStop?: () => void;
  running?: boolean;
  threads?: Array<{ id: string; title?: string }>;
  onSelectThread?: (id: string) => void;
  onNewThread?: () => void;
  inspector?: InspectorTarget;
  error?: string;
  connected?: boolean;
  citations?: Array<{ id?: string; title: string; publishedAt: string; href: string }>;
  inspectorRecords?: Exclude<InspectorTarget, null>[];
  interrupts?: unknown[];
  onResolveInterrupt: (
    interrupt: unknown,
    payload: Record<string, unknown> & { approved: boolean; reason?: string },
  ) => Promise<void> | void;
  onCancelInterrupt: (interrupt: unknown) => Promise<void> | void;
  onRefreshInterrupts: () => Promise<void> | void;
  onSaveArtifact?: (id: string) => void;
  onVersionChange?: (id: string, version: string) => void;
}) {
  const [target, setTarget] = useState<InspectorTarget>(initialInspector);
  const previousFocus = useRef<HTMLElement | null>(null);
  const open = (next: InspectorTarget) => {
    previousFocus.current = document.activeElement as HTMLElement;
    setTarget(next);
  };
  const close = () => {
    setTarget(null);
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
  };
  const selectedTarget = target && (inspectorRecords.find((record) => record.kind === target.kind && record.id === target.id) ?? (initialInspector?.kind === target.kind && initialInspector.id === target.id ? initialInspector : null));
  return (
    <main className="research-workbench" aria-label="研究工作台">
      <header>
        <h1>投资研究助手</h1>
        <button onClick={onNewThread}>新建 chat</button>
      </header>
      {!connected && <p role="status">连接已断开，正在重连…</p>}
      {error && <p role="alert">{error}</p>}
      <aside aria-label="研究线程">
        <h2>线程</h2>
        {threads.length === 0 ? (
          <span>暂无 chat</span>
        ) : (
          threads.map((thread) => (
            <button key={thread.id} onClick={() => onSelectThread(thread.id)}>
              {thread.title ?? thread.id}
            </button>
          ))
        )}
      </aside>
      <section aria-label="研究对话">
        <ConversationPanel
          messages={messages}
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={onSend}
          onStop={onStop}
          running={running}
          interrupts={interrupts}
          onResolveInterrupt={onResolveInterrupt}
          onCancelInterrupt={onCancelInterrupt}
          onRefreshInterrupts={onRefreshInterrupts}
        />
        {citations.map((citation, index) => (
          <a
            href={citation.href}
            key={`${citation.id ?? citation.href}:${index}`}
            onClick={(event) => {
              event.preventDefault();
              const evidence = inspectorRecords.find((record) => record.kind === "evidence" && (record.id === citation.id || record.href === citation.href));
              open(evidence ?? {
                kind: "evidence",
                id: citation.id ?? citation.href,
                title: citation.title,
                href: citation.href,
                content: citation.publishedAt,
              });
            }}
          >
            {citation.publishedAt || citation.title}
          </a>
        ))}
      </section>
      <section aria-label="研究工具栏">
        {inspectorRecords.filter((record) => record.kind !== "evidence").map((record) => <button key={`${record.kind}:${record.id}`} onClick={() => open(record)}>{recordLabel(record)}</button>)}
      </section>
      <ResearchInspector target={selectedTarget} onClose={close} onSaveArtifact={onSaveArtifact} onVersionChange={onVersionChange} />
    </main>
  );
}

function recordLabel(record: Exclude<InspectorTarget, null>) {
  if (record.kind === "artifact" || record.kind === "evidence") return record.title ?? record.id;
  if (record.kind === "tool") return record.name;
  return record.impact ?? record.id;
}
