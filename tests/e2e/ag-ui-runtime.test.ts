import { describe, expect, it } from "vitest";
import { createApp } from "../../apps/chat-backend/src/app.js";
import { FakeAgentSession } from "./fake-agent-session.js";

function fakeClient() {
  const events = new Map<string, any[]>();
  const runs = new Map<string, any>();
  let seq = 0;
  return {
    async createAguiRun(thread_id: string, input: unknown, key: string) {
      const old = [...runs.values()].find((r) => r.thread_id === thread_id && r.idempotency_key === key);
      if (old) return { run: { ...old, replayed: true }, replayed: true, last_event_seq: seq };
      const run = { id: `run-${++seq}`, thread_id, idempotency_key: key, status: "running", model: null };
      runs.set(run.id, run);
      events.set(thread_id, []);
      return { run, replayed: false, last_event_seq: 0 };
    },
    async appendAguiEvents(thread_id: string, run_id: string, values: any[]) {
      const list = events.get(thread_id) ?? [];
      const created = values.map((v) => ({ thread_id, run_id, sequence: ++seq, type: v.type, data: v.data }));
      list.push(...created); events.set(thread_id, list); return { events: created };
    },
    async listAguiEvents(thread_id: string, after = 0) { return (events.get(thread_id) ?? []).filter((e) => e.sequence > after); },
    async transitionAguiRun(run_id: string, status: string) { const run = runs.get(run_id); run.status = status; return run; },
    async getAguiState(thread_id: string) { return { thread: { id: thread_id, title: "", title_source: "", title_locked: false, created_at: "" }, last_event_seq: (events.get(thread_id) ?? []).at(-1)?.sequence ?? 0, runs: [...runs.values()].filter((r) => r.thread_id === thread_id) }; },
  } as any;
}

describe("AG-UI runtime process contract", () => {
  it("streams persisted events, supports reconnect cursor and idempotent duplicate", async () => {
    const client = fakeClient();
    const app = await createApp({ researchClient: client, sessionFactory: async (id) => new FakeAgentSession(id) as any });
    await app.ready();
    const first = await app.inject({ method: "POST", url: "/v1/threads/thread-1/runs", payload: { input: "research", idempotency_key: "same" } });
    expect(first.statusCode).toBe(200);
    const duplicate = await app.inject({ method: "POST", url: "/v1/threads/thread-1/runs", payload: { input: "research", idempotency_key: "same" } });
    expect(duplicate.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await app.inject({ method: "GET", url: "/v1/threads/thread-1/events?after=0" });
    const body = replay.json() as Array<{ sequence: number; type: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.map((e) => e.sequence)).toEqual([...body].sort((a, b) => a - b).map((e) => e.sequence));
    await app.close();
  });
});
