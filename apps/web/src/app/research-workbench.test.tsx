// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchWorkbench } from "./research-workbench.js";
import type { InspectorTarget } from "../features/inspector/inspector-state.js";

const callbacks = {
  onResolveInterrupt: vi.fn(),
  onCancelInterrupt: vi.fn(),
  onRefreshInterrupts: vi.fn(),
};

const records: Exclude<InspectorTarget, null>[] = [
  { kind: "evidence", id: "evidence-1", title: "财报来源", href: "#source-1", content: "证据正文" },
  { kind: "artifact", id: "artifact-1", title: "行业报告", body: "完整产物正文", version: "v2", saved: false },
  { kind: "tool", id: "tool-1", name: "query", parameters: { q: "PCB" }, result: { rows: 3 }, durationMs: 42, error: "部分失败" },
  { kind: "approval", id: "approval-1", runId: "run-1", impact: "将保存报告", decision: "待处理" },
];

describe("ResearchWorkbench", () => {
  afterEach(() => cleanup());
  it("opens citation evidence and keeps artifact bodies outside conversation", () => {
    render(<ResearchWorkbench {...callbacks} inspectorRecords={records} citations={[{ id: "evidence-1", title: "财报来源", publishedAt: "2026-08-14", href: "#source-1" }]} messages={[{ id: "m1", role: "assistant", content: "查看来源" }]} />);
    expect(screen.queryByText("完整产物正文")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "2026-08-14" }));
    expect(screen.getByText("证据正文")).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开来源" }).getAttribute("href")).toBe("#source-1");
  });

  it("renders real inspector records and exposes their complete details", () => {
    render(<ResearchWorkbench {...callbacks} inspectorRecords={records} />);
    fireEvent.click(screen.getByRole("button", { name: "query" }));
    expect(screen.getByText(/\"q\": "PCB"/)).toBeTruthy();
    expect(screen.getByText(/\"rows\": 3/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("部分失败");
    fireEvent.click(screen.getByRole("button", { name: "关闭检查器" }));
    fireEvent.click(screen.getByRole("button", { name: "将保存报告" }));
    expect(screen.getByText("待处理")).toBeTruthy();
  });

  it("saves and changes the selected artifact version by id", () => {
    const onSaveArtifact = vi.fn();
    const onVersionChange = vi.fn();
    const { rerender } = render(<ResearchWorkbench {...callbacks} inspectorRecords={records} onSaveArtifact={onSaveArtifact} onVersionChange={onVersionChange} />);
    fireEvent.click(screen.getByRole("button", { name: "行业报告" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    fireEvent.click(screen.getByRole("button", { name: "切换版本" }));
    expect(onSaveArtifact).toHaveBeenCalledWith("artifact-1");
    expect(onVersionChange).toHaveBeenCalledWith("artifact-1", "v2");
    rerender(<ResearchWorkbench {...callbacks} inspectorRecords={records.map((record) => record.kind === "artifact" ? { ...record, saved: true, version: "v3" } : record)} onSaveArtifact={onSaveArtifact} onVersionChange={onVersionChange} />);
    expect(screen.getByText("已保存")).toBeTruthy();
    expect(screen.getByText("v3")).toBeTruthy();
  });

  it("restores focus to the connected trigger after closing inspector", () => {
    render(<ResearchWorkbench {...callbacks} inspectorRecords={records} />);
    const trigger = screen.getByRole("button", { name: "行业报告" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "关闭检查器" }));
    expect(document.activeElement).toBe(trigger);
  });

  it("selects an actual thread", () => {
    const onSelectThread = vi.fn();
    render(<ResearchWorkbench {...callbacks} inspectorRecords={[]} threads={[{ id: "thread-1", title: "PCB 研究" }]} onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByRole("button", { name: "PCB 研究" }));
    expect(onSelectThread).toHaveBeenCalledWith("thread-1");
  });

  it("preserves schema-driven fields in interrupt resolve payloads", async () => {
    const resolve = vi.fn();
    render(<ResearchWorkbench inspectorRecords={[]} interrupts={[{ runId: "run-1", interruptId: "i-1", schema: { properties: { ticker: { type: "string" } } } }]} onResolveInterrupt={resolve} onCancelInterrupt={vi.fn()} onRefreshInterrupts={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("ticker"), { target: { value: "300476.SZ" } });
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(resolve).toHaveBeenCalledWith(expect.anything(), { approved: true, ticker: "300476.SZ" });
  });
});
