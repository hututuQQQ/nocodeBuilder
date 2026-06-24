import { describe, expect, it } from "vitest";
import type { DevelopmentSpec, SpecRevision, SpecTask } from "./types";
import { compileSpecTaskContract } from "./taskCompiler";

describe("compileSpecTaskContract", () => {
  it("adds Spec source metadata and task scoped criteria", () => {
    const revision = createRevision();
    const spec = createSpec(revision);
    const task = revision.tasks[0];
    const contract = compileSpecTaskContract({ revision, spec, task });

    expect(contract.objective).toBe(task.objective);
    expect(contract.scope.allowedPaths).toEqual(task.allowedPaths);
    expect(contract.acceptanceCriteria).toEqual([
      revision.requirements.acceptanceCriteria[0],
    ]);
    expect(contract.source).toEqual({
      acceptanceCriteriaIds: task.acceptanceCriteriaIds,
      mode: "spec",
      requirementIds: task.requirementIds,
      revisionId: revision.id,
      specId: spec.id,
      taskId: task.id,
    });
    expect(contract.scope.forbiddenPaths).toContain(".aibuilder/**");
  });

  it("forces full_site only for the Initial Build generate task", () => {
    const backendTask = createTask({
      id: "task-2",
      objective: "Apply Supabase schema for customer accounts.",
    });
    const revision = createRevision({
      tasks: [
        createTask({
          id: "task-1",
          objective: "Generate the initial application.",
        }),
        backendTask,
      ],
    });
    const spec = createSpec(revision, { kind: "initial_build" });

    const initialContract = compileSpecTaskContract({
      executionMode: "generate",
      revision,
      spec,
      task: revision.tasks[0],
    });
    const backendContract = compileSpecTaskContract({
      executionMode: "modify",
      revision,
      spec,
      task: backendTask,
    });

    expect(initialContract.taskType).toBe("full_site");
    expect(backendContract.taskType).toBe("backend_feature");
    expect(backendContract.permissions.databaseChange).toBe("ask");
  });

  it("infers Initial Build style tasks normally after generation", () => {
    const styleTask = createTask({
      objective: "Polish the button colors and spacing.",
    });
    const revision = createRevision({ tasks: [styleTask] });
    const spec = createSpec(revision, { kind: "initial_build" });
    const contract = compileSpecTaskContract({
      executionMode: "modify",
      revision,
      spec,
      task: styleTask,
    });

    expect(contract.taskType).toBe("style_edit");
  });
});

function createSpec(
  revision: SpecRevision,
  patch: Partial<DevelopmentSpec> = {},
): DevelopmentSpec {
  return {
    conversationId: "conv-1",
    createdAt: "2026-06-24T00:00:00Z",
    currentRevisionId: revision.id,
    id: "spec-1",
    kind: "feature",
    projectId: "project-1",
    revisions: [revision],
    status: "review",
    updatedAt: "2026-06-24T00:00:00Z",
    ...patch,
  };
}

function createRevision(patch: Partial<SpecRevision> = {}): SpecRevision {
  const task = createTask();

  return {
    brief: "Hero update",
    createdAt: "2026-06-24T00:00:00Z",
    design: {
      components: [],
      dataModel: [],
      integrations: [],
      pages: [],
      summary: "Update one page.",
      technicalDecisions: [],
      verificationStrategy: ["Run build."],
    },
    id: "rev-1",
    requirements: {
      acceptanceCriteria: [
        {
          description: "The hero is visible.",
          id: "criterion-1",
          required: true,
        },
      ],
      constraints: [],
      goal: "Update hero.",
      outOfScope: [],
      unresolvedQuestions: [],
      userStories: [
        {
          description: "As a visitor, I see a hero.",
          id: "story-1",
        },
      ],
    },
    tasks: [task],
    version: 1,
    ...patch,
  };
}

function createTask(patch: Partial<SpecTask> = {}): SpecTask {
  return {
    acceptanceCriteriaIds: ["criterion-1"],
    allowedPaths: ["app/page.tsx"],
    dependencyIds: [],
    expectedFiles: ["app/page.tsx"],
    id: "task-1",
    objective: "Update the home page hero.",
    requirementIds: ["story-1"],
    status: "pending",
    title: "Hero update",
    ...patch,
  };
}
