import { describe, expect, it } from "vitest";
import type { DevelopmentSpec } from "./types";
import {
  getLegalSpecTransitions,
  isTerminalSpecStatus,
  markSpecBlocked,
  transitionSpecStatus,
} from "./specStateMachine";

describe("specStateMachine", () => {
  it("treats blocked as retryable and failed as terminal", () => {
    expect(isTerminalSpecStatus("blocked")).toBe(false);
    expect(isTerminalSpecStatus("failed")).toBe(true);
    expect(getLegalSpecTransitions("blocked")).toEqual([
      "building",
      "verifying",
      "cancelled",
    ]);
  });

  it("allows building to enter blocked and retry through legal transitions", () => {
    const building = { ...createSpec(), status: "building" as const };
    const blocked = markSpecBlocked(building, "Task failed.");

    expect(blocked.status).toBe("blocked");
    expect(blocked.failureMessage).toBe("Task failed.");

    const retrying = transitionSpecStatus(blocked, "building");
    expect(retrying.status).toBe("building");
    expect(retrying.failureMessage).toBeUndefined();
  });

  it("clears stale final verification evidence when retrying verification", () => {
    const blocked = {
      ...createSpec(),
      failureMessage: "Final npm run build failed.",
      finalVerification: {
        checkedAt: "2026-01-01T00:01:00.000Z",
        command: "npm run build",
        output: "build failed",
        success: false,
      },
      status: "blocked" as const,
    };

    const retrying = transitionSpecStatus(blocked, "verifying");

    expect(retrying.status).toBe("verifying");
    expect(retrying.failureMessage).toBeUndefined();
    expect(retrying.finalVerification).toBeUndefined();
  });

  it("does not allow terminal failed specs to be revived", () => {
    const failed = { ...createSpec(), status: "failed" as const };

    expect(() => transitionSpecStatus(failed, "building")).toThrow(
      "failed -> building",
    );
  });
});

function createSpec(): DevelopmentSpec {
  return {
    conversationId: "conv-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentRevisionId: "rev-1",
    id: "spec-1",
    kind: "feature",
    projectId: "project-1",
    revisions: [
      {
        brief: "Build a feature",
        createdAt: "2026-01-01T00:00:00.000Z",
        design: {
          components: [],
          dataModel: [],
          integrations: [],
          pages: [],
          summary: "Design",
          technicalDecisions: [],
          verificationStrategy: [],
        },
        id: "rev-1",
        requirements: {
          acceptanceCriteria: [
            {
              description: "Criterion",
              id: "ac-1",
              required: true,
            },
          ],
          constraints: [],
          goal: "Goal",
          outOfScope: [],
          unresolvedQuestions: [],
          userStories: [
            {
              description: "Story",
              id: "req-1",
            },
          ],
        },
        tasks: [
          {
            acceptanceCriteriaIds: ["ac-1"],
            allowedPaths: ["app/page.tsx"],
            dependencyIds: [],
            expectedFiles: ["app/page.tsx"],
            id: "task-1",
            objective: "Do it",
            requirementIds: ["req-1"],
            status: "pending",
            title: "Task",
          },
        ],
        version: 1,
      },
    ],
    status: "review",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
