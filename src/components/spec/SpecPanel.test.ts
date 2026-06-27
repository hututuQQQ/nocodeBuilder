import { describe, expect, it } from "vitest";
import {
  canSendSpecChatMessage,
  canShowSpecTaskRetry,
  canUseSpecChat,
  findFirstRetryableSpecTask,
  formatApprovalExpiryLabel,
  formatAcceptanceEvidenceLabels,
  formatSpecTaskAutoRetryLabel,
  getAcceptanceStatusSymbol,
  getSpecTaskDisplayStatus,
  shouldShowSpecApprovalNotice,
} from "./SpecPanel";
import type { AgentApproval, AgentRun } from "../../agent-core/types";
import { translate } from "../../i18n";

describe("SpecPanel acceptance criteria projection", () => {
  it("uses explicit status symbols for acceptance criteria", () => {
    expect(getAcceptanceStatusSymbol("passed")).toBe("+");
    expect(getAcceptanceStatusSymbol("failed")).toBe("x");
    expect(getAcceptanceStatusSymbol("pending")).toBe("o");
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
    expect(
      formatAcceptanceEvidenceLabels(
        { runIds: [], taskIds: ["task-1"] },
        translateZh,
      ),
    ).toEqual({
      runs: "运行：无",
      tasks: "任务：task-1",
    });
  });

  it("formats automatic retry task badges only after a retry starts", () => {
    expect(formatSpecTaskAutoRetryLabel({ autoRetryCount: undefined })).toBeNull();
    expect(formatSpecTaskAutoRetryLabel({ autoRetryCount: 0 })).toBeNull();
    expect(formatSpecTaskAutoRetryLabel({ autoRetryCount: 1 })).toBe(
      "Auto retry 1",
    );
  });

  it("uses terminal AgentRun status for a stale running task display", () => {
    expect(
      getSpecTaskDisplayStatus(
        { runId: "run-1", status: "running" },
        [{ id: "run-1", status: "failed" }],
      ),
    ).toBe("failed");
    expect(
      getSpecTaskDisplayStatus(
        { runId: "run-2", status: "running" },
        [{ id: "run-2", status: "budget_exceeded" }],
      ),
    ).toBe("budget_exceeded");
    expect(
      getSpecTaskDisplayStatus(
        { runId: "run-3", status: "running" },
        [{ id: "run-3", status: "paused" }],
      ),
    ).toBe("running");
  });

  it("shows waiting approval as the current task status", () => {
    expect(
      getSpecTaskDisplayStatus(
        { runId: "run-approval", status: "running" },
        [{ id: "run-approval", status: "waiting_approval" }],
      ),
    ).toBe("waiting_approval");
  });

  it("surfaces a pending approval for the current Spec task", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");

    expect(
      shouldShowSpecApprovalNotice({
        approval: createNoticeApproval({
          expiresAt: "2026-01-01T00:10:00Z",
        }),
        conversation: createNoticeConversation(),
        now,
        run: createNoticeRun(),
        spec: createNoticeSpec(),
      }),
    ).toBe(true);
    expect(formatApprovalExpiryLabel("2026-01-01T00:10:00Z", now)).toBe(
      "No timeout",
    );
  });

  it("keeps expired unresolved approval notices visible until a decision", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");

    expect(
      shouldShowSpecApprovalNotice({
        approval: createNoticeApproval({
          expiresAt: "2025-12-31T23:59:00Z",
        }),
        conversation: createNoticeConversation(),
        now,
        run: createNoticeRun(),
        spec: createNoticeSpec(),
      }),
    ).toBe(true);
  });

  it("hides approval notices that are resolved or not for the current task", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");

    expect(
      shouldShowSpecApprovalNotice({
        approval: createNoticeApproval({
          decision: "approved",
          resolvedAt: "2026-01-01T00:01:00Z",
        }),
        conversation: createNoticeConversation(),
        now,
        run: createNoticeRun(),
        spec: createNoticeSpec(),
      }),
    ).toBe(false);
    expect(
      shouldShowSpecApprovalNotice({
        approval: createNoticeApproval(),
        conversation: createNoticeConversation(),
        now,
        run: createNoticeRun({ id: "run-other" }),
        spec: createNoticeSpec(),
      }),
    ).toBe(false);
    expect(
      shouldShowSpecApprovalNotice({
        approval: createNoticeApproval(),
        conversation: createNoticeConversation({ mode: "chat" }),
        now,
        run: createNoticeRun(),
        spec: createNoticeSpec(),
      }),
    ).toBe(false);
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

const translateZh = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("zh-CN", key, params);

function createNoticeApproval(
  overrides: Partial<
    Pick<
      AgentApproval,
      "consumedAt" | "decision" | "expiresAt" | "resolvedAt" | "runId"
    >
  > = {},
): Pick<
  AgentApproval,
  "consumedAt" | "decision" | "expiresAt" | "resolvedAt" | "runId"
> {
  return {
    consumedAt: undefined,
    decision: undefined,
    expiresAt: "2026-01-01T00:10:00Z",
    resolvedAt: undefined,
    runId: "run-1",
    ...overrides,
  };
}

function createNoticeConversation(
  overrides: Partial<{ activeSpecId: string | null; id: string; mode: string }> = {},
) {
  return {
    activeSpecId: "spec-1",
    id: "conversation-1",
    mode: "spec",
    ...overrides,
  };
}

function createNoticeRun(
  overrides: Partial<Pick<AgentRun, "conversationId" | "id" | "status">> = {},
): Pick<AgentRun, "contract" | "conversationId" | "id" | "status"> {
  return {
    contract: {
      acceptanceCriteria: [],
      budget: {
        maxModelTurns: 1,
        maxMutations: 1,
        maxRepairCycles: 1,
        maxToolCalls: 1,
      },
      objective: "Implement task",
      permissions: {
        databaseChange: "ask",
        dependencyChange: "ask",
        fileDelete: "ask",
        fileWrite: true,
        previewDeployment: "deny",
        productionDeployment: "deny",
      },
      scope: {
        allowedPaths: [],
        forbiddenPaths: [],
      },
      source: {
        acceptanceCriteriaIds: [],
        mode: "spec",
        requirementIds: [],
        revisionId: "rev-1",
        specId: "spec-1",
        taskId: "task-1",
      },
      taskType: "component_edit",
    },
    conversationId: "conversation-1",
    id: "run-1",
    status: "waiting_approval",
    ...overrides,
  };
}

function createNoticeSpec() {
  return {
    currentRevisionId: "rev-1",
    id: "spec-1",
    revisions: [
      {
        id: "rev-1",
        tasks: [{ id: "task-1", runId: "run-1", status: "running" as const }],
      },
    ],
  };
}
