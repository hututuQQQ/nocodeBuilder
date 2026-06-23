import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../contract/taskContract";
import { normalizeApprovalHash } from "../policy/policyEngine";
import type {
  AgentApproval,
  AgentEvent,
  AgentRun,
  AgentRunCheckpoint,
  TaskContract,
  ToolResult,
  VerificationReport,
} from "../types";
import {
  RunController,
  type HeadlessModelAction,
  type RunContextBundle,
  type RunControllerPorts,
} from "./runController";
import type { RunStateMachine } from "./runStateMachine";

describe("Headless RunController", () => {
  it("scenario A completes after read, edit, and passed verification", async () => {
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "read_files", args: { paths: ["app/page.tsx"] } },
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Hello",
            old_string: "Hi",
            path: "app/page.tsx",
            summary: "Update copy",
          },
        },
        { type: "finish_candidate", summary: "Copy updated" },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: compileTaskContract({ objective: "Change hero copy" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-1",
    });

    expect(run.status).toBe("completed");
    expect(run.modelTurns).toBe(3);
    expect(run.toolCalls).toBe(2);
    expect(run.mutationCount).toBe(1);
    expect(ports.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: ports.events.length }, (_, index) => index + 1),
    );
    expect(ports.events.map((event) => event.type)).toContain("run.completed");
  });

  it("scenario B repairs after failed verification and then completes", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Broken",
            old_string: "Hi",
            path: "app/page.tsx",
            summary: "Introduce first attempt",
          },
        },
        { type: "finish_candidate", summary: "First attempt ready" },
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Fixed",
            old_string: "Broken",
            path: "app/page.tsx",
            summary: "Repair failed build",
          },
        },
        { type: "finish_candidate", summary: "Repair complete" },
      ],
      verificationStatuses: ["failed", "passed"],
    });
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: compileTaskContract({ objective: "Fix build after edit" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-repair",
    });

    expect(run.status).toBe("completed");
    expect(run.repairCycles).toBe(1);
    expect(run.modelTurns).toBe(4);
    expect(run.toolCalls).toBe(2);
    expect(ports.contexts[2]?.observations).toContain("Build failed");
    expect(ports.events.map((event) => event.type)).toContain("verification.completed");
    expect(ports.events.map((event) => event.type)).toContain("run.completed");
  });

  it("scenario E resumes a waiting approval run after approved exact args hash", async () => {
    const deleteArgs = { paths: ["components/Old.tsx"], summary: "Remove obsolete component" };
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "finish_candidate", summary: "Removed component" },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const waiting = await controller.start({
      contract: compileTaskContract({ objective: "Remove obsolete component" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-approval",
    });

    expect(waiting.status).toBe("waiting_approval");
    expect(ports.approvalRecords.length).toBe(1);
    expect(ports.approvalRecords[0]?.normalizedArgsHash).toBe(
      normalizeApprovalHash("run-approval", "delete_files", deleteArgs),
    );

    ports.resolveLatestApproval("approved");
    const completed = await controller.resume("run-approval");

    expect(completed.status).toBe("completed");
    expect(completed.toolCalls).toBe(1);
    expect(ports.verificationRequests[0]?.changedFiles).toContain("components/Old.tsx");
    expect(ports.verificationRequests[0]?.deletedFiles).toEqual(["components/Old.tsx"]);
    expect(ports.events.map((event) => event.type)).toContain("approval.resolved");
    expect(ports.events.map((event) => event.type)).toContain("tool.completed");
  });

  it("scenario E returns a policy observation after approval is denied", async () => {
    const deleteArgs = { paths: ["components/Old.tsx"], summary: "Remove obsolete component" };
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "finish_candidate", summary: "Use a non-destructive alternative" },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const waiting = await controller.start({
      contract: compileTaskContract({ objective: "Remove obsolete component" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-approval-denied",
    });

    expect(waiting.status).toBe("waiting_approval");

    ports.resolveLatestApproval("denied");
    const completed = await controller.resume("run-approval-denied");

    expect(completed.status).toBe("completed");
    expect(completed.toolCalls).toBe(0);
    expect(ports.contexts[1]?.observations).toContain("Approval denied by user.");
    expect(ports.events.map((event) => event.type)).toContain("approval.resolved");
    expect(ports.events.map((event) => event.type)).not.toContain("tool.completed");
  });

  it("scenario D injects steering without expanding task permissions", async () => {
    const ports = createFakePorts({
      initialEvents: [
        {
          id: "event-steering",
          payload: { content: "不要修改数据库" },
          runId: "run-steering",
          sequence: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "steering.received",
        },
      ],
      modelActions: [{ type: "finish_candidate", summary: "No changes needed" }],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: compileTaskContract({ objective: "Change copy only", taskType: "copy_edit" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-steering",
    });

    expect(run.status).toBe("completed");
    expect(ports.contexts[0]?.steering).toContain("不要修改数据库");
    expect(ports.contexts[0]?.run.contract.permissions.databaseChange).toBe("deny");
  });

  it("scenario C resumes a paused run from checkpoint and continues to completion", async () => {
    const contract = compileTaskContract({ objective: "Continue paused copy edit" });
    const pausedRun = createPausedRun("run-resume", contract);
    const ports = createFakePorts({
      modelActions: [{ type: "finish_candidate", summary: "Ready after resume" }],
      verificationStatuses: ["passed"],
    });
    ports.seedRun(pausedRun);
    ports.seedCheckpoint({
      id: "checkpoint-resume",
      runId: pausedRun.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceFingerprint: "workspace:fingerprint",
      plan: { steps: ["read", "edit", "verify"] },
      observations: ["Read app/page.tsx before pause"],
      changedFiles: ["app/page.tsx"],
      deletedFiles: [],
      packageChanged: false,
      readSnapshots: [
        {
          contentHash: "hash-before-pause",
          path: "app/page.tsx",
          readAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      latestReportId: "report-before-pause",
      repairFeedback: [],
      steeringWatermark: 0,
    });
    const controller = new RunController(ports);

    const completed = await controller.resume(pausedRun.id);

    expect(completed.status).toBe("completed");
    expect(ports.contexts[0]?.observations).toContain("Read app/page.tsx before pause");
    expect(ports.verificationRequests[0]?.changedFiles).toEqual(["app/page.tsx"]);
    expect(ports.events.map((event) => event.type)).toContain("run.resumed");
    expect(ports.events.map((event) => event.type)).toContain("checkpoint.created");
    expect(ports.checkpointRecords[ports.checkpointRecords.length - 1]?.latestReportId).toBe(
      `report-${pausedRun.id}-passed`,
    );
  });

  it("refuses to resume blindly when the workspace fingerprint changed", async () => {
    const contract = compileTaskContract({ objective: "Continue paused copy edit" });
    const pausedRun = createPausedRun("run-stale-resume", contract);
    const ports = createFakePorts({
      modelActions: [{ type: "finish_candidate", summary: "Should not run" }],
      verificationStatuses: ["passed"],
    });
    ports.seedRun(pausedRun);
    ports.seedCheckpoint({
      id: "checkpoint-stale",
      runId: pausedRun.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceFingerprint: "workspace:fingerprint:old",
      plan: null,
      observations: [],
      changedFiles: [],
      deletedFiles: [],
      packageChanged: false,
      readSnapshots: [],
      repairFeedback: [],
      steeringWatermark: 0,
    });
    ports.setWorkspaceFingerprint("workspace:fingerprint:new");
    const controller = new RunController(ports);

    await expect(controller.resume(pausedRun.id)).rejects.toThrow(
      "Workspace fingerprint changed since checkpoint.",
    );

    expect(ports.modelCalls).toBe(0);
    expect((await ports.runStore.get(pausedRun.id))?.status).toBe("failed");
    expect(ports.events.map((event) => event.type)).toContain("run.failed");
  });

  it("scenario H preserves counters and stops after budget exhaustion", async () => {
    const ports = createFakePorts({
      modelActions: [
        { type: "answer", message: "First turn" },
        { type: "answer", message: "This should not run" },
      ],
      verificationStatuses: [],
    });
    const controller = new RunController(ports);
    const contract: TaskContract = {
      ...compileTaskContract({ objective: "Answer briefly" }),
      budget: {
        maxModelTurns: 1,
        maxToolCalls: 2,
        maxMutations: 1,
        maxRepairCycles: 0,
      },
    };

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-budget",
    });

    expect(run.status).toBe("budget_exceeded");
    expect(run.modelTurns).toBe(1);
    expect(ports.modelCalls).toBe(1);
    expect(ports.events.map((event) => event.type)).toContain("run.budget_exceeded");
  });
});

function createFakePorts({
  initialEvents = [],
  modelActions,
  verificationStatuses,
}: {
  initialEvents?: AgentEvent[];
  modelActions: HeadlessModelAction[];
  verificationStatuses: VerificationReport["status"][];
}) {
  const runs = new Map<string, AgentRun>();
  const events: AgentEvent[] = [...initialEvents];
  const approvals: AgentApproval[] = [];
  const checkpoints: AgentRunCheckpoint[] = [];
  const contexts: RunContextBundle[] = [];
  const verificationRequests: Array<{
    changedFiles: string[];
    deletedFiles: string[];
    packageChanged: boolean;
    run: AgentRun;
  }> = [];
  let modelCalls = 0;
  let workspaceFingerprint = "workspace:fingerprint";

  const appendEvent = (event: Omit<AgentEvent, "id" | "sequence">) => {
    const record: AgentEvent = {
      ...event,
      id: `event-${events.length + 1}`,
      sequence: events.length + 1,
    };
    events.push(record);
    return record;
  };

  const ports: RunControllerPorts & {
    approvalRecords: AgentApproval[];
    checkpointRecords: AgentRunCheckpoint[];
    contexts: RunContextBundle[];
    events: AgentEvent[];
    get modelCalls(): number;
    resolveLatestApproval(decision: "approved" | "denied"): void;
    seedCheckpoint(checkpoint: AgentRunCheckpoint): void;
    seedRun(run: AgentRun): void;
    setWorkspaceFingerprint(fingerprint: string): void;
    verificationRequests: Array<{
      changedFiles: string[];
      deletedFiles: string[];
      packageChanged: boolean;
      run: AgentRun;
    }>;
  } = {
    approvalRecords: approvals,
    checkpointRecords: checkpoints,
    contexts,
    artifacts: {},
    checkpoints: {
      getLatest: async (runId) =>
        [...checkpoints]
          .reverse()
          .find((checkpoint) => checkpoint.runId === runId) ?? null,
      save: async (checkpoint) => {
        checkpoints.push(checkpoint);
        return checkpoint;
      },
    },
    clock: {
      now: () => "2026-01-01T00:00:00.000Z",
    },
    events,
    eventStore: {
      append: async (event) => appendEvent(event),
      list: async (runId) => events.filter((event) => event.runId === runId),
    },
    get modelCalls() {
      return modelCalls;
    },
    model: {
      next: async (context) => {
        const action = modelActions.shift();
        contexts.push(context);
        modelCalls += 1;

        if (!action) {
          throw new Error("Fake model ran out of actions.");
        }

        return action;
      },
    },
    approvals: {
      create: async (approval) => {
        approvals.push(approval);
        return approval;
      },
      getLatestResolved: async (runId) =>
        [...approvals]
          .reverse()
          .find((approval) => approval.runId === runId && approval.decision) ?? null,
      getPending: async (runId) =>
        approvals.find(
          (approval) => approval.runId === runId && !approval.decision && !approval.resolvedAt,
        ) ?? null,
      listApprovedHashes: async (runId) =>
        new Set(
          approvals
            .filter((approval) => approval.runId === runId && approval.decision === "approved")
            .map((approval) => approval.normalizedArgsHash),
        ),
    },
    resolveLatestApproval(decision) {
      const approval = approvals[approvals.length - 1];

      if (!approval) {
        throw new Error("No approval to resolve.");
      }

      approval.decision = decision;
      approval.resolvedAt = "2026-01-01T00:01:00.000Z";
    },
    seedCheckpoint(checkpoint) {
      checkpoints.push(checkpoint);
    },
    seedRun(run) {
      runs.set(run.id, run);
    },
    setWorkspaceFingerprint(fingerprint) {
      workspaceFingerprint = fingerprint;
    },
    runStore: {
      create: async (run) => {
        runs.set(run.id, run);
        appendEvent({
          runId: run.id,
          type: "run.created",
          timestamp: run.startedAt,
          payload: { status: run.status },
        });
        return run;
      },
      get: async (runId) => runs.get(runId) ?? null,
      recordProgress: async (previousRun, patch, event) => {
        const nextRun: AgentRun = {
          ...previousRun,
          ...patch,
          stateVersion: previousRun.stateVersion + 1,
          updatedAt: event.timestamp,
        };
        runs.set(nextRun.id, nextRun);
        appendEvent(event);
        return nextRun;
      },
      transition: async (_previousRun, result: ReturnType<RunStateMachine["transition"]>) => {
        runs.set(result.run.id, result.run);
        appendEvent(result.event);
        return result.run;
      },
    },
    tools: {
      execute: async ({ tool }): Promise<ToolResult> => ({
        artifactIds: [],
        retryable: false,
        status: "success",
        summary: `${tool} succeeded`,
        workspaceEffects:
          tool === "edit_file"
            ? { changedFiles: ["app/page.tsx"], packageChanged: false }
            : tool === "delete_files"
              ? {
                  changedFiles: [],
                  deletedFiles: ["components/Old.tsx"],
                  packageChanged: false,
                }
            : undefined,
      }),
    },
    verifier: {
      verify: async (input): Promise<VerificationReport> => {
        const { run } = input;
        const status = verificationStatuses.shift() ?? "passed";
        verificationRequests.push({
          changedFiles: [...input.changedFiles],
          deletedFiles: [...input.deletedFiles],
          packageChanged: input.packageChanged,
          run,
        });

        return {
          artifactIds: [],
          checks: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          id: `report-${run.id}-${status}`,
          missingEvidence: status === "inconclusive" ? ["missing preview"] : [],
          newlyIntroducedFailures: status === "failed" ? ["build failed"] : [],
          repairFeedback: status === "failed" ? ["Build failed"] : [],
          runId: run.id,
          status,
        };
      },
    },
    verificationRequests,
    workspace: {
      fingerprint: async () => workspaceFingerprint,
    },
  };

  return ports;
}

function createPausedRun(runId: string, contract: TaskContract): AgentRun {
  return {
    id: runId,
    projectId: "project-1",
    conversationId: "conversation-1",
    contract,
    status: "paused",
    phase: "paused",
    stateVersion: 3,
    modelTurns: 1,
    toolCalls: 1,
    mutationCount: 1,
    repairCycles: 0,
    cancelRequested: false,
    pauseRequested: false,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
