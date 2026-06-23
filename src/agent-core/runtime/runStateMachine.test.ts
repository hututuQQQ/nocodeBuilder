import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../contract/taskContract";
import type { VerificationReport } from "../types";
import { RunStateMachine } from "./runStateMachine";

describe("RunStateMachine", () => {
  it("allows verifier-passed completion and rejects terminal transitions", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Change hero copy" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-1",
    });
    const started = machine.transition(run, { type: "start" }).run;
    const verifying = machine.transition(started, { type: "enter_verifying" }).run;
    const completed = machine.transition(verifying, {
      type: "verification_passed",
      report: report("passed"),
    }).run;

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeTruthy();
    expect(() => machine.transition(completed, { type: "enter_planning" })).toThrow();
  });

  it("does not complete when verifier report is failed", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Fix build" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-1",
    });
    const started = machine.transition(run, { type: "start" }).run;

    expect(() =>
      machine.transition(started, {
        type: "verification_passed",
        report: report("passed"),
      }),
    ).toThrow(/Illegal run transition/);

    const verifying = machine.transition(started, { type: "enter_verifying" }).run;

    expect(() =>
      machine.transition(verifying, {
        type: "verification_passed",
        report: report("failed"),
      }),
    ).toThrow(/Cannot complete/);
  });

  it("moves failed verification into repairing until budget is exhausted", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Fix preview" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-1",
    });
    const started = machine.transition(run, { type: "start" }).run;
    const verifying = machine.transition(started, { type: "enter_verifying" }).run;
    const repairing = machine.transition(verifying, {
      type: "verification_failed",
      report: report("failed"),
    }).run;

    expect(repairing.status).toBe("repairing");
    expect(repairing.repairCycles).toBe(1);
  });

  it("supports pause, resume, and cancel requests", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Adjust styles" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-1",
    });
    const started = machine.transition(run, { type: "start" }).run;
    const pauseRequested = machine.transition(started, { type: "request_pause" }).run;
    const paused = machine.transition(pauseRequested, { type: "pause_at_boundary" }).run;
    const resumed = machine.transition(paused, { type: "resume" }).run;
    const cancelRequested = machine.transition(resumed, { type: "request_cancel" }).run;
    const cancelled = machine.transition(cancelRequested, { type: "cancel" }).run;

    expect(paused.status).toBe("paused");
    expect(resumed.status).toBe("planning");
    expect(cancelled.status).toBe("cancelled");
  });

  it("only resolves approval while waiting for approval", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Delete a file" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-1",
    });
    const started = machine.transition(run, { type: "start" }).run;

    expect(() =>
      machine.transition(started, {
        type: "approval_granted",
        approvalId: "approval-1",
      }),
    ).toThrow(/Illegal run transition/);

    const waiting = machine.transition(started, { type: "enter_waiting_approval" }).run;
    const resumed = machine.transition(waiting, {
      type: "approval_granted",
      approvalId: "approval-1",
    });

    expect(resumed.run.status).toBe("planning");
    expect(resumed.event.type).toBe("approval.resolved");
    expect(resumed.event.payload).toEqual({
      approvalId: "approval-1",
      decision: "approved",
    });
  });

  it("emits budget_exceeded status and event when repair budget is exhausted", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: {
        ...compileTaskContract({ objective: "Fix build" }),
        budget: {
          maxModelTurns: 1,
          maxToolCalls: 1,
          maxMutations: 1,
          maxRepairCycles: 0,
        },
      },
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-1",
    });
    const started = machine.transition(run, { type: "start" }).run;
    const verifying = machine.transition(started, { type: "enter_verifying" }).run;
    const result = machine.transition(verifying, {
      type: "verification_failed",
      report: report("failed"),
    });

    expect(result.run.status).toBe("budget_exceeded");
    expect(result.event.type).toBe("run.budget_exceeded");
  });
});

function report(status: VerificationReport["status"]): VerificationReport {
  return {
    id: `report-${status}`,
    runId: "run-1",
    status,
    checks: [],
    newlyIntroducedFailures: [],
    missingEvidence: [],
    artifactIds: [],
    repairFeedback: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
}
