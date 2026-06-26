import type {
  AgentApproval,
  AgentApprovalDecision,
  AgentEvent,
  AgentReadSnapshot,
  AgentRun,
  AgentRunCheckpoint,
  RunContextSummary,
  TaskContract,
  ToolResult,
  VerificationReport,
} from "../types";
import {
  isInvalidProjectPath,
  isPathForbidden,
  matchesProjectPathPattern,
  normalizeProjectPath,
} from "../pathScope";
import { normalizeApprovalHash, PolicyEngine } from "../policy/policyEngine";
import { getCoreToolDefinition, validateCoreToolInput } from "../tools/toolRegistry";
import { isTerminalAgentRunStatus, RunStateMachine } from "./runStateMachine";

export type HeadlessModelAction =
  | {
      type: "tool_call";
      tool: string;
      args: unknown;
      rationale?: string;
    }
  | {
      type: "tool_calls";
      calls: Array<{
        type?: "tool_call";
        tool: string;
        args: unknown;
        rationale?: string;
      }>;
      rationale?: string;
    }
  | {
      type: "finish_candidate";
      summary: string;
      verification?: string;
    }
  | {
      type: "answer";
      message: string;
    }
  | {
      type: "model_validation_error";
      attempts: number;
      invalidResponsePreview: string;
      message: string;
      validationError: string;
    };

export type RunContextBundle = {
  observations: string[];
  run: AgentRun;
  runContextSummary: RunContextSummary;
  steering: string[];
  workspaceFingerprint: string;
};

export type RunStore = {
  create(run: AgentRun): Promise<AgentRun>;
  get(runId: string): Promise<AgentRun | null>;
  transition(previousRun: AgentRun, result: ReturnType<RunStateMachine["transition"]>): Promise<AgentRun>;
  recordProgress(
    previousRun: AgentRun,
    patch: Partial<Pick<AgentRun, "modelTurns" | "toolCalls" | "mutationCount">>,
    event: Omit<AgentEvent, "id" | "sequence">,
  ): Promise<AgentRun>;
};

export type EventStore = {
  append(event: Omit<AgentEvent, "id" | "sequence">): Promise<AgentEvent>;
  list(runId: string): Promise<AgentEvent[]>;
};

export type ModelPort = {
  next(context: RunContextBundle, signal?: AbortSignal): Promise<HeadlessModelAction>;
};

export type ToolExecutorPort = {
  execute(input: {
    args: unknown;
    run: AgentRun;
    tool: string;
    signal?: AbortSignal;
  }): Promise<ToolResult>;
};

export type VerifierPort = {
  verify(input: {
    answerMessage?: string;
    baselineCommandResults?: Record<string, unknown>;
    baselinePackageJson?: string | null;
    changedFiles: string[];
    deletedFiles: string[];
    externalEffects: string[];
    packageChanged: boolean;
    readSnapshots?: AgentReadSnapshot[];
    run: AgentRun;
  }): Promise<VerificationReport>;
};

export type WorkspacePort = {
  fingerprint(): Promise<string>;
  validateReadSnapshots?: (snapshots: AgentReadSnapshot[]) => Promise<AgentReadSnapshot[]>;
};

export type ApprovalPort = {
  create(approval: AgentApproval): Promise<AgentApproval>;
  getLatestUnresolved(runId: string): Promise<AgentApproval | null>;
  getPending(runId: string): Promise<AgentApproval | null>;
  getLatestResolved(runId: string): Promise<AgentApproval | null>;
  listApprovedAuthorizations(runId: string): Promise<AgentApproval[]>;
  claimApprovedAuthorization(input: {
    approvalId: string;
    consumedAt: string;
    normalizedArgsHash: string;
    runId: string;
    toolCallId: string;
  }): Promise<AgentApproval>;
  resolve(
    runId: string,
    approvalId: string,
    decision: AgentApprovalDecision,
    resolvedAt: string,
  ): Promise<AgentApproval>;
};

export type ArtifactPort = {
  write?(input: { content: string; relativePath: string; runId: string }): Promise<string>;
};

export type CheckpointPort = {
  save(checkpoint: AgentRunCheckpoint): Promise<AgentRunCheckpoint>;
  getLatest(runId: string): Promise<AgentRunCheckpoint | null>;
};

export type ClockPort = {
  now(): string;
};

export type ContextSummarizerPort = {
  summarize(input: {
    changedFiles: string[];
    current: RunContextSummary;
    deletedFiles: string[];
    observations: string[];
    run: AgentRun;
    signal?: AbortSignal;
  }): Promise<RunContextSummary>;
};

export type RunControllerPorts = {
  runStore: RunStore;
  eventStore: EventStore;
  model: ModelPort;
  tools: ToolExecutorPort;
  verifier: VerifierPort;
  workspace: WorkspacePort;
  approvals: ApprovalPort;
  artifacts: ArtifactPort;
  checkpoints: CheckpointPort;
  contextSummarizer?: ContextSummarizerPort;
  clock: ClockPort;
};

export type StartRunInput = {
  baselineCommandResults?: Record<string, unknown>;
  baselinePackageJson?: string | null;
  baselineArtifactId?: string;
  contract: TaskContract;
  conversationId: string;
  initialObservations?: unknown[];
  projectId: string;
  runId?: string;
};

type HeadlessToolCallAction = Extract<HeadlessModelAction, { type: "tool_call" }>;

type RunDriveState = {
  answerMessage?: string;
  baselineArtifactId?: string;
  baselineCommandResults?: Record<string, unknown>;
  baselinePackageJson?: string | null;
  changedFiles: Set<string>;
  deletedFiles: Set<string>;
  externalEffects: string[];
  expectedFileEvidenceAutoReadPaths: string[];
  expectedFileEvidenceAutoVerifyKey?: string;
  finishSummary?: string;
  latestReportId?: string;
  observations: unknown[];
  packageChanged: boolean;
  pendingEvidenceVerification?: PendingEvidenceVerificationState;
  pendingApprovalAction?: HeadlessToolCallAction;
  plan: unknown;
  readSnapshots: AgentRunCheckpoint["readSnapshots"];
  repairFeedback: string[];
  consecutiveModelValidationFailures: number;
  loopGuard: LoopGuardState;
  progressGuard: ProgressGuardState;
  runContextSummary: RunContextSummary;
  steeringWatermark: number;
};

type LoopGuardState = {
  lastFingerprint?: string;
  rescuedFingerprint?: string;
};

type ProgressGuardState = {
  readOnlyNoProgressCount: number;
  readOnlyStallPostRescueCount: number;
  readOnlyStallRescued: boolean;
};

type PendingEvidenceVerificationState = {
  missingExpectedFiles: string[];
  reason: string;
};

export class RunController {
  private readonly machine = new RunStateMachine();
  private readonly policy = new PolicyEngine();
  private readonly ports: RunControllerPorts;

  constructor(ports: RunControllerPorts) {
    this.ports = ports;
  }

  async start(input: StartRunInput, signal?: AbortSignal): Promise<AgentRun> {
    const created = this.machine.createRun({
      contract: input.contract,
      conversationId: input.conversationId,
      now: this.ports.clock.now(),
      projectId: input.projectId,
      runId: input.runId,
    });
    let run = await this.ports.runStore.create(created);
    run = await this.commit(run, this.machine.transition(run, { type: "start" }));
    const initialState = createEmptyDriveState({
      baselineArtifactId: input.baselineArtifactId,
      baselineCommandResults: input.baselineCommandResults,
      baselinePackageJson: input.baselinePackageJson,
      initialObservations: input.initialObservations,
    });
    await this.saveCheckpoint(
      run,
      initialState,
      "run-started",
    );

    return this.drive(run, signal, initialState);
  }

  async resume(runId: string, signal?: AbortSignal): Promise<AgentRun> {
    const loaded = await this.ports.runStore.get(runId);

    if (!loaded) {
      throw new Error(`Run ${runId} was not found.`);
    }

    let run = loaded;
    const previousStatus = run.status;

    if (isTerminalAgentRunStatus(run.status)) {
      return run;
    }

    await this.appendRecoveryRequested(run, "manual-resume");

    let restoredState: RunDriveState | undefined;

    if (run.status === "created") {
      run = await this.commit(run, this.machine.transition(run, { type: "start" }));
      const checkpoint = await this.saveCheckpoint(
        run,
        createEmptyDriveState(),
        "recover-created-start",
      );
      await this.appendRecoveredEvent({
        checkpointId: checkpoint.id,
        nextStatus: run.status,
        previousStatus,
        reason: "created-run-restarted",
        runId: run.id,
      });
    } else if (run.status === "paused") {
      run = await this.commit(run, this.machine.transition(run, { type: "resume" }));
      const restored = await this.restoreCheckpointBundle(run);
      restoredState = restored.state;
      await this.appendRecoveredEvent({
        checkpointId: restored.checkpointId,
        nextStatus: run.status,
        previousStatus,
        reason: "paused-run-resumed",
        runId: run.id,
      });
    } else if (run.status === "waiting_approval") {
      const resumedApproval = await this.resumeApproval(run, signal);
      run = resumedApproval.run;
      restoredState = resumedApproval.state;
      if (!resumedApproval.recoveredEventWritten) {
        await this.appendRecoveredEvent({
          checkpointId: resumedApproval.checkpointId,
          nextStatus: run.status,
          previousStatus,
          reason: resumedApproval.recoveryReason,
          runId: run.id,
        });
      }
    } else {
      const restored = await this.restoreCheckpointBundle(run);
      restoredState = restored.state;

      if (run.status === "mutating") {
        restoredState.observations.push(
          "The previous write step was interrupted. Reinspect the workspace before applying another mutation.",
        );
      } else if (run.status === "verifying") {
        restoredState.observations.push(
          "The previous verification step was interrupted. Re-run verification before completing the run.",
        );
      }

      const recoveryReason = recoveryReasonForStatus(run.status);
      run = await this.commit(
        run,
        this.machine.transition(run, {
          checkpointId: restored.checkpointId,
          nextStatus: "planning",
          reason: recoveryReason,
          type: "recover_interrupted",
        }),
      );
      await this.saveCheckpoint(run, restoredState, `recover:${recoveryReason}`);
    }

    if (isTerminalAgentRunStatus(run.status) || run.status === "waiting_approval") {
      return run;
    }

    return this.drive(run, signal, restoredState ?? await this.restoreCheckpoint(run));
  }

