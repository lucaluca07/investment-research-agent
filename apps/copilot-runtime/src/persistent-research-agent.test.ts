import { describe, expect, it, vi } from "vitest";
import { firstValueFrom, toArray } from "rxjs";
import { PersistentResearchAgent } from "./persistent-research-agent.js";

function response(value: unknown, init: ResponseInit = {}) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init }); }

describe("PersistentResearchAgent", () => {
  it("declares capabilities and rejects non-loopback", async () => {
    const agent = new PersistentResearchAgent({ baseUrl: "http://127.0.0.1:8020" });
    expect((await agent.getCapabilities()).transport?.streaming).toBe(true);
    expect(() => new PersistentResearchAgent({ baseUrl: "https://example.com" })).toThrow(/loopback/);
  });
  it("clones request messages and filters headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "RUN_STARTED", runId: "r" })}\n\n`)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const messages = [{ id: "m", role: "user", content: "hi" }] as any; const agent = new PersistentResearchAgent({ baseUrl: "http://127.0.0.1:8020", fetch: fetcher, headers: { authorization: "a", cookie: "no" } });
    await firstValueFrom(agent.run({ threadId: "t", runId: "r", messages } as any));
    expect(messages).toEqual([{ id: "m", role: "user", content: "hi" }]); expect(fetcher.mock.calls[0][1].headers).toMatchObject({ authorization: "a" });
  });
  it("replays events after cursor", async () => {
    const fetcher = vi.fn().mockImplementation((url: string) => url.includes("/state") ? response({ state: { x: 1 } }) : response([{ sequence: 1, data: { type: "RUN_STARTED", runId: "r" } }, { sequence: 2, data: { type: "RUN_FINISHED", runId: "r", outcome: { type: "interrupt", interrupts: [] } } }]));
    const agent = new PersistentResearchAgent({ baseUrl: "http://127.0.0.1:8020", fetch: fetcher, threadId: "t" });
    const events = await firstValueFrom((agent as any).connect({ threadId: "t", messages: [] }).pipe(toArray())); expect(events).toHaveLength(2); expect((agent as any).state.x).toBe(1);
  });
  it("aborts the persisted run by run id", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response({})));
    const agent = new PersistentResearchAgent({ baseUrl: "http://127.0.0.1:8020", fetch: fetcher });
    agent.run({ threadId: "t", runId: "run-1", messages: [] } as any).subscribe(); agent.abortRun(); await Promise.resolve();
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/v1/runs/run-1/transition") && (call[1].body as string).includes('"status":"cancelled"'))).toBe(true);
  });
  it("aborts in-flight stream when unsubscribed", async () => {
    let signal!: AbortSignal; const fetcher = vi.fn().mockImplementation((_url, init) => { signal = init.signal; return new Promise(() => undefined); });
    const agent = new PersistentResearchAgent({ baseUrl: "http://127.0.0.1:8020", fetch: fetcher }); const sub = agent.run({ threadId: "t", runId: "r", messages: [] } as any).subscribe(); await Promise.resolve(); sub.unsubscribe(); expect(signal.aborted).toBe(true);
  });
});
