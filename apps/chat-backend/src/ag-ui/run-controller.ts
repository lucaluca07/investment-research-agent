import { EventType, type AGUIEvent } from "@ag-ui/core";
import { PiEventAdapter } from "./pi-event-adapter.js";
import { EventWriter } from "./event-writer.js";
import type { AguiRun, ResearchClient } from "../research-client.js";
import { ResumeController, type ResumeRequest } from "./resume-controller.js";

type Session = { prompt(text: string): Promise<void>; subscribe(listener: (event: unknown) => void): () => void; abort?: () => Promise<void> | void };
export type RunControllerOptions = { client: ResearchClient; sessionFactory?: (threadId: string) => Promise<Session>; resumeController?: ResumeController };
type Active = { run: AguiRun; session: Session; writer: EventWriter; unsubscribe: () => void; listeners: Set<(event: unknown) => void>; cancelled: boolean; terminal: boolean; eventWrites: Promise<void>; done: Promise<void> };

export class RunController {
  private readonly active = new Map<string, Active>();
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Set<string>();
  private readonly openInterrupts = new Map<string, Set<string>>();
  constructor(private readonly options: RunControllerOptions) {}

  subscribe(threadId: string, listener: (event: unknown) => void): () => void {
    const run = this.active.get(threadId); if (!run) return () => undefined;
    run.listeners.add(listener); return () => run.listeners.delete(listener);
  }

  getActive(threadId: string): AguiRun | undefined { return this.active.get(threadId)?.run; }
  registerInterrupt(threadId: string, interruptId: string): void { let set=this.openInterrupts.get(threadId); if(!set){set=new Set();this.openInterrupts.set(threadId,set);} set.add(interruptId); }
  async resume(request: ResumeRequest): Promise<Awaited<ReturnType<ResumeController["resume"]>>> { const result=await (this.options.resumeController ?? new ResumeController(this.options.client)).resume(request); return result; }
  async resumeActive(request: Omit<ResumeRequest, "session"|"emit">): Promise<Awaited<ReturnType<ResumeController["resume"]>>> {
    const active = this.active.get(request.threadId); if (!active) throw new Error("thread has no active run");
    const result = await (this.options.resumeController ?? new ResumeController(this.options.client)).resume({ ...request, session: active.session, emit: async (event) => { await active.writer.write(event); } });
    await active.session.prompt(`Continue interrupted research operation ${result.operation_id}`);
    return result;
  }

  async start(threadId: string, input: unknown, idempotencyKey: string, model?: string): Promise<{ run: AguiRun; replayed: boolean; last_event_seq: number; done: Promise<void> }> {
    if (this.openInterrupts.get(threadId)?.size) {
      const message = "open interrupt requires resume";
      const runId = `rejected-${Date.now()}`;
      await this.options.client.appendAguiEvents(threadId, runId, [{ type: EventType.RUN_ERROR, data: { runId, message, code: "open_interrupt" } }]);
      throw new Error(message);
    }
    const current = this.active.get(threadId); if (current || this.starting.has(threadId)) throw new Error("thread already has an active run");
    this.starting.add(threadId);
    let created;
    try { created = await this.options.client.createAguiRun(threadId, input, idempotencyKey, model); }
    catch (error) { this.starting.delete(threadId); throw error; }
    if (created.replayed || ["completed", "failed", "cancelled"].includes(created.run.status)) { this.starting.delete(threadId); return { ...created, done: Promise.resolve() }; }
    let session: Session;
    try { session = await this.getSession(threadId); }
    catch (error) {
      this.starting.delete(threadId);
      const message = error instanceof Error ? error.message : "session initialization failed";
      await this.options.client.appendAguiEvents(threadId, created.run.id, [{ type: EventType.RUN_ERROR, data: { runId: created.run.id, message, code: "run_failed" } }]);
      await this.options.client.transitionAguiRun(created.run.id, "failed", { message, retryable: false }, false);
      throw error;
    }
    const listeners = new Set<(event: unknown) => void>();
    const writer = new EventWriter({ threadId, runId: created.run.id, appendEventBatch: (t, r, e) => this.options.client.appendAguiEvents(t, r, e), emit: (event) => { for (const listener of listeners) listener(event); } });
    const adapter = new PiEventAdapter();
    let eventWrites = Promise.resolve();
    const active: Active = { run: created.run, session, writer, unsubscribe: () => undefined, listeners, cancelled: false, terminal: false, eventWrites, done: Promise.resolve() };
    try {
      active.unsubscribe = session.subscribe((piEvent) => { for (const event of adapter.adapt(piEvent)) eventWrites = eventWrites.then(() => writer.write(event)); active.eventWrites = eventWrites; });
    } catch (error) {
      const message = error instanceof Error ? error.message : "session subscription failed";
      this.starting.delete(threadId); this.sessions.delete(threadId);
      await this.options.client.appendAguiEvents(threadId, created.run.id, [{ type: EventType.RUN_ERROR, data: { runId: created.run.id, message, code: "run_failed" } }]);
      await this.options.client.transitionAguiRun(created.run.id, "failed", { message, retryable: false }, false);
      throw error;
    }
    this.active.set(threadId, active);
    this.starting.delete(threadId);
    active.done = this.execute(threadId, active, input);
    return { ...created, done: active.done };
  }