  private async drive(
    initialRun: AgentRun,
    signal?: AbortSignal,
    restoredState?: RunDriveState,
  ): Promise<AgentRun> {
    let run = initialRun;
    const state = restoredState ?? createEmptyDriveState();

    while (!isTerminalAgentRunStatus(run.status)) {
      run = await this.refreshRunRequests(run);

      if (run.cancelRequested && run.status !== "cancelled") {
        run = await this.commit(run, this.machine.transition(run, { type: "cancel" }));
        await this.saveCheckpoint(run, state, "cancelled");
        return run;
      }

      if (run.status === "waiting_approval" || run.status === "paused") {
        await this.saveCheckpoint(run, state, run.status);
        return run;
      }

      if (run.pauseRequested) {
        run = await this.commit(run, this.machine.transition(run, { type: "pause_at_boundary" }));
        await this.saveCheckpoint(run, state, "pause-boundary");
        return run;
      }

      if (run.status === "repairing") {
        run = await this.commit(run, this.machine.transition(run, { type: "enter_planning" }));
        await this.saveCheckpoint(run, state, "repair-planning");
      }

      run = await this.enforceBudget(run, "maxModelTurns", run.modelTurns);

      if (isTerminalAgentRunStatus(run.status)) {
        await this.saveCheckpoint(run, state, "budget-exceeded");
        return run;
      }

      const context = await this.compileContext(run, state, signal);
      const action = await this.ports.model.next(context, signal);
      run = await this.refreshRunRequests(run);

      if (run.cancelRequested || run.status === "cancelled") {
        run = await this.cancelAtBoundary(run, state, "cancelled-after-model");
        return run;
      }

      if (isTerminalAgentRunStatus(run.status) || run.status === "waiting_approval" || run.status === "paused") {
        await this.saveCheckpoint(run, state, "stopped-after-model");
        return run;
      }

      if (action.type === "model_validation_error") {
        run = await this.recordModelValidationFailure(run, state, action);

        if (isTerminalAgentRunStatus(run.status)) {
          return run;
        }

        if (run.pauseRequested) {
          run = await this.commit(run, this.machine.transition(run, { type: "pause_at_boundary" }));
          await this.saveCheckpoint(run, state, "pause-after-model-validation");
          return run;
        }

        continue;
      }

      state.consecutiveModelValidationFailures = 0;
      run = await this.ports.runStore.recordProgress(
        run,
        { modelTurns: run.modelTurns + 1 },
        {
          runId: run.id,
          type: "model.completed",
          timestamp: this.ports.clock.now(),
          payload: { type: action.type },
        },
      );
      await this.saveCheckpoint(run, state, "model-completed");

      if (run.pauseRequested) {
        run = await this.commit(run, this.machine.transition(run, { type: "pause_at_boundary" }));
        await this.saveCheckpoint(run, state, "pause-after-model");
        return run;
      }

      if (action.type === "answer") {
        state.answerMessage = action.message;
        state.observations.push(action.message);
        run = await this.verifyAndAdvance(run, state, { final: true });
        continue;
      }

      if (action.type === "finish_candidate") {
        state.finishSummary = action.summary;
        run = await this.verifyAndAdvance(run, state, { final: true });
        continue;
      }

      if (action.type === "tool_calls") {
        run = await this.executeToolBatch(run, action.calls, state, signal);
        continue;
      }

      run = await this.executeToolAction(run, action, state, signal);
    }

    await this.saveCheckpoint(run, state, "terminal");
    return run;
  }

  private async recordModelValidationFailure(
    run: AgentRun,
    state: RunDriveState,
    action: Extract<HeadlessModelAction, { type: "model_validation_error" }>,
  ): Promise<AgentRun> {
    state.consecutiveModelValidationFailures += 1;
    const consecutiveFailures = state.consecutiveModelValidationFailures;
    state.observations.push(
      JSON.stringify(buildModelValidationObservation(action, consecutiveFailures)),
    );

    run = await this.ports.runStore.recordProgress(
      run,
      { modelTurns: run.modelTurns + 1 },
      {
        runId: run.id,
        type: "model.failed",
        timestamp: this.ports.clock.now(),
        payload: {
          attempts: action.attempts,
          consecutiveFailures,
          invalidResponsePreview: action.invalidResponsePreview,
          message: action.message,
          retryable: consecutiveFailures <= MAX_MODEL_VALIDATION_OBSERVATIONS,
          type: action.type,
          validationError: action.validationError,
        },
      },
    );

    const loopSignal = await this.handleLoopSignal(run, state, {
      details: action.validationError,
      kind: "model_validation",
      summary: `Model response validation failed: ${action.validationError}`,
    });

    if (loopSignal.stopped) {
      await this.saveCheckpoint(loopSignal.run, state, "model-validation-loop-exhausted");
      return loopSignal.run;
    }

    if (loopSignal.rescued) {
      await this.saveCheckpoint(run, state, "model-validation-loop-rescue");
      return run;
    }

    if (consecutiveFailures > MAX_MODEL_VALIDATION_OBSERVATIONS) {
      const failedRun = await this.commit(
        run,
        this.machine.transition(run, {
          reason: [
            "Model response validation repair attempts exhausted.",
            action.validationError,
          ].join(" "),
          type: "fail",
        }),
      );
      await this.saveCheckpoint(failedRun, state, "model-validation-exhausted");
      return failedRun;
    }

    await this.saveCheckpoint(run, state, "model-validation-failed");
    return run;
  }

