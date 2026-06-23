import type {
  AgentApproval,
  AgentApprovalDecision,
  AgentEvent,
  AgentReadSnapshot,
  AgentRun,
  AgentRunCheckpoint,
  TaskContract,
  ToolResult,
  VerificationReport,
} from "../types";
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
    };

export type RunContextBundle = {
  observations: string[];
  run: AgentRun;
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
    packageChanged: boolean;
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
  listApprovedHashes(runId: string): Promise<Set<string>>;
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
  clock: ClockPort;
};

export type StartRunInput = {
  baselineCommandResults?: Record<string, unknown>;
  baselinePackageJson?: string | null;
  baselineArtifactId?: string;
  contract: TaskContract;
  conversationId: string;
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
  finishSummary?: string;
  latestReportId?: string;
  observations: unknown[];
  packageChanged: boolean;
  pendingApprovalAction?: HeadlessToolCallAction;
  plan: unknown;
  readSnapshots: AgentRunCheckpoint["readSnapshots"];
  repairFeedback: string[];
  steeringWatermark: number;
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
    await this.saveCheckpoint(
      run,
      createEmptyDriveState({
        baselineArtifactId: input.baselineArtifactId,
        baselineCommandResults: input.baselineCommandResults,
        baselinePackageJson: input.baselinePackageJson,
      }),
      "run-started",
    );

    return this.drive(run, signal);
  }

  async resume(runId: string, signal?: AbortSignal): Promise<AgentRun> {
    const loaded = await this.ports.runStore.get(runId);

    if (!loaded) {
      throw new Error(`Run ${runId} was not found.`);
    }

    let run = loaded;

    let restoredState: RunDriveState | undefined;

    if (run.status === "paused") {
      run = await this.commit(run, this.machine.transition(run, { type: "resume" }));
    } else if (run.status === "waiting_approval") {
      const resumedApproval = await this.resumeApproval(run, signal);
      run = resumedApproval.run;
      restoredState = resumedApproval.state;
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

      const context = await this.compileContext(run, state);
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

  private async executeToolAction(
    run: AgentRun,
    action: Extract<HeadlessModelAction, { type: "tool_call" }>,
    state: RunDriveState,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    const tool = getCoreToolDefinition(action.tool);

    if (!tool) {
      await this.ports.eventStore.append({
        runId: run.id,
        type: "tool.failed",
        timestamp: this.ports.clock.now(),
        payload: { reason: `Unknown tool ${action.tool}.`, tool: action.tool },
      });
      return run;
    }

    validateCoreToolInput(action.tool, action.args);

    run = await this.enforceBudget(run, "maxToolCalls", run.toolCalls);

    if (isTerminalAgentRunStatus(run.status)) {
      await this.saveCheckpoint(run, state, "tool-budget-exceeded");
      return run;
    }

    if (!tool.readOnly) {
      run = await this.enforceBudget(run, "maxMutations", run.mutationCount);

      if (isTerminalAgentRunStatus(run.status)) {
        await this.saveCheckpoint(run, state, "mutation-budget-exceeded");
        return run;
      }
    }

    const approvedHashes = await this.ports.approvals.listApprovedHashes(run.id);
    const policyDecision = this.policy.evaluate({
      approvedHashes,
      args: action.args,
      run,
      tool,
    });

    if (!policyDecision.allowed) {
      await this.ports.eventStore.append({
        runId: run.id,
        type: "policy.denied",
        timestamp: this.ports.clock.now(),
        payload: { reason: policyDecision.reason, tool: action.tool },
      });
      return run;
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

    const startedAt = this.ports.clock.now();
    await this.ports.eventStore.append({
      runId: run.id,
      type: "tool.started",
      timestamp: startedAt,
      payload: { tool: action.tool },
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

    for (const path of changed) {
      state.changedFiles.add(path);
    }

    for (const path of deleted) {
      state.changedFiles.add(path);
      state.deletedFiles.add(path);
    }

    state.packageChanged ||= result.workspaceEffects?.packageChanged === true;
    state.readSnapshots = result.workspaceEffects?.readSnapshots ?? state.readSnapshots;

    const mutationDelta = !tool.readOnly && changed.length + deleted.length > 0 ? 1 : 0;
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
          packageChanged: state.packageChanged,
          status: result.status,
          summary: result.summary,
          tool: action.tool,
        },
      },
    );
    state.observations.push(result.structuredData ?? result.summary);
    await this.saveCheckpoint(nextRun, state, "tool-completed");

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

    const approvedHashes = await this.ports.approvals.listApprovedHashes(run.id);

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

      for (const path of changed) {
        state.changedFiles.add(path);
      }

      for (const path of deleted) {
        state.changedFiles.add(path);
        state.deletedFiles.add(path);
      }

      state.packageChanged ||= result.workspaceEffects?.packageChanged === true;
      state.readSnapshots = result.workspaceEffects?.readSnapshots ?? state.readSnapshots;
      state.observations.push(result.structuredData ?? result.summary);

      await this.ports.eventStore.append({
        artifactIds: result.artifactIds,
        runId: run.id,
        type: result.status === "success" ? "tool.completed" : "tool.failed",
        timestamp: this.ports.clock.now(),
        payload: {
          batch: true,
          deletedFiles: deleted,
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
    await this.saveCheckpoint(nextRun, state, "tool-batch-completed");

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
      packageChanged: state.packageChanged,
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

    if (report.status === "passed") {
      const nextRun = await this.commit(
        run,
        this.machine.transition(run, {
          type: options.final ? "verification_passed" : "verification_passed_continue",
          report,
        }),
      );
      await this.saveCheckpoint(
        nextRun,
        state,
        options.final ? "verification-passed" : "verification-passed-continue",
      );
      return nextRun;
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
  ): Promise<{ run: AgentRun; state?: RunDriveState }> {
    const unresolved = await this.ports.approvals.getLatestUnresolved(run.id);

    if (unresolved && isApprovalExpired(unresolved, this.ports.clock.now())) {
      const state = await this.restoreCheckpoint(run);
      await this.ports.approvals.resolve(
        run.id,
        unresolved.id,
        "expired",
        this.ports.clock.now(),
      );
      state.pendingApprovalAction = undefined;
      state.observations.push(
        "Previous approval expired. Request a new approval if the action is still needed.",
      );
      const nextRun = await this.commit(
        run,
        this.machine.transition(run, {
          approvalId: unresolved.id,
          type: "approval_expired",
        }),
      );
      await this.saveCheckpoint(nextRun, state, "approval-expired");
      return { run: nextRun, state };
    }

    if (unresolved ?? await this.ports.approvals.getPending(run.id)) {
      return { run };
    }

    const resolved = await this.ports.approvals.getLatestResolved(run.id);

    if (!resolved) {
      return { run };
    }

    const state = await this.restoreCheckpoint(run);

    if (resolved.decision === "approved") {
      let nextRun = await this.commit(
        run,
        this.machine.transition(run, {
          type: "approval_granted",
          approvalId: resolved.id,
        }),
      );
      await this.saveCheckpoint(nextRun, state, "approval-approved");

      const approvedAction = state.pendingApprovalAction;
      state.pendingApprovalAction = undefined;

      if (!approvedAction) {
        state.observations.push("Approved action was not found in the latest checkpoint.");
        return { run: nextRun, state };
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
        return { run: nextRun, state };
      }

      nextRun = await this.executeToolAction(nextRun, approvedAction, state, signal);
      return { run: nextRun, state };
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
    return { run: nextRun, state };
  }

  private async compileContext(
    run: AgentRun,
    state: RunDriveState,
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

    return {
      observations: state.observations.map(stringifyPayload),
      run,
      steering,
      workspaceFingerprint: await this.ports.workspace.fingerprint(),
    };
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

  private async restoreCheckpoint(run: AgentRun): Promise<RunDriveState> {
    const checkpoint = await this.ports.checkpoints.getLatest(run.id);

    if (!checkpoint) {
      return createEmptyDriveState();
    }

    const currentFingerprint = await this.ports.workspace.fingerprint();

    const readSnapshots =
      checkpoint.workspaceFingerprint === currentFingerprint
        ? [...checkpoint.readSnapshots]
        : await this.validateReadSnapshots(checkpoint.readSnapshots);

    const metadata = readRunDriveStateMetadata(checkpoint.plan);

    return {
      answerMessage: metadata.answerMessage,
      baselineArtifactId: metadata.baselineArtifactId,
      baselineCommandResults: metadata.baselineCommandResults,
      baselinePackageJson: metadata.baselinePackageJson ?? checkpoint.packageBaselineJson,
      changedFiles: new Set(checkpoint.changedFiles),
      deletedFiles: new Set(checkpoint.deletedFiles),
      finishSummary: metadata.finishSummary,
      latestReportId: checkpoint.latestReportId,
      observations: [...checkpoint.observations],
      packageChanged: checkpoint.packageChanged,
      pendingApprovalAction: metadata.pendingApprovalAction,
      plan: metadata.userPlan,
      readSnapshots,
      repairFeedback: [...checkpoint.repairFeedback],
      steeringWatermark: checkpoint.steeringWatermark,
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
  > = {},
): RunDriveState {
  return {
    baselineArtifactId: initial.baselineArtifactId,
    baselineCommandResults: initial.baselineCommandResults,
    baselinePackageJson: initial.baselinePackageJson,
    changedFiles: new Set(),
    deletedFiles: new Set(),
    finishSummary: undefined,
    observations: [],
    packageChanged: false,
    plan: null,
    readSnapshots: [],
    repairFeedback: [],
    steeringWatermark: 0,
  };
}

type CheckpointDriveStateMetadata = {
  answerMessage?: string;
  baselineArtifactId?: string;
  baselineCommandResults?: Record<string, unknown>;
  baselinePackageJson?: string | null;
  finishSummary?: string;
  pendingApprovalAction?: HeadlessToolCallAction;
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
      finishSummary: state.finishSummary,
      pendingApprovalAction: state.pendingApprovalAction,
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
    finishSummary:
      typeof metadataRecord.finishSummary === "string"
        ? metadataRecord.finishSummary
        : undefined,
    pendingApprovalAction: isHeadlessToolCallAction(metadataRecord.pendingApprovalAction)
      ? metadataRecord.pendingApprovalAction
      : undefined,
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
  return new Date(approval.expiresAt).getTime() <= new Date(now).getTime();
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