  async stop(threadId: string): Promise<AguiRun> {
    const active = this.active.get(threadId); if (!active) throw new Error("thread has no active run");
    if (active.terminal) { await active.done; return active.run; }
    active.cancelled = true;
    try { await active.session.abort?.(); } catch { /* cancellation remains durable */ }
    if (!active.terminal) {
      active.terminal = true;
      await active.eventWrites.catch(() => undefined);
      await this.options.client.transitionAguiRun(active.run.id, "cancelled", { code: "run_cancelled", retryable: false }, false);
      active.run = { ...active.run, status: "cancelled" };
      await active.writer.write({ type: EventType.RUN_ERROR, runId: active.run.id, message: "Run cancelled", code: "run_cancelled" } as AGUIEvent);
      await active.writer.flush();
    }
    await active.done;
    return { ...active.run, status: "cancelled" };
  }

  private async execute(threadId: string, active: Active, input: unknown): Promise<void> {
    try {
      await active.session.prompt(promptText(input));
      await active.eventWrites;
      if (!active.cancelled && !active.terminal) {
        active.terminal = true;
        await active.writer.write({ type: EventType.RUN_FINISHED, runId: active.run.id, outcome: { type: "success" } } as AGUIEvent);
        await this.options.client.transitionAguiRun(active.run.id, "completed", undefined, false);
        active.run = { ...active.run, status: "completed" };
      }
    } catch (error) {
      if (!active.cancelled && !active.terminal) {
        active.terminal = true;
        await this.options.client.transitionAguiRun(active.run.id, "failed", { message: error instanceof Error ? error.message : String(error), retryable: false }, false);
        active.run = { ...active.run, status: "failed" };
        await active.writer.write({ type: EventType.RUN_ERROR, runId: active.run.id, message: error instanceof Error ? error.message : "Run failed", code: "run_failed" } as AGUIEvent);
      }
      this.sessions.delete(threadId);
    } finally {
      await active.writer.flush().catch(() => undefined);
      active.unsubscribe(); this.active.delete(threadId);
    }
  }

  private async getSession(threadId: string): Promise<Session> { const cached = this.sessions.get(threadId); if (cached) return cached; const session = await (this.options.sessionFactory ? this.options.sessionFactory(threadId) : Promise.reject(new Error("sessionFactory is required"))); this.sessions.set(threadId, session); return session; }
}

function promptText(input: unknown): string { if (typeof input === "string") return input; if (Array.isArray(input)) { const last = [...input].reverse().find((item) => item && typeof item === "object" && "role" in item && (item as any).role === "user"); if (last && typeof (last as any).content === "string") return (last as any).content; } if (input && typeof input === "object" && typeof (input as any).content === "string") return (input as any).content; return JSON.stringify(input); }
