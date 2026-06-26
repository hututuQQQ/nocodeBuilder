import type {
  AgentEvent,
  AgentEventType,
  AgentRun,
  AgentRunFailureKind,
  AgentRunPhase,
  AgentRunStatus,
  TaskContract,
  VerificationReport,
} from "../types";

export type RunTransition =
  | { type: "start" }
  | { type: "enter_planning" }
  | { type: "enter_exploring" }
  | { type: "enter_mutating"; mutationDelta?: number }
  | {
      type: "enter_waiting_approval";
      approvalId: string;
      normalizedArgsHash: string;
      toolName: string;
    }
  | { type: "approval_granted"; approvalId: string }
  | { type: "approval_denied"; approvalId: string; reason?: string }
  | { type: "approval_expired"; approvalId: string }
  | { type: "enter_verifying" }
  | { type: "verification_passed_continue"; report: VerificationReport }
  | { type: "verification_passed"; report: VerificationReport }
  | { type: "verification_failed"; report: VerificationReport }
  | {
      type: "budget_exceeded";
      budget: keyof TaskContract["budget"];
      failureKind?: AgentRunFailureKind;
      reason: string;
    }
  | { type: "repair_budget_exceeded"; report?: VerificationReport }
  | { type: "request_pause" }
  | { type: "pause_at_boundary" }
  | { type: "resume" }
  | {
      type: "recover_interrupted";
      checkpointId?: string;
      nextStatus?: Exclude<
        AgentRunStatus,
        "completed" | "failed" | "cancelled" | "budget_exceeded"
      >;
      reason: string;
    }
  | { type: "request_cancel" }
  | { type: "cancel" }
  | { type: "fail"; reason: string };

export type RunTransitionResult = {
  event: Omit<AgentEvent, "id" | "sequence">;
  run: AgentRun;
};

const TERMINAL_STATUSES = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "budget_exceeded",
]);

type RunTransitionType = RunTransition["type"];

