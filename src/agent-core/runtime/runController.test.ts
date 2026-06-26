import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../contract/taskContract";
import { normalizeApprovalHash } from "../policy/policyEngine";
import type {
  AgentApproval,
  AgentEvent,
  AgentReadSnapshot,
  AgentRun,
  AgentRunCheckpoint,
  TaskContract,
  ToolResult,
  VerificationReport,
} from "../types";
import {
  RunController,
  type HeadlessModelAction,
  readRunDriveStateMetadata,
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
      verificationStatuses: ["failed", "passed", "passed"],
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
    expect(run.modelTurns).toBe(3);
    expect(run.toolCalls).toBe(2);
    expect(ports.contexts[1]?.observations).toContain("Build failed");
    expect(ports.events.map((event) => event.type)).toContain("verification.completed");
    expect(ports.events.map((event) => event.type)).toContain("run.completed");
  });

  it("feeds model validation errors back as observations before retrying", async () => {
    const ports = createFakePorts({
      modelActions: [
        createModelValidationAction("Invalid model response: unsupported Supabase column type \"int2\"."),
        { type: "finish_candidate", summary: "Schema fixed" },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: compileTaskContract({ objective: "Create Supabase tables" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-model-validation",
    });

    expect(run.status).toBe("completed");
    expect(run.modelTurns).toBe(2);
    expect(ports.contexts[1]?.observations.join("\n")).toContain("model_validation");
    expect(ports.contexts[1]?.observations.join("\n")).toContain("unsupported Supabase column type");
    expect(ports.events.map((event) => event.type)).toContain("model.failed");
    expect(ports.events.map((event) => event.type)).toContain("run.completed");

    const latestCheckpoint =
      ports.checkpointRecords[ports.checkpointRecords.length - 1];
    const metadata = readRunDriveStateMetadata(latestCheckpoint?.plan);
    expect(metadata.consecutiveModelValidationFailures).toBe(0);
  });

  it("auto-completes a Spec run after a passed tool verification", async () => {
    const specContract: TaskContract = {
      ...compileTaskContract({ objective: "Implement task file" }),
      source: {
        acceptanceCriteriaIds: ["criterion-1"],
        expectedFiles: ["app/page.tsx"],
        mode: "spec",
        requirementIds: ["story-1"],
        revisionId: "revision-1",
        specId: "spec-1",
        taskId: "task-1",
      },
    };
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Hello",
            old_string: "Hi",
            path: "app/page.tsx",
            summary: "Update page",
          },
        },
        { type: "tool_call", tool: "read_files", args: { paths: ["app/page.tsx"] } },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: specContract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-spec-autocomplete",
    });

    expect(run.status).toBe("completed");
    expect(run.modelTurns).toBe(1);
    expect(run.toolCalls).toBe(1);
    expect(ports.modelCalls).toBe(1);
    expect(ports.events.map((event) => event.type)).toContain("run.completed");
  });

  it("stops repeated model validation observations after one loop rescue", async () => {
    const ports = createFakePorts({
      modelActions: [
        createModelValidationAction("Invalid model response: unsupported Supabase default value \"''\"."),
        createModelValidationAction("Invalid model response: unsupported Supabase default value \"''\"."),
        createModelValidationAction("Invalid model response: unsupported Supabase default value \"''\"."),
      ],
      verificationStatuses: [],
    });
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: compileTaskContract({ objective: "Create Supabase tables" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-model-validation-exhausted",
    });

    expect(run.status).toBe("budget_exceeded");
    expect(run.modelTurns).toBe(3);
    expect(
      ports.events.filter((event) => event.type === "model.failed"),
    ).toHaveLength(3);
    expect(ports.events.find((event) => event.type === "run.budget_exceeded")?.payload)
      .toMatchObject({
        failureKind: "loop_exhausted",
      });
    const latestCheckpoint =
      ports.checkpointRecords[ports.checkpointRecords.length - 1];
    expect(latestCheckpoint?.observations.join("\n")).toContain(
      "model_validation",
    );
    expect(latestCheckpoint?.observations.join("\n")).toContain(
      "loop_rescue",
    );
  });

  it("scenario E resumes a waiting approval run after approved exact args hash", async () => {
    const deleteArgs = { paths: ["components/Old.tsx"], summary: "Remove obsolete component" };
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "finish_candidate", summary: "Removed component" },
      ],
      verificationStatuses: ["passed", "passed"],
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

  it("consumes an approved action only once", async () => {
    const deleteArgs = { paths: ["components/Old.tsx"], summary: "Remove obsolete component" };
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const waiting = await controller.start({
      contract: compileTaskContract({ objective: "Remove obsolete component" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-approval-consume",
    });

    expect(waiting.status).toBe("waiting_approval");
    ports.resolveLatestApproval("approved");

    const waitingAgain = await controller.resume("run-approval-consume");

    expect(waitingAgain.status).toBe("waiting_approval");
    expect(waitingAgain.toolCalls).toBe(1);
    expect(ports.approvalRecords).toHaveLength(2);
  });

  it("executes identical approved actions through independent approval ids", async () => {
    const deleteArgs = { paths: ["components/Old.tsx"], summary: "Remove obsolete component" };
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "finish_candidate", summary: "Removed component twice" },
      ],
      verificationStatuses: ["passed", "passed", "passed"],
    });
    const controller = new RunController(ports);

    const waitingA = await controller.start({
      contract: compileTaskContract({ objective: "Remove obsolete component twice" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-approval-repeat",
    });

    expect(waitingA.status).toBe("waiting_approval");
    const approvalA = ports.approvalRecords[0]!;
    ports.resolveLatestApproval("approved");

    const waitingB = await controller.resume("run-approval-repeat");

    expect(waitingB.status).toBe("waiting_approval");
    expect(waitingB.toolCalls).toBe(1);
    expect(approvalA.consumedAt).toBeDefined();
    expect(ports.approvalRecords).toHaveLength(2);
    const approvalB = ports.approvalRecords[1]!;
    expect(approvalB.id).not.toBe(approvalA.id);
    expect(approvalB.normalizedArgsHash).toBe(approvalA.normalizedArgsHash);

    ports.resolveLatestApproval("approved");
    const completed = await controller.resume("run-approval-repeat");

    expect(completed.status).toBe("completed");
    expect(completed.toolCalls).toBe(2);
    expect(approvalB.consumedAt).toBeDefined();
    expect(ports.events.filter((event) => event.type === "approval.consumed"))
      .toHaveLength(2);
    expect(ports.events.filter((event) => event.type === "tool.completed"))
      .toHaveLength(2);
  });

  it("does not replay an approval that was already claimed before resume", async () => {
    const deleteArgs = { paths: ["components/Old.tsx"], summary: "Remove obsolete component" };
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "finish_candidate", summary: "Should not execute" },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const waiting = await controller.start({
      contract: compileTaskContract({ objective: "Remove obsolete component" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-approval-crash-resume",
    });

    expect(waiting.status).toBe("waiting_approval");
    const approvalA = ports.approvalRecords[0]!;
    approvalA.decision = "approved";
    approvalA.resolvedAt = "2026-01-01T00:01:00.000Z";
    approvalA.consumedAt = "2026-01-01T00:01:30.000Z";
    approvalA.consumedToolCallId = "tool-call-before-crash";

    const recovered = await controller.resume("run-approval-crash-resume");

    expect(recovered.status).toBe("waiting_approval");
    expect(recovered.toolCalls).toBe(0);
    expect(ports.approvalRecords).toHaveLength(2);
    expect(ports.events.filter((event) => event.type === "tool.completed"))
      .toHaveLength(0);
  });

  it("does not execute the tool when an approval claim fails", async () => {
    const deleteArgs = { paths: ["components/Old.tsx"], summary: "Remove obsolete component" };
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "finish_candidate", summary: "Claim failed safely" },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const waiting = await controller.start({
      contract: compileTaskContract({ objective: "Remove obsolete component" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-approval-claim-race",
    });

    expect(waiting.status).toBe("waiting_approval");
    ports.resolveLatestApproval("approved");
    ports.approvals.claimApprovedAuthorization = async () => {
      throw new Error("approval was claimed elsewhere");
    };

    const completed = await controller.resume("run-approval-claim-race");

    expect(completed.status).toBe("completed");
    expect(completed.toolCalls).toBe(0);
    expect(ports.events.filter((event) => event.type === "approval.consume_failed"))
      .toHaveLength(1);
    expect(ports.events.filter((event) => event.type === "tool.completed"))
      .toHaveLength(0);
  });

  it("keeps an unresolved approval waiting after expiresAt instead of expiring the run", async () => {
    const deleteArgs = { paths: ["components/Old.tsx"], summary: "Remove obsolete component" };
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "delete_files", args: deleteArgs },
        { type: "finish_candidate", summary: "Should not run before approval" },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    const waiting = await controller.start({
      contract: compileTaskContract({ objective: "Remove obsolete component" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-approval-late",
    });
    ports.approvalRecords[0]!.expiresAt = "2000-01-01T00:00:00.000Z";

    const stillWaiting = await controller.resume(waiting.id);

    expect(stillWaiting.status).toBe("waiting_approval");
    expect(stillWaiting.modelTurns).toBe(1);
    expect(ports.approvalRecords[0]?.decision).toBeUndefined();
    expect(ports.events.map((event) => event.type)).not.toContain("approval.expired");
    expect(ports.events.filter((event) => event.type === "approval.requested"))
      .toHaveLength(1);
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

  it("prunes stale read snapshots when the workspace fingerprint changed", async () => {
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
      readSnapshots: [
        {
          contentHash: "stale",
          path: "app/page.tsx",
          readAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      repairFeedback: [],
      steeringWatermark: 0,
    });
    ports.setWorkspaceFingerprint("workspace:fingerprint:new");
    const controller = new RunController(ports);

    const completed = await controller.resume(pausedRun.id);

    expect(completed.status).toBe("completed");
    expect(ports.modelCalls).toBe(1);
    expect(
      ports.checkpointRecords[ports.checkpointRecords.length - 1]?.readSnapshots,
    ).toEqual([]);
  });

  it("persists a rolling run context summary in checkpoint metadata", async () => {
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "read_files", args: { paths: ["app/page.tsx"] } },
        { type: "finish_candidate", summary: "Ready to verify" },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    await controller.start({
      contract: compileTaskContract({ objective: "Inspect and finish" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-summary",
    });

    const latestCheckpoint = ports.checkpointRecords[ports.checkpointRecords.length - 1];
    const metadata = readRunDriveStateMetadata(latestCheckpoint.plan);

    expect(metadata.userPlan).toBeNull();
    expect(metadata.runContextSummary?.objective).toBe("Inspect and finish");
    expect(metadata.runContextSummary?.summarizedObservationCount).toBeGreaterThanOrEqual(1);
    expect(metadata.runContextSummary?.completed.join("\n")).toContain("read_files succeeded");
  });

  it("surfaces failed baseline diagnostics to the first model turn", async () => {
    const ports = createFakePorts({
      modelActions: [
        { type: "finish_candidate", summary: "Repair can be planned from baseline" },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);

    await controller.start({
      baselineCommandResults: {
        build: {
          command: "npm run build",
          exitCode: 1,
          output: [
            "Failed to compile.",
            "./lib/game/controller.ts:164:9",
            "Type error: Property 'rank' does not exist on type 'HandRank'.",
          ].join("\n"),
          success: false,
        },
      },
      contract: compileTaskContract({ objective: "Repair build before continuing" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-baseline-diagnostics",
    });

    expect(ports.contexts[0]?.observations.join("\n")).toContain(
      "baseline_diagnostics",
    );
    expect(ports.contexts[0]?.observations.join("\n")).toContain(
      "lib/game/controller.ts:164:9",
    );
    expect(ports.contexts[0]?.runContextSummary.latestFailures.join("\n"))
      .toContain("Baseline build failed before this run");
  });

  it("does not classify successful read_files content as latest failure", async () => {
    const contract = compileTaskContract({ objective: "Inspect existing UI" });
    const pausedRun = createPausedRun("run-read-summary", contract);
    const readObservation = JSON.stringify({
      files: [
        {
          content: "const [error, setError] = useState(''); return <p>网络错误，请重试</p>;",
          path: "components/Lobby.tsx",
        },
      ],
    });
    const ports = createFakePorts({
      modelActions: [
        { type: "finish_candidate", summary: "Already implemented" },
      ],
      verificationStatuses: ["passed"],
    });
    ports.seedRun(pausedRun);
    ports.seedCheckpoint({
      id: "checkpoint-read-summary",
      runId: pausedRun.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceFingerprint: "workspace:fingerprint",
      plan: null,
      observations: [readObservation],
      changedFiles: [],
      deletedFiles: [],
      packageChanged: false,
      readSnapshots: [],
      repairFeedback: [],
      steeringWatermark: 0,
    });
    const controller = new RunController(ports);

    await controller.resume(pausedRun.id);

    expect(ports.contexts[0]?.runContextSummary.latestFailures).toEqual([]);
    expect(ports.contexts[0]?.runContextSummary.completed).toHaveLength(1);
  });

  it("summarizes successful structured observations without carrying raw file content", async () => {
    const contract = compileTaskContract({ objective: "Continue from read" });
    const pausedRun = createPausedRun("run-structured-summary", contract);
    const readObservation = JSON.stringify({
      content: JSON.stringify({
        files: [
          {
            content: "x".repeat(6_000),
            path: "components/Lobby.tsx",
          },
        ],
      }),
      ok: true,
      summary: "Read 1 file(s): components/Lobby.tsx",
      tool: "read_files",
    });
    const ports = createFakePorts({
      modelActions: [
        { type: "finish_candidate", summary: "Already inspected" },
      ],
      verificationStatuses: ["passed"],
    });
    ports.seedRun(pausedRun);
    ports.seedCheckpoint({
      id: "checkpoint-structured-summary",
      runId: pausedRun.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceFingerprint: "workspace:fingerprint",
      plan: null,
      observations: [readObservation],
      changedFiles: [],
      deletedFiles: [],
      packageChanged: false,
      readSnapshots: [],
      repairFeedback: [],
      steeringWatermark: 0,
    });
    const controller = new RunController(ports);

    await controller.resume(pausedRun.id);

    expect(ports.contexts[0]?.runContextSummary.completed).toEqual([
      "Read 1 file(s): components/Lobby.tsx",
    ]);
  });

  it("falls back to deterministic context summary when the LLM summarizer fails", async () => {
    const contract = compileTaskContract({ objective: "Continue long run" });
    const pausedRun = createPausedRun("run-summary-fallback", contract);
    const longObservations = Array.from(
      { length: 9 },
      (_, index) => `Observation ${index} ${"x".repeat(3_000)}`,
    );
    const ports = createFakePorts({
      modelActions: [
        { type: "finish_candidate", summary: "Recovered" },
      ],
      verificationStatuses: ["passed"],
    });
    ports.contextSummarizer = {
      summarize: async () => {
        throw new Error("summary model unavailable");
      },
    };
    ports.seedRun(pausedRun);
    ports.seedCheckpoint({
      id: "checkpoint-summary-fallback",
      runId: pausedRun.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceFingerprint: "workspace:fingerprint",
      plan: null,
      observations: longObservations,
      changedFiles: ["app/page.tsx"],
      deletedFiles: [],
      packageChanged: false,
      readSnapshots: [],
      repairFeedback: [],
      steeringWatermark: 0,
    });
    const controller = new RunController(ports);

    const completed = await controller.resume(pausedRun.id);

    expect(completed.status).toBe("completed");
    expect(ports.contexts[0]?.runContextSummary.summarizedObservationCount)
      .toBe(longObservations.length);
  });

  it("scenario H verifies answers once and completes without exhausting budget", async () => {
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

    expect(run.status).toBe("completed");
    expect(run.modelTurns).toBe(1);
    expect(ports.modelCalls).toBe(1);
    expect(ports.events.map((event) => event.type)).toContain("run.completed");
  });

  it("stops before executing a tool after maxToolCalls is reached", async () => {
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "read_files", args: { paths: ["app/page.tsx"] } },
        { type: "tool_call", tool: "read_files", args: { paths: ["components/Hero.tsx"] } },
      ],
      verificationStatuses: [],
    });
    const controller = new RunController(ports);
    const contract: TaskContract = {
      ...compileTaskContract({ objective: "Inspect files" }),
      budget: {
        maxModelTurns: 4,
        maxToolCalls: 1,
        maxMutations: 2,
        maxRepairCycles: 1,
      },
    };

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-tool-budget",
    });

    expect(run.status).toBe("budget_exceeded");
    expect(run.toolCalls).toBe(1);
    expect(ports.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
  });

  it("surfaces forbidden-path policy denials to the next model turn", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "write_files",
          args: {
            files: [{ content: "SECRET=value", path: ".env.local" }],
            summary: "Write env file",
          },
        },
        { type: "answer", message: "I cannot write env files." },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);
    const contract = compileTaskContract({ objective: "Change scoped files" });

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-policy-denied",
    });

    expect(run.status).toBe("completed");
    expect(ports.contexts[1]?.observations).toContain(
      "Policy denied write_files: Tool target is inside a forbidden path such as .aibuilder or .env.",
    );
    expect(ports.events.map((event) => event.type)).toContain("policy.denied");
  });

  it("stops before executing a write tool after maxMutations is reached", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Hello",
            old_string: "Hi",
            path: "app/page.tsx",
            summary: "First edit",
          },
        },
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Hey",
            old_string: "Hello",
            path: "app/page.tsx",
            summary: "Second edit",
          },
        },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);
    const contract: TaskContract = {
      ...compileTaskContract({ objective: "Edit copy" }),
      budget: {
        maxModelTurns: 4,
        maxToolCalls: 4,
        maxMutations: 1,
        maxRepairCycles: 1,
      },
    };

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-mutation-budget",
    });

    expect(run.status).toBe("budget_exceeded");
    expect(run.mutationCount).toBe(1);
    expect(ports.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
  });

  it("keeps answer tasks read-only when the model tries to write after inspection", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "read_files",
          args: { paths: ["lib/auth.ts"] },
        },
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Fixed",
            old_string: "Broken",
            path: "lib/auth.ts",
            summary: "Fix auth",
          },
        },
        {
          type: "answer",
          message: "注册失败是因为 profiles.user_id 没有被写入。",
        },
      ],
      verificationStatuses: ["passed"],
    });
    const controller = new RunController(ports);
    const contract = compileTaskContract({
      objective:
        "为什么注册不了。null value in column \"user_id\" of relation \"profiles\" violates not-null constraint。",
    });

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-answer-write-denied",
    });

    expect(contract.taskType).toBe("answer");
    expect(run.status).toBe("completed");
    expect(run.mutationCount).toBe(0);
    expect(ports.events.some((event) =>
      event.type === "run.budget_exceeded" &&
      event.payload &&
      typeof event.payload === "object" &&
      "budget" in event.payload &&
      event.payload.budget === "maxMutations",
    )).toBe(false);
    expect(ports.events.map((event) => event.type)).toContain("policy.denied");
    expect(ports.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
    expect(ports.contexts[2]?.observations).toContain(
      "Policy denied edit_file: This task contract does not permit file writes.",
    );
  });

  it("does not continue repairing after the repair budget is exhausted", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Broken",
            old_string: "Hi",
            path: "app/page.tsx",
            summary: "Break build",
          },
        },
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Should not run",
            old_string: "Broken",
            path: "app/page.tsx",
            summary: "Repair",
          },
        },
      ],
      verificationStatuses: ["failed"],
    });
    const controller = new RunController(ports);
    const contract: TaskContract = {
      ...compileTaskContract({ objective: "Fix preview" }),
      budget: {
        maxModelTurns: 4,
        maxToolCalls: 4,
        maxMutations: 4,
        maxRepairCycles: 0,
      },
    };

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-repair-budget",
    });

    expect(run.status).toBe("budget_exceeded");
    expect(run.modelTurns).toBe(1);
    expect(run.toolCalls).toBe(1);
  });

  it("stops repeated verification failures after one loop rescue", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Broken once",
            old_string: "Hi",
            path: "app/page.tsx",
            summary: "First repair attempt",
          },
        },
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Broken twice",
            old_string: "Broken once",
            path: "app/page.tsx",
            summary: "Second repair attempt",
          },
        },
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Broken third time",
            old_string: "Broken twice",
            path: "app/page.tsx",
            summary: "Third repair attempt",
          },
        },
      ],
      verificationStatuses: ["failed", "failed", "failed"],
    });
    const controller = new RunController(ports);
    const contract: TaskContract = {
      ...compileTaskContract({ objective: "Fix repeated build failure" }),
      budget: {
        maxModelTurns: 8,
        maxToolCalls: 8,
        maxMutations: 8,
        maxRepairCycles: 8,
      },
    };

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-loop-guard",
    });

    const terminalEvent = ports.events.find((event) => event.type === "run.budget_exceeded");
    const rescueCheckpoint = ports.checkpointRecords.find((checkpoint) =>
      checkpoint.observations.some((observation) =>
        String(observation).includes('"tool":"loop_rescue"'),
      ),
    );

    expect(run.status).toBe("budget_exceeded");
    expect(run.modelTurns).toBe(3);
    expect(rescueCheckpoint).toBeDefined();
    expect(terminalEvent?.payload).toMatchObject({
      failureKind: "loop_exhausted",
    });
  });

  it("stops read-only no-progress loops after one focused rescue", async () => {
    const readActions: HeadlessModelAction[] = Array.from(
      { length: 20 },
      (_, index) => ({
        type: "tool_call",
        tool: "read_files",
        args: { paths: [`app/read-${index}.tsx`] },
      }),
    );
    const ports = createFakePorts({
      modelActions: readActions,
      verificationStatuses: [],
    });
    const controller = new RunController(ports);
    const contract: TaskContract = {
      ...compileTaskContract({ objective: "Implement a feature from several files" }),
      budget: {
        maxModelTurns: 40,
        maxToolCalls: 40,
        maxMutations: 8,
        maxRepairCycles: 8,
      },
      source: {
        acceptanceCriteriaIds: ["criterion-1"],
        expectedFiles: ["app/page.tsx", "components/Panel.tsx"],
        mode: "spec",
        requirementIds: ["story-1"],
        revisionId: "revision-1",
        specId: "spec-1",
        taskId: "task-1",
      },
    };

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-read-only-stall",
    });

    const terminalEvent = ports.events.find((event) => event.type === "run.budget_exceeded");
    const rescueCheckpoint = ports.checkpointRecords.find((checkpoint) =>
      checkpoint.observations.some((observation) =>
        String(observation).includes("Read-only exploration is repeating"),
      ),
    );
    const rescueContext = ports.contexts.find((context) =>
      context.observations.join("\n").includes("Read-only exploration is repeating"),
    );

    expect(run.status).toBe("budget_exceeded");
    expect(run.modelTurns).toBeLessThan(contract.budget.maxModelTurns);
    expect(run.toolCalls).toBeLessThan(contract.budget.maxToolCalls);
    expect(rescueCheckpoint).toBeDefined();
    expect(rescueContext).toBeDefined();
    expect(terminalEvent?.payload).toMatchObject({
      failureKind: "loop_exhausted",
      reason: expect.stringContaining("Read-only exploration repeated"),
    });
  });

  it("auto-verifies after read-only evidence satisfies missing expected files", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "edit_file",
          args: {
            new_string: "Hello",
            old_string: "Hi",
            path: "app/page.tsx",
            summary: "Update page",
          },
        },
        {
          type: "tool_call",
          tool: "read_files",
          args: { paths: ["components/Panel.tsx"] },
        },
        { type: "finish_candidate", summary: "Should not need another model turn" },
      ],
      verificationStatuses: [],
    });
    let verificationCount = 0;
    ports.tools.execute = async ({ args, tool }): Promise<ToolResult> => {
      if (tool === "edit_file") {
        return {
          artifactIds: [],
          retryable: false,
          status: "success",
          summary: "Edited app/page.tsx.",
          workspaceEffects: {
            changedFiles: ["app/page.tsx"],
            packageChanged: false,
          },
        };
      }

      const path = (args as { paths: string[] }).paths[0]!;
      return {
        artifactIds: [],
        retryable: false,
        status: "success",
        structuredData: {
          files: [{ content: "export function Panel() { return null; }", path }],
        },
        summary: `Read ${path}`,
        workspaceEffects: {
          changedFiles: [],
          packageChanged: false,
          readSnapshots: [
            {
              contentHash: `hash:${path}`,
              path,
              readAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      };
    };
    ports.verifier.verify = async (input): Promise<VerificationReport> => {
      verificationCount += 1;

      if (verificationCount === 1) {
        return {
          artifactIds: [],
          checks: [
            {
              id: "acceptance:request-addressed",
              required: true,
              status: "inconclusive",
              summary: "Expected file evidence is missing for: components/Panel.tsx.",
              title: "Acceptance: request-addressed",
            },
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "report-missing-evidence",
          missingEvidence: [
            "Expected file evidence is missing for: components/Panel.tsx.",
          ],
          newlyIntroducedFailures: [],
          repairFeedback: [],
          runId: input.run.id,
          status: "inconclusive",
        };
      }

      return {
        artifactIds: [],
        checks: [
          {
            id: "acceptance:request-addressed",
            required: true,
            status: "passed",
            summary: "Existing workspace evidence inspected expected file(s).",
            title: "Acceptance: request-addressed",
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "report-evidence-passed",
        missingEvidence: [],
        newlyIntroducedFailures: [],
        repairFeedback: [],
        runId: input.run.id,
        status: "passed",
      };
    };
    const controller = new RunController(ports);
    const contract: TaskContract = {
      ...compileTaskContract({ objective: "Update page and panel" }),
      source: {
        acceptanceCriteriaIds: ["criterion-1"],
        expectedFiles: ["app/page.tsx", "components/Panel.tsx"],
        mode: "spec",
        requirementIds: ["story-1"],
        revisionId: "revision-1",
        specId: "spec-1",
        taskId: "task-1",
      },
    };

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-auto-evidence-verify",
    });

    expect(run.status).toBe("completed");
    expect(verificationCount).toBe(2);
    expect(ports.modelCalls).toBe(2);
    expect(ports.events.filter((event) => event.type === "verification.completed"))
      .toHaveLength(2);
    expect(
      ports.checkpointRecords.some((checkpoint) =>
        checkpoint.runId === run.id &&
        checkpoint.readSnapshots.some((snapshot) => snapshot.path === "components/Panel.tsx"),
      ),
    ).toBe(true);
  });

  it("auto-verifies a spec run once all expected files are read before mutation", async () => {
    const expectedFiles = [
      "components/ActionPanel.tsx",
      "lib/game/controller.ts",
      "app/api/game/route.ts",
    ];
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_calls",
          calls: expectedFiles.map((path) => ({
            type: "tool_call",
            tool: "read_files",
            args: { paths: [path] },
          })),
        },
        {
          type: "tool_call",
          tool: "read_files",
          args: { paths: ["components/ActionPanel.tsx"] },
        },
      ],
      verificationStatuses: [],
    });
    let verificationCount = 0;
    ports.tools.execute = async ({ args, tool }): Promise<ToolResult> => {
      expect(tool).toBe("read_files");
      const path = (args as { paths: string[] }).paths[0]!;
      return {
        artifactIds: [],
        retryable: false,
        status: "success",
        structuredData: {
          files: [{ content: `// ${path}`, path }],
        },
        summary: `Read ${path}`,
        workspaceEffects: {
          changedFiles: [],
          packageChanged: false,
          readSnapshots: [
            {
              contentHash: `hash:${path}`,
              path,
              readAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      };
    };
    ports.verifier.verify = async (input): Promise<VerificationReport> => {
      verificationCount += 1;
      expect(input.changedFiles).toEqual([]);
      expect(input.readSnapshots?.map((snapshot) => snapshot.path).sort())
        .toEqual([...expectedFiles].sort());

      return {
        artifactIds: [],
        checks: [
          {
            id: "acceptance:request-addressed",
            required: true,
            status: "passed",
            summary: "Existing workspace evidence inspected expected file(s).",
            title: "Acceptance: request-addressed",
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "report-expected-files-read",
        missingEvidence: [],
        newlyIntroducedFailures: [],
        repairFeedback: [],
        runId: input.run.id,
        status: "passed",
      };
    };
    const controller = new RunController(ports);
    const contract: TaskContract = {
      ...compileTaskContract({ objective: "Implement action panel integration" }),
      source: {
        acceptanceCriteriaIds: ["criterion-5", "criterion-6"],
        expectedFiles,
        mode: "spec",
        requirementIds: ["story-4", "story-5"],
        revisionId: "revision-1",
        specId: "spec-1",
        taskId: "task-8",
      },
    };

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-expected-files-read-auto-verify",
    });

    expect(run.status).toBe("completed");
    expect(run.modelTurns).toBe(1);
    expect(run.toolCalls).toBe(expectedFiles.length);
    expect(verificationCount).toBe(1);
    expect(
      ports.checkpointRecords.some((checkpoint) =>
        checkpoint.runId === run.id &&
        checkpoint.id.includes("checkpoint") &&
        readRunDriveStateMetadata(checkpoint.plan).expectedFileEvidenceAutoVerifyKey
          ?.includes("components/ActionPanel.tsx"),
      ),
    ).toBe(true);
  });

  it("auto-reads missing spec expected files when read-only exploration skips them", async () => {
    const expectedFiles = [
      "components/ActionPanel.tsx",
      "lib/game/controller.ts",
      "app/api/game/route.ts",
    ];
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "read_files",
          args: { paths: ["components/ActionPanel.tsx"] },
        },
        {
          type: "tool_call",
          tool: "read_files",
          args: { paths: ["lib/context/GameContext.tsx"] },
        },
        {
          type: "tool_call",
          tool: "read_files",
          args: { paths: ["components/ActionPanel.tsx"] },
        },
      ],
      verificationStatuses: ["passed"],
    });
    ports.tools.execute = async ({ args, tool }): Promise<ToolResult> => {
      expect(tool).toBe("read_files");
      const path = (args as { paths: string[] }).paths[0]!;
      return {
        artifactIds: [],
        retryable: false,
        status: "success",
        structuredData: {
          files: [{ content: `// ${path}`, path }],
        },
        summary: `Read ${path}`,
        workspaceEffects: {
          changedFiles: [],
          packageChanged: false,
          readSnapshots: [
            {
              contentHash: `hash:${path}`,
              path,
              readAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      };
    };
    const controller = new RunController(ports);
    const contract: TaskContract = {
      ...compileTaskContract({ objective: "Implement action panel integration" }),
      source: {
        acceptanceCriteriaIds: ["criterion-5", "criterion-6"],
        expectedFiles,
        mode: "spec",
        requirementIds: ["story-4", "story-5"],
        revisionId: "revision-1",
        specId: "spec-1",
        taskId: "task-8",
      },
    };

    const run = await controller.start({
      contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-auto-read-missing-expected-files",
    });

    expect(run.status).toBe("completed");
    expect(run.modelTurns).toBe(2);
    expect(run.toolCalls).toBe(4);
    expect(ports.verificationRequests).toHaveLength(1);
    expect(
      ports.verificationRequests[0]?.readSnapshots
        .map((snapshot) => snapshot.path)
        .sort(),
    ).toEqual([
      ...expectedFiles,
      "lib/context/GameContext.tsx",
    ].sort());
    expect(
      ports.events.some((event) =>
        event.type === "plan.updated" &&
        JSON.stringify(event.payload).includes("auto-reading-missing-expected-files"),
      ),
    ).toBe(true);
    expect(
      ports.checkpointRecords.some((checkpoint) =>
        checkpoint.observations.some((observation) =>
          String(observation).includes("Auto-reading missing expected file"),
        ),
      ),
    ).toBe(true);
  });

  it("runs read-only tool_calls concurrently and records observations in order", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_calls",
          calls: [
            { type: "tool_call", tool: "read_files", args: { paths: ["app/a.tsx"] } },
            { type: "tool_call", tool: "read_files", args: { paths: ["app/b.tsx"] } },
          ],
        },
        { type: "finish_candidate", summary: "Read both files" },
      ],
      verificationStatuses: ["passed"],
    });
    const starts: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    ports.tools.execute = async ({ args }): Promise<ToolResult> => {
      const path = (args as { paths: string[] }).paths[0]!;
      starts.push(path);

      if (starts.length === 1) {
        await firstStarted;
      } else {
        releaseFirst?.();
      }

      return {
        artifactIds: [],
        retryable: false,
        status: "success",
        structuredData: `read:${path}`,
        summary: `Read ${path}`,
        workspaceEffects: {
          changedFiles: [],
          packageChanged: false,
          readSnapshots: [
            {
              contentHash: `hash:${path}`,
              path,
              readAt: path === "app/a.tsx"
                ? "2026-01-01T00:00:02.000Z"
                : "2026-01-01T00:00:01.000Z",
            },
          ],
        },
      };
    };
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: compileTaskContract({ objective: "Inspect files" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-batch",
    });

    expect(run.status).toBe("completed");
    expect(run.toolCalls).toBe(2);
    expect(starts).toEqual(["app/a.tsx", "app/b.tsx"]);
    expect(ports.contexts[1]?.observations.join("\n")).toContain("read:app/a.tsx");
    expect(ports.contexts[1]?.observations.join("\n")).toContain("read:app/b.tsx");
    expect(
      ports.checkpointRecords[ports.checkpointRecords.length - 1]?.readSnapshots,
    ).toEqual([
      {
        contentHash: "hash:app/a.tsx",
        path: "app/a.tsx",
        readAt: "2026-01-01T00:00:02.000Z",
      },
      {
        contentHash: "hash:app/b.tsx",
        path: "app/b.tsx",
        readAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(ports.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: ports.events.length }, (_, index) => index + 1),
    );
  });

  it("allows duplicate read_files when exact retained content may be needed", async () => {
    const ports = createFakePorts({
      modelActions: [
        { type: "tool_call", tool: "read_files", args: { paths: ["app/page.tsx"] } },
        { type: "tool_call", tool: "read_files", args: { paths: ["app/page.tsx"] } },
        { type: "finish_candidate", summary: "Existing page inspected" },
      ],
      verificationStatuses: ["passed"],
    });
    let readExecutions = 0;
    ports.tools.execute = async ({ tool }): Promise<ToolResult> => {
      if (tool !== "read_files") {
        throw new Error(`Unexpected tool ${tool}`);
      }

      readExecutions += 1;
      return {
        artifactIds: [],
        retryable: false,
        status: "success",
        structuredData: {
          files: [
            {
              content: "export default function Page() {}",
              path: "app/page.tsx",
            },
          ],
        },
        summary: "Read app/page.tsx",
        workspaceEffects: {
          changedFiles: [],
          packageChanged: false,
          readSnapshots: [
            {
              contentHash: "hash-1",
              path: "app/page.tsx",
              readAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      };
    };
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: compileTaskContract({ objective: "Inspect page" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-duplicate-read",
    });

    expect(run.status).toBe("completed");
    expect(readExecutions).toBe(2);
    expect(run.toolCalls).toBe(2);
    expect(ports.events.some((event) =>
      event.type === "tool.failed" &&
      JSON.stringify(event.payload).includes("Duplicate read_files skipped"),
    )).toBe(false);
  });

  it("allows repeated reads after a mutation so edits can recover exact text", async () => {
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
            summary: "Update page",
          },
        },
        { type: "tool_call", tool: "read_files", args: { paths: ["app/page.tsx"] } },
        { type: "tool_call", tool: "read_files", args: { paths: ["app/page.tsx"] } },
        { type: "finish_candidate", summary: "Repair complete" },
      ],
      verificationStatuses: ["failed", "passed"],
    });
    let readExecutions = 0;
    let editExecutions = 0;
    ports.tools.execute = async ({ tool }): Promise<ToolResult> => {
      if (tool === "read_files") {
        readExecutions += 1;

        return {
          artifactIds: [],
          retryable: false,
          status: "success",
          structuredData: {
            files: [
              {
                content: "1 | export default function Page() {}",
                contentHash: `hash-${readExecutions}`,
                endLine: 1,
                path: "app/page.tsx",
                startLine: 1,
                totalLines: 1,
                truncated: false,
              },
            ],
          },
          summary: "Read app/page.tsx",
          workspaceEffects: {
            changedFiles: [],
            packageChanged: false,
            readSnapshots: [
              {
                contentHash: `hash-${readExecutions}`,
                path: "app/page.tsx",
                readAt: `2026-01-01T00:00:0${readExecutions}.000Z`,
              },
            ],
          },
        };
      }

      if (tool === "edit_file") {
        editExecutions += 1;

        return {
          artifactIds: [],
          retryable: false,
          status: "success",
          structuredData: "Edited app/page.tsx.",
          summary: "Edited app/page.tsx.",
          workspaceEffects: {
            changedFiles: ["app/page.tsx"],
            packageChanged: false,
          },
        };
      }

      throw new Error(`Unexpected tool ${tool}`);
    };
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: compileTaskContract({ objective: "Repair page" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-reread-after-mutation",
    });

    expect(run.status).toBe("completed");
    expect(readExecutions).toBe(3);
    expect(editExecutions).toBe(1);
    expect(run.toolCalls).toBe(4);
    expect(ports.events.some((event) =>
      event.type === "tool.failed" &&
      JSON.stringify(event.payload).includes("Duplicate read_files skipped"),
    )).toBe(false);
  });

  it("counts external database tool effects as verification evidence and mutation progress", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_call",
          tool: "apply_supabase_schema",
          args: {
            summary: "Created Supabase tables",
            tables: [
              {
                columns: [
                  {
                    dataType: "uuid",
                    name: "id",
                    nullable: false,
                    primaryKey: true,
                  },
                ],
                name: "profiles",
              },
            ],
          },
        },
        { type: "finish_candidate", summary: "Schema applied" },
      ],
      verificationStatuses: ["passed", "passed"],
    });
    ports.tools.execute = async (): Promise<ToolResult> => ({
      artifactIds: [],
      retryable: false,
      status: "success",
      structuredData: "schema applied",
      summary: "Created Supabase tables",
      workspaceEffects: {
        changedFiles: [],
        externalEffects: ["Supabase schema applied for table(s): profiles, rooms."],
        packageChanged: false,
      },
    });
    const controller = new RunController(ports);

    const contract = compileTaskContract({ objective: "Create Supabase tables" });
    const run = await controller.start({
      contract: {
        ...contract,
        permissions: {
          ...contract.permissions,
          databaseChange: "allow",
        },
      },
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-database-evidence",
    });

    expect(run.status).toBe("completed");
    expect(run.mutationCount).toBe(1);
    expect(ports.verificationRequests[0]?.externalEffects).toContain(
      "Supabase schema applied for table(s): profiles, rooms.",
    );
  });

  it("rejects tool_calls batches that contain a write tool", async () => {
    const ports = createFakePorts({
      modelActions: [
        {
          type: "tool_calls",
          calls: [
            { type: "tool_call", tool: "read_files", args: { paths: ["app/page.tsx"] } },
            {
              type: "tool_call",
              tool: "edit_file",
              args: {
                new_string: "Hello",
                old_string: "Hi",
                path: "app/page.tsx",
                summary: "Should not execute",
              },
            },
          ],
        },
        { type: "finish_candidate", summary: "Batch rejected" },
      ],
      verificationStatuses: ["passed"],
    });
    let executed = false;
    ports.tools.execute = async (): Promise<ToolResult> => {
      executed = true;
      return {
        artifactIds: [],
        retryable: false,
        status: "success",
        summary: "unexpected",
      };
    };
    const controller = new RunController(ports);

    const run = await controller.start({
      contract: compileTaskContract({ objective: "Inspect files" }),
      conversationId: "conversation-1",
      projectId: "project-1",
      runId: "run-batch-write",
    });

    expect(run.status).toBe("completed");
    expect(run.toolCalls).toBe(0);
    expect(executed).toBe(false);
    expect(ports.events.some((event) => event.type === "tool.failed")).toBe(true);
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
    externalEffects: string[];
    packageChanged: boolean;
    readSnapshots: AgentReadSnapshot[];
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
    resolveLatestApproval(decision: "approved" | "denied" | "expired"): void;
    seedCheckpoint(checkpoint: AgentRunCheckpoint): void;
    seedRun(run: AgentRun): void;
    setWorkspaceFingerprint(fingerprint: string): void;
    verificationRequests: Array<{
      changedFiles: string[];
      deletedFiles: string[];
      externalEffects: string[];
      packageChanged: boolean;
      readSnapshots: AgentReadSnapshot[];
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
      getLatestUnresolved: async (runId) =>
        [...approvals]
          .reverse()
          .find((approval) => approval.runId === runId && !approval.decision && !approval.resolvedAt) ?? null,
      getPending: async (runId) =>
        approvals.find(
          (approval) => approval.runId === runId && !approval.decision && !approval.resolvedAt,
        ) ?? null,
      listApprovedAuthorizations: async (runId) =>
        approvals.filter(
          (approval) =>
            approval.runId === runId &&
            approval.decision === "approved" &&
            approval.resolvedAt &&
            !approval.consumedAt &&
            new Date(approval.resolvedAt).getTime() <=
              new Date(approval.expiresAt).getTime(),
        ),
      claimApprovedAuthorization: async ({
        approvalId,
        consumedAt,
        normalizedArgsHash,
        runId,
        toolCallId,
      }) => {
        const approval = approvals.find(
          (item) =>
            item.id === approvalId &&
            item.runId === runId &&
            item.decision === "approved" &&
            item.normalizedArgsHash === normalizedArgsHash &&
            !item.consumedAt,
        );

        if (!approval) {
          throw new Error("Approval claim failed.");
        }

        approval.consumedAt = consumedAt;
        approval.consumedToolCallId = toolCallId;
        return approval;
      },
      resolve: async (runId, approvalId, decision, resolvedAt) => {
        const approval = approvals.find((item) => item.runId === runId && item.id === approvalId);

        if (!approval) {
          throw new Error("Approval not found.");
        }

        approval.decision = decision;
        approval.resolvedAt = resolvedAt;
        return approval;
      },
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
          externalEffects: [...input.externalEffects],
          packageChanged: input.packageChanged,
          readSnapshots: [...(input.readSnapshots ?? [])],
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
      validateReadSnapshots: async (snapshots) =>
        snapshots.filter((snapshot) => snapshot.contentHash !== "stale"),
    },
  };

  return ports;
}

function createModelValidationAction(
  validationError: string,
): HeadlessModelAction {
  return {
    attempts: 3,
    invalidResponsePreview: JSON.stringify({
      type: "tool_call",
      tool: "apply_supabase_schema",
    }),
    message: `Invalid model response repair exhausted after 3 attempt(s): ${validationError}`,
    type: "model_validation_error",
    validationError,
  };
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
