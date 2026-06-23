import { describe, expect, it } from "vitest";
import { validateAgentStepResponse } from "./validators";

describe("agent model action validation", () => {
  it("normalizes legacy finish into finish_candidate", () => {
    const result = validateAgentStepResponse({
      type: "finish",
      summary: "Done",
    });

    expect(result.type).toBe("finish_candidate");
  });
});
