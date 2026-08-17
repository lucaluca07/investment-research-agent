import { EventType, RunAgentInputSchema, RunFinishedEventSchema } from "@ag-ui/core";
import { describe, expect, it } from "vitest";

describe("AG-UI 0.0.57 compatibility", () => {
  it("parses an interrupt outcome on RUN_FINISHED", () => {
    const event = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "run-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "approval-1",
            reason: "Approval required",
          },
        ],
      },
    });

    expect(event.outcome).toEqual({
      type: "interrupt",
      interrupts: [
        {
          id: "approval-1",
          reason: "Approval required",
        },
      ],
    });
  });

  it("parses resume entries on RunAgent input", () => {
    const input = RunAgentInputSchema.parse({
      threadId: "thread-1",
      runId: "run-2",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
      resume: [
        {
          interruptId: "approval-1",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });

    expect(input.resume).toEqual([
      {
        interruptId: "approval-1",
        status: "resolved",
        payload: { approved: true },
      },
    ]);
  });
});
