// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalInterruptView, createAguiResumeAdapter, parseApprovalInterrupts } from "./approval-interrupt.js";

describe("approval interrupts", () => {
  afterEach(() => cleanup());
  const interrupt = { runId: "run-1", interruptId: "approval-1", title: "导出研究报告", description: "允许执行导出吗？" };
  it("resolves approve/reject and supports cancel", async () => {
    const resolve = vi.fn(); const cancel = vi.fn();
    render(<ApprovalInterruptView interrupt={interrupt} actions={{ resolve, cancel }} />);
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ approved: true }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
  });
  it("rejects with a reason and ignores invalid payloads", async () => {
    const resolve = vi.fn();
    const { rerender } = render(<ApprovalInterruptView interrupt={interrupt} actions={{ resolve, cancel: vi.fn() }} />);
    fireEvent.change(screen.getByLabelText("拒绝原因"), { target: { value: "数据不完整" } });
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ approved: false, reason: "数据不完整" }));
    rerender(<ApprovalInterruptView interrupt={{ nope: true }} actions={{ resolve, cancel: vi.fn() }} />);
    expect(screen.getByRole("alert").textContent).toContain("无法识别");
  });
  it("extracts standard RUN_FINISHED interrupt outcomes", () => {
    expect(parseApprovalInterrupts({ type: "interrupt", interrupts: [interrupt, { nope: true }] })).toEqual([interrupt]);
  });
  it("builds a resumable AG-UI request with run and interrupt ids", async () => {
    const resume = vi.fn(); const stop = vi.fn();
    const actions = createAguiResumeAdapter({ runId: "run-1", interruptId: "approval-1" }, resume, stop);
    await actions.resolve({ approved: true }); await actions.cancel();
    expect(resume).toHaveBeenCalledWith({ run_id: "run-1", interrupt_id: "approval-1", payload: { approved: true } });
    expect(stop).toHaveBeenCalledWith({ run_id: "run-1", interrupt_id: "approval-1" });
  });
  it("refreshes automatically after a 409 without resubmitting", async () => {
    const refresh = vi.fn(); const resolve = vi.fn().mockRejectedValue({ status: 409 });
    render(<ApprovalInterruptView interrupt={interrupt} actions={{ resolve, cancel: vi.fn(), refresh }} />);
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "批准" })).not.toHaveProperty("disabled", true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("prevents duplicate busy submissions", async () => {
    let release!: () => void; const resolve = vi.fn(() => new Promise<void>((r) => { release = r; }));
    render(<ApprovalInterruptView interrupt={interrupt} actions={{ resolve, cancel: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: "批准" })); fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(resolve).toHaveBeenCalledTimes(1); release();
  });
  it("keeps multiple open interrupts visible", () => {
    render(<div>{["a", "b"].map((id) => <ApprovalInterruptView key={id} interrupt={{ runId: "run-1", interruptId: id }} actions={{ resolve: vi.fn(), cancel: vi.fn() }} />)}</div>);
    expect(screen.getAllByRole("button", { name: "批准" })).toHaveLength(2);
  });
  it("blocks invalid payload before any action", () => {
    const resolve = vi.fn(); render(<ApprovalInterruptView interrupt={{ runId: "run-1" }} actions={{ resolve, cancel: vi.fn() }} />);
    expect(screen.getByRole("alert")).toBeTruthy(); expect(resolve).not.toHaveBeenCalled();
  });
  it("validates boolean schema values", () => {
    render(<ApprovalInterruptView interrupt={{ runId: "run-1", interruptId: "typed", schema: { required: ["flag"], properties: { flag: { type: "boolean" } } } }} actions={{ resolve: vi.fn(), cancel: vi.fn() }} />);
    expect(screen.getByRole("button", { name: "批准" })).toHaveProperty("disabled", true);
  });
});
