// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useResearchRun } from "./use-research-run.js";

describe("useResearchRun", () => {
  it("adds a stable user id and rotates key only after success", async () => {
    const client = { runAgent: vi.fn().mockResolvedValue(undefined), cancelAgent: vi.fn() };
    const { result } = renderHook(() => useResearchRun(client, "t"));
    act(() => { result.current.setDraft("hello"); }); await act(async () => { await result.current.send(); });
    expect(client.runAgent).toHaveBeenCalledOnce(); expect(result.current.messages[0]?.role).toBe("user");
  });
  it("dedupes replay sequences and handles cancellation", async () => {
    const client = { runAgent: vi.fn().mockResolvedValue(undefined), cancelAgent: vi.fn().mockResolvedValue(undefined) };
    const { result } = renderHook(() => useResearchRun(client, "t"));
    act(() => result.current.replay([{ type: "TEXT_MESSAGE_CONTENT", sequence: 1, data: { message_id: "a", delta: "x" } }, { type: "TEXT_MESSAGE_CONTENT", sequence: 1, data: { message_id: "a", delta: "x" } }]));
    expect(result.current.messages).toHaveLength(1); client.runAgent.mockImplementation(() => new Promise<void>(() => undefined)); act(() => result.current.setDraft("go")); act(() => { void result.current.send(); }); await act(async () => { await Promise.resolve(); }); await act(async () => { await result.current.stop(); }); expect(client.cancelAgent).toHaveBeenCalled();
  });
  it("reconnects from the server cursor and keeps the retry key until success", async () => {
    let resolve!: () => void; const client = { runAgent: vi.fn().mockImplementation(() => new Promise<void>((r) => { resolve = r; })), cancelAgent: vi.fn() };
    const { result } = renderHook(() => useResearchRun(client, "t"));
    await act(async () => { await result.current.reconnect({ messages: [], last_event_seq: 4 }, [{ type: "TEXT_MESSAGE_CONTENT", sequence: 4, data: { message_id: "a", delta: "old" } }, { type: "TEXT_MESSAGE_CONTENT", sequence: 5, data: { message_id: "a", delta: "new" } }]); });
    expect(result.current.lastEventSeq).toBe(5); expect(result.current.messages[0]?.content).toBe("new");
    act(() => result.current.setDraft("x")); act(() => { void result.current.send(); }); await act(async () => Promise.resolve());
    const firstKey = client.runAgent.mock.calls[0][0].idempotencyKey; act(() => { resolve(); }); await act(async () => Promise.resolve());
    expect(client.runAgent.mock.calls[0][0].idempotencyKey).toBe(firstKey); expect(result.current.idempotencyKey).not.toBe(firstKey);
  });
  it("suppresses cancelled errors and reuses a failed request key", async () => {
    const client = { runAgent: vi.fn().mockRejectedValueOnce({ code: "temporary" }).mockRejectedValueOnce({ code: "run_cancelled" }), cancelAgent: vi.fn() };
    const { result } = renderHook(() => useResearchRun(client, "t")); act(() => result.current.setDraft("x"));
    await act(async () => { await expect(result.current.send()).rejects.toEqual({ code: "temporary" }); });
    const key = client.runAgent.mock.calls[0][0].idempotencyKey; act(() => result.current.setDraft("x")); await act(async () => { await result.current.send(); });
    expect(client.runAgent.mock.calls[1][0].idempotencyKey).toBe(key); expect(result.current.cancelled).toBe(true);
  });
});
