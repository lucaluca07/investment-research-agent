import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { awaitDrain, registerResearchRuntime, streamAgentRun, takeSseEvents, writeFrame } from "./server.js";

describe("runtime listener", () => {
  const frame = (id: number, type: string, data: unknown) => [
    `id: ${id}`,
    `event: ${type}`,
    `data: ${JSON.stringify(data)}`,
    "",
    "",
  ].join("\n");

  it("serves health/info and streams interrupt outcome as SSE", async () => {
    const app = Fastify(); const fetchMock = vi.fn().mockImplementation((url: string) => url.includes("/runs") ? Promise.resolve(new Response(JSON.stringify({ run_id: "r" }), { status: 200 })) : Promise.resolve(new Response(frame(1, "RUN_FINISHED", { type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: "i" }] } }), { status: 200, headers: { "content-type": "text/event-stream" } })));
    vi.stubGlobal("fetch", fetchMock);
    app.get("/health", async () => ({ ok: true })); registerResearchRuntime(app, { researchUrl: "http://127.0.0.1:8010" }); await app.ready();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200); expect((await app.inject({ method: "GET", url: "/info" })).json().agents[0].name).toBe("research-agent");
    const result = await app.inject({ method: "POST", url: "/agent/research-agent/run", payload: { threadId: "t", messages: [] }, headers: { authorization: "ok", cookie: "blocked" } });
    expect(result.headers["content-type"]).toContain("text/event-stream"); expect(result.body).toContain("event: RUN_FINISHED"); expect(result.body).toContain('"type":"interrupt"'); expect(fetchMock.mock.calls[0][1].headers.cookie).toBeUndefined();
  });
  it("emits RUN_ERROR when event upstream fails", async () => {
    const app = Fastify(); vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => url.includes("/runs") ? Promise.resolve(new Response(JSON.stringify({ run_id: "r" }), { status: 200 })) : Promise.resolve(new Response("bad", { status: 503 }))));
    registerResearchRuntime(app, { researchUrl: "http://127.0.0.1:8010" }); await app.ready(); const result = await app.inject({ method: "POST", url: "/agent/research-agent/run", payload: { threadId: "t", messages: [] } }); expect(result.body).toContain("RUN_ERROR");
  });
  it("emits RUN_ERROR when run creation fails", async () => {
    const app = Fastify(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream unavailable", { status: 503 })));
    registerResearchRuntime(app, { researchUrl: "http://127.0.0.1:8010" }); await app.ready();
    const result = await app.inject({ method: "POST", url: "/agent/research-agent/run", payload: { threadId: "t" } });
    expect(result.body).toContain("RUN_ERROR"); expect(result.body).toContain("upstream unavailable");
  });
  it("does not forward cookie headers", async () => {
    const app = Fastify(); const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ run_id: "r" }), { status: 400 })); vi.stubGlobal("fetch", fetchMock); registerResearchRuntime(app, { researchUrl: "http://127.0.0.1:8010" }); await app.ready(); await app.inject({ method: "POST", url: "/agent/research-agent/run", headers: { cookie: "secret" }, payload: { threadId: "t" } }); expect(fetchMock.mock.calls[0][1].headers.cookie).toBeUndefined();
  });
  it("serves discovery on loopback listener", async () => {
    const app = Fastify(); registerResearchRuntime(app, { researchUrl: "http://127.0.0.1:8010" }); await app.ready(); const result = await app.inject({ method: "GET", url: "/info" }); expect(result.statusCode).toBe(200); expect(result.json().agents[0].name).toBe("research-agent");
  });
  it("unblocks backpressure wait on abort and close", async () => {
    const raw = { once: vi.fn(), off: vi.fn() }; const controller = new AbortController(); const pending = awaitDrain(raw, controller.signal); controller.abort(); await expect(pending).resolves.toBe(false); expect(raw.off).toHaveBeenCalled();
  });
  it("emits sequenced RUN_ERROR when the upstream SSE closes before a terminal event", async () => {
    const app = Fastify(); vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => url.includes("/runs") ? Promise.resolve(new Response(JSON.stringify({ run_id: "r" }), { status: 200 })) : Promise.resolve(new Response(frame(4, "RUN_STARTED", { type: "RUN_STARTED" }), { status: 200, headers: { "content-type": "text/event-stream" } })))); registerResearchRuntime(app, { researchUrl: "http://127.0.0.1:8010" }); await app.ready(); const result = await app.inject({ method: "POST", url: "/agent/research-agent/run", payload: { threadId: "t" } }); expect(result.body).toContain("event stream closed before a terminal event"); expect(result.body).toContain("id: 5");
  });

  it("parses fragmented named SSE frames and preserves the cursor", () => {
    const partial = takeSseEvents(["id: 7", "event: TEXT_MESSAGE_CONTENT", "data: {\"delta\":\"hel"].join("\n"));
    expect(partial.events).toEqual([]);
    const complete = takeSseEvents(`${partial.remainder}lo\"}\n\n${frame(8, "RUN_FINISHED", { type: "RUN_FINISHED" })}`);
    expect(complete.events).toEqual([{ id: 7, type: "TEXT_MESSAGE_CONTENT", data: { delta: "hello" } }, { id: 8, type: "RUN_FINISHED", data: { type: "RUN_FINISHED" } }]);
  });
  it("route stream uses abort-aware backpressure primitive", async () => {
    const raw = { once: vi.fn(), off: vi.fn() }; const controller = new AbortController(); const pending = awaitDrain(raw, controller.signal); controller.abort(); await expect(pending).resolves.toBe(false); expect(raw.once).toHaveBeenCalled(); expect(raw.off).toHaveBeenCalled();
  });

  it("aborts the events fetch and cleans listeners when the raw stream closes", async () => {
    const listeners = new Map<string, () => void>();
    const raw = {
      write: vi.fn(() => false),
      end: vi.fn(),
      once: vi.fn((name: string, fn: () => void) => listeners.set(name, fn)),
      off: vi.fn((name: string, fn: () => void) => { if (listeners.get(name) === fn) listeners.delete(name); }),
    };
    const controller = new AbortController();
    let eventsSignal!: AbortSignal;
    const fetcher = vi.fn().mockImplementation((url: string, init: RequestInit = {}) => {
      if (url.endsWith("/runs")) return Promise.resolve(new Response(JSON.stringify({ run_id: "r" }), { status: 200 }));
      eventsSignal = init.signal!;
      return Promise.resolve(new Response(JSON.stringify([{ sequence: 1, type: "RUN_STARTED", data: { type: "RUN_STARTED" } }]), { status: 200 }));
    });
    const pending = streamAgentRun({ researchUrl: "http://research", input: { threadId: "t" }, headers: {}, raw, signal: controller.signal, fetcher });
    await vi.waitFor(() => expect(eventsSignal).toBeDefined());
    controller.abort();
    listeners.get("close")?.();
    await pending;
    expect(eventsSignal.aborted).toBe(true);
    expect(raw.off).toHaveBeenCalled();
  });

  it("cleans drain listeners when raw close interrupts backpressure", async () => {
    const raw = { once: vi.fn(), off: vi.fn() };
    const controller = new AbortController();
    const pending = awaitDrain(raw, controller.signal);
    const close = raw.once.mock.calls.find(([name]) => name === "close")?.[1] as (() => void) | undefined;
    close?.();
    await expect(pending).resolves.toBe(false);
    expect(raw.off).toHaveBeenCalledWith("drain", expect.any(Function));
    expect(raw.off).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("uses drain for error frames when raw write applies backpressure", async () => {
    const raw = { write: vi.fn(() => false), once: vi.fn(), off: vi.fn() };
    const controller = new AbortController();
    const pending = writeFrame(raw, "error", controller.signal);
    const drain = raw.once.mock.calls.find(([name]) => name === "drain")?.[1] as (() => void) | undefined;
    expect(drain).toBeDefined(); drain?.();
    await expect(pending).resolves.toBe(true);
    expect(raw.off).toHaveBeenCalledWith("drain", expect.any(Function));
  });
});
