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

  it.each([
    ".env",
    ".aibuilder/state.json",
    "node_modules/package/index.js",
  ])("blocks forbidden path %s before allowed-path evaluation", (path) => {
    const result = checkRunDrift({
      manifest: createManifest({
        compiledAllowedPaths: ["**"],
        forbiddenPaths: [".env", ".env.*", ".aibuilder/**", "node_modules/**"],
      }),
      action: {
        type: "tool_call",
        tool: "edit_file",
        args: {
          path,
          old_string: "a",
          new_string: "b",
          summary: "Edit forbidden path",
        },
      },
      changedFiles: [],
      recentObservations: [],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("forbiddenPaths");
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

  it("allows finish candidates through to verifier even without linked acceptance evidence", () => {
    const result = checkRunDrift({
      manifest: createManifest(),
      action: {
        type: "finish_candidate",
        summary: "Done.",
      },
      changedFiles: [],
      recentObservations: [],
    });

    expect(result.ok).toBe(true);
  });

  it("allows finish candidates when changed task files provide acceptance evidence", () => {
    const result = checkRunDrift({
      manifest: createManifest(),
      action: {
        type: "finish_candidate",
        summary: "Page changes render.",
      },
      changedFiles: ["app/page.tsx"],
      recentObservations: [],
    });

    expect(result.ok).toBe(true);
  });

  it("asks for revision when steering conflicts with the TaskManifest", () => {
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
      steering: ["Change plan: build login and database auth instead."],
    });

    expect(result.ok).toBe(false);
    expect(result.suggestedAction).toBe("ask_for_revision");
  });

  it("blocks actions that obviously target a different task objective", () => {
    const result = checkRunDrift({
      manifest: createManifest({
        taskObjective: "Update checkout copy on the page",
      }),
      action: {
        type: "tool_call",
        tool: "edit_file",
        rationale: "Implement user login database schema",
        args: {
          path: "app/page.tsx",
          old_string: "a",
          new_string: "b",
          summary: "Add auth login database work",
        },
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

function createManifest(patch: {
  compiledAllowedPaths?: string[];
  forbiddenPaths?: string[];
  taskObjective?: string;
} = {}): TaskManifest {
  const taskObjective = patch.taskObjective ?? "Update page";

  return {
    antiDriftRules: [],
    conversationId: "conv-1",
    knownRisks: [],
    mode: "spec",
    projectGoal: "Build feature",
    projectId: "project-1",
    rawUserGoal: "Build feature",
    runtimeContract: {
      compiledAllowedPaths: patch.compiledAllowedPaths ?? ["app/**", "components/**"],
      expectedFiles: ["app/page.tsx"],
      forbiddenPaths: patch.forbiddenPaths ?? [
        ".env",
        ".env.*",
        ".aibuilder/**",
        "node_modules/**",
        ".git/**",
      ],
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
      taskObjective,
      taskTitle: taskObjective,
    },
  };
}
