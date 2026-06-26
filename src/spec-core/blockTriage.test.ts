import { describe, expect, it } from "vitest";
import type { AgentRun, VerificationReport } from "../agent-core/types";
import type { DevelopmentSpec, SpecRevision, SpecTask } from "./types";
import { diagnoseSpecBlock } from "./blockTriage";

describe("diagnoseSpecBlock", () => {
  it("detects build blocked final verification", () => {
    const revision = createRevision({
      tasks: [createTask({ status: "passed", runId: "run-1" })],
    });
    const diagnosis = diagnoseSpecBlock({
      spec: createSpec(revision, {
        finalVerification: {
          checkedAt: "2026-01-01T00:00:00Z",
          command: "npm run build",
          output: "Type error",
          success: false,
        },
      }),
      revision,
    });

    expect(diagnosis.kind).toBe("build_blocked");
  });

  it("retries the task when final build output contains actionable source diagnostics", () => {
    const revision = createRevision({
      tasks: [createTask({ status: "passed", runId: "run-1" })],
    });
    const diagnosis = diagnoseSpecBlock({
      spec: createSpec(revision, {
        finalVerification: {
          checkedAt: "2026-01-01T00:00:00Z",
          command: "npm run build",
          output:
            "Failed to compile.\napp/page.tsx:12:7\nType error: Property 'title' does not exist on type '{}'.",
          success: false,
        },
      }),
      revision,
    });

    expect(diagnosis.kind).toBe("build_blocked");
    expect(diagnosis.recommendedPlan).toMatchObject({
      action: "retry_task",
      taskId: "task-1",
    });
    if (diagnosis.recommendedPlan.action !== "retry_task") {
      throw new Error("Expected retry_task recovery plan.");
    }
    expect(diagnosis.recommendedPlan.note).toContain("app/page.tsx:12:7");
    expect(diagnosis.recommendedPlan.note).toContain("Type error");
  });

  it("retries final verification for environmental build failures", () => {
    const revision = createRevision({
      tasks: [createTask({ status: "passed", runId: "run-1" })],
    });
    const diagnosis = diagnoseSpecBlock({
      spec: createSpec(revision, {
        finalVerification: {
          checkedAt: "2026-01-01T00:00:00Z",
          command: "pnpm install",
          output: "ERR_PNPM_FETCH_503 registry returned 503 temporary failure",
          success: false,
        },
      }),
      revision,
    });

    expect(diagnosis.kind).toBe("build_blocked");
    expect(diagnosis.recommendedPlan.action).toBe("retry_verification");
  });

  it("detects scope blocked failures", () => {
    const task = createTask({
      error: "Policy denied edit_file: path is outside allowed paths.",
      status: "failed",
      runId: "run-1",
    });
    const revision = createRevision({ tasks: [task] });
    const diagnosis = diagnoseSpecBlock({
      spec: createSpec(revision),
      revision,
      latestRun: createRun("run-1"),
    });

    expect(diagnosis.kind).toBe("scope_blocked");
    expect(diagnosis.recommendedPlan.action).toBe("expand_scope_and_retry");
  });

  it("detects runtime blocked missing runs", () => {
    const task = createTask({ status: "running", runId: "run-missing" });
    const revision = createRevision({ tasks: [task] });
    const diagnosis = diagnoseSpecBlock({
      spec: createSpec(revision),
      revision,
      latestRun: null,
    });

    expect(diagnosis.kind).toBe("runtime_blocked");
  });

  it("detects acceptance blocked final verification", () => {
    const revision = createRevision({
      tasks: [createTask({ status: "passed", runId: "run-1" })],
    });
    const diagnosis = diagnoseSpecBlock({
      spec: createSpec(revision, {
        finalVerification: {
          checkedAt: "2026-01-01T00:00:00Z",
          command: "acceptance criteria",
          output: "criterion-1 failed",
          success: false,
        },
      }),
      revision,
    });

    expect(diagnosis.kind).toBe("acceptance_blocked");
  });

  it("detects verification blocked reports", () => {
    const task = createTask({ status: "failed", runId: "run-1" });
    const revision = createRevision({ tasks: [task] });
    const diagnosis = diagnoseSpecBlock({
      spec: createSpec(revision),
      revision,
      latestRun: createRun("run-1"),
      latestVerificationReport: createReport("run-1", "failed"),
    });

    expect(diagnosis.kind).toBe("verification_blocked");
  });
});

function createSpec(
  revision: SpecRevision,
  patch: Partial<DevelopmentSpec> = {},
): DevelopmentSpec {
  return {
    conversationId: "conv-1",
    createdAt: "2026-01-01T00:00:00Z",
    currentRevisionId: revision.id,
    failureMessage: "Spec blocked.",
    id: "spec-1",
    kind: "feature",
    projectId: "project-1",
    revisions: [revision],
    status: "blocked",
    updatedAt: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

function createRevision(patch: Partial<SpecRevision> = {}): SpecRevision {
  return {
    approvedAt: "2026-01-01T00:00:00Z",
    brief: "Build feature",
    createdAt: "2026-01-01T00:00:00Z",
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
        { id: "criterion-1", description: "Works", required: true },
      ],
      constraints: [],
      goal: "Goal",
      outOfScope: [],
      unresolvedQuestions: [],
      userStories: [{ id: "story-1", description: "Story" }],
    },
    tasks: [createTask()],
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
    objective: "Implement feature",
    requirementIds: ["story-1"],
    status: "blocked",
    title: "Task",
    error: "Task failed.",
    ...patch,
  };
}

function createRun(id: string): AgentRun {
  return {
    cancelRequested: false,
    contract: {
      acceptanceCriteria: [],
      budget: {
        maxModelTurns: 8,
        maxMutations: 8,
        maxRepairCycles: 2,
        maxToolCalls: 16,
      },
      objective: "Implement feature",
      permissions: {
        databaseChange: "deny",
        dependencyChange: "ask",
        fileDelete: "ask",
        fileWrite: true,
        previewDeployment: "ask",
        productionDeployment: "ask",
      },
      scope: {
        allowedPaths: ["app/**"],
        forbiddenPaths: [".env*"],
      },
      taskType: "component_edit",
    },
    conversationId: "conv-1",
    id,
    modelTurns: 0,
    mutationCount: 0,
    pauseRequested: false,
    phase: "planning",
    projectId: "project-1",
    repairCycles: 0,
    startedAt: "2026-01-01T00:00:00Z",
    stateVersion: 1,
    status: "failed",
    toolCalls: 0,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function createReport(
  runId: string,
  status: VerificationReport["status"],
): VerificationReport {
  return {
    artifactIds: [],
    checks: [],
    createdAt: "2026-01-01T00:00:00Z",
    id: "report-1",
    missingEvidence: ["criterion-1 missing"],
    newlyIntroducedFailures: [],
    repairFeedback: ["Fix task"],
    runId,
    status,
  };
}
