import { describe, expect, it } from "vitest";
import {
  canSendSpecChatMessage,
  canShowSpecTaskRetry,
  canUseSpecChat,
  findFirstRetryableSpecTask,
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

  it("finds the failed Initial Build task for the blocked-state retry action", () => {
    const failedTask = {
      dependencyIds: [],
      id: "task-1",
      status: "failed" as const,
      title: "Initialize Next.js project with dependencies",
    };
    const blockedTask = {
      blockedByTaskId: "task-1",
      dependencyIds: ["task-1"],
      id: "task-2",
      status: "blocked" as const,
      title: "Build homepage",
    };

    expect(findFirstRetryableSpecTask([failedTask, blockedTask])).toBe(
      failedTask,
    );
  });

  it("skips dependency-blocked tasks when picking a blocked-state retry target", () => {
    const failedDependency = {
      dependencyIds: [],
      id: "task-1",
      status: "failed" as const,
    };
    const blockedTask = {
      dependencyIds: ["task-1"],
      id: "task-2",
      status: "blocked" as const,
    };

    expect(findFirstRetryableSpecTask([blockedTask, failedDependency])).toBe(
      failedDependency,
    );
  });

  it("allows Spec chat steering while the current task is busy", () => {
    expect(
      canSendSpecChatMessage({
        canSteerActiveRun: true,
        draft: "try a smaller first step",
        hasConversation: true,
        hasProject: true,
        isArchived: false,
        isBusy: true,
      }),
    ).toBe(true);
  });

  it("blocks Spec chat sends during non-steering busy states", () => {
    expect(
      canSendSpecChatMessage({
        canSteerActiveRun: false,
        draft: "change the plan",
        hasConversation: true,
        hasProject: true,
        isArchived: false,
        isBusy: true,
      }),
    ).toBe(false);
  });

  it("keeps Spec chat input available before a message is typed", () => {
    expect(
      canUseSpecChat({
        canSteerActiveRun: false,
        hasConversation: true,
        hasProject: true,
        isArchived: false,
        isBusy: false,
      }),
    ).toBe(true);
    expect(
      canSendSpecChatMessage({
        canSteerActiveRun: false,
        draft: "",
        hasConversation: true,
        hasProject: true,
        isArchived: false,
        isBusy: false,
      }),
    ).toBe(false);
  });
});
