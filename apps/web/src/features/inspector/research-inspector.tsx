import type { InspectorTarget } from "./inspector-state.js";

export function ResearchInspector({ target, onClose, onSaveArtifact, onVersionChange }: { target: InspectorTarget; onClose: () => void; onSaveArtifact?: (id: string) => void; onVersionChange?: (id: string, version: string) => void }) {
  if (!target) return null;
  const heading = target.kind === "tool" ? target.name : (target.kind === "evidence" || target.kind === "artifact") ? target.title ?? target.kind : target.kind;
  return <aside aria-label="研究检查器" data-inspector-kind={target.kind} tabIndex={-1}>
    <header><h2>{heading}</h2><button type="button" aria-label="关闭检查器" onClick={onClose}>×</button></header>
    {target.kind === "evidence" && <section><h3>证据详情</h3>{target.href && <a href={target.href}>打开来源</a>}<p>{target.content ?? "暂无内容"}</p></section>}
    {target.kind === "artifact" && <section><h3>产物预览</h3><p data-artifact-body>{target.body ?? "暂无正文"}</p><dl><dt>版本</dt><dd>{target.version ?? "草稿"}</dd><dt>保存状态</dt><dd>{target.saved ? "已保存" : "未保存"}</dd></dl><button type="button" onClick={() => onSaveArtifact?.(target.id)}>保存</button><button type="button" onClick={() => onVersionChange?.(target.id, target.version ?? "草稿")}>切换版本</button></section>}
    {target.kind === "tool" && <section><h3>工具调用</h3><dl><dt>工具</dt><dd>{target.name}</dd><dt>参数</dt><dd><pre>{JSON.stringify(target.parameters ?? {}, null, 2)}</pre></dd><dt>结果</dt><dd><pre>{JSON.stringify(target.result ?? null, null, 2)}</pre></dd><dt>耗时</dt><dd>{target.durationMs ?? 0} ms</dd>{target.error && <><dt>错误</dt><dd role="alert">{target.error}</dd></>}</dl></section>}
    {target.kind === "approval" && <section><h3>审批请求</h3><dl><dt>影响</dt><dd>{target.impact ?? "未说明"}</dd><dt>决定</dt><dd>{target.decision ?? "待处理"}</dd></dl></section>}
  </aside>;
}
