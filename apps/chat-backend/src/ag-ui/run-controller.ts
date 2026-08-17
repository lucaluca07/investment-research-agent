import { EventType, type AGUIEvent } from "@ag-ui/core";
import { PiEventAdapter } from "./pi-event-adapter.js";
import { EventWriter } from "./event-writer.js";
import type {
  AguiRun,
  InterruptCheckpoint,
  InterruptDecision,
  ResearchClient,
} from "../research-client.js";
import { ResumeController, type ResumeRequest } from "./resume-controller.js";

type Session = {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  abort?: () => Promise<void> | void;
};
export type RunControllerOptions = {
  client: ResearchClient;
  sessionFactory?: (threadId: string) => Promise<Session>;
  resumeController?: ResumeController;
  operationExecutor?: (
    toolName: string | undefined,
    input: unknown,
  ) => Promise<unknown>;
};
type Active = {
  run: AguiRun;
  session: Session;
  writer: EventWriter;
  unsubscribe: () => void;
  listeners: Set<(event: unknown) => void>;
  cancelled: boolean;
  terminal: boolean;
  eventWrites: Promise<void>;
  done: Promise<void>;
};

export class RunController {
  private readonly active = new Map<string, Active>();
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Set<string>();
  private readonly openInterrupts = new Map<string, Map<string, string>>();
  constructor(private readonly options: RunControllerOptions) {}

