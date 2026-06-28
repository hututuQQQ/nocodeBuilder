import type {
  AgentApproval,
  AgentApprovalDecision,
  AgentEvent,
  AgentFailureCode,
  AgentFinishEvidence,
  AgentReadSnapshot,
  AgentRun,
  AgentRunCheckpoint,
  AgentStructuredObservation,
  AgentWorkingState,
  RunContextSummary,
  SuggestedAgentAction,
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
import {
  createTaskManifestFromContract,
  type TaskManifest,
} from "../manifest/taskManifest";
import { checkRunDrift, type DriftCheckResult } from "./driftGuard";
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
      evidence?: AgentFinishEvidence;
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
  observations: unknown[];
  run: AgentRun;
  runContextSummary: RunContextSummary;
  steering: string[];
  workingState: AgentWorkingState;
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
    finishEvidence?: AgentFinishEvidence;
    noOpReason?: string;
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
  manifest?: TaskManifest;
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
  finishEvidence?: AgentFinishEvidence;
  latestReportId?: string;
  observations: unknown[];
  packageChanged: boolean;
  pendingEvidenceVerification?: PendingEvidenceVerificationState;
  pendingApprovalAction?: HeadlessToolCallAction;
  plan: unknown;
  preflightAutoReadFingerprints: string[];
  readSnapshots: AgentRunCheckpoint["readSnapshots"];
  repairFeedback: string[];
  consecutiveModelValidationFailures: number;
  consecutiveDriftFailures: number;
  loopGuard: LoopGuardState;
  progressGuard: ProgressGuardState;
  runContextSummary: RunContextSummary;
  steeringWatermark: number;
  workingState: AgentWorkingState;
};

type LoopGuardState = {
  lastFingerprint?: string;
  rescueCount?: number;
  repeatedCount?: number;
  rescuedFingerprint?: string;
};

