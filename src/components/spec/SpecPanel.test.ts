import { describe, expect, it } from "vitest";
import {
  formatAcceptanceEvidenceLabels,
  getAcceptanceStatusSymbol,
} from "./SpecPanel";

describe("SpecPanel acceptance criteria projection", () => {
  it("uses explicit status symbols for acceptance criteria", () => {
    expect(getAcceptanceStatusSymbol("passed")).toBe("✓");
    expect(getAcceptanceStatusSymbol("failed")).toBe("✕");
    expect(getAcceptanceStatusSymbol("pending")).toBe("○");
  });

  it("formats task and run evidence for each acceptance criterion", () => {
    expect(
      formatAcceptanceEvidenceLabels({
        runIds: ["run-1", "run-2"],
        taskIds: ["task-1", "task-2"],
      }),
    ).toEqual({
      runs: "Runs: run-1, run-2",
      tasks: "Tasks: task-1, task-2",
    });
    expect(formatAcceptanceEvidenceLabels({ runIds: [], taskIds: [] })).toEqual({
      runs: "Runs: none",
      tasks: "Tasks: none",
    });
  });
});
