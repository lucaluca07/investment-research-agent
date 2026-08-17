// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchInspector } from "./research-inspector.js";

describe("ResearchInspector details", () => {
  afterEach(() => cleanup());
  it("renders evidence, artifact, tool and approval details", () => {
    const close = vi.fn();
    const cases = [
      { kind: "evidence", id: "e", title: "来源", content: "证据正文", href: "https://example.com" },
      { kind: "artifact", id: "a", title: "产物", body: "完整正文", version: "v2", saved: true },
      { kind: "tool", id: "t", name: "query", parameters: { q: 1 }, result: { ok: true }, durationMs: 42, error: "oops" },
      { kind: "approval", id: "p", runId: "r", impact: "高", decision: "待定" },
    ] as const;
    for (const target of cases) { const view = render(<ResearchInspector target={target} onClose={close} />); expect(screen.getByRole("complementary")).toBeTruthy(); if (target.kind === "evidence") expect(screen.getByText("证据正文")).toBeTruthy(); if (target.kind === "artifact") expect(screen.getByText("v2")).toBeTruthy(); if (target.kind === "tool") { expect(screen.getAllByText("query").length).toBeGreaterThan(0); expect(screen.getByText("42 ms")).toBeTruthy(); } if (target.kind === "approval") expect(screen.getByText("高")).toBeTruthy(); view.unmount(); }
  });
  it("keeps artifact body in inspector and closes with callback", () => {
    const close = vi.fn(); const save = vi.fn(); const version = vi.fn(); render(<ResearchInspector target={{ kind: "artifact", id: "a", body: "正文", version: "v1", saved: false }} onClose={close} onSaveArtifact={save} onVersionChange={version} />);
    expect(screen.getByText("正文")).toBeTruthy(); expect(screen.getByText("v1")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "保存" })); fireEvent.click(screen.getByRole("button", { name: "切换版本" })); fireEvent.click(screen.getByRole("button", { name: "关闭检查器" })); expect(close).toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith("a"); expect(version).toHaveBeenCalledWith("a", "v1");
  });
});
