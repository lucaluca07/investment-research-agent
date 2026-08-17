export type InspectorTarget =
  | { kind: "evidence"; id: string; title?: string; content?: string; href?: string }
  | { kind: "artifact"; id: string; title?: string; body?: string; version?: string; saved?: boolean }
  | { kind: "tool"; id: string; name: string; parameters?: unknown; result?: unknown; durationMs?: number; error?: string }
  | { kind: "approval"; id: string; runId: string; impact?: string; decision?: string }
  | null;

export function openInspector(target: InspectorTarget): InspectorTarget { return target; }
export function closeInspector(): null { return null; }
