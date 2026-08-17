import { EventType, type AGUIEvent } from "@ag-ui/core";
import type { InterruptDecision, ResearchClient } from "../research-client.js";
import { getResearchSessionMetadata, validateSessionStoragePath } from "../pi/research-session.js";

export type ResumeCheckpoint = {
  checkpoint_id: string; interrupt_id: string; run_id: string; operation_id: string;
  session_id?: string; session_revision?: number; session_storage_path?: string;
  tool_call_id?: string; tool_name?: string; input?: unknown; messages?: unknown[];
};
export type ResumeOperationApi = { resolve(threadId: string, interruptId: string, nonce: string, status: "resolved"|"cancelled", payload: { approved: boolean }): Promise<InterruptDecision>; status(threadId: string, operationId: string): Promise<{ status: string; result?: unknown }>; begin(threadId: string, operationId: string): Promise<void>; complete(threadId: string, operationId: string, result: unknown): Promise<void> };
export type ResumeRequest = { threadId: string; checkpointReader: () => Promise<ResumeCheckpoint>; decision: InterruptDecision; session: ResumeSession; execute?: (input: unknown, toolName?: string) => Promise<unknown>; emit: (event: AGUIEvent) => Promise<void> | void };
export type ResumeSession = { restore?: (revision: number) => Promise<void> | void; inject?: (text: string) => Promise<void> | void; prompt?: (text: string) => Promise<void>; subscribe?: (listener: (event: unknown) => void) => () => void };

export class ResumeController {
  constructor(private readonly client: ResearchClient, private readonly operations?: ResumeOperationApi) {}

  async resume(request: ResumeRequest): Promise<{ operation_id: string; result: unknown; fallback: boolean; events: AGUIEvent[] }> {
    const checkpoint = await request.checkpointReader();
    const { decision } = request;
    if (checkpoint.interrupt_id !== decision.interrupt_id || checkpoint.operation_id !== decision.operation_id || checkpoint.checkpoint_id !== decision.checkpoint_id) throw new Error("resume decision does not match checkpoint");
    if (!decision.payload || typeof decision.payload.approved !== "boolean") throw new Error("invalid resume decision");
    if (!this.operations) throw new Error("resume operation API is required");
    if (checkpoint.session_id && checkpoint.session_id !== (getResearchSessionMetadata(request.session)?.sessionId)) throw new Error("checkpoint session mismatch");
    if (checkpoint.session_revision !== undefined && (!Number.isInteger(checkpoint.session_revision) || checkpoint.session_revision < 0)) throw new Error("invalid checkpoint revision");
    if (checkpoint.session_storage_path) validateSessionStoragePath(process.env.IRA_RUNTIME_DIR ?? `${process.cwd()}/.ira-runtime`, checkpoint.session_storage_path);
    if (checkpoint.tool_call_id && checkpoint.tool_name === undefined) throw new Error("checkpoint tool mapping missing");
    const current = await this.operations.status(request.threadId, checkpoint.operation_id);
    if (current.status === "succeeded") {
      const replay = { type: EventType.TOOL_CALL_RESULT, toolCallId: checkpoint.tool_call_id ?? checkpoint.operation_id, content: JSON.stringify(current.result), role: "tool" } as AGUIEvent;
      await request.emit(replay);
      await request.session.inject?.(`Resume result: ${JSON.stringify(current.result)}`);
      return { operation_id: checkpoint.operation_id, result: current.result, fallback: false, events: [replay] };
    }
    // Resolve first so the Research Service remains the atomic owner of operation state.
    const nonce = String((checkpoint as any).nonce ?? (decision as any).nonce ?? "");
    const resolved = await this.operations.resolve(request.threadId, checkpoint.interrupt_id, nonce, decision.status === "cancelled" ? "cancelled" : "resolved", decision.payload);
    const approved = resolved.payload.approved && resolved.status === "resolved";
    let result: unknown = { approved, operation_id: checkpoint.operation_id };
    if (approved) {
      try {
        await this.operations.begin(request.threadId, checkpoint.operation_id);
        await request.session.restore?.(checkpoint.session_revision ?? 0); result = request.execute ? await request.execute(checkpoint.input, checkpoint.tool_name) : result;
        await this.operations.complete(request.threadId, checkpoint.operation_id, result);
      }
      catch { result = { status: "recovery_fallback", messages: checkpoint.messages ?? [], tool_call_id: checkpoint.tool_call_id, tool_name: checkpoint.tool_name, input: checkpoint.input, decision: resolved.payload, result }; }
    } else result = { status: resolved.status === "cancelled" ? "cancelled" : "rejected", approved: false };
    const events: AGUIEvent[] = [{ type: EventType.TOOL_CALL_RESULT, toolCallId: checkpoint.tool_call_id ?? checkpoint.operation_id, content: JSON.stringify(result), role: "tool" } as AGUIEvent];
    await request.emit(events[0]);
    await request.session.inject?.(`Resume result: ${JSON.stringify(result)}`);
    return { operation_id: checkpoint.operation_id, result, fallback: Boolean((result as any)?.status === "recovery_fallback"), events };
  }

  static assertSessionPath(session: unknown, expectedSessionId?: string): void {
    const metadata = getResearchSessionMetadata(session);
    if (!metadata || (expectedSessionId && metadata.sessionId !== expectedSessionId)) throw new Error("invalid Pi session metadata");
    if (!metadata.storagePath.includes(`${"sessions"}`)) throw new Error("invalid Pi session storage path");
  }
}
