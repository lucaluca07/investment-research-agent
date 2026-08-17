import { isDeepStrictEqual } from "node:util";

import { EventType, type AGUIEvent } from "@ag-ui/core";

import type { AguiEvent, ResearchClient } from "../research-client.js";

type PersistableEvent = { type: string; data: Record<string, unknown> };
type AppendEventBatch = (
  threadId: string,
  runId: string,
  events: PersistableEvent[],
) => ReturnType<ResearchClient["appendAguiEvents"]>;

export type EventWriterOptions = {
  threadId: string;
  runId: string;
  appendEventBatch: AppendEventBatch;
  emit: (event: AguiEvent) => void | Promise<void>;
  flushIntervalMs?: number;
  maxTextBatchBytes?: number;
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: boolean;
};

export class EventWriter {
  private readonly threadId: string;
  private readonly runId: string;
  private readonly appendEventBatch: AppendEventBatch;
  private readonly emit: EventWriterOptions["emit"];
  private readonly flushIntervalMs: number;
  private readonly maxTextBatchBytes: number;
  private queue: Promise<void> = Promise.resolve();
  private pendingText: AGUIEvent[] = [];
  private pendingTextBytes = 0;
  private pendingAcks: Deferred[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private lastSequence: number | undefined;

  constructor(options: EventWriterOptions) {
    if (!options.threadId || !options.runId) throw new Error("threadId and runId are required");
    this.threadId = options.threadId;
    this.runId = options.runId;
    this.appendEventBatch = options.appendEventBatch;
    this.emit = options.emit;
    this.flushIntervalMs = options.flushIntervalMs ?? 50;
    this.maxTextBatchBytes = options.maxTextBatchBytes ?? 2048;
  }

  write(event: AGUIEvent): Promise<void> {
    if (this.closed) return Promise.reject(new Error("EventWriter is closed"));
    if (event.type !== EventType.TEXT_MESSAGE_CONTENT) {
      return this.enqueue(async () => {
        await this.persistPendingText();
        await this.persistAndEmit([event]);
      });
    }

    const ack = deferred();
    const prepared = this.enqueue(async () => {
      this.pendingText.push(event);
      this.pendingAcks.push(ack);
      this.pendingTextBytes += Buffer.byteLength(event.delta, "utf8");
      if (this.pendingTextBytes >= this.maxTextBatchBytes) {
        await this.persistPendingText();
      } else {
        this.ensureTimer();
      }
    });
    return prepared
      .catch((error) => {
        settleReject(ack, error);
      })
      .then(() => ack.promise);
  }

  flush(): Promise<void> {
    return this.enqueue(() => this.persistPendingText());
  }

  close(): Promise<void> {
    if (this.closed) return this.queue;
    this.closed = true;
    return this.enqueue(() => this.persistPendingText());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.queue.then(operation);
    this.queue = current.catch(() => undefined);
    return current;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, this.flushIntervalMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async persistPendingText(): Promise<void> {
    if (this.pendingText.length === 0) return;
    this.clearTimer();
    const events = this.pendingText;
    const acknowledgements = this.pendingAcks;
    this.pendingText = [];
    this.pendingAcks = [];
    this.pendingTextBytes = 0;
    try {
      await this.persistAndEmit(events);
      for (const ack of acknowledgements) settleResolve(ack);
    } catch (error) {
      for (const ack of acknowledgements) settleReject(ack, error);
      throw error;
    }
  }

  private async persistAndEmit(events: AGUIEvent[]): Promise<void> {
    const payload = events.map(toPersistableEvent);
    const persisted = await this.appendEventBatch(this.threadId, this.runId, payload);
    this.validatePersistenceResponse(payload, persisted.events);
    for (const event of persisted.events) await this.emit(event);
  }

  private validatePersistenceResponse(requested: PersistableEvent[], persisted: AguiEvent[]): void {
    if (persisted.length !== requested.length) invalidPersistenceResponse();
    let previousSequence = this.lastSequence;
    for (let index = 0; index < requested.length; index += 1) {
      const expected = requested[index];
      const actual = persisted[index];
      if (
        !actual
        || actual.thread_id !== this.threadId
        || actual.run_id !== this.runId
        || !Number.isInteger(actual.sequence)
        || actual.sequence < 0
        || (previousSequence !== undefined && actual.sequence !== previousSequence + 1)
        || actual.type !== expected.type
        || !isDeepStrictEqual(actual.data, expected.data)
      ) invalidPersistenceResponse();
      previousSequence = actual.sequence;
    }
    this.lastSequence = previousSequence;
  }
}

function toPersistableEvent(event: AGUIEvent): PersistableEvent {
  const { type, ...data } = event;
  return { type, data };
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const value: Deferred = {
    promise: new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: () => resolvePromise(),
    reject: (error) => rejectPromise(error),
    settled: false,
  };
  return value;
}

function settleResolve(value: Deferred): void {
  if (value.settled) return;
  value.settled = true;
  value.resolve();
}

function settleReject(value: Deferred, error: unknown): void {
  if (value.settled) return;
  value.settled = true;
  value.reject(error);
}

function invalidPersistenceResponse(): never {
  throw new Error("Invalid persistence response for AG-UI event batch");
}
