// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationPanel } from "./conversation-panel.js";
afterEach(() => cleanup());
it("blocks ordinary send while an interrupt is pending", () => { const send = vi.fn(); render(<ConversationPanel messages={[]} draft="question" onDraftChange={vi.fn()} onSend={send} onStop={vi.fn()} onResolveInterrupt={vi.fn()} onCancelInterrupt={vi.fn()} onRefreshInterrupts={vi.fn()} interrupts={[{ runId: "run-1", interruptId: "i-1" }]} running={false} />); expect(screen.getByRole("button", { name: "发送" })).toHaveProperty("disabled", true); });
it("disables sending while running and exposes stop", () => { render(<ConversationPanel messages={[]} draft="question" onDraftChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} onResolveInterrupt={vi.fn()} onCancelInterrupt={vi.fn()} onRefreshInterrupts={vi.fn()} running />); expect(screen.getByRole("button", { name: "停止" })).toBeTruthy(); expect(screen.getByRole("button", { name: "停止" })).toBeTruthy(); expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true); });