  private async executeToolAction(
    run: AgentRun,
    action: Extract<HeadlessModelAction, { type: "tool_call" }>,
    state: RunDriveState,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    const tool = getCoreToolDefinition(action.tool);

    if (!tool) {
      const reason = `Unknown tool ${action.tool}.`;
      state.observations.push(
        JSON.stringify({
          content: reason,
          ok: false,
          summary: reason,
          tool: action.tool,
        }),
      );
      await this.ports.eventStore.append({
        runId: run.id,
        type: "tool.failed",
        timestamp: this.ports.clock.now(),
        payload: { reason, tool: action.tool },
      });
      const loopSignal = await this.handleLoopSignal(run, state, {
        details: reason,
        kind: "invalid_tool",
        summary: reason,
      });

      if (loopSignal.stopped) {
        await this.saveCheckpoint(loopSignal.run, state, "unknown-tool-loop-exhausted");
        return loopSignal.run;
      }

      if (loopSignal.rescued) {
        await this.saveCheckpoint(run, state, "unknown-tool-loop-rescue");
        return run;
      }

      return run;
    }

    validateCoreToolInput(action.tool, action.args);

    run = await this.enforceBudget(run, "maxToolCalls", run.toolCalls);

    if (isTerminalAgentRunStatus(run.status)) {
      await this.saveCheckpoint(run, state, "tool-budget-exceeded");
      return run;
    }

    const approvedAuthorizations =
      await this.ports.approvals.listApprovedAuthorizations(run.id);
    const approvedHashes = new Set(
      approvedAuthorizations.map((approval) => approval.normalizedArgsHash),
    );
    const actionApprovalHash = normalizeApprovalHash(run.id, action.tool, action.args);
    const approvedAuthorization = approvedAuthorizations.find(
      (approval) => approval.normalizedArgsHash === actionApprovalHash,
    ) ?? null;
    const policyDecision = this.policy.evaluate({
      approvedHashes,
      args: action.args,
      run,
      tool,
    });

    if (!policyDecision.allowed) {
      state.observations.push(
        `Policy denied ${action.tool}: ${policyDecision.reason}`,
      );
      await this.ports.eventStore.append({
        runId: run.id,
        type: "policy.denied",
        timestamp: this.ports.clock.now(),
        payload: { reason: policyDecision.reason, tool: action.tool },
      });
      await this.saveCheckpoint(run, state, `policy-denied:${action.tool}`);
      return run;
    }

    if (!tool.readOnly) {
      run = await this.enforceBudget(run, "maxMutations", run.mutationCount);

      if (isTerminalAgentRunStatus(run.status)) {
        await this.saveCheckpoint(run, state, "mutation-budget-exceeded");
        return run;
      }
    }

    if (policyDecision.approvalRequired) {
      const approval = await this.ports.approvals.create({
        id: createId("approval"),
        runId: run.id,
        toolCallId: createId("tool-call"),
        toolName: action.tool,
        normalizedArgsHash: policyDecision.approvalHash,
        targetResources: collectTargetResources(action.args),
        exactSideEffect: policyDecision.reason,
        createdAt: this.ports.clock.now(),
        expiresAt: addMinutesIso(this.ports.clock.now(), 30),
      });
      state.pendingApprovalAction = action;
      const waitingRun = await this.commit(
        run,
        this.machine.transition(run, {
          approvalId: approval.id,
          normalizedArgsHash: approval.normalizedArgsHash,
          toolName: approval.toolName,
          type: "enter_waiting_approval",
        }),
      );
      await this.saveCheckpoint(waitingRun, state, `approval-requested:${approval.id}`);
      return waitingRun;
    }

    const toolCallId = createId("tool-call");

    if (approvedAuthorization) {
      const consumedAt = this.ports.clock.now();

      try {
        await this.ports.approvals.claimApprovedAuthorization({
          approvalId: approvedAuthorization.id,
          consumedAt,
          normalizedArgsHash: actionApprovalHash,
          runId: run.id,
          toolCallId,
        });
        await this.ports.eventStore.append({
          runId: run.id,
          type: "approval.consumed",
          timestamp: consumedAt,
          payload: {
            approvalId: approvedAuthorization.id,
            consumedAt,
            normalizedArgsHash: actionApprovalHash,
            toolCallId,
            toolName: action.tool,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.observations.push(
          `Approved authorization for ${action.tool} could not be claimed. Request a fresh approval before executing this action.`,
        );
        await this.ports.eventStore.append({
          runId: run.id,
          type: "approval.consume_failed",
          timestamp: this.ports.clock.now(),
          payload: {
            approvalId: approvedAuthorization.id,
            normalizedArgsHash: actionApprovalHash,
            reason: message,
            toolCallId,
            toolName: action.tool,
          },
        });
        await this.saveCheckpoint(run, state, "approval-claim-failed");
        return run;
      }
    }

    const startedAt = this.ports.clock.now();
    await this.ports.eventStore.append({
      runId: run.id,
      type: "tool.started",
      timestamp: startedAt,
      payload: { tool: action.tool, toolCallId },
    });

    if (tool.readOnly && run.status !== "exploring") {
      run = await this.commit(run, this.machine.transition(run, { type: "enter_exploring" }));
    } else if (!tool.readOnly && run.status !== "mutating") {
      run = await this.commit(run, this.machine.transition(run, { type: "enter_mutating" }));
    }

    const result = await this.ports.tools.execute({
      args: action.args,
      run,
      signal,
      tool: action.tool,
    });
    run = await this.refreshRunRequests(run);

    if (run.cancelRequested || run.status === "cancelled") {
      return this.cancelAtBoundary(run, state, "cancelled-after-tool");
    }

    if (isTerminalAgentRunStatus(run.status) || run.status === "waiting_approval" || run.status === "paused") {
      await this.saveCheckpoint(run, state, "stopped-after-tool");
      return run;
    }

    const changed = result.workspaceEffects?.changedFiles ?? [];
    const deleted = result.workspaceEffects?.deletedFiles ?? [];
    const externalEffects = result.workspaceEffects?.externalEffects ?? [];

    for (const path of changed) {
      state.changedFiles.add(path);
    }

    for (const path of deleted) {
      state.changedFiles.add(path);
      state.deletedFiles.add(path);
    }

    state.packageChanged ||= result.workspaceEffects?.packageChanged === true;
    state.externalEffects.push(...externalEffects);
    state.readSnapshots = mergeReadSnapshots(
      state.readSnapshots,
      result.workspaceEffects?.readSnapshots ?? [],
    );
    const mutationDelta =
      !tool.readOnly && changed.length + deleted.length + externalEffects.length > 0
        ? 1
        : 0;
    const nextRun = await this.ports.runStore.recordProgress(
      run,
      {
        mutationCount: run.mutationCount + mutationDelta,
        toolCalls: run.toolCalls + 1,
      },
      {
        artifactIds: result.artifactIds,
        runId: run.id,
        type: result.status === "success" ? "tool.completed" : "tool.failed",
        timestamp: this.ports.clock.now(),
        payload: {
          deletedFiles: deleted,
          externalEffects,
          packageChanged: state.packageChanged,
          status: result.status,
          summary: result.summary,
          tool: action.tool,
        },
      },
    );
    state.observations.push(JSON.stringify(buildToolObservation(action.tool, result)));

    const autoReadRun = await this.maybeAutoReadMissingExpectedFiles(
      nextRun,
      state,
      tool.readOnly ? 1 : 0,
      signal,
    );

    if (autoReadRun) {
      return autoReadRun;
    }

    if (shouldAutoVerifyAfterEvidenceRead(nextRun, state, tool.readOnly, result)) {
      resetReadOnlyNoProgress(state);
      await this.saveCheckpoint(nextRun, state, "expected-file-evidence-collected");
      return this.verifyAndAdvance(nextRun, state, { final: false });
    }

    const progressSignal = await this.handleToolProgressSignal(nextRun, state, {
      readOnlyCount: tool.readOnly ? 1 : 0,
      resetReadOnlyStall: !tool.readOnly || mutationDelta > 0,
    });

    if (progressSignal.stopped) {
      await this.saveCheckpoint(progressSignal.run, state, "read-only-stall-loop-exhausted");
      return progressSignal.run;
    }

    await this.saveCheckpoint(
      nextRun,
      state,
      progressSignal.rescued ? "read-only-stall-loop-rescue" : "tool-completed",
    );

    if (nextRun.pauseRequested) {
      const pausedRun = await this.commit(
        nextRun,
        this.machine.transition(nextRun, { type: "pause_at_boundary" }),
      );
      await this.saveCheckpoint(pausedRun, state, "pause-after-tool");
      return pausedRun;
    }

    if (
      result.status === "success" &&
      tool.requiresVerification &&
      changed.length + deleted.length > 0
    ) {
      return this.verifyAndAdvance(nextRun, state, { final: false });
    }

    if (nextRun.status !== "planning") {
      const planningRun = await this.commit(
        nextRun,
        this.machine.transition(nextRun, { type: "enter_planning" }),
      );
      await this.saveCheckpoint(planningRun, state, "tool-returned-to-planning");
      return planningRun;
    }

    return nextRun;
  }

  private async executeToolBatch(
    run: AgentRun,
    calls: Extract<HeadlessModelAction, { type: "tool_calls" }>["calls"],
    state: RunDriveState,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    const actions = calls.map((call) => ({ ...call, type: "tool_call" as const }));
    const toolEntries = actions.map((action) => ({
      action,
      tool: getCoreToolDefinition(action.tool),
    }));
    const invalidTool = toolEntries.find((entry) => !entry.tool);

    if (invalidTool) {
      await this.ports.eventStore.append({
        runId: run.id,
        type: "tool.failed",
        timestamp: this.ports.clock.now(),
        payload: {
          reason: `Unknown tool ${invalidTool.action.tool}.`,
          tool: invalidTool.action.tool,
        },
      });
      return run;
    }

    const unsafeTool = toolEntries.find(
      (entry) => !entry.tool?.readOnly || !entry.tool.concurrencySafe,
    );

    if (unsafeTool) {
      const summary = `tool_calls may only batch read-only concurrency-safe tools, but included ${unsafeTool.action.tool}.`;
      state.observations.push(summary);
      await this.ports.eventStore.append({
        runId: run.id,
        type: "tool.failed",
        timestamp: this.ports.clock.now(),
        payload: { reason: summary, tool: "tool_calls" },
      });
      return run;
    }

    for (const action of actions) {
      validateCoreToolInput(action.tool, action.args);
    }

    if (run.toolCalls + actions.length > run.contract.budget.maxToolCalls) {
      const exceededRun = await this.commit(
        run,
        this.machine.transition(run, {
          budget: "maxToolCalls",
          reason: "maxToolCalls was exhausted by a read-only tool batch.",
          type: "budget_exceeded",
        }),
      );
      await this.saveCheckpoint(exceededRun, state, "tool-batch-budget-exceeded");
      return exceededRun;
    }

    const approvedHashes = new Set(
      (await this.ports.approvals.listApprovedAuthorizations(run.id))
        .map((approval) => approval.normalizedArgsHash),
    );

    for (const { action, tool } of toolEntries) {
      const policyDecision = this.policy.evaluate({
        approvedHashes,
        args: action.args,
        run,
        tool: tool!,
      });

      if (!policyDecision.allowed || policyDecision.approvalRequired) {
        const summary = !policyDecision.allowed
          ? policyDecision.reason
          : `${action.tool} cannot request approval inside a batched tool_calls action.`;
        state.observations.push(summary);
        await this.ports.eventStore.append({
          runId: run.id,
          type: "policy.denied",
          timestamp: this.ports.clock.now(),
          payload: { reason: summary, tool: action.tool },
        });
        return run;
      }
    }

    for (const action of actions) {
      await this.ports.eventStore.append({
        runId: run.id,
        type: "tool.started",
        timestamp: this.ports.clock.now(),
        payload: { batch: true, tool: action.tool },
      });
    }

    if (run.status !== "exploring") {
      run = await this.commit(run, this.machine.transition(run, { type: "enter_exploring" }));
    }

    const results = await Promise.all(
      actions.map((action) =>
        this.ports.tools.execute({
          args: action.args,
          run,
          signal,
          tool: action.tool,
        }),
      ),
    );

    run = await this.refreshRunRequests(run);

    if (run.cancelRequested || run.status === "cancelled") {
      return this.cancelAtBoundary(run, state, "cancelled-after-tool-batch");
    }

    if (isTerminalAgentRunStatus(run.status) || run.status === "waiting_approval" || run.status === "paused") {
      await this.saveCheckpoint(run, state, "stopped-after-tool-batch");
      return run;
    }

    for (const [index, result] of results.entries()) {
      const action = actions[index]!;
      const changed = result.workspaceEffects?.changedFiles ?? [];
      const deleted = result.workspaceEffects?.deletedFiles ?? [];
      const externalEffects = result.workspaceEffects?.externalEffects ?? [];

      for (const path of changed) {
        state.changedFiles.add(path);
      }

      for (const path of deleted) {
        state.changedFiles.add(path);
        state.deletedFiles.add(path);
      }

      state.packageChanged ||= result.workspaceEffects?.packageChanged === true;
      state.externalEffects.push(...externalEffects);
      state.readSnapshots = mergeReadSnapshots(
        state.readSnapshots,
        result.workspaceEffects?.readSnapshots ?? [],
      );
      state.observations.push(JSON.stringify(buildToolObservation(action.tool, result)));

      await this.ports.eventStore.append({
        artifactIds: result.artifactIds,
        runId: run.id,
        type: result.status === "success" ? "tool.completed" : "tool.failed",
        timestamp: this.ports.clock.now(),
        payload: {
          batch: true,
          deletedFiles: deleted,
          externalEffects,
          packageChanged: state.packageChanged,
          status: result.status,
          summary: result.summary,
          tool: action.tool,
        },
      });
    }

    const nextRun = await this.ports.runStore.recordProgress(
      run,
      {
        mutationCount: run.mutationCount,
        toolCalls: run.toolCalls + actions.length,
      },
      {
        runId: run.id,
        type: "plan.updated",
        timestamp: this.ports.clock.now(),
        payload: { batchSize: actions.length, reason: "read-only tool batch completed" },
      },
    );

    const autoReadRun = await this.maybeAutoReadMissingExpectedFiles(
      nextRun,
      state,
      results.length,
      signal,
    );

    if (autoReadRun) {
      return autoReadRun;
    }

    if (shouldAutoVerifyAfterEvidenceRead(nextRun, state, true, {
      status: results.every((result) => result.status === "success")
        ? "success"
        : "domain_error",
    })) {
      resetReadOnlyNoProgress(state);
      await this.saveCheckpoint(nextRun, state, "expected-file-evidence-collected");
      return this.verifyAndAdvance(nextRun, state, { final: false });
    }

    const progressSignal = await this.handleToolProgressSignal(nextRun, state, {
      readOnlyCount: results.length,
      resetReadOnlyStall: results.some((result) => result.status !== "success"),
    });

    if (progressSignal.stopped) {
      await this.saveCheckpoint(progressSignal.run, state, "read-only-stall-loop-exhausted");
      return progressSignal.run;
    }

    await this.saveCheckpoint(
      nextRun,
      state,
      progressSignal.rescued ? "read-only-stall-loop-rescue" : "tool-batch-completed",
    );

    if (nextRun.pauseRequested) {
      const pausedRun = await this.commit(
        nextRun,
        this.machine.transition(nextRun, { type: "pause_at_boundary" }),
      );
      await this.saveCheckpoint(pausedRun, state, "pause-after-tool-batch");
      return pausedRun;
    }

    if (nextRun.status !== "planning") {
      const planningRun = await this.commit(
        nextRun,
        this.machine.transition(nextRun, { type: "enter_planning" }),
      );
      await this.saveCheckpoint(planningRun, state, "tool-batch-returned-to-planning");
      return planningRun;
    }

    return nextRun;
  }

  private async maybeAutoReadMissingExpectedFiles(
    run: AgentRun,
    state: RunDriveState,
    incomingReadOnlyCount: number,
    signal?: AbortSignal,
  ): Promise<AgentRun | null> {
    const missingExpectedFiles = getAutoReadableMissingExpectedFiles(
      run,
      state,
      incomingReadOnlyCount,
    );

    if (missingExpectedFiles.length === 0) {
      return null;
    }

    state.expectedFileEvidenceAutoReadPaths = uniqueStrings([
      ...state.expectedFileEvidenceAutoReadPaths,
      ...missingExpectedFiles,
    ]);
    state.observations.push(
      JSON.stringify(buildExpectedFileAutoReadObservation(missingExpectedFiles)),
    );

    await this.ports.eventStore.append({
      runId: run.id,
      type: "plan.updated",
      timestamp: this.ports.clock.now(),
      payload: {
        files: missingExpectedFiles,
        reason: "auto-reading-missing-expected-files",
      },
    });
    await this.saveCheckpoint(run, state, "auto-read-missing-expected-files");

    return this.executeToolBatch(
      run,
      missingExpectedFiles.map((path) => ({
        tool: "read_files",
        args: { paths: [path] },
        rationale: "Collect missing expected-file evidence before further planning.",
      })),
      state,
      signal,
    );
  }

  private async verifyAndAdvance(
    run: AgentRun,
    state: RunDriveState,
    options: { final: boolean },
  ): Promise<AgentRun> {
    run = await this.commit(run, this.machine.transition(run, { type: "enter_verifying" }));
    await this.saveCheckpoint(run, state, "verification-started");

    const report = await this.ports.verifier.verify({
      answerMessage: state.answerMessage,
      baselineCommandResults: state.baselineCommandResults,
      baselinePackageJson: state.baselinePackageJson,
      changedFiles: [...state.changedFiles],
      deletedFiles: [...state.deletedFiles],
      externalEffects: [...state.externalEffects],
      packageChanged: state.packageChanged,
      readSnapshots: [...state.readSnapshots],
      run,
    });
    state.latestReportId = report.id;
    state.repairFeedback = [...report.repairFeedback];
    run = await this.refreshRunRequests(run);

    if (run.cancelRequested || run.status === "cancelled") {
      return this.cancelAtBoundary(run, state, "cancelled-after-verifier");
    }

    if (isTerminalAgentRunStatus(run.status) || run.status === "waiting_approval" || run.status === "paused") {
      await this.saveCheckpoint(run, state, "stopped-after-verifier");
      return run;
    }

    await this.ports.eventStore.append({
      artifactIds: report.artifactIds,
      runId: run.id,
      type: "verification.completed",
      timestamp: report.createdAt,
      payload: { reportId: report.id, status: report.status },
    });
    state.observations.push(JSON.stringify(buildVerificationObservation(report)));

    if (report.status === "passed") {
      state.pendingEvidenceVerification = undefined;
      const shouldComplete =
        options.final || shouldCompleteSpecRunAfterPassedVerification(run);
      const nextRun = await this.commit(
        run,
        this.machine.transition(run, {
          type: shouldComplete ? "verification_passed" : "verification_passed_continue",
          report,
        }),
      );
      await this.saveCheckpoint(
        nextRun,
        state,
        shouldComplete ? "verification-passed" : "verification-passed-continue",
      );
      return nextRun;
    }

    state.pendingEvidenceVerification = buildPendingEvidenceVerificationState(
      run,
      state,
      report,
    );
    const loopSignal = await this.handleLoopSignal(run, state, {
      details: buildVerificationFailureDetails(report),
      kind: "verification",
      summary: buildVerificationFailureSummary(report),
    });

    if (loopSignal.stopped) {
      await this.saveCheckpoint(loopSignal.run, state, "verification-loop-exhausted");
      return loopSignal.run;
    }

    state.observations.push(...report.repairFeedback);
    const repairingRun = await this.commit(
      run,
      this.machine.transition(run, { type: "verification_failed", report }),
    );
    await this.saveCheckpoint(repairingRun, state, "verification-failed");
    return repairingRun;
  }

  private async resumeApproval(
    run: AgentRun,
    signal?: AbortSignal,
  ): Promise<{
    checkpointId?: string;
    recoveredEventWritten?: boolean;
    recoveryReason: string;
    run: AgentRun;
    state?: RunDriveState;
  }> {
    const unresolved = await this.ports.approvals.getLatestUnresolved(run.id);

    if (unresolved ?? await this.ports.approvals.getPending(run.id)) {
      const checkpoint = await this.ports.checkpoints.getLatest(run.id);
      return {
        checkpointId: checkpoint?.id,
        recoveryReason: "pending-approval-still-valid",
        run,
      };
    }

    const resolved = await this.ports.approvals.getLatestResolved(run.id);

    if (!resolved) {
      const restored = await this.restoreCheckpointBundle(run);
      const state = restored.state;
      state.pendingApprovalAction = undefined;
      state.observations.push(
        "No approval record was available for the interrupted waiting_approval run. Replan and request approval again if needed.",
      );
      const nextRun = await this.commit(
        run,
        this.machine.transition(run, {
          checkpointId: restored.checkpointId,
          nextStatus: "planning",
          reason: "approval-record-missing",
          type: "recover_interrupted",
        }),
      );
      await this.saveCheckpoint(nextRun, state, "approval-record-missing");
      return {
        checkpointId: restored.checkpointId,
        recoveredEventWritten: true,
        recoveryReason: "approval-record-missing",
        run: nextRun,
        state,
      };
    }

    const restored = await this.restoreCheckpointBundle(run);
    const state = restored.state;

    if (resolved.decision === "approved") {
      let nextRun = await this.commit(
        run,
        this.machine.transition(run, {
          type: "approval_granted",
          approvalId: resolved.id,
        }),
      );
      await this.saveCheckpoint(nextRun, state, "approval-approved");
      await this.appendRecoveredEvent({
        checkpointId: restored.checkpointId,
        nextStatus: nextRun.status,
        previousStatus: run.status,
        reason: "approved-action-resumed",
        runId: run.id,
      });

      const approvedAction = state.pendingApprovalAction;
      state.pendingApprovalAction = undefined;

      if (!approvedAction) {
        state.observations.push("Approved action was not found in the latest checkpoint.");
        return {
          checkpointId: restored.checkpointId,
          recoveredEventWritten: true,
          recoveryReason: "approved-action-missing",
          run: nextRun,
          state,
        };
      }

      const approvedHash = normalizeApprovalHash(
        run.id,
        approvedAction.tool,
        approvedAction.args,
      );

      if (approvedHash !== resolved.normalizedArgsHash) {
        state.observations.push(
          "Approved action arguments no longer match the stored approval hash.",
        );
        return {
          checkpointId: restored.checkpointId,
          recoveredEventWritten: true,
          recoveryReason: "approved-action-hash-mismatch",
          run: nextRun,
          state,
        };
      }

      nextRun = await this.executeToolAction(nextRun, approvedAction, state, signal);
      return {
        checkpointId: restored.checkpointId,
        recoveredEventWritten: true,
        recoveryReason: "approved-action-resumed",
        run: nextRun,
        state,
      };
    }

    if (resolved.decision === "expired") {
      state.observations.push(
        "Previous approval expired. Request a new approval if the action is still needed.",
      );
      state.pendingApprovalAction = undefined;
      const nextRun = await this.commit(
        run,
        this.machine.transition(run, {
          approvalId: resolved.id,
          type: "approval_expired",
        }),
      );
      await this.saveCheckpoint(nextRun, state, "approval-expired");
      return {
        checkpointId: restored.checkpointId,
        recoveryReason: "approval-expired",
        run: nextRun,
        state,
      };
    }

    state.observations.push("Approval denied by user.");
    const nextRun = await this.commit(
      run,
      this.machine.transition(run, {
        type: "approval_denied",
        approvalId: resolved.id,
        reason: "Approval denied by user.",
      }),
    );
    await this.saveCheckpoint(nextRun, state, "approval-denied");
    state.pendingApprovalAction = undefined;
    return {
      checkpointId: restored.checkpointId,
      recoveryReason: "approval-denied",
      run: nextRun,
      state,
    };
  }

  private async compileContext(
    run: AgentRun,
    state: RunDriveState,
    signal?: AbortSignal,
  ): Promise<RunContextBundle> {
    const events = await this.ports.eventStore.list(run.id);
    const steeringEvents = events.filter(
      (event) => event.type === "steering.received" && event.sequence > state.steeringWatermark,
    );
    const steering = steeringEvents
      .map((event) => stringifyPayload(event.payload));
    state.steeringWatermark = steeringEvents.reduce(
      (watermark, event) => Math.max(watermark, event.sequence),
      state.steeringWatermark,
    );

    const observations = [
      ...buildBaselineDiagnosticObservations(run, state),
      ...state.observations.map(stringifyPayload),
    ];
    state.runContextSummary = await this.refreshRunContextSummary(
      run,
      state,
      observations,
      signal,
    );

    return {
      observations,
      run,
      runContextSummary: state.runContextSummary,
      steering,
      workspaceFingerprint: await this.ports.workspace.fingerprint(),
    };
  }

  private async refreshRunContextSummary(
    run: AgentRun,
    state: RunDriveState,
    observations: string[],
    signal?: AbortSignal,
  ) {
    const deterministicSummary = buildDeterministicRunContextSummary({
      changedFiles: [...state.changedFiles],
      current: state.runContextSummary,
      deletedFiles: [...state.deletedFiles],
      now: this.ports.clock.now(),
      observations,
      run,
    });
    const shouldRequestLlmSummary = shouldSummarizeWithLlm(
      state.runContextSummary,
      observations,
    );

    if (!this.ports.contextSummarizer || !shouldRequestLlmSummary) {
      return deterministicSummary;
    }

    try {
      return normalizeRunContextSummary(
        await this.ports.contextSummarizer.summarize({
          changedFiles: [...state.changedFiles],
          current: deterministicSummary,
          deletedFiles: [...state.deletedFiles],
          observations,
          run,
          signal,
        }),
        deterministicSummary,
      );
    } catch {
      return deterministicSummary;
    }
  }

  private async handleLoopSignal(
    run: AgentRun,
    state: RunDriveState,
    signal: {
      details: string;
      kind: string;
      summary: string;
    },
  ): Promise<{ rescued: boolean; stopped: boolean; run: AgentRun }> {
    const fingerprint = buildFailureFingerprint(signal.kind, signal.details);

    if (state.loopGuard.lastFingerprint !== fingerprint) {
      state.loopGuard.lastFingerprint = fingerprint;
      return { rescued: false, run, stopped: false };
    }

    if (state.loopGuard.rescuedFingerprint === fingerprint) {
      const stoppedRun = await this.commit(
        run,
        this.machine.transition(run, {
          budget: "maxModelTurns",
          failureKind: "loop_exhausted",
          reason: LOOP_EXHAUSTED_REASON,
          type: "budget_exceeded",
        }),
      );
      return { rescued: false, run: stoppedRun, stopped: true };
    }

    state.loopGuard.rescuedFingerprint = fingerprint;
    state.observations.push(
      JSON.stringify(buildLoopRescueObservation(signal.summary, signal.details)),
    );

    return { rescued: true, run, stopped: false };
  }

  private async handleToolProgressSignal(
    run: AgentRun,
    state: RunDriveState,
    signal: {
      readOnlyCount: number;
      resetReadOnlyStall: boolean;
    },
  ): Promise<{ rescued: boolean; stopped: boolean; run: AgentRun }> {
    if (signal.resetReadOnlyStall || signal.readOnlyCount <= 0) {
      resetReadOnlyNoProgress(state);
      return { rescued: false, run, stopped: false };
    }

    state.progressGuard.readOnlyNoProgressCount += signal.readOnlyCount;

    if (state.progressGuard.readOnlyStallRescued) {
      state.progressGuard.readOnlyStallPostRescueCount += signal.readOnlyCount;

      if (
        state.progressGuard.readOnlyStallPostRescueCount >=
          READ_ONLY_STALL_RESCUE_GRACE
      ) {
        const stoppedRun = await this.commit(
          run,
          this.machine.transition(run, {
            budget: "maxModelTurns",
            failureKind: "loop_exhausted",
            reason: READ_ONLY_STALL_EXHAUSTED_REASON,
            type: "budget_exceeded",
          }),
        );
        return { rescued: false, run: stoppedRun, stopped: true };
      }

      return { rescued: false, run, stopped: false };
    }

    if (
      state.progressGuard.readOnlyNoProgressCount <
        getReadOnlyNoProgressThreshold(run)
    ) {
      return { rescued: false, run, stopped: false };
    }

    state.progressGuard.readOnlyStallRescued = true;
    state.progressGuard.readOnlyStallPostRescueCount = 0;
    state.observations.push(
      JSON.stringify(buildReadOnlyStallRescueObservation(state)),
    );

    return { rescued: true, run, stopped: false };
  }

  private async enforceBudget(
    run: AgentRun,
    budget: keyof TaskContract["budget"],
    currentValue: number,
  ): Promise<AgentRun> {
    if (currentValue < run.contract.budget[budget]) {
      return run;
    }

    return this.commit(
      run,
      this.machine.transition(run, {
        budget,
        reason: `${budget} was exhausted.`,
        type: "budget_exceeded",
      }),
    );
  }

  private async refreshRunRequests(run: AgentRun): Promise<AgentRun> {
    const persisted = await this.ports.runStore.get(run.id);

    if (!persisted || persisted.stateVersion < run.stateVersion) {
      return run;
    }

    return persisted;
  }

  private async cancelAtBoundary(
    run: AgentRun,
    state: RunDriveState,
    reason: string,
  ): Promise<AgentRun> {
    if (run.status === "cancelled") {
      await this.saveCheckpoint(run, state, reason);
      return run;
    }

    if (isTerminalAgentRunStatus(run.status)) {
      await this.saveCheckpoint(run, state, reason);
      return run;
    }

    const cancelledRun = await this.commit(
      run,
      this.machine.transition(run, { type: "cancel" }),
    );
    await this.saveCheckpoint(cancelledRun, state, reason);
    return cancelledRun;
  }

  private async appendRecoveryRequested(run: AgentRun, reason: string) {
    await this.ports.eventStore.append({
      runId: run.id,
      type: "run.recovery_requested",
      timestamp: this.ports.clock.now(),
      payload: {
        reason,
        status: run.status,
      },
    });
  }

  private async appendRecoveredEvent(input: {
    checkpointId?: string;
    nextStatus: AgentRun["status"];
    previousStatus: AgentRun["status"];
    reason: string;
    runId: string;
  }) {
    await this.ports.eventStore.append({
      runId: input.runId,
      type: "run.recovered",
      timestamp: this.ports.clock.now(),
      payload: {
        checkpointId: input.checkpointId,
        nextStatus: input.nextStatus,
        previousStatus: input.previousStatus,
        reason: input.reason,
      },
    });
  }

  private async restoreCheckpoint(run: AgentRun): Promise<RunDriveState> {
    return (await this.restoreCheckpointBundle(run)).state;
  }

  private async restoreCheckpointBundle(
    run: AgentRun,
  ): Promise<{ checkpointId?: string; state: RunDriveState }> {
    const checkpoint = await this.ports.checkpoints.getLatest(run.id);

    if (!checkpoint) {
      return { state: createEmptyDriveState() };
    }

    const currentFingerprint = await this.ports.workspace.fingerprint();

    const readSnapshots =
      checkpoint.workspaceFingerprint === currentFingerprint
        ? [...checkpoint.readSnapshots]
        : await this.validateReadSnapshots(checkpoint.readSnapshots);

    const metadata = readRunDriveStateMetadata(checkpoint.plan);

    return {
      checkpointId: checkpoint.id,
      state: {
        answerMessage: metadata.answerMessage,
        baselineArtifactId: metadata.baselineArtifactId,
        baselineCommandResults: metadata.baselineCommandResults,
        baselinePackageJson: metadata.baselinePackageJson ?? checkpoint.packageBaselineJson,
        changedFiles: new Set(checkpoint.changedFiles),
        deletedFiles: new Set(checkpoint.deletedFiles),
        externalEffects: metadata.externalEffects ?? [],
        expectedFileEvidenceAutoReadPaths:
          metadata.expectedFileEvidenceAutoReadPaths ?? [],
        expectedFileEvidenceAutoVerifyKey: metadata.expectedFileEvidenceAutoVerifyKey,
        finishSummary: metadata.finishSummary,
        latestReportId: checkpoint.latestReportId,
        observations: [...checkpoint.observations],
        packageChanged: checkpoint.packageChanged,
        pendingEvidenceVerification: metadata.pendingEvidenceVerification,
        pendingApprovalAction: metadata.pendingApprovalAction,
        plan: metadata.userPlan,
        readSnapshots,
        repairFeedback: [...checkpoint.repairFeedback],
        consecutiveModelValidationFailures:
          metadata.consecutiveModelValidationFailures ?? 0,
        loopGuard: metadata.loopGuard ?? {},
        progressGuard:
          metadata.progressGuard ?? createEmptyProgressGuardState(),
        runContextSummary: normalizeRunContextSummary(
          metadata.runContextSummary,
          createEmptyRunContextSummary(run.contract.objective),
        ),
        steeringWatermark: checkpoint.steeringWatermark,
      },
    };
  }

  private async validateReadSnapshots(snapshots: AgentReadSnapshot[]) {
    if (!this.ports.workspace.validateReadSnapshots) {
      return [];
    }

    return this.ports.workspace.validateReadSnapshots(snapshots);
  }

  private async saveCheckpoint(
    run: AgentRun,
    state: RunDriveState,
    reason: string,
  ): Promise<AgentRunCheckpoint> {
    const checkpoint = await this.ports.checkpoints.save({
      id: createId("checkpoint"),
      runId: run.id,
      createdAt: this.ports.clock.now(),
      workspaceFingerprint: await this.ports.workspace.fingerprint(),
      plan: writeDriveStateMetadata(state),
      observations: [...state.observations],
      changedFiles: [...state.changedFiles],
      deletedFiles: [...state.deletedFiles],
      packageChanged: state.packageChanged,
      packageBaselineJson: state.baselinePackageJson,
      readSnapshots: [...state.readSnapshots],
      latestReportId: state.latestReportId,
      repairFeedback: [...state.repairFeedback],
      steeringWatermark: state.steeringWatermark,
    });

    await this.ports.eventStore.append({
      runId: run.id,
      type: "checkpoint.created",
      timestamp: checkpoint.createdAt,
      payload: {
        checkpointId: checkpoint.id,
        reason,
        steeringWatermark: checkpoint.steeringWatermark,
        workspaceFingerprint: checkpoint.workspaceFingerprint,
      },
    });

    return checkpoint;
  }

  private commit(
    run: AgentRun,
    result: ReturnType<RunStateMachine["transition"]>,
  ): Promise<AgentRun> {
    return this.ports.runStore.transition(run, result);
  }
}

function createEmptyDriveState(
  initial: Pick<
    RunDriveState,
    "baselineArtifactId" | "baselineCommandResults" | "baselinePackageJson"
  > & { initialObservations?: unknown[] } = {},
): RunDriveState {
  return {
    baselineArtifactId: initial.baselineArtifactId,
    baselineCommandResults: initial.baselineCommandResults,
    baselinePackageJson: initial.baselinePackageJson,
    changedFiles: new Set(),
    deletedFiles: new Set(),
    externalEffects: [],
    expectedFileEvidenceAutoReadPaths: [],
    expectedFileEvidenceAutoVerifyKey: undefined,
    finishSummary: undefined,
    observations: [...(initial.initialObservations ?? [])],
    packageChanged: false,
    pendingEvidenceVerification: undefined,
    plan: null,
    readSnapshots: [],
    repairFeedback: [],
    consecutiveModelValidationFailures: 0,
    loopGuard: {},
    progressGuard: createEmptyProgressGuardState(),
    runContextSummary: createEmptyRunContextSummary(),
    steeringWatermark: 0,
  };
}

const MAX_MODEL_VALIDATION_OBSERVATIONS = 2;
const READ_ONLY_NO_PROGRESS_MIN_THRESHOLD = 10;
const READ_ONLY_NO_PROGRESS_MAX_THRESHOLD = 16;
const READ_ONLY_STALL_RESCUE_GRACE = 3;
const EXPECTED_FILE_AUTO_READ_AFTER_READ_ONLY_COUNT = 2;
const LOOP_EXHAUSTED_REASON =
  "The same failure repeated after one focused rescue attempt, so the run stopped to avoid a token/context budget loop.";
const READ_ONLY_STALL_EXHAUSTED_REASON =
  "Read-only exploration repeated after one focused rescue attempt without edits, verification, or finish, so the run stopped to avoid a token/context budget loop.";
const RUN_CONTEXT_SUMMARY_LLM_CHAR_THRESHOLD = 24_000;
const RUN_CONTEXT_SUMMARY_LLM_OBSERVATION_DELTA = 8;

function createEmptyProgressGuardState(): ProgressGuardState {
  return {
    readOnlyNoProgressCount: 0,
    readOnlyStallPostRescueCount: 0,
    readOnlyStallRescued: false,
  };
}

function resetReadOnlyNoProgress(state: RunDriveState) {
  state.progressGuard = createEmptyProgressGuardState();
}

function getAutoReadableMissingExpectedFiles(
  run: AgentRun,
  state: RunDriveState,
  incomingReadOnlyCount: number,
) {
  if (
    run.contract.source?.mode !== "spec" ||
    run.contract.taskType === "answer" ||
    hasImplementationProgress(run, state) ||
    state.progressGuard.readOnlyNoProgressCount + incomingReadOnlyCount <
      EXPECTED_FILE_AUTO_READ_AFTER_READ_ONLY_COUNT
  ) {
    return [];
  }

  const attempted = new Set(
    state.expectedFileEvidenceAutoReadPaths.map(normalizeProjectPath),
  );

  return getMissingExpectedFilesForRun(run, state)
    .filter((path) =>
      !attempted.has(path) &&
      run.contract.scope.allowedPaths.some((pattern) =>
        matchesProjectPathPattern(path, pattern),
      ) &&
      !isPathForbidden(path, run.contract.scope.forbiddenPaths),
    )
    .slice(0, 8);
}

function hasImplementationProgress(run: AgentRun, state: RunDriveState) {
  return (
    run.mutationCount > 0 ||
    state.changedFiles.size > 0 ||
    state.deletedFiles.size > 0 ||
    state.externalEffects.length > 0 ||
    state.packageChanged
  );
}

function shouldAutoVerifyAfterEvidenceRead(
  run: AgentRun,
  state: RunDriveState,
  readOnly: boolean,
  result: Pick<ToolResult, "status">,
) {
  if (!readOnly || result.status !== "success") {
    return false;
  }

  if (
    Boolean(state.pendingEvidenceVerification) &&
    getMissingExpectedFilesForRun(run, state).length === 0
  ) {
    return true;
  }

  return shouldAutoVerifyCompleteExpectedFileEvidence(run, state);
}

function shouldAutoVerifyCompleteExpectedFileEvidence(
  run: AgentRun,
  state: RunDriveState,
) {
  if (
    run.contract.source?.mode !== "spec" ||
    run.contract.taskType === "answer" ||
    hasImplementationProgress(run, state)
  ) {
    return false;
  }

  const evidenceKey = buildCompleteExpectedFileEvidenceKey(run, state);

  if (!evidenceKey || state.expectedFileEvidenceAutoVerifyKey === evidenceKey) {
    return false;
  }

  state.expectedFileEvidenceAutoVerifyKey = evidenceKey;
  return true;
}

function buildCompleteExpectedFileEvidenceKey(
  run: AgentRun,
  state: RunDriveState,
) {
  const expectedFiles = getExpectedFilesForRun(run);

  if (expectedFiles.length === 0 || getMissingExpectedFilesForRun(run, state).length > 0) {
    return undefined;
  }

  const evidencePaths = getRunEvidencePaths(run, state);
  const matchedExpectedFiles = expectedFiles.map((expected) => {
    const matchingEvidence = evidencePaths.find((path) =>
      path === expected || matchesProjectPathPattern(path, expected),
    );
    return `${expected}:${matchingEvidence ?? expected}`;
  });

  return matchedExpectedFiles.join("|");
}

function buildModelValidationObservation(
  action: Extract<HeadlessModelAction, { type: "model_validation_error" }>,
  consecutiveFailures: number,
) {
  const summary = compactSummaryText(
    `Model response validation failed: ${action.validationError}`,
    420,
  );

  return {
    content: [
      "The previous model response did not match the agent response protocol.",
      `Validation error: ${action.validationError}`,
      `Internal repair attempts used before this observation: ${action.attempts}.`,
      `Consecutive model validation observations: ${consecutiveFailures}.`,
      "Return one corrected JSON agent response on the next step. Do not repeat the invalid schema or parameters.",
      action.invalidResponsePreview
        ? `Invalid response preview:\n${action.invalidResponsePreview}`
        : "",
    ].filter(Boolean).join("\n"),
    ok: false,
    summary,
    tool: "model_validation",
  };
}

function buildLoopRescueObservation(summary: string, details: string) {
  const compactSummary = compactSummaryText(summary, 420);
  const compactDetails = compactSummaryText(details, 1_600);

  return {
    content: [
      "The same failure pattern repeated.",
      "This is the final automatic rescue attempt for this failure fingerprint.",
      `Failure summary: ${compactSummary}`,
      compactDetails ? `Failure details: ${compactDetails}` : "",
      "Change strategy now: do not repeat the previous action, do one focused repair using retained evidence, return finish_candidate if already fixed, or return a blocker answer if the missing information cannot be recovered from context.",
    ].filter(Boolean).join("\n"),
    ok: false,
    summary: `Loop rescue: ${compactSummary}`,
    tool: "loop_rescue",
  };
}

function buildBaselineDiagnosticObservations(
  run: AgentRun,
  state: RunDriveState,
) {
  if (run.contract.taskType === "answer" || run.mutationCount > 0) {
    return [];
  }

  const failedCommands = Object.entries(state.baselineCommandResults ?? {})
    .filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1]) && entry[1].success === false,
    )
    .slice(0, 3);