const LEGAL_TRANSITIONS: Record<AgentRunStatus, ReadonlySet<RunTransitionType>> = {
  created: new Set(["start", "recover_interrupted", "request_cancel", "cancel", "fail"]),
  planning: new Set([
    "enter_planning",
    "enter_exploring",
    "enter_mutating",
    "enter_waiting_approval",
    "enter_verifying",
    "request_pause",
    "pause_at_boundary",
    "recover_interrupted",
    "request_cancel",
    "budget_exceeded",
    "cancel",
    "fail",
  ]),
  exploring: new Set([
    "enter_planning",
    "enter_exploring",
    "enter_mutating",
    "enter_verifying",
    "request_pause",
    "pause_at_boundary",
    "recover_interrupted",
    "request_cancel",
    "budget_exceeded",
    "cancel",
    "fail",
  ]),
  mutating: new Set([
    "enter_planning",
    "enter_mutating",
    "enter_verifying",
    "request_pause",
    "pause_at_boundary",
    "recover_interrupted",
    "request_cancel",
    "budget_exceeded",
    "cancel",
    "fail",
  ]),
  waiting_approval: new Set([
    "approval_granted",
    "approval_denied",
    "approval_expired",
    "recover_interrupted",
    "request_cancel",
    "budget_exceeded",
    "cancel",
    "fail",
  ]),
  verifying: new Set([
    "verification_passed_continue",
    "verification_passed",
    "verification_failed",
    "repair_budget_exceeded",
    "request_pause",
    "pause_at_boundary",
    "recover_interrupted",
    "request_cancel",
    "budget_exceeded",
    "cancel",
    "fail",
  ]),
  repairing: new Set([
    "enter_planning",
    "enter_exploring",
    "enter_mutating",
    "enter_verifying",
    "repair_budget_exceeded",
    "request_pause",
    "pause_at_boundary",
    "recover_interrupted",
    "request_cancel",
    "budget_exceeded",
    "cancel",
    "fail",
  ]),
  paused: new Set(["resume", "recover_interrupted", "request_cancel", "cancel", "fail"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  budget_exceeded: new Set(),
};

export class RunStateMachine {
  createRun({
    contract,
    conversationId,
    now = new Date().toISOString(),
    projectId,
    runId = createId("run"),
  }: {
    contract: TaskContract;
    conversationId: string;
    now?: string;
    projectId: string;
    runId?: string;
  }): AgentRun {
    return {
      id: runId,
      projectId,
      conversationId,
      contract,
      status: "created",
      phase: "created",
      stateVersion: 0,
      modelTurns: 0,
      toolCalls: 0,
      mutationCount: 0,
      repairCycles: 0,
      cancelRequested: false,
      pauseRequested: false,
      startedAt: now,
      updatedAt: now,
    };
  }

  transition(
    currentRun: AgentRun,
    transition: RunTransition,
    now = new Date().toISOString(),
  ): RunTransitionResult {
    assertLegalTransition(currentRun, transition.type);

    switch (transition.type) {
      case "start":
        return this.move(currentRun, "planning", "planning", "run.started", {}, now);
      case "enter_planning":
        return this.move(currentRun, "planning", "planning", "plan.updated", {}, now);
      case "enter_exploring":
        return this.move(currentRun, "exploring", "exploring", "plan.updated", {}, now);
      case "enter_mutating":
        return this.move(
          currentRun,
          "mutating",
          "mutating",
          "plan.updated",
          { mutationDelta: transition.mutationDelta ?? 0 },
          now,
          { mutationCount: currentRun.mutationCount + (transition.mutationDelta ?? 0) },
        );
      case "enter_waiting_approval":
        return this.move(
          currentRun,
          "waiting_approval",
          "waiting_approval",
          "approval.requested",
          {
            approvalId: transition.approvalId,
            normalizedArgsHash: transition.normalizedArgsHash,
            toolName: transition.toolName,
          },
          now,
        );
      case "approval_granted":
        return this.move(
          currentRun,
          "planning",
          "planning",
          "approval.resolved",
          { approvalId: transition.approvalId, decision: "approved" },
          now,
        );
      case "approval_expired":
        return this.move(
          currentRun,
          "planning",
          "planning",
          "approval.expired",
          { approvalId: transition.approvalId, decision: "expired" },
          now,
        );
      case "approval_denied":
        return this.move(
          currentRun,
          "planning",
          "planning",
          "approval.resolved",
          {
            approvalId: transition.approvalId,
            decision: "denied",
            reason: transition.reason,
          },
          now,
        );
      case "enter_verifying":
        return this.move(
          currentRun,
          "verifying",
          "verifying",
          "verification.started",
          {},
          now,
        );
      case "verification_passed":
        assertReportStatus(transition.report, "passed");
        return this.move(
          currentRun,
          "completed",
          "completed",
          "run.completed",
          { reportId: transition.report.id },
          now,
          { completedAt: now },
        );
      case "verification_passed_continue":
        assertReportStatus(transition.report, "passed");
        return this.move(
          currentRun,
          "planning",
          "planning",
          "plan.updated",
          { reportId: transition.report.id, status: transition.report.status },
          now,
        );
      case "verification_failed": {
        if (currentRun.repairCycles >= currentRun.contract.budget.maxRepairCycles) {
          return this.move(
          currentRun,
          "budget_exceeded",
          "budget_exceeded",
          "run.budget_exceeded",
          {
            failureKind: "local_budget",
            reason: "Repair budget exceeded after verification failed.",
            reportId: transition.report.id,
            },
            now,
            { completedAt: now },
          );
        }

        return this.move(
          currentRun,
          "repairing",
          "repairing",
          "plan.updated",
          { reportId: transition.report.id, status: transition.report.status },
          now,
          { repairCycles: currentRun.repairCycles + 1 },
        );
      }
      case "budget_exceeded":
        return this.move(
          currentRun,
          "budget_exceeded",
          "budget_exceeded",
          "run.budget_exceeded",
          {
            budget: transition.budget,
            failureKind: transition.failureKind ?? "local_budget",
            reason: transition.reason,
          },
          now,
          { completedAt: now },
        );
      case "repair_budget_exceeded":
        return this.move(
          currentRun,
          "budget_exceeded",
          "budget_exceeded",
          "run.budget_exceeded",
          {
            failureKind: "local_budget",
            reason: "Repair budget exceeded.",
            reportId: transition.report?.id,
          },
          now,
          { completedAt: now },
        );
      case "request_pause":
        return this.move(
          currentRun,
          currentRun.status,
          currentRun.phase,
          "run.pause_requested",
          { requested: true },
          now,
          { pauseRequested: true },
        );
      case "pause_at_boundary":
        if (!currentRun.pauseRequested) {
          throw new Error("Cannot pause at boundary before pause was requested.");
        }

        return this.move(currentRun, "paused", "paused", "run.paused", {}, now);
      case "resume":
        return this.move(currentRun, "planning", "planning", "run.resumed", {}, now, {
          pauseRequested: false,
        });
      case "recover_interrupted": {
        const nextStatus = transition.nextStatus ?? currentRun.status;
        return this.move(
          currentRun,
          nextStatus,
          nextStatus,
          "run.recovered",
          {
            checkpointId: transition.checkpointId,
            nextStatus,
            previousStatus: currentRun.status,
            reason: transition.reason,
          },
          now,
          {
            pauseRequested: false,
          },
        );
      }
      case "request_cancel":
        return this.move(
          currentRun,
          currentRun.status,
          currentRun.phase,
          "run.cancel_requested",
          { requested: true },
          now,
          { cancelRequested: true },
        );
      case "cancel":
        return this.move(
          currentRun,
          "cancelled",
          "cancelled",
          "run.cancelled",
          {},
          now,
          { cancelRequested: true, completedAt: now },
        );
      case "fail":
        return this.move(
          currentRun,
          "failed",
          "failed",
          "run.failed",
          { reason: transition.reason },
          now,
          { completedAt: now },
        );
    }
  }

  private move(
    currentRun: AgentRun,
    status: AgentRunStatus,
    phase: AgentRunPhase,
    eventType: AgentEventType,
    payload: unknown,
    now: string,
    patch: Partial<AgentRun> = {},
  ): RunTransitionResult {
    const run: AgentRun = {
      ...currentRun,
      ...patch,
      status,
      phase,
      stateVersion: currentRun.stateVersion + 1,
      updatedAt: now,
    };

    return {
      run,
      event: {
        runId: currentRun.id,
        type: eventType,
        timestamp: now,
        payload,
      },
    };
  }
}

export function isTerminalAgentRunStatus(status: AgentRunStatus) {
  return TERMINAL_STATUSES.has(status);
}

export function getLegalRunTransitions(status: AgentRunStatus): RunTransitionType[] {
  return [...LEGAL_TRANSITIONS[status]];
}

export function createAgentEventId(type: string) {
  return createId(type.replace(/\W+/g, "-"));
}

function assertReportStatus(report: VerificationReport, status: VerificationReport["status"]) {
  if (report.status !== status) {
    throw new Error(
      `Cannot complete run with ${report.status} verification report ${report.id}.`,
    );
  }
}

function assertLegalTransition(currentRun: AgentRun, transitionType: RunTransitionType) {
  const legalTransitions = LEGAL_TRANSITIONS[currentRun.status];

  if (!legalTransitions.has(transitionType)) {
    const legalList = [...legalTransitions].sort().join(", ") || "none";
    throw new Error(
      `Illegal run transition ${transitionType} from ${currentRun.status} for ${currentRun.id}. Legal transitions: ${legalList}.`,
    );
  }
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
