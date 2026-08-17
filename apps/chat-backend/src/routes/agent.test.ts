import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerAgentRoutes } from "./agent.js";

function setup() {
  const app = Fastify();
  const client = { listAguiEvents: vi.fn(async () => []), getAguiState: vi.fn(async () => ({ thread: { id: "t", title: "", title_source: "", title_locked: false, created_at: "now" }, last_event_seq: 0, runs: [] })) } as any;
  const controller = { start: vi.fn(async () => ({ run: { id: "r", status: "running" }, replayed: false, last_event_seq: 0, done: Promise.resolve() })), subscribe: vi.fn(() => () => undefined), stop: vi.fn(async () => ({ id: "r", status: "cancelled" })) } as any;
  return { app, client, controller };
}

describe("AG-UI agent routes", () => {
  it("validates idempotency and exposes replay/state", async () => {
    const { app, client, controller } = setup(); await registerAgentRoutes(app, client, controller);
    expect((await app.inject({ method: "POST", url: "/v1/threads/t/runs", payload: { input: "x" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/v1/threads/t/events?after=2" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/threads/t/state" })).statusCode).toBe(200);
    expect(client.listAguiEvents).toHaveBeenCalledWith("t", 2);
  });

  it("supports stop and standard run registration", async () => {
    const { app, controller } = setup(); await registerAgentRoutes(app, {} as any, controller);
    expect((await app.inject({ method: "POST", url: "/v1/threads/t/stop" })).statusCode).toBe(200);
    expect(controller.stop).toHaveBeenCalledWith("t");
  });

  it("serves standard and compatibility SSE paths and maps active conflict", async () => {
    const { app, client, controller } = setup();
    client.listAguiEvents.mockResolvedValue([{ thread_id: "t", sequence: 1, run_id: "r", type: "RUN_STARTED", data: {} }]);
    await registerAgentRoutes(app, client, controller);
    const standard = await app.inject({ method: "POST", url: "/v1/threads/t/runs", payload: { input: "x", idempotency_key: "k" } });
    expect(standard.statusCode).toBe(200); expect(standard.headers["content-type"]).toContain("text/event-stream");
    const alias = await app.inject({ method: "POST", url: "/v1/threads/t/runs/stream", payload: { input: "x", idempotency_key: "k2" } });
    expect(alias.statusCode).toBe(200); expect(controller.start).toHaveBeenCalledTimes(2);
    controller.start.mockRejectedValueOnce(new Error("thread already has an active run"));
    expect((await app.inject({ method: "POST", url: "/v1/threads/t/runs", payload: { input: "x", idempotency_key: "k3" } })).statusCode).toBe(409);
  });

  it("closes the replay-subscribe window with sequence de-duplication", async () => {
    const { app, client, controller } = setup(); let live: ((event: unknown) => void) | undefined;
    controller.subscribe.mockImplementation((_thread: string, listener: (event: unknown) => void) => { live = listener; return () => undefined; });
    client.listAguiEvents.mockImplementation(async () => { live?.({ thread_id: "t", sequence: 2, run_id: "r", type: "TEXT_MESSAGE_CONTENT", data: { delta: "live" } }); return [{ thread_id: "t", sequence: 1, run_id: "r", type: "RUN_STARTED", data: {} }, { thread_id: "t", sequence: 2, run_id: "r", type: "TEXT_MESSAGE_CONTENT", data: { delta: "replay" } }]; });
    await registerAgentRoutes(app, client, controller);
    const response = await app.inject({ method: "POST", url: "/v1/threads/t/runs", payload: { input: "x", idempotency_key: "k" } });
    expect(response.body.match(/TEXT_MESSAGE_CONTENT/g)?.length).toBe(1);
  });
});