  if (failedCommands.length === 0) {
    return [];
  }

  return failedCommands.map(([checkId, result]) => {
    const command = typeof result.command === "string"
      ? result.command
      : checkId;
    const exitCode = typeof result.exitCode === "number" ||
      result.exitCode === null
      ? result.exitCode
      : "unknown";
    const output = typeof result.output === "string" ? result.output : "";
    const diagnostics = extractDiagnosticSummary(output) ||
      compactSummaryText(output, 1_600);
    const summary = compactSummaryText(
      `Baseline ${checkId} failed before this run: ${command} exited ${exitCode}.`,
      420,
    );

    return JSON.stringify({
      content: [
        "Baseline diagnostics were captured before this run started.",
        "This failure already exists in the workspace and can block Spec verification.",
        "If the diagnostic points into allowed paths for this task, repair it before broad exploration.",
        `[${checkId}] ${command} exitCode=${exitCode}`,
        diagnostics ? `Diagnostics: ${diagnostics}` : "",
      ].filter(Boolean).join("\n"),
      ok: false,
      summary,
      tool: "baseline_diagnostics",
    });
  });
}

function buildReadOnlyStallRescueObservation(state: RunDriveState) {
  const readCount = state.progressGuard.readOnlyNoProgressCount;
  const changedFiles = [...state.changedFiles].slice(-8);
  const latestFailures = state.runContextSummary.latestFailures.slice(-3);
  const summary = compactSummaryText(
    `Read-only exploration made ${readCount} consecutive tool call(s) without edits, verification, finish, or answer.`,
    420,
  );

  return {
    content: [
      "Read-only exploration is repeating without implementation progress.",
      "This is the final automatic rescue attempt for this no-progress pattern.",
      `Consecutive read-only tool calls without progress: ${readCount}.`,
      changedFiles.length > 0
        ? `Changed files already available: ${changedFiles.join(", ")}.`
        : "No files have been changed yet in this no-progress window.",
      latestFailures.length > 0
        ? `Latest retained failure evidence: ${latestFailures.join(" ")}`
        : "",
      "Change strategy now: stop broad reading. Use retained evidence to make one focused edit/write, return finish_candidate if the implementation is complete, or return a blocker answer if one more targeted read cannot recover the missing exact text.",
    ].filter(Boolean).join("\n"),
    ok: false,
    summary: `Loop rescue: ${summary}`,
    tool: "loop_rescue",
  };
}

