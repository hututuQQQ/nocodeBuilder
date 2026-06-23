import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../contract/taskContract";
import type { AgentEvent, AgentRun, VerificationReport } from "../types";
import { RunStateMachine, type RunTransitionResult } from "./runStateMachine";

describe("fake-model runtime integration", () => {
  it("scenario A completes after a file mutation and passed verification", () => {
    const harness = new FakeRuntimeHarness("Change page copy");

    harness.start();
    harness.modelTurn("tool_call:read_files");
    harness.tool("read_files", true);
    harness.modelTurn("tool_call:edit_file");
    harness.tool("edit_file", true);
    harness.verify("passed");

    expect(harness.run.status).toBe("completed");
    expect(harness.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: harness.events.length }, (_, index) => index + 1),
    );
    expect(harness.report?.status).toBe("passed");
  });

  it("scenario B repairs after the first build verification fails", () => {
    const harness = new FakeRuntimeHarness("Fix broken build");

    harness.start();
    harness.modelTurn("tool_call:edit_file");
    harness.tool("edit_file", true);
    harness.verify("failed");
    harness.modelTurn("tool_call:edit_file");
    harness.tool("edit_file", true);
    harness.verify("passed");

    expect(harness.run.status).toBe("completed");
    expect(harness.run.repairCycles).toBe(1);
    expect(harness.events.some((event) => event.type === "verification.completed")).toBe(true);
  });

  it("scenario C resumes a paused run and then completes", () => {
    const harness = new FakeRuntimeHarness("Continue paused work");

    harness.start();
    harness.transition(harness.machine.transition(harness.run, { type: "request_pause" }));
    harness.transition(harness.machine.transition(harness.run, { type: "pause_at_boundary" }));
    const reloadedRun = { ...harness.run };
    harness.run = reloadedRun;
    harness.transition(harness.machine.transition(harness.run, { type: "resume" }));
    harness.modelTurn("finish_candidate");
    harness.verify("passed");

    expect(harness.run.status).toBe("completed");
    expect(harness.events.map((event) => event.type)).toContain("run.resumed");
  });
});

class FakeRuntimeHarness {
  readonly events: AgentEvent[] = [];
  readonly machine = new RunStateMachine();
  report: VerificationReport | null = null;
  run: AgentRun;

  constructor(objective: string) {
    this.run = this.machine.createRun({
      contract: compileTaskContract({ objective }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-1",
    });
    this.append("run.created", {});
  }

  start() {
    this.transition(this.machine.transition(this.run, { type: "start" }));
  }

  modelTurn(summary: string) {
    this.run = {
      ...this.run,
      modelTurns: this.run.modelTurns + 1,
    };
    this.append("model.completed", { summary });
  }

  tool(tool: string, ok: boolean) {
    this.run = {
      ...this.run,
      toolCalls: this.run.toolCalls + 1,
      mutationCount: tool === "edit_file" ? this.run.mutationCount + 1 : this.run.mutationCount,
    };
    this.append(ok ? "tool.completed" : "tool.failed", { tool });
  }

  verify(status: VerificationReport["status"]) {
    this.transition(this.machine.transition(this.run, { type: "enter_verifying" }));
    this.report = {
      id: `report-${this.events.length}`,
      runId: this.run.id,
      status,
      checks: [],
      newlyIntroducedFailures: status === "failed" ? ["build failed"] : [],
      missingEvidence: [],
      artifactIds: [],
      repairFeedback: status === "failed" ? ["BuildVerifier: build failed"] : [],
      createdAt: "2026-01-01T00:00:00Z",
    };
    this.append("verification.completed", {
      reportId: this.report.id,
      status,
    });
    this.transition(
      this.machine.transition(this.run, {
        type: status === "passed" ? "verification_passed" : "verification_failed",
        report: this.report,
      }),
    );
  }

  transition(result: RunTransitionResult) {
    this.run = result.run;
    this.append(result.event.type, result.event.payload);
  }

  private append(type: AgentEvent["type"], payload: unknown) {
    this.events.push({
      id: `event-${this.events.length + 1}`,
      runId: this.run.id,
      sequence: this.events.length + 1,
      type,
      timestamp: "2026-01-01T00:00:00Z",
      payload,
    });
  }
}
