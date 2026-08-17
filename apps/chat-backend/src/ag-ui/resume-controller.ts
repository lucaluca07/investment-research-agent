import { EventType, type AGUIEvent } from "@ag-ui/core";
import type { InterruptDecision, ResearchClient } from "../research-client.js";

/** Immutable context read from Research Service, never accepted from the browser. */
export type ResumeCheckpoint = {
  checkpoint_id: string; interrupt_id: string; run_id: string; operation_id: string; nonce?: string;
  tool_call_id?: string; tool_name?: string; input?: unknown; messages?: unknown[]; evidence?: unknown[];
  session_id?: string; session_revision?: number; session_storage_ref?: string;
};
export type ResumeOperationApi = {
  resolve(threadId: string, interruptId: string, nonce: string, status: "resolved" | "cancelled", payload: { approved: boolean }): Promise<InterruptDecision>;
  status(threadId: string, operationId: string): Promise<{ status: string; result?: unknown }>;
  begin(threadId: string, operationId: string): Promise<void>;
  complete(threadId: string, operationId: string, result: unknown): Promise<void>;
  fail?(threadId: string, operationId: string, error: unknown): Promise<void>;
};
export type RecoveryRun = { id: string };
export type ResumeRequest = {
  threadId: string; checkpointReader: () => Promise<ResumeCheckpoint>; decision: InterruptDecision;
  /** Creates a new persisted recovery_fallback run; no live Pi session is required. */
  createRecoveryRun: (context: { resumed_from_run_id: string; recovery: "recovery_fallback"; messages: unknown[]; evidence: unknown[]; tool_call_id?: string; tool_name?: string; decision: InterruptDecision }) => Promise<RecoveryRun>;
  execute: (input: unknown, toolName?: string) => Promise<unknown>;
  emit: (runId: string, event: AGUIEvent) => Promise<void>;
};

export class ResumeController {
  constructor(private readonly _client: ResearchClient, private readonly operations: ResumeOperationApi) {}

  async resume(request: ResumeRequest): Promise<{ operation_id: string; result: unknown; fallback: true; recovery_run_id: string }> {
    const checkpoint = await request.checkpointReader();
    const { decision } = request;
    if (checkpoint.interrupt_id !== decision.interrupt_id || checkpoint.operation_id !== decision.operation_id || checkpoint.checkpoint_id !== decision.checkpoint_id) throw new Error("resume decision does not match checkpoint");
    if (!decision.payload || typeof decision.payload.approved !== "boolean") throw new Error("invalid resume decision");
    const prior = await this.operations.status(request.threadId, checkpoint.operation_id);
    const receipt = prior.status === "succeeded"
      ? decision
      : await this.operations.resolve(request.threadId, checkpoint.interrupt_id, checkpoint.nonce ?? "", decision.status === "cancelled" ? "cancelled" : "resolved", decision.payload);
    const recovery = await request.createRecoveryRun({ resumed_from_run_id: checkpoint.run_id, recovery: "recovery_fallback", messages: checkpoint.messages ?? [], evidence: checkpoint.evidence ?? [], tool_call_id: checkpoint.tool_call_id, tool_name: checkpoint.tool_name, decision: receipt });
    let result: unknown;
    try {
      if (prior.status === "succeeded") result = prior.result;
      else if (!receipt.payload.approved || receipt.status === "cancelled") result = { status: receipt.status === "cancelled" ? "cancelled" : "rejected", approved: false };
      else {
        await this.operations.begin(request.threadId, checkpoint.operation_id);
        result = await request.execute(checkpoint.input, checkpoint.tool_name);
        await this.operations.complete(request.threadId, checkpoint.operation_id, result);
      }
    } catch (error) {
      await this.operations.fail?.(request.threadId, checkpoint.operation_id, { message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      await request.emit(recovery.id, { type: EventType.RUN_ERROR, runId: recovery.id, message: error instanceof Error ? error.message : "Recovery operation failed", code: "recovery_failed" } as AGUIEvent);
      throw error;
    }
    // Only replay the original ID. Recovery never synthesizes TOOL_CALL_START/ARGS/END.
    await request.emit(recovery.id, { type: EventType.TOOL_CALL_RESULT, toolCallId: checkpoint.tool_call_id ?? checkpoint.operation_id, content: JSON.stringify(result), role: "tool" } as AGUIEvent);
    await request.emit(recovery.id, { type: EventType.RUN_FINISHED, runId: recovery.id, outcome: { type: "success" } } as AGUIEvent);
    return { operation_id: checkpoint.operation_id, result, fallback: true, recovery_run_id: recovery.id };
  }
}