function buildExpectedFileAutoReadObservation(paths: string[]) {
  const listedPaths = paths.slice(0, 8).join(", ");

  return {
    content: [
      "Spec expected-file evidence was incomplete during read-only exploration.",
      `The runtime is automatically reading missing expected file(s): ${listedPaths}.`,
      "Use this evidence for the next focused edit or verification result instead of rereading the same file.",
    ].join("\n"),
    ok: true,
    summary: `Auto-reading missing expected file(s): ${listedPaths}.`,
    tool: "expected_file_evidence",
  };
}

function buildPendingEvidenceVerificationState(
  run: AgentRun,
  state: RunDriveState,
  report: VerificationReport,
): PendingEvidenceVerificationState | undefined {
  const reason = report.missingEvidence.find((item) =>
    item.startsWith("Expected file evidence is missing for:"),
  );

  if (!reason || report.repairFeedback.length > 0) {
    return undefined;
  }

  const missingExpectedFiles = getMissingExpectedFilesForRun(run, state);

  if (missingExpectedFiles.length === 0) {
    return undefined;
  }

  return {
    missingExpectedFiles,
    reason,
  };
}

function getMissingExpectedFilesForRun(run: AgentRun, state: RunDriveState) {
  const expectedFiles = getExpectedFilesForRun(run);

  if (expectedFiles.length === 0) {
    return [];
  }

  const evidencePaths = getRunEvidencePaths(run, state);

  return expectedFiles.filter(
    (expected) =>
      !evidencePaths.some((path) =>
        path === expected || matchesProjectPathPattern(path, expected),
      ),
  );
}