type ProgressGuardState = {
  observedDiagnosticFingerprints: string[];
  observedReadEvidenceFingerprints: string[];
  observedSearchEvidenceFingerprints: string[];
  lastReadOnlyActionFingerprint?: string;
  readOnlyRescuedFingerprint?: string;
  readOnlyNoProgressCount: number;
  repeatedReadOnlyActionCount: number;
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
      manifest: input.manifest ?? createTaskManifestFromContract({
        contract: input.contract,
        conversationId: input.conversationId,
        projectId: input.projectId,
      }),
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

    let run: AgentRun = ensureRunManifest(loaded);
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
      run = ensureRunManifest(run);

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

      const runWithManifest = ensureRunManifest(run);
      run = runWithManifest;
      const driftCheck = checkRunDrift({
        manifest: runWithManifest.manifest,
        action,
        changedFiles: [...state.changedFiles],
        recentObservations: context.observations.slice(-8).map(stringifyPayload),
        steering: context.steering,
      });

      if (!driftCheck.ok) {
        run = await this.recordDriftFailure(run, state, driftCheck);

        if (isTerminalAgentRunStatus(run.status)) {
          return run;
        }

        continue;
      }

      state.consecutiveDriftFailures = 0;
      state.consecutiveModelValidationFailures = 0;
      state.workingState.lastActionFingerprint = buildActionFingerprint(action);
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
        state.finishEvidence = normalizeFinishEvidence(action.evidence);
        appendFinishEvidenceToWorkingState(state, state.finishEvidence);
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
      buildModelValidationObservation(action, consecutiveFailures),
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

  private async recordDriftFailure(
    run: AgentRun,
    state: RunDriveState,
    driftCheck: DriftCheckResult,
  ): Promise<AgentRun> {
    state.consecutiveDriftFailures += 1;
    const summary = `Drift guard rejected model action: ${driftCheck.reason}`;
    state.observations.push(
      JSON.stringify({
        content: [
          driftCheck.reason,
          driftCheck.suggestedAction
            ? `suggestedAction=${driftCheck.suggestedAction}`
            : "",
          "TaskManifest is the source of truth. Choose a corrected next action that stays within the manifest.",
        ].filter(Boolean).join("\n"),
        ok: false,
        summary,
        tool: "drift_guard",
      }),
    );

    await this.ports.eventStore.append({
      runId: run.id,
      type: "model.failed",
      timestamp: this.ports.clock.now(),
      payload: {
        reason: driftCheck.reason,
        retryable: state.consecutiveDriftFailures < 2,
        suggestedAction: driftCheck.suggestedAction,
        type: "drift_guard",
      },
    });

    if (state.consecutiveDriftFailures < 2) {
      await this.saveCheckpoint(run, state, "drift-guard-observation");
      return run;
    }

    const failedRun = await this.commit(
      run,
      this.machine.transition(run, {
        reason: summary,
        type: "fail",
      }),
    );
    await this.saveCheckpoint(failedRun, state, "drift-guard-failed");
    return failedRun;
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
        buildPolicyDeniedObservation(run, action, policyDecision.reason),
      );
      state.workingState.currentBlocker = {
        code: "POLICY_DENIED",
        message: policyDecision.reason,
        fingerprint: buildActionFingerprint(action),
        suggestedAction: inferPolicyDeniedSuggestedAction(run, action, policyDecision.reason),
      };
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

    const actionFingerprint = buildActionFingerprint(action);
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

    const preflightReadPaths = getPreflightReadBeforeWritePaths(action, state);

    if (
      preflightReadPaths.length > 0 &&
      !state.preflightAutoReadFingerprints.includes(actionFingerprint)
    ) {
      state.preflightAutoReadFingerprints.push(actionFingerprint);
      state.observations.push(
        buildPreflightAutoReadObservation(action, preflightReadPaths),
      );
      state.workingState.currentBlocker = {
        code: "MUST_READ_BEFORE_WRITE",
        message: `${action.tool} requires current read evidence before mutation.`,
        fingerprint: actionFingerprint,
        suggestedAction: {
          type: "tool_call",
          tool: "read_files",
          args: { paths: preflightReadPaths },
          rationale: "Runtime preflight is refreshing files before mutation.",
        },
      };
      await this.saveCheckpoint(run, state, `preflight-read:${action.tool}`);
      run = await this.executeToolBatch(
        run,
        preflightReadPaths.map((path) => ({
          tool: "read_files",
          args: { paths: [path] },
          rationale: "Read current file contents before retrying the mutation.",
        })),
        state,
        signal,
      );

      if (
        isTerminalAgentRunStatus(run.status) ||
        run.status === "waiting_approval" ||
        run.status === "paused"
      ) {
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
    const readOnlyInformationGain = tool.readOnly
      ? consumeReadOnlyInformationGain(state, action.tool, result)
      : false;
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
    state.observations.push(buildToolObservation(action.tool, result));

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
      actionFingerprint,
      hasInformationGain: readOnlyInformationGain,
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
    const readOnlyInformationGain = results.some((result, index) =>
      consumeReadOnlyInformationGain(state, actions[index]!.tool, result),
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
      state.observations.push(buildToolObservation(action.tool, result));

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
      actionFingerprint: buildActionFingerprint({
        calls: actions,
        type: "tool_calls",
      }),
      hasInformationGain: readOnlyInformationGain,
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
      buildExpectedFileAutoReadObservation(missingExpectedFiles),
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
      finishEvidence: state.finishEvidence,
      noOpReason: hasImplementationProgress(run, state)
        ? undefined
        : state.finishEvidence?.noOpReason,
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
    state.observations.push(buildVerificationObservation(report));

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
    const now = this.ports.clock.now();

    if (unresolved && isApprovalExpired(unresolved, now)) {
      await this.ports.approvals.resolve(run.id, unresolved.id, "expired", now);
    } else if (unresolved ?? await this.ports.approvals.getPending(run.id)) {
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
    run = ensureRunManifest(run);
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

    const observations: unknown[] = [
      ...buildBaselineDiagnosticObservations(run, state),
      ...state.observations,
    ];
    const summaryObservations = observations.map(stringifyPayload);
    state.runContextSummary = await this.refreshRunContextSummary(
      run,
      state,
      summaryObservations,
      signal,
    );
    state.workingState = buildCurrentWorkingState(run, state);

    return {
      observations,
      run,
      runContextSummary: state.runContextSummary,
      steering,
      workingState: state.workingState,
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
    const maxRescueAttempts = getLoopRescueAttemptLimit(run, state, signal.kind);

    if (state.loopGuard.lastFingerprint !== fingerprint) {
      state.loopGuard.lastFingerprint = fingerprint;
      state.loopGuard.repeatedCount = 1;
      state.loopGuard.rescueCount = 0;
      state.loopGuard.rescuedFingerprint = undefined;
      return { rescued: false, run, stopped: false };
    }

    state.loopGuard.repeatedCount = (state.loopGuard.repeatedCount ?? 1) + 1;

    const previousRescueCount = state.loopGuard.rescuedFingerprint === fingerprint
      ? state.loopGuard.rescueCount ?? 1
      : 0;

    if (previousRescueCount >= maxRescueAttempts) {
      const stoppedRun = await this.commit(
        run,
        this.machine.transition(run, {
          budget: "maxModelTurns",
          failureKind: "loop_exhausted",
          reason: buildLoopExhaustedReason(maxRescueAttempts),
          type: "budget_exceeded",
        }),
      );
      return { rescued: false, run: stoppedRun, stopped: true };
    }

    const nextRescueCount = previousRescueCount + 1;
    state.loopGuard.rescuedFingerprint = fingerprint;
    state.loopGuard.rescueCount = nextRescueCount;
    state.observations.push(
      buildLoopRescueObservation({
        details: signal.details,
        maxRescueAttempts,
        rescueAttempt: nextRescueCount,
        summary: signal.summary,
      }),
    );

    return { rescued: true, run, stopped: false };
  }

  private async handleToolProgressSignal(
    run: AgentRun,
    state: RunDriveState,
    signal: {
      actionFingerprint?: string;
      hasInformationGain: boolean;
      readOnlyCount: number;
      resetReadOnlyStall: boolean;
    },
  ): Promise<{ rescued: boolean; stopped: boolean; run: AgentRun }> {
    if (signal.resetReadOnlyStall || signal.readOnlyCount <= 0) {
      resetReadOnlyNoProgress(state);
      return { rescued: false, run, stopped: false };
    }

    const fingerprint = signal.actionFingerprint ?? "read-only:unknown";
    state.progressGuard.readOnlyNoProgressCount += signal.readOnlyCount;

    if (signal.hasInformationGain) {
      state.progressGuard.lastReadOnlyActionFingerprint = fingerprint;
      state.progressGuard.repeatedReadOnlyActionCount = 0;
      state.progressGuard.readOnlyStallPostRescueCount = 0;
      return { rescued: false, run, stopped: false };
    }

    if (state.progressGuard.lastReadOnlyActionFingerprint !== fingerprint) {
      state.progressGuard.lastReadOnlyActionFingerprint = fingerprint;
      state.progressGuard.repeatedReadOnlyActionCount = signal.readOnlyCount;
      state.progressGuard.readOnlyStallPostRescueCount = 0;
      return { rescued: false, run, stopped: false };
    }

    state.progressGuard.repeatedReadOnlyActionCount += signal.readOnlyCount;

    if (state.progressGuard.readOnlyStallRescued) {
      if (
        state.progressGuard.readOnlyRescuedFingerprint === fingerprint
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
      state.progressGuard.repeatedReadOnlyActionCount <
        REPEATED_READ_ONLY_ACTION_RESCUE_THRESHOLD
    ) {
      return { rescued: false, run, stopped: false };
    }

    state.progressGuard.readOnlyStallRescued = true;
    state.progressGuard.readOnlyRescuedFingerprint = fingerprint;
    state.progressGuard.readOnlyStallPostRescueCount = 0;
    state.observations.push(
      buildReadOnlyStallRescueObservation(state, fingerprint),
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
        finishEvidence: metadata.finishEvidence,
        latestReportId: checkpoint.latestReportId,
        observations: [...checkpoint.observations],
        packageChanged: checkpoint.packageChanged,
        pendingEvidenceVerification: metadata.pendingEvidenceVerification,
        pendingApprovalAction: metadata.pendingApprovalAction,
        plan: metadata.userPlan,
        preflightAutoReadFingerprints:
          metadata.preflightAutoReadFingerprints ?? [],
        readSnapshots,
        repairFeedback: [...checkpoint.repairFeedback],
        consecutiveModelValidationFailures:
          metadata.consecutiveModelValidationFailures ?? 0,
        consecutiveDriftFailures: metadata.consecutiveDriftFailures ?? 0,
        loopGuard: metadata.loopGuard ?? {},
        progressGuard:
          metadata.progressGuard ?? createEmptyProgressGuardState(),
        runContextSummary: normalizeRunContextSummary(
          metadata.runContextSummary,
          createEmptyRunContextSummary(run.contract.objective),
        ),
        steeringWatermark: checkpoint.steeringWatermark,
        workingState: metadata.workingState ?? createEmptyWorkingState(run.contract.objective),
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
    finishEvidence: undefined,
    observations: [...(initial.initialObservations ?? [])],
    packageChanged: false,
    pendingEvidenceVerification: undefined,
    plan: null,
    preflightAutoReadFingerprints: [],
    readSnapshots: [],
    repairFeedback: [],
    consecutiveModelValidationFailures: 0,
    consecutiveDriftFailures: 0,
    loopGuard: {},
    progressGuard: createEmptyProgressGuardState(),
    runContextSummary: createEmptyRunContextSummary(),
    steeringWatermark: 0,
    workingState: createEmptyWorkingState(""),
  };
}

function ensureRunManifest(run: AgentRun): AgentRun & { manifest: TaskManifest } {
  return run.manifest
    ? run as AgentRun & { manifest: TaskManifest }
    : {
        ...run,
        manifest: createTaskManifestFromContract({
          contract: run.contract,
          conversationId: run.conversationId,
          projectId: run.projectId,
        }),
      };
}

const MAX_MODEL_VALIDATION_OBSERVATIONS = 2;
const DEFAULT_LOOP_RESCUE_ATTEMPTS = 1;
const SPEC_VERIFICATION_LOOP_RESCUE_ATTEMPTS = 3;
const REPEATED_READ_ONLY_ACTION_RESCUE_THRESHOLD = 3;
const READ_ONLY_STALL_RESCUE_GRACE = 3;
const EXPECTED_FILE_AUTO_READ_AFTER_READ_ONLY_COUNT = 2;
const LOOP_EXHAUSTED_REASON =
  "The same failure repeated after one focused rescue attempt, so the run stopped to avoid a repeated-action loop.";
const READ_ONLY_STALL_EXHAUSTED_REASON =
  "Read-only exploration repeated after one focused rescue attempt without edits, verification, or finish, so the run stopped to avoid a repeated-action loop.";
const RUN_CONTEXT_SUMMARY_LLM_CHAR_THRESHOLD = 24_000;
const RUN_CONTEXT_SUMMARY_LLM_OBSERVATION_DELTA = 8;

function createEmptyProgressGuardState(): ProgressGuardState {
  return {
    observedDiagnosticFingerprints: [],
    observedReadEvidenceFingerprints: [],
    observedSearchEvidenceFingerprints: [],
    lastReadOnlyActionFingerprint: undefined,
    readOnlyRescuedFingerprint: undefined,
    readOnlyNoProgressCount: 0,
    repeatedReadOnlyActionCount: 0,
    readOnlyStallPostRescueCount: 0,
    readOnlyStallRescued: false,
  };
}

function createEmptyWorkingState(objective: string): AgentWorkingState {
  return {
    objective,
    repeatedActionCount: 0,
    evidence: {
      acceptanceEvidence: [],
      diagnostics: [],
      mutations: [],
      readFiles: [],
      searches: [],
    },
  };
}

function normalizeFinishEvidence(value: AgentFinishEvidence | undefined) {
  if (!value) {
    return undefined;
  }

  const evidence: AgentFinishEvidence = {};
  const readFiles = uniqueStrings((value.readFiles ?? [])
    .map(normalizeProjectPath)
    .filter(Boolean));
  const changedFiles = uniqueStrings((value.changedFiles ?? [])
    .map(normalizeProjectPath)
    .filter(Boolean));
  const acceptanceEvidence = (value.acceptanceEvidence ?? [])
    .map((item) => ({
      criterionId: item.criterionId.trim(),
      evidence: compactSummaryText(item.evidence, 600),
    }))
    .filter((item) => item.criterionId && item.evidence);

  if (readFiles.length > 0) {
    evidence.readFiles = readFiles;
  }

  if (changedFiles.length > 0) {
    evidence.changedFiles = changedFiles;
  }

  if (value.noOpReason?.trim()) {
    evidence.noOpReason = compactSummaryText(value.noOpReason, 600);
  }

  if (acceptanceEvidence.length > 0) {
    evidence.acceptanceEvidence = acceptanceEvidence;
  }

  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function appendFinishEvidenceToWorkingState(
  state: RunDriveState,
  evidence: AgentFinishEvidence | undefined,
) {
  if (!evidence) {
    return;
  }

  const now = new Date().toISOString();
  state.workingState.evidence.acceptanceEvidence = [
    ...state.workingState.evidence.acceptanceEvidence,
    ...(evidence.acceptanceEvidence ?? []).map((item) => ({
      criterionId: item.criterionId,
      evidence: item.evidence,
      source: evidence.noOpReason ? "manual" : "changed_file",
    })),
  ].slice(-40);

  if (evidence.changedFiles?.length) {
    state.workingState.evidence.mutations = [
      ...state.workingState.evidence.mutations,
      ...evidence.changedFiles.map((path) => ({
        path,
        action: "finish_evidence",
        summary: "Model cited this changed file as finish evidence.",
        at: now,
      })),
    ].slice(-40);
  }
}

function resetReadOnlyNoProgress(state: RunDriveState) {
  state.progressGuard = createEmptyProgressGuardState();
}

function consumeReadOnlyInformationGain(
  state: RunDriveState,
  tool: string,
  result: ToolResult,
) {
  const structured = readStructuredObservation(result.structuredData);
  const readFingerprints = [
    ...(result.workspaceEffects?.readSnapshots ?? []).map((snapshot) =>
      buildReadEvidenceFingerprint({
        contentHash: snapshot.contentHash,
        endLine: snapshot.endLine,
        path: snapshot.path,
        startLine: snapshot.startLine,
      }),
    ),
    ...(structured?.evidence?.readFiles ?? []).map(buildReadEvidenceFingerprint),
  ];
  const searchFingerprints = (structured?.evidence?.searches ?? []).map((search) =>
    [
      search.tool || tool,
      search.fingerprint,
      search.resultCount ?? "unknown",
      ...(search.newPaths ?? []).map(normalizeProjectPath).sort(),
    ].join(":"),
  );
  const diagnosticFingerprints = structured?.error
    ? (
        structured.error.diagnostics?.length
          ? structured.error.diagnostics.map((diagnostic) =>
              [
                structured.error?.code,
                normalizeProjectPath(diagnostic.path ?? ""),
                diagnostic.line ?? "",
                diagnostic.column ?? "",
                diagnostic.message,
              ].join(":"),
            )
          : [[
              structured.error.code,
              structured.error.message,
            ].join(":")]
      )
    : [];

  return consumeNewFingerprints(
    state.progressGuard.observedReadEvidenceFingerprints,
    readFingerprints,
  ) || consumeNewFingerprints(
    state.progressGuard.observedSearchEvidenceFingerprints,
    searchFingerprints,
  ) || consumeNewFingerprints(
    state.progressGuard.observedDiagnosticFingerprints,
    diagnosticFingerprints,
  );
}

function buildReadEvidenceFingerprint(input: {
  contentHash?: string;
  endLine?: number;
  path: string;
  startLine?: number;
}) {
  return [
    normalizeProjectPath(input.path),
    input.startLine ?? "full",
    input.endLine ?? "full",
    input.contentHash ?? "unknown",
  ].join(":");
}

function consumeNewFingerprints(seen: string[], next: string[]) {
  let gained = false;

  for (const fingerprint of next.filter(Boolean)) {
    if (seen.includes(fingerprint)) {
      continue;
    }

    seen.push(fingerprint);
    gained = true;
  }

  if (seen.length > 240) {
    seen.splice(0, seen.length - 240);
  }

  return gained;
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
    error: {
      code: "MODEL_PROTOCOL_ERROR" as const,
      fingerprint: buildFailureFingerprint("model_validation", action.validationError),
      message: action.validationError,
      retryable: consecutiveFailures <= MAX_MODEL_VALIDATION_OBSERVATIONS,
      suggestedAction: {
        type: "blocker" as const,
        reason: "The model response did not match the required JSON protocol.",
        recoveryOptions: [
          "Return one corrected JSON response.",
          "Use only supported tool names and arguments.",
        ],
      },
    },
    ok: false,
    summary,
    tool: "model_validation",
  };
}

function getLoopRescueAttemptLimit(
  run: AgentRun,
  state: RunDriveState,
  kind: string,
) {
  if (
    kind === "verification" &&
    run.contract.source?.mode === "spec" &&
    hasImplementationProgress(run, state)
  ) {
    return SPEC_VERIFICATION_LOOP_RESCUE_ATTEMPTS;
  }

  return DEFAULT_LOOP_RESCUE_ATTEMPTS;
}

function buildLoopExhaustedReason(maxRescueAttempts: number) {
  if (maxRescueAttempts <= 1) {
    return LOOP_EXHAUSTED_REASON;
  }

  return `The same failure repeated after ${maxRescueAttempts} focused rescue attempts, so the run stopped to avoid a repeated-action loop.`;
}

function buildLoopRescueObservation(input: {
  details: string;
  maxRescueAttempts: number;
  rescueAttempt: number;
  summary: string;
}) {
  const { details, maxRescueAttempts, rescueAttempt, summary } = input;
  const compactSummary = compactSummaryText(summary, 420);
  const compactDetails = compactSummaryText(details, 1_600);
  const rescueLine = rescueAttempt >= maxRescueAttempts
    ? "This is the final automatic rescue attempt for this failure fingerprint."
    : `This is automatic rescue attempt ${rescueAttempt} of ${maxRescueAttempts} for this failure fingerprint.`;

  return {
    content: [
      "The same failure pattern repeated.",
      rescueLine,
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

function buildReadOnlyStallRescueObservation(
  state: RunDriveState,
  repeatedFingerprint: string,
) {
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
      `Failure code: REPEATED_ACTION.`,
      `Repeated action fingerprint: ${repeatedFingerprint}.`,
      `Forbidden repeated action: do not repeat this exact fingerprint again.`,
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
    error: {
      code: "REPEATED_ACTION" as const,
      fingerprint: repeatedFingerprint,
      message: summary,
      retryable: true,
      suggestedAction: {
        type: "blocker" as const,
        reason: "The same read-only action repeated without new evidence.",
        recoveryOptions: [
          "Use a different targeted read/search.",
          "Apply a focused edit from retained evidence.",
          "Return finish_candidate if the request is already satisfied.",
        ],
      },
    },
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

export function buildActionFingerprint(action: HeadlessModelAction): string {
  if (action.type === "tool_call") {
    return `tool_call:${action.tool}:${stableJson(action.args)}`;
  }

  if (action.type === "tool_calls") {
    return `tool_calls:${action.calls
      .map((call) => `${call.tool}:${stableJson(call.args)}`)
      .sort()
      .join("|")}`;
  }

  if (action.type === "finish_candidate") {
    return `finish_candidate:${compactSummaryText(action.summary, 300)}`;
  }

  if (action.type === "answer") {
    return `answer:${compactSummaryText(action.message, 300)}`;
  }

  return `model_validation:${compactSummaryText(action.validationError, 300)}`;
}

function getPreflightReadBeforeWritePaths(
  action: HeadlessToolCallAction,
  state: RunDriveState,
) {
  const readPaths = new Set(state.readSnapshots.map((snapshot) =>
    normalizeProjectPath(snapshot.path),
  ));

  return collectReadBeforeWriteTargetPaths(action)
    .map(normalizeProjectPath)
    .filter((path) => path && !readPaths.has(path));
}

function collectReadBeforeWriteTargetPaths(action: HeadlessToolCallAction) {
  if (!isRecord(action.args)) {
    return [];
  }

  if (
    (action.tool === "edit_file" || action.tool === "replace_file_range") &&
    typeof action.args.path === "string"
  ) {
    return [action.args.path];
  }

  if (action.tool === "delete_files" && Array.isArray(action.args.paths)) {
    return action.args.paths.filter((path): path is string => typeof path === "string");
  }

  return [];
}

function buildPreflightAutoReadObservation(
  action: HeadlessToolCallAction,
  paths: string[],
): AgentStructuredObservation {
  return {
    ok: true,
    tool: "runtime_preflight",
    summary: `Runtime preflight auto-reading before ${action.tool}: ${paths.join(", ")}`,
    error: {
      code: "MUST_READ_BEFORE_WRITE",
      message: `${action.tool} requires fresh file evidence before mutation.`,
      retryable: true,
      fingerprint: buildActionFingerprint(action),
      relatedFiles: paths,
      suggestedAction: {
        type: "tool_call",
        tool: "read_files",
        args: { paths },
        rationale: "Read target file contents before retrying the mutation.",
      },
    },
    evidence: {
      readFiles: paths.map((path) => ({ path })),
    },
  };
}

function buildPolicyDeniedObservation(
  run: AgentRun,
  action: HeadlessToolCallAction,
  reason: string,
): AgentStructuredObservation {
  const relatedFiles = collectTargetResources(action.args).map(normalizeProjectPath);

  return {
    ok: false,
    tool: "policy",
    summary: `Policy denied ${action.tool}: ${reason}`,
    error: {
      code: inferPolicyDeniedCode(reason),
      message: reason,
      retryable: true,
      fingerprint: buildActionFingerprint(action),
      relatedFiles,
      suggestedAction: inferPolicyDeniedSuggestedAction(run, action, reason),
    },
  };
}

function inferPolicyDeniedCode(reason: string): AgentFailureCode {
  if (/forbidden/i.test(reason)) {
    return "FORBIDDEN_PATH";
  }

  if (/outside|scope|allowed/i.test(reason)) {
    return "OUTSIDE_ALLOWED_PATH";
  }

  if (/approval/i.test(reason)) {
    return "APPROVAL_REQUIRED";
  }

  return "POLICY_DENIED";
}

function inferPolicyDeniedSuggestedAction(
  run: AgentRun,
  _action: HeadlessToolCallAction,
  reason: string,
): SuggestedAgentAction {
  if (
    run.contract.taskType === "answer" &&
    !run.contract.permissions.fileWrite &&
    /(write|edit|delete|file)/i.test(reason)
  ) {
    return {
      type: "revise_contract",
      reason: "The task is classified as answer/read-only but the attempted action needs file writes.",
      patch: {
        taskType: "component_edit",
        permissions: { fileWrite: true },
      },
    };
  }

  if (/approval/i.test(reason)) {
    return {
      type: "request_approval",
      reason,
    };
  }

  return {
    type: "blocker",
    reason,
    recoveryOptions: [
      "Choose a path inside allowed scope.",
      "Revise or expand the task contract/spec scope.",
      "Stop instead of retrying the denied action.",
    ],
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
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

  const code = classifyVerificationFailureCode(report);

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
    error: report.status === "passed"
      ? undefined
      : {
          code,
          fingerprint: buildFailureFingerprint(
            "verification",
            buildVerificationFailureDetails(report),
          ),
          message: failedOrMissing.slice(0, 3).join(" ") ||
            `Verification ${report.status}.`,
          retryable: true,
          suggestedAction: {
            type: "tool_call" as const,
            tool: "read_files",
            args: {
              paths: uniqueStrings(
                report.checks.flatMap((check) =>
                  extractLikelyFilePaths([
                    check.summary,
                    typeof check.details === "string" ? check.details : stringifyPayload(check.details),
                  ].join("\n")),
                ),
              ).slice(0, 4),
            },
            rationale: "Refresh files named in verifier diagnostics before repairing.",
          },
        },
    ok: report.status === "passed",
    summary: compactSummaryText(summary, 420),
    tool: "verification",
  };
}

function classifyVerificationFailureCode(report: VerificationReport): AgentFailureCode {
  const text = [
    ...report.newlyIntroducedFailures,
    ...report.missingEvidence,
    ...report.repairFeedback,
  ].join("\n");

  if (/expected file evidence/i.test(text)) {
    return "MISSING_EXPECTED_FILE_EVIDENCE";
  }

  if (/acceptance/i.test(text)) {
    return "MISSING_ACCEPTANCE_EVIDENCE";
  }

  if (/build/i.test(text)) {
    return /pre-existing/i.test(text)
      ? "BUILD_PREEXISTING_UNRELATED"
      : "BUILD_REGRESSION";
  }

  if (/preview/i.test(text)) {
    return /unavailable|did not produce/i.test(text)
      ? "PREVIEW_UNAVAILABLE"
      : "PREVIEW_REGRESSION";
  }

  return "UNKNOWN_RUNTIME_FAILURE";
}

function buildToolObservation(tool: string, result: ToolResult) {
  const structuredObservation = readStructuredObservation(result.structuredData);

  if (structuredObservation) {
    return {
      ...structuredObservation,
      tool: structuredObservation.tool ?? tool,
    };
  }

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
  consecutiveDriftFailures?: number;
  consecutiveModelValidationFailures?: number;
  externalEffects?: string[];
  expectedFileEvidenceAutoReadPaths?: string[];
  expectedFileEvidenceAutoVerifyKey?: string;
  finishSummary?: string;
  finishEvidence?: AgentFinishEvidence;
  loopGuard?: LoopGuardState;
  pendingEvidenceVerification?: PendingEvidenceVerificationState;
  pendingApprovalAction?: HeadlessToolCallAction;
  preflightAutoReadFingerprints?: string[];
  progressGuard?: ProgressGuardState;
  runContextSummary?: RunContextSummary;
  userPlan: unknown;
  workingState?: AgentWorkingState;
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
      consecutiveDriftFailures: state.consecutiveDriftFailures,
      consecutiveModelValidationFailures: state.consecutiveModelValidationFailures,
      externalEffects: state.externalEffects,
      expectedFileEvidenceAutoReadPaths: state.expectedFileEvidenceAutoReadPaths,
      expectedFileEvidenceAutoVerifyKey: state.expectedFileEvidenceAutoVerifyKey,
      finishSummary: state.finishSummary,
      finishEvidence: state.finishEvidence,
      loopGuard: state.loopGuard,
      pendingEvidenceVerification: state.pendingEvidenceVerification,
      pendingApprovalAction: state.pendingApprovalAction,
      preflightAutoReadFingerprints: state.preflightAutoReadFingerprints,
      progressGuard: state.progressGuard,
      runContextSummary: state.runContextSummary,
      workingState: state.workingState,
    },
  };
}

function buildCurrentWorkingState(
  run: AgentRun,
  state: RunDriveState,
): AgentWorkingState {
  const existing = state.workingState ?? createEmptyWorkingState(run.contract.objective);
  const latestStructuredFailure = [...state.observations]
    .reverse()
    .map(readStructuredObservation)
    .find((observation) => observation?.error);
  const currentBlocker = latestStructuredFailure?.error
    ? {
        code: latestStructuredFailure.error.code,
        message: latestStructuredFailure.error.message,
        fingerprint: latestStructuredFailure.error.fingerprint,
        suggestedAction: latestStructuredFailure.error.suggestedAction,
      }
    : existing.currentBlocker;

  return {
    ...existing,
    objective: run.contract.objective,
    currentBlocker,
    repeatedActionCount:
      state.progressGuard.repeatedReadOnlyActionCount ||
      existing.repeatedActionCount,
    evidence: {
      ...existing.evidence,
      readFiles: buildWorkingStateReadEvidence(state.readSnapshots),
      searches: uniqueWorkingSearches([
        ...existing.evidence.searches,
        ...collectStructuredSearches(state.observations),
      ]).slice(-40),
      diagnostics: uniqueWorkingDiagnostics([
        ...existing.evidence.diagnostics,
        ...collectStructuredDiagnostics(state.observations),
      ]).slice(-40),
      mutations: uniqueWorkingMutations([
        ...existing.evidence.mutations,
        ...[...state.changedFiles].map((path) => ({
          action: "edit",
          at: run.updatedAt,
          path,
          summary: "File changed during this run.",
        })),
        ...[...state.deletedFiles].map((path) => ({
          action: "delete",
          at: run.updatedAt,
          path,
          summary: "File deleted during this run.",
        })),
      ]).slice(-40),
    },
    nextStepHint: state.runContextSummary.nextStep,
  };
}

function buildWorkingStateReadEvidence(snapshots: AgentReadSnapshot[]) {
  const byPath = new Map<string, AgentWorkingState["evidence"]["readFiles"][number]>();

  for (const snapshot of snapshots) {
    const existing = byPath.get(snapshot.path);
    const range = {
      startLine: snapshot.startLine ?? 1,
      endLine: snapshot.endLine ?? Number.MAX_SAFE_INTEGER,
    };

    if (!existing) {
      byPath.set(snapshot.path, {
        path: snapshot.path,
        contentHash: snapshot.contentHash,
        ranges: [range],
        readAt: snapshot.readAt,
      });
      continue;
    }

    existing.ranges = mergeLineRanges([...existing.ranges, range]);
    if (snapshot.readAt > existing.readAt) {
      existing.readAt = snapshot.readAt;
      existing.contentHash = snapshot.contentHash;
    }
  }

  return [...byPath.values()].slice(-80);
}

function collectStructuredDiagnostics(
  observations: unknown[],
): AgentWorkingState["evidence"]["diagnostics"] {
  return observations.flatMap((observation) => {
    const structured = readStructuredObservation(observation);

    if (!structured?.error) {
      return [];
    }

    const at = new Date().toISOString();
    const diagnostics: AgentWorkingState["evidence"]["diagnostics"] =
      structured.error.diagnostics?.map((diagnostic) => ({
      source: "tool" as const,
      code: structured.error?.code,
      path: diagnostic.path,
      line: diagnostic.line,
      column: diagnostic.column,
      message: diagnostic.message,
      at,
    })) ?? [];

    return diagnostics.length > 0
      ? diagnostics
      : [{
          source: "runtime" as const,
          code: structured.error.code,
          message: structured.error.message,
          at,
        }];
  });
}

function collectStructuredSearches(
  observations: unknown[],
): AgentWorkingState["evidence"]["searches"] {
  return observations.flatMap((observation) => {
    const structured = readStructuredObservation(observation);
    const searches = structured?.evidence?.searches ?? [];
    const at = new Date().toISOString();

    return searches.map((search) => ({
      tool: search.tool,
      fingerprint: search.fingerprint,
      resultCount: search.resultCount,
      newPaths: search.newPaths,
      summary: search.summary,
      at,
    }));
  });
}

function uniqueWorkingSearches(
  searches: AgentWorkingState["evidence"]["searches"],
) {
  const byKey = new Map<string, AgentWorkingState["evidence"]["searches"][number]>();

  for (const search of searches) {
    byKey.set(`${search.tool}:${search.fingerprint}`, search);
  }

  return [...byKey.values()];
}

function readStructuredObservation(value: unknown): AgentStructuredObservation | null {
  const parsed = typeof value === "string" ? parseObservationRecord(value) : value;

  if (!isRecord(parsed)) {
    return null;
  }

  if (isRecord(parsed.structuredData)) {
    return readStructuredObservation(parsed.structuredData);
  }

  if (
    typeof parsed.ok === "boolean" &&
    typeof parsed.summary === "string" &&
    (
      typeof parsed.error === "undefined" ||
      (
        isRecord(parsed.error) &&
        typeof parsed.error.code === "string" &&
        typeof parsed.error.message === "string"
      )
    )
  ) {
    return parsed as AgentStructuredObservation;
  }

  if (typeof parsed.content === "string") {
    return readStructuredObservation(parsed.content);
  }

  return null;
}

function uniqueWorkingDiagnostics(
  diagnostics: AgentWorkingState["evidence"]["diagnostics"],
) {
  const seen = new Set<string>();

  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.source,
      diagnostic.code,
      diagnostic.path,
      diagnostic.line,
      diagnostic.column,
      diagnostic.message,
    ].join(":");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function uniqueWorkingMutations(
  mutations: AgentWorkingState["evidence"]["mutations"],
) {
  const seen = new Set<string>();

  return mutations.filter((mutation) => {
    const key = `${mutation.action}:${mutation.path}:${mutation.summary}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function mergeLineRanges(ranges: Array<{ endLine: number; startLine: number }>) {
  const sorted = ranges
    .filter((range) => range.startLine > 0 && range.endLine >= range.startLine)
    .sort((left, right) => left.startLine - right.startLine);
  const merged: Array<{ endLine: number; startLine: number }> = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];

    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
      continue;
    }

    previous.endLine = Math.max(previous.endLine, range.endLine);
  }

  return merged;
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
    consecutiveDriftFailures: readNonNegativeInteger(
      metadataRecord.consecutiveDriftFailures,
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
    finishEvidence: readFinishEvidence(metadataRecord.finishEvidence),
    loopGuard: readLoopGuardState(metadataRecord.loopGuard),
    pendingEvidenceVerification: readPendingEvidenceVerificationState(
      metadataRecord.pendingEvidenceVerification,
    ),
    pendingApprovalAction: isHeadlessToolCallAction(metadataRecord.pendingApprovalAction)
      ? metadataRecord.pendingApprovalAction
      : undefined,
    preflightAutoReadFingerprints: readOptionalStringArray(
      metadataRecord.preflightAutoReadFingerprints,
    ),
    progressGuard: readProgressGuardState(metadataRecord.progressGuard),
    runContextSummary: readRunContextSummary(metadataRecord.runContextSummary),
    workingState: readWorkingState(metadataRecord.workingState),
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

function readFinishEvidence(value: unknown): AgentFinishEvidence | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return normalizeFinishEvidence({
    readFiles: readOptionalStringArray(value.readFiles),
    changedFiles: readOptionalStringArray(value.changedFiles),
    noOpReason:
      typeof value.noOpReason === "string" ? value.noOpReason : undefined,
    acceptanceEvidence: Array.isArray(value.acceptanceEvidence)
      ? value.acceptanceEvidence
          .filter(isRecord)
          .map((item) => ({
            criterionId:
              typeof item.criterionId === "string" ? item.criterionId : "",
            evidence: typeof item.evidence === "string" ? item.evidence : "",
          }))
      : undefined,
  });
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
    rescueCount: readNonNegativeInteger(value.rescueCount),
    repeatedCount: readNonNegativeInteger(value.repeatedCount),
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
    observedDiagnosticFingerprints:
      readOptionalStringArray(value.observedDiagnosticFingerprints) ?? [],
    observedReadEvidenceFingerprints:
      readOptionalStringArray(value.observedReadEvidenceFingerprints) ?? [],
    observedSearchEvidenceFingerprints:
      readOptionalStringArray(value.observedSearchEvidenceFingerprints) ?? [],
    lastReadOnlyActionFingerprint:
      typeof value.lastReadOnlyActionFingerprint === "string"
        ? value.lastReadOnlyActionFingerprint
        : undefined,
    readOnlyRescuedFingerprint:
      typeof value.readOnlyRescuedFingerprint === "string"
        ? value.readOnlyRescuedFingerprint
        : undefined,
    readOnlyNoProgressCount:
      readNonNegativeInteger(value.readOnlyNoProgressCount) ?? 0,
    repeatedReadOnlyActionCount:
      readNonNegativeInteger(value.repeatedReadOnlyActionCount) ?? 0,
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

function readWorkingState(value: unknown): AgentWorkingState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const fallback = createEmptyWorkingState(
    typeof value.objective === "string" ? value.objective : "",
  );
  const evidence = isRecord(value.evidence) ? value.evidence : {};

  return {
    objective:
      typeof value.objective === "string" ? value.objective : fallback.objective,
    currentBlocker: readWorkingStateBlocker(value.currentBlocker),
    lastActionFingerprint:
      typeof value.lastActionFingerprint === "string"
        ? value.lastActionFingerprint
        : undefined,
    repeatedActionCount:
      readNonNegativeInteger(value.repeatedActionCount) ?? 0,
    evidence: {
      readFiles: readWorkingStateArray(evidence.readFiles),
      searches: readWorkingStateArray(evidence.searches),
      diagnostics: readWorkingStateArray(evidence.diagnostics),
      mutations: readWorkingStateArray(evidence.mutations),
      acceptanceEvidence: readWorkingStateArray(evidence.acceptanceEvidence),
    },
    nextStepHint:
      typeof value.nextStepHint === "string" ? value.nextStepHint : undefined,
  };
}

function readWorkingStateBlocker(value: unknown): AgentWorkingState["currentBlocker"] {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    return undefined;
  }

  return {
    code: value.code as AgentFailureCode,
    message: value.message,
    fingerprint:
      typeof value.fingerprint === "string" ? value.fingerprint : undefined,
    suggestedAction: isRecord(value.suggestedAction)
      ? value.suggestedAction as SuggestedAgentAction
      : undefined,
  };
}

function readWorkingStateArray(value: unknown): never[] {
  return Array.isArray(value) ? value as never[] : [];
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

function isApprovalExpired(approval: AgentApproval, now: string) {
  const expiresAtMs = new Date(approval.expiresAt).getTime();
  const nowMs = new Date(now).getTime();

  return Number.isNaN(expiresAtMs) ||
    Number.isNaN(nowMs) ||
    expiresAtMs <= nowMs;
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
