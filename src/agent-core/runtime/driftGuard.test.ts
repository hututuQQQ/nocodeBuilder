import { describe, expect, it } from "vitest";
import type { TaskManifest } from "../manifest/taskManifest";
import { checkRunDrift } from "./driftGuard";

describe("checkRunDrift", () => {
  it("blocks edits outside compiled allowed paths", () => {
    const result = checkRunDrift({
      manifest: createManifest(),
      action: {
        type: "tool_call",
        tool: "edit_file",
        args: {
          path: "src/other.ts",
          old_string: "a",
          new_string: "b",
          summary: "Edit outside scope",
        },
      },
      changedFiles: [],
      recentObservations: [],
    });

    expect(result.ok).toBe(false);
    expect(result.suggestedAction).toBe("block_scope");
  });

  it("blocks answer actions that conflict with code-changing task objectives", () => {
    const result = checkRunDrift({
      manifest: createManifest(),
      action: {
        type: "answer",
        message: "Done.",
      },
      changedFiles: [],
      recentObservations: [],
    });

    expect(result.ok).toBe(false);
    expect(result.suggestedAction).toBe("block_plan");
  });

  it("allows legal edits inside compiled allowed paths", () => {
    const result = checkRunDrift({
      manifest: createManifest(),
      action: {
        type: "tool_call",
        tool: "edit_file",
        args: {
          path: "app/page.tsx",
          old_string: "a",
          new_string: "b",
          summary: "Edit page",
        },
      },
      changedFiles: [],
      recentObservations: [],
    });

    expect(result.ok).toBe(true);
  });
});

function createManifest(): TaskManifest {
  return {
    antiDriftRules: [],
    conversationId: "conv-1",
    knownRisks: [],
    mode: "spec",
    projectGoal: "Build feature",
    projectId: "project-1",
    rawUserGoal: "Build feature",
    runtimeContract: {
      compiledAllowedPaths: ["app/**", "components/**"],
      expectedFiles: ["app/page.tsx"],
      forbiddenPaths: [".env*", "node_modules/**", ".git/**"],
      permissions: {
        databaseChange: "deny",
        dependencyChange: "ask",
        fileDelete: "ask",
        fileWrite: true,
        previewDeployment: "ask",
        productionDeployment: "ask",
      },
      taskType: "component_edit",
    },
    spec: {
      designDecisions: [],
      expectedFiles: ["app/page.tsx"],
      linkedAcceptanceCriteria: [
        { id: "criterion-1", description: "Page changes render.", required: true },
      ],
      linkedRequirements: [{ id: "story-1", description: "Story" }],
      revisionId: "rev-1",
      specId: "spec-1",
      taskId: "task-1",
      taskObjective: "Update page",
      taskTitle: "Update page",
    },
  };
}