function getExpectedFilesForRun(run: AgentRun) {
  return run.contract.source?.mode === "spec"
    ? uniqueStrings(
        (run.contract.source.expectedFiles ?? [])
          .map(normalizeProjectPath)
          .filter((path) => path && !isInvalidProjectPath(path)),
      )
    : [];
}

function getRunEvidencePaths(run: AgentRun, state: RunDriveState) {
  return uniqueStrings([
    ...[...state.changedFiles].map(normalizeProjectPath),
    ...state.readSnapshots.map((snapshot) => normalizeProjectPath(snapshot.path)),
  ]).filter((path) =>
    path &&
    !isInvalidProjectPath(path) &&
    run.contract.scope.allowedPaths.some((pattern) =>
      matchesProjectPathPattern(path, pattern),
    ) &&
    !isPathForbidden(path, run.contract.scope.forbiddenPaths),
  );
}

function buildFailureFingerprint(kind: string, details: string) {
  return `${kind}:${details
    .toLowerCase()
    .replace(/\brun-[a-z0-9-]+\b/g, "run-id")
    .replace(/\breport-[a-z0-9-]+\b/g, "report-id")
    .replace(/\b[a-f0-9]{8,}\b/g, "hex-id")
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z/g, "timestamp")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900)}`;
}

function createEmptyRunContextSummary(objective = ""): RunContextSummary {
  return {
    changedFiles: [],
    completed: [],
    decisions: [],
    deletedFiles: [],
    importantFiles: [],
    latestFailures: [],
    nextStep: "Choose the smallest useful next tool call or finish_candidate if complete.",
    objective,
    summarizedObservationCount: 0,
  };
}

