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
});

function createSpec(revision: SpecRevision): DevelopmentSpec {
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
  };
}

function createRevision(): SpecRevision {
  const task: SpecTask = {
    acceptanceCriteriaIds: ["criterion-1"],
    allowedPaths: ["app/page.tsx"],
    dependencyIds: [],
    expectedFiles: ["app/page.tsx"],
    id: "task-1",
    objective: "Update the home page hero.",
    requirementIds: ["story-1"],
    status: "pending",
    title: "Hero update",
  };

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
  };
}
