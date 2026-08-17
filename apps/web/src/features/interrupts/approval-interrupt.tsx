import { useCallback, useMemo, useState } from "react";

export type ApprovalInterrupt = {
  interruptId: string;
  runId: string;
  title?: string;
  description?: string;
  schema?: { type?: string; required?: string[]; properties?: Record<string, { type?: string; title?: string; description?: string; enum?: string[] }> };
  [key: string]: unknown;
};

export type InterruptActions = {
  resolve: (payload: { approved: boolean; reason?: string; [key: string]: unknown }) => Promise<void> | void;
  cancel: () => Promise<void> | void;
  refresh?: () => Promise<void> | void;
};

export type AguiResumeRequest = { run_id: string; interrupt_id: string; payload: Record<string, unknown> & { approved: boolean; reason?: string } };

export function createAguiResumeAdapter(interrupt: unknown, resume: (request: AguiResumeRequest) => Promise<void> | void, cancel: (request: Pick<AguiResumeRequest, "run_id" | "interrupt_id">) => Promise<void> | void): InterruptActions {
  const item = parseInterrupt(interrupt);
  if (!item || !item.runId) throw new Error("invalid_interrupt_payload");
  return { resolve: (payload) => resume({ run_id: item.runId, interrupt_id: item.interruptId, payload }), cancel: () => cancel({ run_id: item.runId, interrupt_id: item.interruptId }) };
}

/** The native interrupt contract is deliberately kept outside the chat transcript. */
export function useInterrupt(raw: unknown, actions: InterruptActions, options: { renderInChat?: boolean } = {}) {
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const interrupt = useMemo(() => parseInterrupt(raw), [raw]);
  const call = useCallback(async (fn: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (error) { if ((error as { status?: number }).status === 409) { setConflict(true); if (actions.refresh) { try { await actions.refresh(); setConflict(false); } catch { /* keep stale conflict */ } } return; } throw error; } finally { setBusy(false); }
  }, [busy]);
  return {
    interrupt,
    busy,
    conflict,
    renderInChat: options.renderInChat ?? false,
    resolve: (payload: { approved: boolean; reason?: string; [key: string]: unknown }) => call(() => actions.resolve(payload)),
    cancel: () => call(actions.cancel),
    refresh: actions.refresh ? () => call(actions.refresh!) : undefined,
  };
}

function parseInterrupt(raw: unknown): ApprovalInterrupt | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.interruptId !== "string" || !value.interruptId || typeof value.runId !== "string" || !value.runId) return null;
  return value as ApprovalInterrupt;
}

export function ApprovalInterruptView({ interrupt, actions }: { interrupt: unknown; actions: InterruptActions }) {
  const controller = useInterrupt(interrupt, actions, { renderInChat: false });
  const [reason, setReason] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  if (!controller.interrupt) return <p role="alert">无法识别的审批请求</p>;
  const item = controller.interrupt;
  return <aside aria-label="审批请求" data-render-in-chat="false">
    <h3>{item.title ?? "需要审批"}</h3>
    {controller.conflict && <p role="status">审批状态已刷新，请确认当前状态</p>}
    {item.description && <p>{item.description}</p>}
    {item.schema?.properties && Object.entries(item.schema.properties).map(([name, field]) => <label key={name}>{field.title ?? name}<input aria-label={field.title ?? name} required={field.type !== "boolean"} value={fields[name] ?? ""} onChange={(e) => setFields((old) => ({ ...old, [name]: e.target.value }))} disabled={controller.busy} /></label>)}
    <label>拒绝原因<input aria-label="拒绝原因" value={reason} onChange={(event) => setReason(event.target.value)} disabled={controller.busy} /></label>
    <div>
      <button type="button" onClick={() => controller.resolve({ approved: true, ...coerceFields(item.schema, fields) })} disabled={controller.busy || controller.conflict || (item.schema?.required ?? []).some((name) => !fields[name]?.trim()) || !schemaTypesValid(item.schema, fields)}>批准</button>
      <button type="button" onClick={() => controller.resolve({ approved: false, reason: reason.trim() || undefined })} disabled={controller.busy || controller.conflict}>拒绝</button>
      <button type="button" onClick={controller.cancel} disabled={controller.busy || controller.conflict}>取消</button>
    </div>
  </aside>;
}

function schemaTypesValid(schema: ApprovalInterrupt["schema"], fields: Record<string, string>) {
  return Object.entries(schema?.properties ?? {}).every(([name, field]) => {
    const value = fields[name]; if (!value) return true;
    if (field.enum && !field.enum.includes(value)) return false;
    if (field.type === "number" && Number.isNaN(Number(value))) return false;
    if (field.type === "boolean" && value !== "true" && value !== "false") return false;
    return !field.type || field.type === "string" || field.type === "number" || field.type === "boolean";
  });
}
function coerceFields(schema: ApprovalInterrupt["schema"], fields: Record<string, string>) { const out: Record<string, unknown> = {}; for (const [name, value] of Object.entries(fields)) { const type = schema?.properties?.[name]?.type; out[name] = type === "number" ? Number(value) : type === "boolean" ? value === "true" : value; } return out; }

export function parseApprovalInterrupts(outcome: unknown): ApprovalInterrupt[] {
  if (!outcome || typeof outcome !== "object") return [];
  const interrupts = (outcome as Record<string, unknown>).interrupts;
  return Array.isArray(interrupts) ? interrupts.map(parseInterrupt).filter((item): item is ApprovalInterrupt => item !== null) : [];
}