function getReadOnlyNoProgressThreshold(run: AgentRun) {
  const expectedFiles = run.contract.source?.expectedFiles?.length ?? 0;
  const expectedFileAllowance =
    expectedFiles > 0
      ? expectedFiles * 3 + 4
      : READ_ONLY_NO_PROGRESS_MIN_THRESHOLD;
  const budgetAwareAllowance = Math.max(
    6,
    Math.floor(run.contract.budget.maxModelTurns * 0.4),
  );

  return Math.min(
    READ_ONLY_NO_PROGRESS_MAX_THRESHOLD,
    Math.max(READ_ONLY_NO_PROGRESS_MIN_THRESHOLD, expectedFileAllowance),
    budgetAwareAllowance,
  );
}

function buildDeterministicRunContextSummary({
  changedFiles,
  current,
  deletedFiles,
  now,
  observations,
  run,
}: {
  changedFiles: string[];
  current: RunContextSummary;
  deletedFiles: string[];
  now: string;
  observations: string[];
  run: AgentRun;
}): RunContextSummary {
  const latest = observations.slice(-14);
  const latestFailures = latest
    .filter(isFailureLikeObservation)
    .map((observation) => summarizeObservationForContext(observation, "failure"))
    .slice(-6);
  const completed = latest
    .filter((observation) => !isFailureLikeObservation(observation))
    .map((observation) => summarizeObservationForContext(observation, "completed"))
    .filter(Boolean)
    .slice(-8);
  const importantFiles = uniqueStrings([
    ...current.importantFiles,
    ...changedFiles,
    ...deletedFiles,
    ...latest.flatMap(extractLikelyFilePaths),
  ]).slice(-32);
  const decisions = uniqueStrings([
    ...current.decisions,
    ...(changedFiles.length > 0
      ? [`Changed ${changedFiles.length} file(s): ${changedFiles.slice(-6).join(", ")}`]
      : []),
    ...(deletedFiles.length > 0
      ? [`Deleted ${deletedFiles.length} file(s): ${deletedFiles.slice(-6).join(", ")}`]
      : []),
  ]).slice(-12);

  return {
    changedFiles: uniqueStrings(changedFiles).slice(-40),
    completed,
    decisions,
    deletedFiles: uniqueStrings(deletedFiles).slice(-40),
    importantFiles,
    latestFailures,
    nextStep: deriveSummaryNextStep(latestFailures, changedFiles),
    objective: compactSummaryText(current.objective || run.contract.objective, 500),
    summarizedObservationCount: observations.length,
    updatedAt: now,
  };
}

function shouldSummarizeWithLlm(
  current: RunContextSummary,
  observations: string[],
) {
  const rawChars = observations.reduce((total, observation) => total + observation.length, 0);
  const newObservations = observations.length - current.summarizedObservationCount;

  return (
    rawChars > RUN_CONTEXT_SUMMARY_LLM_CHAR_THRESHOLD &&
    (current.summarizedObservationCount === 0 ||
      newObservations >= RUN_CONTEXT_SUMMARY_LLM_OBSERVATION_DELTA)
  );
}

function normalizeRunContextSummary(
  value: unknown,
  fallback: RunContextSummary,
): RunContextSummary {
  if (!isRecord(value)) {
    return fallback;
  }

  return {
    changedFiles: readStringArray(value.changedFiles, fallback.changedFiles, 40),
    completed: readStringArray(value.completed, fallback.completed, 12),
    decisions: readStringArray(value.decisions, fallback.decisions, 12),
    deletedFiles: readStringArray(value.deletedFiles, fallback.deletedFiles, 40),
    importantFiles: readStringArray(value.importantFiles, fallback.importantFiles, 40),
    latestFailures: readStringArray(value.latestFailures, fallback.latestFailures, 8),
    nextStep:
      typeof value.nextStep === "string" && value.nextStep.trim()
        ? compactSummaryText(value.nextStep, 360)
        : fallback.nextStep,
    objective:
      typeof value.objective === "string" && value.objective.trim()
        ? compactSummaryText(value.objective, 500)
        : fallback.objective,
    summarizedObservationCount:
      typeof value.summarizedObservationCount === "number" &&
      Number.isFinite(value.summarizedObservationCount) &&
      value.summarizedObservationCount >= 0
        ? Math.floor(value.summarizedObservationCount)
        : fallback.summarizedObservationCount,
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  };
}

function readRunContextSummary(value: unknown) {
  return isRecord(value)
    ? normalizeRunContextSummary(value, createEmptyRunContextSummary())
    : undefined;
}

function deriveSummaryNextStep(latestFailures: string[], changedFiles: string[]) {
  if (latestFailures.length > 0) {
    return "Repair the latest failure using the retained error context and relevant files.";
  }

  if (changedFiles.length > 0) {
    return "Verify the changed files and return finish_candidate when acceptance criteria are met.";
  }

  return "Choose the smallest useful next tool call or finish_candidate if complete.";
}

