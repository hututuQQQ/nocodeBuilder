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
    const completed = machine.transition(started, {
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

    expect(() =>
      machine.transition(run, {
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
    const repairing = machine.transition(run, {
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
    const pauseRequested = machine.transition(run, { type: "request_pause" }).run;
    const paused = machine.transition(pauseRequested, { type: "pause_at_boundary" }).run;
    const resumed = machine.transition(paused, { type: "resume" }).run;
    const cancelRequested = machine.transition(resumed, { type: "request_cancel" }).run;
    const cancelled = machine.transition(cancelRequested, { type: "cancel" }).run;

    expect(paused.status).toBe("paused");
    expect(resumed.status).toBe("planning");
    expect(cancelled.status).toBe("cancelled");
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
