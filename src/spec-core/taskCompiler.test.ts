import { describe, expect, it } from "vitest";
import type { DevelopmentSpec, SpecRevision, SpecTask } from "./types";
import {
  compileAllowedPathsForSpecTask,
  compileSpecTaskContract,
} from "./taskCompiler";

describe("compileSpecTaskContract", () => {
  it("adds Spec source metadata while keeping generic verifier criteria", () => {
    const revision = createRevision();
    const spec = createSpec(revision);
    const task = revision.tasks[0];
    const contract = compileSpecTaskContract({ revision, spec, task });

    expect(contract.objective).toBe(task.objective);
    expect(contract.scope.allowedPaths).toEqual(
      expect.arrayContaining(task.allowedPaths),
    );
    expect(contract.acceptanceCriteria.map((criterion) => criterion.id)).toEqual([
      "request-addressed",
      "verifier-passed",
    ]);
    expect(contract.source).toEqual({
      acceptanceCriteriaIds: task.acceptanceCriteriaIds,
      expectedFiles: task.expectedFiles,
      mode: "spec",
      requirementIds: task.requirementIds,
      revisionId: revision.id,
      specId: spec.id,
      taskId: task.id,
    });
    expect(contract.scope.forbiddenPaths).toContain(".aibuilder/**");
  });

  it("rejects unknown task scoped criteria before execution", () => {
    const task = createTask({ acceptanceCriteriaIds: ["missing-criterion"] });
    const revision = createRevision({ tasks: [task] });
    const spec = createSpec(revision);

    expect(() =>
      compileSpecTaskContract({ revision, spec, task }),
    ).toThrow("Spec task references unknown criterion missing-criterion.");
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

  it("keeps default scaffold paths for the Initial Build generate task", () => {
    const revision = createRevision({
      tasks: [
        createTask({
          allowedPaths: ["package.json", "app/**"],
          objective: "Initialize the Next.js project foundation.",
        }),
      ],
    });
    const spec = createSpec(revision, { kind: "initial_build" });
    const contract = compileSpecTaskContract({
      executionMode: "generate",
      revision,
      spec,
      task: revision.tasks[0],
    });

    expect(contract.scope.allowedPaths).toEqual(
      expect.arrayContaining([
        "package.json",
        "app/**",
        "data/**",
        "postcss.config.*",
      ]),
    );
  });

  it("uses wider budgets for Spec tasks than generic chat tasks", () => {
    const revision = createRevision();
    const spec = createSpec(revision);
    const contract = compileSpecTaskContract({
      revision,
      spec,
      task: revision.tasks[0],
    });

    expect(contract.budget).toMatchObject({
      maxModelTurns: expect.any(Number),
      maxToolCalls: expect.any(Number),
      maxMutations: expect.any(Number),
      maxRepairCycles: expect.any(Number),
    });
    expect(contract.budget.maxModelTurns).toBeGreaterThanOrEqual(23);
    expect(contract.budget.maxToolCalls).toBeGreaterThanOrEqual(73);
    expect(contract.budget.maxMutations).toBeGreaterThanOrEqual(18);
  });

  it("expands Spec task budgets on automatic retry", () => {
    const revision = createRevision();
    const spec = createSpec(revision);
    const firstContract = compileSpecTaskContract({
      revision,
      spec,
      task: revision.tasks[0],
    });
    const retryTask = {
      ...revision.tasks[0],
      autoRetryCount: 2,
    };
    const retryContract = compileSpecTaskContract({
      revision,
      spec,
      task: retryTask,
    });

    expect(retryContract.budget.maxModelTurns)
      .toBe(firstContract.budget.maxModelTurns + 20);
    expect(retryContract.budget.maxToolCalls)
      .toBe(firstContract.budget.maxToolCalls + 72);
    expect(retryContract.budget.maxMutations)
      .toBe(firstContract.budget.maxMutations + 24);
    expect(retryContract.budget.maxRepairCycles)
      .toBe(firstContract.budget.maxRepairCycles + 2);
  });

  it("gives backend and Initial Build generation tasks enough execution room", () => {
    const backendTask = createTask({
      expectedFiles: [
        "lib/supabase/server.ts",
        "lib/supabase/client.ts",
        "app/api/rooms/route.ts",
        "app/game/[roomId]/page.tsx",
      ],
      objective: "Implement Supabase realtime rooms and game state APIs.",
    });
    const generateTask = createTask({
      expectedFiles: [
        "package.json",
        "app/page.tsx",
        "app/layout.tsx",
        "components/table.tsx",
        "lib/game.ts",
      ],
      objective: "Generate the initial online poker application.",
    });
    const revision = createRevision({ tasks: [generateTask, backendTask] });
    const spec = createSpec(revision, { kind: "initial_build" });

    const generatedContract = compileSpecTaskContract({
      executionMode: "generate",
      revision,
      spec,
      task: generateTask,
    });
    const backendContract = compileSpecTaskContract({
      executionMode: "modify",
      revision,
      spec,
      task: backendTask,
    });

    expect(generatedContract.budget.maxModelTurns).toBeGreaterThanOrEqual(44);
    expect(generatedContract.budget.maxToolCalls).toBeGreaterThanOrEqual(180);
    expect(generatedContract.budget.maxMutations).toBeGreaterThanOrEqual(90);
    expect(generatedContract.budget.maxRepairCycles).toBeGreaterThanOrEqual(8);
    expect(backendContract.taskType).toBe("backend_feature");
    expect(backendContract.budget.maxModelTurns).toBeGreaterThanOrEqual(34);
    expect(backendContract.budget.maxToolCalls).toBeGreaterThanOrEqual(130);
    expect(backendContract.budget.maxMutations).toBeGreaterThanOrEqual(48);
    expect(backendContract.budget.maxRepairCycles).toBeGreaterThanOrEqual(10);
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

  it("expands backend intent paths beyond planner hints", () => {
    const task = createTask({
      allowedPaths: ["app/page.tsx"],
      objective: "Add backend API routes for login.",
    });
    const revision = createRevision({ tasks: [task] });
    const spec = createSpec(revision);
    const contract = compileSpecTaskContract({ revision, spec, task });

    expect(contract.scope.allowedPaths).toEqual(
      expect.arrayContaining(["app/api/**", "lib/**", "package.json"]),
    );
  });

  it("keeps expectedFiles and dependency intent paths in compiled allowed paths", () => {
    const task = createTask({
      expectedFiles: ["lib/foo.ts"],
      objective: "Install a package dependency and update build config.",
    });
    const revision = createRevision({ tasks: [task] });
    const spec = createSpec(revision);
    const paths = compileAllowedPathsForSpecTask({
      task,
      revision,
      spec,
      baseAllowedPaths: ["app/**"],
    });

    expect(paths).toEqual(
      expect.arrayContaining(["lib/foo.ts", "package.json", "next.config.*"]),
    );
  });

  it("filters forbidden paths from compiled allowed paths", () => {
    const task = createTask({
      allowedPaths: [".env", "node_modules/**", "app/page.tsx"],
      expectedFiles: [".git/config", "lib/foo.ts"],
    });
    const revision = createRevision({ tasks: [task] });
    const spec = createSpec(revision);
    const paths = compileAllowedPathsForSpecTask({
      task,
      revision,
      spec,
      baseAllowedPaths: [],
    });

    expect(paths).toContain("app/page.tsx");
    expect(paths).toContain("lib/foo.ts");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("node_modules/**");
    expect(paths).not.toContain(".git/config");
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