  subscribe(threadId: string, listener: (event: unknown) => void): () => void {
    const run = this.active.get(threadId);
    if (!run) return () => undefined;
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  getActive(threadId: string): AguiRun | undefined {
    return this.active.get(threadId)?.run;
  }
  registerInterrupt(
    threadId: string,
    interruptId: string,
    runId: string,
  ): void {
    let set = this.openInterrupts.get(threadId);
    if (!set) {
      set = new Map();
      this.openInterrupts.set(threadId, set);
    }
    set.set(interruptId, runId);
  }
  async resume(
    request: ResumeRequest,
  ): Promise<Awaited<ReturnType<ResumeController["resume"]>>> {
    return this.resumer().resume(request);
  }
  async resumeRecovery(
    request: Omit<ResumeRequest, "createRecoveryRun" | "execute" | "emit">,
  ): Promise<Awaited<ReturnType<ResumeController["resume"]>>> {
    const result = await this.resumer().resume({
      ...request,
      createRecoveryRun: async (context) => {
        const created = await this.options.client.createAguiRun(
          request.threadId,
          context,
          `recovery:${request.decision.receipt_id || request.decision.checkpoint_id}`,
        );
        return { id: created.run.id };
      },
      execute: async (input, toolName) => {
        if (!this.options.operationExecutor)
          throw new Error("no server-side operation executor is configured");
        return this.options.operationExecutor(toolName, input);
      },
      emit: async (runId, event) => {
        const writer = new EventWriter({
          threadId: request.threadId,
          runId,
          appendEventBatch: (t, r, events) =>
            this.options.client.appendAguiEvents(t, r, events),
          emit: () => undefined,
        });
        await writer.write(event);
        await writer.flush();
        if (event.type === EventType.RUN_FINISHED)
          await this.options.client.transitionAguiRun(
            runId,
            "completed",
            undefined,
            false,
          );
        if (event.type === EventType.RUN_ERROR)
          await this.options.client.transitionAguiRun(
            runId,
            "failed",
            {
              message: (event as any).message ?? "Recovery failed",
              retryable: false,
            },
            false,
          );
      },
    });
    return result;
  }

  async resumeRecoverySet(request: {
    threadId: string;
    checkpoints: InterruptCheckpoint[];
    decisions: InterruptDecision[];
  }): Promise<{
    recovery_run_id: string;
    results: Array<{ operation_id: string; result: unknown }>;
  }> {
    if (
      !request.checkpoints.length ||
      request.checkpoints.length !== request.decisions.length
    )
      throw new Error("resume decision set must cover every checkpoint");
    const decisions = new Map(
      request.decisions.map((decision) => [decision.interrupt_id, decision]),
    );
    if (decisions.size !== request.decisions.length)
      throw new Error("duplicate resume decision");
    for (const checkpoint of request.checkpoints) {
      const decision = decisions.get(checkpoint.interrupt_id);
      if (
        !decision ||
        decision.operation_id !== checkpoint.operation_id ||
        decision.checkpoint_id !== checkpoint.checkpoint_id ||
        decision.run_id !== checkpoint.run_id
      )
        throw new Error("resume decision does not match checkpoint");
    }
    const first = request.checkpoints[0]!;
    const context = {
      resumed_from_run_id: first.run_id,
      recovery: "recovery_fallback" as const,
      messages: uniqueContext(
        request.checkpoints.flatMap((checkpoint) => checkpoint.messages ?? []),
      ),
      evidence: uniqueContext(
        request.checkpoints.flatMap((checkpoint) => checkpoint.evidence ?? []),
      ),
      tool_calls: request.checkpoints.map((checkpoint) => ({
        tool_call_id: checkpoint.tool_call_id,
        tool_name: checkpoint.tool_name,
        input: checkpoint.input,
      })),
      decisions: request.decisions,
    };
    const receiptKey = request.decisions
      .map((decision) => decision.receipt_id)
      .sort()
      .join(":");
    const created = await this.options.client.createAguiRun(
      request.threadId,
      context,
      `recovery-set:${receiptKey}`,
    );
    const runId = created.run.id;
    if (created.replayed && created.run.status === "completed") {
      const results = await Promise.all(
        request.checkpoints.map(async (checkpoint) => {
          const operation = await this.options.client.operationStatus(
            request.threadId,
            checkpoint.operation_id,
          );
          return {
            operation_id: checkpoint.operation_id,
            result: operation.result,
          };
        }),
      );
      return { recovery_run_id: runId, results };
    }
    if (created.replayed) {
      throw new Error(
        created.run.status === "running" || created.run.status === "pending"
          ? "durable recovery is already in progress"
          : "durable recovery requires manual review",
      );
    }
    const writer = new EventWriter({
      threadId: request.threadId,
      runId,
      appendEventBatch: (threadId, id, events) =>
        this.options.client.appendAguiEvents(threadId, id, events),
      emit: () => undefined,
    });
    const results: Array<{ operation_id: string; result: unknown }> = [];
    try {
      for (const checkpoint of request.checkpoints) {
        const decision = decisions.get(checkpoint.interrupt_id)!;
        const prior = await this.options.client.operationStatus(
          request.threadId,
          checkpoint.operation_id,
        );
        let result: unknown;
        if (prior.status === "succeeded") result = prior.result;
        else if (
          !decision.payload.approved ||
          decision.status === "cancelled" ||
          prior.status === "rejected" ||
          prior.status === "cancelled"
        )
          result = {
            status: decision.status === "cancelled" ? "cancelled" : "rejected",
            approved: false,
          };
        else {
          if (!this.options.operationExecutor)
            throw new Error("no server-side operation executor is configured");
          await this.options.client.beginOperation(
            request.threadId,
            checkpoint.operation_id,
          );
          result = await this.options.operationExecutor(
            checkpoint.tool_name,
            checkpoint.input,
          );
          await this.options.client.completeOperation(
            request.threadId,
            checkpoint.operation_id,
            result,
          );
        }
        results.push({ operation_id: checkpoint.operation_id, result });
        await writer.write({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: checkpoint.tool_call_id ?? checkpoint.operation_id,
          content: JSON.stringify(result),
          role: "tool",
        } as AGUIEvent);
      }
      await writer.flush();
      await this.options.client.transitionAguiRun(
        runId,
        "completed",
        undefined,
        true,
        {
          type: EventType.RUN_FINISHED,
          data: { runId, outcome: { type: "success" } },
        },
      );
      return { recovery_run_id: runId, results };
    } catch (error) {
      const current = request.checkpoints[results.length];
      if (current)
        await this.options.client
          .completeOperationError?.(request.threadId, current.operation_id, {
            message: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      await writer.flush().catch(() => undefined);
      await this.options.client.transitionAguiRun(
        runId,
        "failed",
        {
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
        true,
        {
          type: EventType.RUN_ERROR,
          data: {
            runId,
            message: error instanceof Error ? error.message : "Recovery failed",
            code: "recovery_failed",
          },
        },
      );
      throw error;
    }
  }

  async start(
    threadId: string,
    input: unknown,
    idempotencyKey: string,
    model?: string,
  ): Promise<{
    run: AguiRun;
    replayed: boolean;
    last_event_seq: number;
    done: Promise<void>;
  }> {
    const persistedInterrupts =
      (await this.options.client.listOpenInterrupts?.(threadId)) ?? [];
    const pendingInterrupts = persistedInterrupts.length
      ? new Map(
          persistedInterrupts.map((item: any) => [
            item.interrupt_id,
            item.run_id,
          ]),
        )
      : this.openInterrupts.get(threadId);
    if (pendingInterrupts?.size) {
      const message = "open interrupt requires resume";
      const runId = pendingInterrupts.values().next().value as string;
      await this.options.client.appendAguiEvents(threadId, runId, [
        {
          type: EventType.RUN_ERROR,
          data: { runId, message, code: "open_interrupt" },
        },
      ]);
      throw new Error(message);
    }
    const current = this.active.get(threadId);
    if (current || this.starting.has(threadId))
      throw new Error("thread already has an active run");
    this.starting.add(threadId);
    let created;
    try {
      created = await this.options.client.createAguiRun(
        threadId,
        input,
        idempotencyKey,
        model,
      );
    } catch (error) {
      this.starting.delete(threadId);
      throw error;
    }
    if (
      created.replayed ||
      ["completed", "failed", "cancelled"].includes(created.run.status)
    ) {
      this.starting.delete(threadId);
      return { ...created, done: Promise.resolve() };
    }
    let session: Session;
    try {
      session = await this.getSession(threadId);
    } catch (error) {
      this.starting.delete(threadId);
      const message =
        error instanceof Error
          ? error.message
          : "session initialization failed";
      await this.options.client.appendAguiEvents(threadId, created.run.id, [
        {
          type: EventType.RUN_ERROR,
          data: { runId: created.run.id, message, code: "run_failed" },
        },
      ]);
      await this.options.client.transitionAguiRun(
        created.run.id,
        "failed",
        { message, retryable: false },
        false,
      );
      throw error;
    }
    const listeners = new Set<(event: unknown) => void>();
    const writer = new EventWriter({
      threadId,
      runId: created.run.id,
      appendEventBatch: (t, r, e) =>
        this.options.client.appendAguiEvents(t, r, e),
      emit: (event) => {
        for (const listener of listeners) listener(event);
      },
    });
    const adapter = new PiEventAdapter();
    let eventWrites = Promise.resolve();
    const active: Active = {
      run: created.run,
      session,
      writer,
      unsubscribe: () => undefined,
      listeners,
      cancelled: false,
      terminal: false,
      eventWrites,
      done: Promise.resolve(),
    };
    try {
      active.unsubscribe = session.subscribe((piEvent) => {
        for (const event of adapter.adapt(piEvent))
          eventWrites = eventWrites.then(() => writer.write(event));
        active.eventWrites = eventWrites;
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "session subscription failed";
      this.starting.delete(threadId);
      this.sessions.delete(threadId);
      await this.options.client.appendAguiEvents(threadId, created.run.id, [
        {
          type: EventType.RUN_ERROR,
          data: { runId: created.run.id, message, code: "run_failed" },
        },
      ]);
      await this.options.client.transitionAguiRun(
        created.run.id,
        "failed",
        { message, retryable: false },
        false,
      );
      throw error;
    }
    this.active.set(threadId, active);
    this.starting.delete(threadId);
    active.done = this.execute(threadId, active, input);
    return { ...created, done: active.done };
  }

  async stop(threadId: string): Promise<AguiRun> {
    const active = this.active.get(threadId);
    if (!active) throw new Error("thread has no active run");
    if (active.terminal) {
      await active.done;
      return active.run;
    }
    active.cancelled = true;
    try {
      await active.session.abort?.();
    } catch {
      /* cancellation remains durable */
    }
    if (!active.terminal) {
      active.terminal = true;
      await active.eventWrites.catch(() => undefined);
      await this.options.client.transitionAguiRun(
        active.run.id,
        "cancelled",
        { code: "run_cancelled", retryable: false },
        false,
      );
      active.run = { ...active.run, status: "cancelled" };
      await active.writer.write({
        type: EventType.RUN_ERROR,
        runId: active.run.id,
        message: "Run cancelled",
        code: "run_cancelled",
      } as AGUIEvent);
      await active.writer.flush();
    }
    await active.done;
    return { ...active.run, status: "cancelled" };
  }

  private async execute(
    threadId: string,
    active: Active,
    input: unknown,
  ): Promise<void> {
    try {
      await active.session.prompt(promptText(input));
      await active.eventWrites;
      if (!active.cancelled && !active.terminal) {
        active.terminal = true;
        await active.writer.write({
          type: EventType.RUN_FINISHED,
          runId: active.run.id,
          outcome: { type: "success" },
        } as AGUIEvent);
        await this.options.client.transitionAguiRun(
          active.run.id,
          "completed",
          undefined,
          false,
        );
        active.run = { ...active.run, status: "completed" };
      }
    } catch (error) {
      if (!active.cancelled && !active.terminal) {
        active.terminal = true;
        await this.options.client.transitionAguiRun(
          active.run.id,
          "failed",
          {
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
          false,
        );
        active.run = { ...active.run, status: "failed" };
        await active.writer.write({
          type: EventType.RUN_ERROR,
          runId: active.run.id,
          message: error instanceof Error ? error.message : "Run failed",
          code: "run_failed",
        } as AGUIEvent);
      }
      this.sessions.delete(threadId);
    } finally {
      await active.writer.flush().catch(() => undefined);
      active.unsubscribe();
      this.active.delete(threadId);
    }
  }

  private async getSession(threadId: string): Promise<Session> {
    const cached = this.sessions.get(threadId);
    if (cached) return cached;
    const session = await (this.options.sessionFactory
      ? this.options.sessionFactory(threadId)
      : Promise.reject(new Error("sessionFactory is required")));
    this.sessions.set(threadId, session);
    return session;
  }
  private resumer(): ResumeController {
    return (
      this.options.resumeController ??
      new ResumeController(this.options.client, {
        resolve: async (threadId, interruptId, nonce, status, payload) =>
          this.options.client.resolveInterrupt(threadId, interruptId, {
            nonce,
            status,
            payload,
          }),
        status: (threadId, operationId) =>
          this.options.client.operationStatus(threadId, operationId),
        begin: async (threadId, operationId) => {
          await this.options.client.beginOperation(threadId, operationId);
        },
        complete: async (threadId, operationId, result) => {
          await this.options.client.completeOperation(
            threadId,
            operationId,
            result,
          );
        },
        fail: async (threadId, operationId, error) => {
          await (this.options.client as any).completeOperationError?.(
            threadId,
            operationId,
            error,
          );
        },
      })
    );
  }
}

function promptText(input: unknown): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const last = [...input]
      .reverse()
      .find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          (item as any).role === "user",
      );
    if (last && typeof (last as any).content === "string")
      return (last as any).content;
  }
  if (
    input &&
    typeof input === "object" &&
    typeof (input as any).content === "string"
  )
    return (input as any).content;
  return JSON.stringify(input);
}

function uniqueContext(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value) ?? "undefined";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
