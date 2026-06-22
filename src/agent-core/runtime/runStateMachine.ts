import type {
  AgentEvent,
  AgentEventType,
  AgentRun,
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
  | { type: "enter_waiting_approval" }
  | { type: "enter_verifying" }
  | { type: "verification_passed"; report: VerificationReport }
  | { type: "verification_failed"; report: VerificationReport }
  | { type: "repair_budget_exceeded"; report?: VerificationReport }
  | { type: "request_pause" }
  | { type: "pause_at_boundary" }
  | { type: "resume" }
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
    if (TERMINAL_STATUSES.has(currentRun.status)) {
      throw new Error(
        `Cannot transition terminal run ${currentRun.id} from ${currentRun.status}.`,
      );
    }

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
          "tool.started",
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
          {},
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
      case "verification_failed": {
        if (currentRun.repairCycles >= currentRun.contract.budget.maxRepairCycles) {
          return this.move(
            currentRun,
            "budget_exceeded",
            "budget_exceeded",
            "run.failed",
            {
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
          "verification.completed",
          { reportId: transition.report.id, status: transition.report.status },
          now,
          { repairCycles: currentRun.repairCycles + 1 },
        );
      }
      case "repair_budget_exceeded":
        return this.move(
          currentRun,
          "budget_exceeded",
          "budget_exceeded",
          "run.failed",
          {
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
          "run.paused",
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
        if (currentRun.status !== "paused") {
          throw new Error(`Cannot resume a run in ${currentRun.status}.`);
        }

        return this.move(currentRun, "planning", "planning", "run.resumed", {}, now, {
          pauseRequested: false,
        });
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

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
