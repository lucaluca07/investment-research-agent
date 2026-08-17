import { describe, expect, it, vi } from "vitest";
import { ResumeController } from "./resume-controller.js";

describe("ResumeController", () => {
  it("replays an already-succeeded operation through the durable writer using the original tool id", async () => {
    const operations = { resolve: vi.fn(), status: vi.fn(async () => ({ status: "succeeded", result: { saved: true } })), begin: vi.fn(), complete: vi.fn() };
    const emit = vi.fn();
    const controller = new ResumeController({} as any, operations as any);
    const output = await controller.resume({
      threadId: "t", checkpointReader: async () => ({ checkpoint_id: "c", interrupt_id: "i", run_id: "r", operation_id: "o", tool_call_id: "original-tool", tool_name: "save", input: {} }),
      decision: { interrupt_id: "i", run_id: "r", operation_id: "o", checkpoint_id: "c", receipt_id: "x", status: "resolved", payload: { approved: true } },
      session: {}, emit,
    });
    expect(operations.resolve).not.toHaveBeenCalled();
    expect(operations.begin).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "original-tool" }));
    expect(output.result).toEqual({ saved: true });
  });

  it("restores and emits a deterministic tool result", async () => {
    const op = { resolve: vi.fn(async () => ({ interrupt_id:"i",run_id:"r",operation_id:"o",checkpoint_id:"c",receipt_id:"x",status:"resolved",payload:{approved:true} })), status: vi.fn(async()=>({status:"approved"})), begin:vi.fn(), complete:vi.fn() };
    const emit=vi.fn(); const restore=vi.fn(); const c=new ResumeController({} as any,op as any);
    const out=await c.resume({threadId:"t",checkpointReader:async()=>({checkpoint_id:"c",interrupt_id:"i",run_id:"r",operation_id:"o",session_revision:2,tool_call_id:"tc",tool_name:"x",input:{}}),decision:{interrupt_id:"i",run_id:"r",operation_id:"o",checkpoint_id:"c",receipt_id:"z",status:"resolved",payload:{approved:true}},session:{restore},execute:async()=>"ok",emit});
    expect(restore).toHaveBeenCalledWith(2); expect(emit).toHaveBeenCalled(); expect(out.result).toBe("ok");
  });
});
