import { describe, expect, it, vi } from "vitest";
import { ResumeController } from "./resume-controller.js";

describe("ResumeController", () => {
  it("restores and emits a deterministic tool result", async () => {
    const op = { resolve: vi.fn(async () => ({ interrupt_id:"i",run_id:"r",operation_id:"o",checkpoint_id:"c",receipt_id:"x",status:"resolved",payload:{approved:true} })), status: vi.fn(async()=>({status:"approved"})), begin:vi.fn(), complete:vi.fn() };
    const emit=vi.fn(); const restore=vi.fn(); const c=new ResumeController({} as any,op as any);
    const out=await c.resume({threadId:"t",checkpointReader:async()=>({checkpoint_id:"c",interrupt_id:"i",run_id:"r",operation_id:"o",session_revision:2,tool_call_id:"tc",tool_name:"x",input:{}}),decision:{interrupt_id:"i",run_id:"r",operation_id:"o",checkpoint_id:"c",receipt_id:"z",status:"resolved",payload:{approved:true}},session:{restore},execute:async()=>"ok",emit});
    expect(restore).toHaveBeenCalledWith(2); expect(emit).toHaveBeenCalled(); expect(out.result).toBe("ok");
  });
});
