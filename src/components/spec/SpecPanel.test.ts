import { describe, expect, it } from "vitest";
import {
  canShowSpecTaskRetry,
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

  it("shows Retry only for failed, cancelled, or recoverable blocked tasks", () => {
    const passedDependency = { id: "task-1", status: "passed" as const };
    const failedDependency = { id: "task-2", status: "failed" as const };

    expect(
      canShowSpecTaskRetry(
        { dependencyIds: [], status: "failed" },
        [passedDependency],
      ),
    ).toBe(true);
    expect(
      canShowSpecTaskRetry(
        { dependencyIds: [], status: "cancelled" },
        [passedDependency],
      ),
    ).toBe(true);
    expect(
      canShowSpecTaskRetry(
        { dependencyIds: ["task-1"], status: "blocked" },
        [passedDependency],
      ),
    ).toBe(true);
    expect(
      canShowSpecTaskRetry(
        { dependencyIds: ["task-2"], status: "blocked" },
        [failedDependency],
      ),
    ).toBe(false);
    expect(
      canShowSpecTaskRetry(
        { dependencyIds: [], status: "pending" },
        [passedDependency],
      ),
    ).toBe(false);
  });
});