function isFailureLikeObservation(observation: string) {
  const parsed = parseObservationRecord(observation);

  if (parsed) {
    if (typeof parsed.ok === "boolean") {
      return !parsed.ok;
    }

    if (typeof parsed.status === "string") {
      return !["success", "passed", "ok"].includes(parsed.status.toLowerCase());
    }

    if (Array.isArray(parsed.files)) {
      return false;
    }
  }

  return /\b(error|failed|failure|exception|timeout|denied|invalid|not found|cannot|can't)\b/i
    .test(observation);
}

function summarizeObservationForContext(
  observation: string,
  kind: "completed" | "failure",
) {
  const parsed = parseObservationRecord(observation);

  if (parsed) {
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const tool = typeof parsed.tool === "string" ? parsed.tool : "";

    if (kind === "completed") {
      return compactSummaryText(summary || tool || observation, 260);
    }

    const content = typeof parsed.content === "string" ? parsed.content : "";
    const diagnostics = extractDiagnosticSummary(content);

    return compactSummaryText(
      [summary || tool || "Failed observation", diagnostics].filter(Boolean).join(" "),
      520,
    );
  }

  return compactSummaryText(observation, kind === "failure" ? 520 : 260);
}

function extractDiagnosticSummary(content: string) {
  if (!content) {
    return "";
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /(?:^|\s)(?:\.\/)?[A-Za-z0-9_./@-]+\.[A-Za-z0-9]+:\d+:\d+\b/.test(line) ||
      /(?:Type error|Error|Failed|Cannot find name|not assignable)/i.test(line),
    )
    .slice(-8);

  return lines.join(" ");
}

function parseObservationRecord(observation: string) {
  try {
    const parsed = JSON.parse(observation) as unknown;

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractLikelyFilePaths(value: string) {
  const matches = value.match(
    /\b(?:app|components|lib|public|styles|src|pages|hooks|utils|server)\/[A-Za-z0-9._/@-]+/g,
  );

  return matches ?? [];
}

function compactSummaryText(value: string, maxLength: number) {
  const compacted = value.replace(/\s+/g, " ").trim();

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, maxLength)}...`;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function readStringArray(value: unknown, fallback: string[], maxItems: number) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => compactSummaryText(item, 500))
    .slice(-maxItems);
}

function recoveryReasonForStatus(status: AgentRun["status"]) {
  switch (status) {
    case "planning":
      return "planning-run-recovered";
    case "exploring":
      return "exploring-run-normalized-to-planning";
    case "mutating":
      return "mutating-run-interrupted";
    case "verifying":
      return "verifying-run-normalized-to-planning";
    case "repairing":
      return "repairing-run-normalized-to-planning";
    default:
      return "interrupted-run-recovered";
  }
}

function shouldCompleteSpecRunAfterPassedVerification(run: AgentRun) {
  return run.contract.source?.mode === "spec";
}

function buildVerificationFailureSummary(report: VerificationReport) {
  return compactSummaryText(
    [
      `Verification ${report.status}`,
      ...[
        ...report.repairFeedback,
        ...report.missingEvidence,
        ...report.newlyIntroducedFailures,
      ].slice(0, 3),
    ].join(": "),
    420,
  );
}

function buildVerificationFailureDetails(report: VerificationReport) {
  return [
    `status=${report.status}`,
    ...report.repairFeedback.map((item) => `repair=${item}`),
    ...report.missingEvidence.map((item) => `missing=${item}`),
    ...report.newlyIntroducedFailures.map((item) => `failure=${item}`),
    ...report.checks
      .filter((check) => check.status !== "passed")
      .map((check) => `${check.title}: ${check.status} - ${check.summary}`),
  ].join("\n");
}

function buildVerificationObservation(report: VerificationReport) {
  const failedOrMissing = [
    ...report.newlyIntroducedFailures,
    ...report.missingEvidence,
    ...report.repairFeedback,
  ];
  const summary =
    report.status === "passed"
      ? "Verification passed."
      : `Verification ${report.status}: ${failedOrMissing.slice(0, 3).join(" ")}`;

  return {
    content: [
      `Verification report ${report.id}: ${report.status}.`,
      ...report.checks.map((check) =>
        `${check.title}: ${check.status} - ${check.summary}`,
      ),
      failedOrMissing.length > 0
        ? `Repair or missing evidence: ${failedOrMissing.join(" ")}`
        : "",
    ].filter(Boolean).join("\n"),
    ok: report.status === "passed",
    summary: compactSummaryText(summary, 420),
    tool: "verification",
  };
}

function buildToolObservation(tool: string, result: ToolResult) {
  const contentSource =
    typeof result.structuredData === "undefined"
      ? result.summary
      : result.structuredData;

  return {
    content: stringifyPayload(contentSource),
    ok: result.status === "success",
    summary: result.summary,
    tool,
  };
}

function mergeReadSnapshots(
  currentSnapshots: AgentReadSnapshot[],
  nextSnapshots: AgentReadSnapshot[],
) {
  const snapshotMap = new Map(
    currentSnapshots.map((snapshot) => [snapshot.path, snapshot]),
  );

  for (const snapshot of nextSnapshots) {
    const existing = snapshotMap.get(snapshot.path);

    if (
      !existing ||
      new Date(snapshot.readAt).getTime() >= new Date(existing.readAt).getTime()
    ) {
      snapshotMap.set(snapshot.path, snapshot);
    }
  }

  return [...snapshotMap.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

type CheckpointDriveStateMetadata = {
  answerMessage?: string;
  baselineArtifactId?: string;
  baselineCommandResults?: Record<string, unknown>;
  baselinePackageJson?: string | null;
  consecutiveModelValidationFailures?: number;
  externalEffects?: string[];
  expectedFileEvidenceAutoReadPaths?: string[];
  expectedFileEvidenceAutoVerifyKey?: string;
  finishSummary?: string;
  loopGuard?: LoopGuardState;
  pendingEvidenceVerification?: PendingEvidenceVerificationState;
  pendingApprovalAction?: HeadlessToolCallAction;
  progressGuard?: ProgressGuardState;
  runContextSummary?: RunContextSummary;
  userPlan: unknown;
};

const DRIVE_STATE_PLAN_KEY = "__headlessRunController";

function writeDriveStateMetadata(state: RunDriveState) {
  return {
    userPlan: state.plan,
    [DRIVE_STATE_PLAN_KEY]: {
      answerMessage: state.answerMessage,
      baselineArtifactId: state.baselineArtifactId,
      baselineCommandResults: state.baselineCommandResults,
      baselinePackageJson: state.baselinePackageJson,
      consecutiveModelValidationFailures: state.consecutiveModelValidationFailures,
      externalEffects: state.externalEffects,
      expectedFileEvidenceAutoReadPaths: state.expectedFileEvidenceAutoReadPaths,
      expectedFileEvidenceAutoVerifyKey: state.expectedFileEvidenceAutoVerifyKey,
      finishSummary: state.finishSummary,
      loopGuard: state.loopGuard,
      pendingEvidenceVerification: state.pendingEvidenceVerification,
      pendingApprovalAction: state.pendingApprovalAction,
      progressGuard: state.progressGuard,
      runContextSummary: state.runContextSummary,
    },
  };
}

export function readRunDriveStateMetadata(plan: unknown): CheckpointDriveStateMetadata {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { userPlan: plan };
  }

  const record = plan as Record<string, unknown>;
  const metadata = record[DRIVE_STATE_PLAN_KEY];

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { userPlan: plan };
  }

  const metadataRecord = metadata as Record<string, unknown>;
  return {
    answerMessage:
      typeof metadataRecord.answerMessage === "string"
        ? metadataRecord.answerMessage
        : undefined,
    baselineArtifactId:
      typeof metadataRecord.baselineArtifactId === "string"
        ? metadataRecord.baselineArtifactId
        : undefined,
    baselineCommandResults: isRecord(metadataRecord.baselineCommandResults)
      ? metadataRecord.baselineCommandResults
      : undefined,
    baselinePackageJson:
      typeof metadataRecord.baselinePackageJson === "string" ||
      metadataRecord.baselinePackageJson === null
        ? metadataRecord.baselinePackageJson
        : undefined,
    consecutiveModelValidationFailures: readNonNegativeInteger(
      metadataRecord.consecutiveModelValidationFailures,
    ),
    externalEffects: readOptionalStringArray(metadataRecord.externalEffects),
    expectedFileEvidenceAutoReadPaths: readOptionalStringArray(
      metadataRecord.expectedFileEvidenceAutoReadPaths,
    ),
    expectedFileEvidenceAutoVerifyKey:
      typeof metadataRecord.expectedFileEvidenceAutoVerifyKey === "string"
        ? metadataRecord.expectedFileEvidenceAutoVerifyKey
        : undefined,
    finishSummary:
      typeof metadataRecord.finishSummary === "string"
        ? metadataRecord.finishSummary
        : undefined,
    loopGuard: readLoopGuardState(metadataRecord.loopGuard),
    pendingEvidenceVerification: readPendingEvidenceVerificationState(
      metadataRecord.pendingEvidenceVerification,
    ),
    pendingApprovalAction: isHeadlessToolCallAction(metadataRecord.pendingApprovalAction)
      ? metadataRecord.pendingApprovalAction
      : undefined,
    progressGuard: readProgressGuardState(metadataRecord.progressGuard),
    runContextSummary: readRunContextSummary(metadataRecord.runContextSummary),
    userPlan: "userPlan" in record ? record.userPlan : null,
  };
}

function isHeadlessToolCallAction(value: unknown): value is HeadlessToolCallAction {
  return (
    isRecord(value) &&
    value.type === "tool_call" &&
    typeof value.tool === "string" &&
    "args" in value
  );
}

function readNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function readOptionalStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function readLoopGuardState(value: unknown): LoopGuardState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    lastFingerprint:
      typeof value.lastFingerprint === "string"
        ? value.lastFingerprint
        : undefined,
    rescuedFingerprint:
      typeof value.rescuedFingerprint === "string"
        ? value.rescuedFingerprint
        : undefined,
  };
}

function readProgressGuardState(value: unknown): ProgressGuardState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    readOnlyNoProgressCount:
      readNonNegativeInteger(value.readOnlyNoProgressCount) ?? 0,
    readOnlyStallPostRescueCount:
      readNonNegativeInteger(value.readOnlyStallPostRescueCount) ?? 0,
    readOnlyStallRescued: value.readOnlyStallRescued === true,
  };
}

function readPendingEvidenceVerificationState(
  value: unknown,
): PendingEvidenceVerificationState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const missingExpectedFiles = readOptionalStringArray(value.missingExpectedFiles)
    ?.map(normalizeProjectPath)
    .filter((path) => path && !isInvalidProjectPath(path)) ?? [];
  const reason = typeof value.reason === "string" ? value.reason : "";

  if (missingExpectedFiles.length === 0 || !reason.trim()) {
    return undefined;
  }

  return {
    missingExpectedFiles,
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTargetResources(args: unknown): string[] {
  if (typeof args !== "object" || args === null) {
    return [];
  }

  if (Array.isArray(args)) {
    return args.flatMap((item) =>
      typeof item === "string" ? [item] : collectTargetResources(item),
    );
  }

  const record = args as Record<string, unknown>;
  const resources: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && key.toLowerCase().includes("path")) {
      resources.push(value);
    } else {
      resources.push(...collectTargetResources(value));
    }
  }

  return resources;
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "summary" in payload &&
    "tool" in payload &&
    "ok" in payload
  ) {
    return JSON.stringify(payload);
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof (payload as { message?: unknown }).message === "string"
  ) {
    return (payload as { message: string }).message;
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "content" in payload &&
    typeof (payload as { content?: unknown }).content === "string"
  ) {
    return (payload as { content: string }).content;
  }

  return JSON.stringify(payload);
}

function addMinutesIso(now: string, minutes: number) {
  return new Date(new Date(now).getTime() + minutes * 60_000).toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
