import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  it("crosses a child-process runtime boundary and preserves persisted SSE ids", async () => {
    const port = await freePort();
    const tsx = path.resolve("node_modules/.bin/tsx");
    const fixture = spawn(tsx, [path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime-upstream-fixture.ts"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const [line] = await once(fixture.stdout!, "data") as [Buffer];
    const upstreamPort = Number(line.toString().trim().split(":")[1]);
    const runtime = spawn(tsx, [path.resolve("apps/copilot-runtime/src/server.ts")], { env: { ...process.env, PORT: String(port), IRA_RESEARCH_SERVICE_URL: `http://127.0.0.1:${upstreamPort}`, IRA_RUNTIME_MAX_POLLS: "10" }, stdio: ["ignore", "pipe", "inherit"] });
    try {
      await waitFor(`http://127.0.0.1:${port}/health`);
      const response = await fetch(`http://127.0.0.1:${port}/agent/research-agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: "child-thread", input: "research" }) });
      const text = await response.text();
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
      expect(response.status).toBe(200);
      expect(ids.length).toBe(3);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect((text.match(/messageId/g) ?? []).length).toBe(1);
    } finally {
      runtime.kill("SIGTERM"); fixture.kill("SIGTERM");
      await Promise.allSettled([once(runtime, "exit"), once(fixture, "exit")]);
    }
  }, 20_000);

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

  it("replays only events after Last-Event-ID with monotonic ids", async () => {
    const client = fakeClient();
    const app = await createApp({ researchClient: client, sessionFactory: async (id) => new FakeAgentSession(id) as any });
    await app.ready();
    await app.inject({ method: "POST", url: "/v1/threads/thread-2/runs", payload: { input: "research", idempotency_key: "cursor" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const all = await app.inject({ method: "GET", url: "/v1/threads/thread-2/events?after=0" });
    const events = all.json() as Array<{ sequence: number }>;
    expect(events.length).toBeGreaterThan(0);
    const cursor = events[0]!.sequence;
    const resumed = await app.inject({ method: "GET", url: "/v1/threads/thread-2/events", headers: { "last-event-id": String(cursor) } });
    expect((resumed.json() as Array<{ sequence: number }>).every((event) => event.sequence > cursor)).toBe(true);
    await app.close();
  });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(url: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${url}`);
}
