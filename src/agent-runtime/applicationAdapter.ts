import {
  formatProjectFileTree,
  getContextFilePaths,
  requestAgentStep,
  requestProjectGeneration,
  type AgentObservation,
  type AgentStepResponse,
  type AgentToolCallStep,
} from "../agent/projectModifier";
import {
  buildProjectBackendContext,
  hasBackendIntent,
} from "../agent/project/backendContext";
import { buildDynamicAgentContext } from "../agent/project/memory";
import { AgentVerifier, type BaselineCommandResults } from "../agent-core/verifier/verifier";
import { compileTaskContract } from "../agent-core/contract/taskContract";
import {
  RunController,
  type HeadlessModelAction,
  readRunDriveStateMetadata,
  type RunContextBundle,
  type RunControllerPorts,
} from "../agent-core/runtime/runController";
import { isTerminalAgentRunStatus, RunStateMachine } from "../agent-core/runtime/runStateMachine";
import type {
  AgentApproval,
  AgentEvent,
  AgentRun,
  PreviewVerificationSession,
  ToolResult,
  VerificationReport,
} from "../agent-core/types";
import { getCoreToolDefinition } from "../agent-core/tools/toolRegistry";
import { addStableNodeIdsToGeneratedFiles, ensureSiteIndex, refreshSiteIndex } from "../adapters/siteIrAdapter";
import { keyStore } from "../services/keyStore";
import { getAiProviderDefinition } from "../services/aiProviders";
import {
  getProjectErrorMessage,
  projectApi,
  type FileTree,
  type ProjectInfo,
} from "../services/projects";
import { agentRuntimeApi } from "../services/agentRuntime";
import { appendLogs } from "../store/commandLogs";
import { persistCurrentConversation } from "../store/conversationState";
import {
  appendAssistantMessage,
  appendTerminalLog,
  startStreamingAgentMessage,
  updateAgentStatus,
  type AgentStreamController,
} from "../store/agentUi";
import {
  createAgentRunState,
  ensureCurrentProject,
  executeAgentTool,
  type AgentRunState,
} from "../store/agentToolExecutor";
import type { StoreAccess } from "../store/storeAccess";
import {
  createRunAbortController,
  releaseRunAbortController,
} from "./agentRunControl";

type ApplicationRuntimeMode = "generate" | "modify";

type RunApplicationRuntimeInput = {
  existingRun?: AgentRun;
  mode: ApplicationRuntimeMode;
  project: ProjectInfo;
  resumeObservation?: AgentObservation;
  store: StoreAccess;
  userRequest: string;
};

type RuntimeSessionState = {
  baselineArtifactId?: string;
  baselineCommandResults?: BaselineCommandResults;
  baselinePackageJson?: string | null;
  generationActionQueued: boolean;
  observationStep: number;
  runState: AgentRunState;
  statusLines: string[];
};

export async function generateInitialProjectRuntime(
  store: StoreAccess,
  project: ProjectInfo,
  projectPrompt: string,
) {
  return runApplicationRuntime({
    mode: "generate",
    project,
    store,
    userRequest: projectPrompt,
  });
}

export async function modifyCurrentProjectRuntime(
  store: StoreAccess,
  userRequest: string,
  options: { existingRun?: AgentRun; resumeObservation?: AgentObservation } = {},
) {
  const project = store.get().currentProject;

  if (!project) {
    appendAssistantMessage(
      store,
      "Create or select a project first, then describe what to build.",
    );
    return false;
  }

  return runApplicationRuntime({
    existingRun: options.existingRun,
    mode: "modify",
    project,
    resumeObservation: options.resumeObservation,
    store,
    userRequest,
  });
}

async function runApplicationRuntime(input: RunApplicationRuntimeInput) {
  const { existingRun, mode, project, store, userRequest } = input;
  const stream = startStreamingAgentMessage(
    store,
    mode === "generate"
      ? `Generating ${project.name} with the headless runtime`
      : "Working with the headless runtime",
  );
  const controllerRunId = existingRun?.id ?? createRuntimeId("run");
  const runAbortController = createRunAbortController(controllerRunId);
  const session: RuntimeSessionState = {
    generationActionQueued: false,
    observationStep: 1,
    runState: createAgentRunState(),
    statusLines: [],
  };
  let finalRun: AgentRun | null = null;
  const contract = existingRun
    ? existingRun.contract
    : compileTaskContract({
        objective: userRequest,
        selectedSiteNodeId: store.get().selectedSiteNodeId,
        taskType: mode === "generate" ? "full_site" : undefined,
      });

  store.set((state) => ({
    isGeneratingProject: mode === "generate",
    isModifyingProject: mode === "modify",
    projectError: null,
    terminalLogs: appendLogs(state.terminalLogs, [
      `[agent] Starting headless runtime for ${project.name}`,
    ]),
  }));

  try {
    ensureCurrentProject(store, project.id);
    await ensureFileTree(store, project);
    await ensureSiteIndex(project, store.get().fileTree);

    if (existingRun) {
      await restoreAdapterState(project, existingRun, session);
      store.set({ currentAgentRun: existingRun });
    } else {
      const baseline = contract.taskType === "answer"
        ? createEmptyBaseline()
        : await captureBaseline(store, project);
      session.baselineCommandResults = baseline.commandResults;
      session.baselinePackageJson = baseline.packageJson;
    }

    if (input.resumeObservation) {
      session.observationStep += 1;
    }

    const ports = createApplicationPorts({
      mode,
      project,
      session,
      store,
      stream,
      userRequest,
    });
    const controller = new RunController(ports);

    finalRun = existingRun
      ? await controller.resume(existingRun.id, runAbortController.signal)
      : await controller.start(
          {
            baselineArtifactId: session.baselineArtifactId,
            baselineCommandResults: session.baselineCommandResults,
            baselinePackageJson: session.baselinePackageJson,
            contract,
            conversationId: store.get().currentConversation?.id ?? "conversation-default",
            projectId: project.id,
            runId: controllerRunId,
          },
          runAbortController.signal,
        );

    await completeStreamForRun(project.id, store, stream, finalRun);
    void persistCurrentConversation(store);
    return finalRun.status === "completed";
  } catch (error) {
    const message = getProjectErrorMessage(error);
    const cleanupResult = await cleanupRunAfterRuntimeError({
      message,
      projectId: project.id,
      runId: controllerRunId,
      signalAborted: runAbortController.signal.aborted,
      store,
    });
    const cleanupMessage = cleanupResult.message;

    if (cleanupResult.run?.status === "cancelled") {
      stream.completeWithTypewriter("Run cancelled.");
      void persistCurrentConversation(store);
      store.set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [
          `[agent] Run ${cleanupResult.run?.id ?? controllerRunId} cancelled.`,
        ]),
      }));
      return false;
    }

    stream.failWithTypewriter(`Agent run failed: ${cleanupMessage}`);
    void persistCurrentConversation(store);
    store.set((state) => ({
      projectError: cleanupMessage,
      terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${cleanupMessage}`]),
    }));
    return false;
  } finally {
    if (finalRun) {
      releaseRunAbortController(finalRun.id);
    } else {
      releaseRunAbortController(controllerRunId);
    }

    store.set({
      isGeneratingProject: false,
      isModifyingProject: false,
      previewVerificationSession: null,
    });
  }
}

function createApplicationPorts({
  mode,
  project,
  session,
  store,
  stream,
  userRequest,
}: {
  mode: ApplicationRuntimeMode;
  project: ProjectInfo;
  session: RuntimeSessionState;
  store: StoreAccess;
  stream: AgentStreamController;
  userRequest: string;
}): RunControllerPorts {
  return {
    approvals: createApprovalPort(project.id, store),
    artifacts: {
      write: async ({ content, relativePath, runId }) => {
        const artifact = await agentRuntimeApi.writeArtifact(
          project.id,
          runId,
          relativePath,
          content,
        );
        return artifact.id;
      },
    },
    checkpoints: {
      getLatest: (runId) => agentRuntimeApi.getLatestCheckpoint(project.id, runId),
      save: (checkpoint) => agentRuntimeApi.saveCheckpoint(project.id, checkpoint),
    },
    clock: {
      now: () => new Date().toISOString(),
    },
    eventStore: {
      append: async (event) => {
        const record = await agentRuntimeApi.appendEvent(project.id, event);
        store.set((state) => ({ agentEvents: [...state.agentEvents, record] }));
        return record;
      },
      list: (runId) => agentRuntimeApi.listEvents(project.id, runId),
    },
    model: {
      next: (context, signal) =>
        nextModelAction({
          context,
          mode,
          project,
          session,
          signal,
          store,
          stream,
          userRequest,
        }),
    },
    runStore: {
      create: async (run) => {
        const created = await agentRuntimeApi.createRun(project.id, run);
        await writeBaselineArtifact(project.id, created.id, session);
        const events = await agentRuntimeApi.listEvents(project.id, created.id);
        store.set((state) => ({
          agentEvents: events,
          agentRuns: [created, ...state.agentRuns.filter((item) => item.id !== created.id)],
          currentAgentRun: created,
        }));
        return created;
      },
      get: (runId) => agentRuntimeApi.getRun(project.id, runId),
      recordProgress: async (previousRun, patch, event) => {
        const nextRun: AgentRun = {
          ...previousRun,
          ...patch,
          updatedAt: event.timestamp,
        };
        const { run, event: record } = await agentRuntimeApi.recordProgress(
          project.id,
          previousRun,
          nextRun,
          event,
        );
        projectRunToStore(store, run, record);
        return run;
      },
      transition: async (previousRun, result) => {
        const { run, event } = await agentRuntimeApi.transitionRun(
          project.id,
          previousRun,
          result,
        );
        projectRunToStore(store, run, event);
        return run;
      },
    },
    tools: {
      execute: ({ args, signal, tool }) =>
        executeToolPort({
          args,
          project,
          session,
          signal,
          store,
          stream,
          tool,
        }),
    },
    verifier: {
      verify: async (verificationInput) => {
        const report = await verifyRunPort({
          input: verificationInput,
          project,
          session,
          store,
          stream,
        });
        store.set({ currentVerificationReport: report });
        await agentRuntimeApi.saveVerificationReport(project.id, report);
        return report;
      },
    },
    workspace: {
      fingerprint: () => computeWorkspaceFingerprint(project),
      validateReadSnapshots: (snapshots) =>
        validateReadSnapshotsForProject(project, snapshots),
    },
  };
}

async function nextModelAction({
  context,
  mode,
  project,
  session,
  signal,
  store,
  stream,
  userRequest,
}: {
  context: RunContextBundle;
  mode: ApplicationRuntimeMode;
  project: ProjectInfo;
  session: RuntimeSessionState;
  signal?: AbortSignal;
  store: StoreAccess;
  stream: AgentStreamController;
  userRequest: string;
}): Promise<HeadlessModelAction> {
  const config = await keyStore.getAiProviderConfig();

  if (!config) {
    throw new Error("Configure your AI provider first.");
  }

  const provider = getAiProviderDefinition(config.provider);
  appendTerminalLog(store, `[agent] Using ${provider.label} model ${config.model}`);

  if (await shouldGenerateProject(store, mode, session)) {
    session.generationActionQueued = true;
    updateAgentStatus(stream, session.statusLines, "Generating initial project files.");
    const backendContext = await buildProjectBackendContext(project.id, {
      includeSchema: hasBackendIntent(userRequest),
    });
    const response = await requestProjectGeneration({
      backendContext,
      config,
      onDelta: stream.onModelDelta,
      projectName: project.name,
      signal,
      userPrompt: userRequest,
    });

    return {
      type: "tool_call",
      tool: "write_files",
      args: {
        files: addStableNodeIdsToGeneratedFiles(response.files),
        summary: response.summary,
      },
      rationale: "Initial project generation is represented as a write_files tool call.",
    };
  }

  const agentContext = await buildAgentStepContext({
    context,
    project,
    session,
    store,
    userRequest,
  });
  updateAgentStatus(
    stream,
    session.statusLines,
    `Planning step ${context.run.modelTurns + 1}.`,
  );
  const step = await requestAgentStep({
    config,
    context: agentContext,
    onDelta: stream.onModelDelta,
    signal,
    userRequest,
  });

  return mapAgentStepToHeadlessAction(step);
}

async function shouldGenerateProject(
  store: StoreAccess,
  mode: ApplicationRuntimeMode,
  session: RuntimeSessionState,
) {
  if (session.generationActionQueued) {
    return false;
  }

  if (mode === "generate") {
    return true;
  }

  const fileTree = store.get().fileTree;
  return !fileTree || getContextFilePaths(fileTree).length === 0;
}

function mapAgentStepToHeadlessAction(step: AgentStepResponse): HeadlessModelAction {
  if (step.type === "tool_calls") {
    return {
      type: "tool_calls",
      calls: step.calls.map((call) => ({
        args: call.args,
        rationale: call.rationale,
        tool: call.tool,
        type: "tool_call" as const,
      })),
      rationale: step.rationale,
    };
  }

  return step;
}

async function executeToolPort({
  args,
  project,
  session,
  signal,
  store,
  stream,
  tool,
}: {
  args: unknown;
  project: ProjectInfo;
  session: RuntimeSessionState;
  signal?: AbortSignal;
  store: StoreAccess;
  stream: AgentStreamController;
  tool: string;
}): Promise<ToolResult> {
  if (signal?.aborted) {
    return {
      artifactIds: [],
      retryable: false,
      status: "cancelled",
      summary: `${tool} cancelled before it started.`,
    };
  }

  const step = {
    args,
    rationale: "",
    tool,
    type: "tool_call",
  } as AgentToolCallStep;
  const definition = getCoreToolDefinition(tool);
  const activityId = stream.addActivity({
    detail: definition?.description,
    kind: definition?.readOnly ? "tool" : "file",
    title: tool,
  });
  const result = await executeAgentTool(
    store,
    project,
    step,
    session.observationStep,
    session.runState,
  );
  session.observationStep += 1;

  if (result.didChangeFiles) {
    await refreshProjectStateAfterWrite(store, project);
  }

  stream.updateActivity(activityId, {
    detail: result.observation.summary,
    error: result.observation.ok ? undefined : result.observation.content,
    finishActivity: true,
    status: result.observation.ok ? "succeeded" : "failed",
  });

  return {
    artifactIds: [],
    retryable: !result.observation.ok,
    status: result.observation.ok ? "success" : "domain_error",
    structuredData: result.observation,
    summary: result.observation.summary,
    workspaceEffects: {
      changedFiles: result.didChangeFiles ? result.changedFiles ?? [] : [],
      deletedFiles: result.didChangeFiles ? result.deletedFiles ?? [] : [],
      packageChanged: result.didChangePackage === true,
      readSnapshots: collectReadSnapshots(session.runState),
    },
  };
}

async function verifyRunPort({
  input,
  project,
  session,
  store,
  stream,
}: {
  input: {
    answerMessage?: string;
    baselineCommandResults?: Record<string, unknown>;
    baselinePackageJson?: string | null;
    changedFiles: string[];
    deletedFiles: string[];
    packageChanged: boolean;
    run: AgentRun;
  };
  project: ProjectInfo;
  session: RuntimeSessionState;
  store: StoreAccess;
  stream: AgentStreamController;
}) {
  updateAgentStatus(stream, session.statusLines, "Running verifier.");
  const activityId = stream.addActivity({
    kind: "verification",
    title: "Verification",
  });
  const verifier = new AgentVerifier({
    httpProbe: (url) => projectApi.probePreviewUrl(url),
    readFile: (path) => projectApi.readFile(project.id, path),
    readSiteSpec: () => agentRuntimeApi.readSiteSpec(project.id),
    recordArtifact: async ({ content, relativePath, runId }) => {
      const artifact = await agentRuntimeApi.writeArtifact(
        project.id,
        runId,
        relativePath,
        content,
      );
      return artifact.id;
    },
    runCommand: (command) => runVerifierCommand(store, project, command),
    startPreview: async () => {
      await store.get().startDevServer(project.id);
      return store.get().previewUrl;
    },
    waitForPreviewDiagnostics: (previewInput) =>
      collectSessionPreviewDiagnostics(store, previewInput),
  });
  const approvedDeletionPaths = await loadApprovedDeletionPaths(project.id, input.run.id);
  const approvedPackageChangeKeys = await loadApprovedPackageChangeKeys(project.id, input.run.id);
  const report = await verifier.verify({
    answerMessage: input.answerMessage,
    approvedDeletionPaths,
    approvedPackageChangeKeys,
    baselineCommandResults:
      (input.baselineCommandResults as BaselineCommandResults | undefined) ??
      session.baselineCommandResults,
    baselinePackageJson: input.baselinePackageJson ?? session.baselinePackageJson,
    changedFiles: input.changedFiles,
    deletedFiles: input.deletedFiles,
    packageChanged: input.packageChanged,
    previewUrl: store.get().previewUrl,
    run: input.run,
  });

  stream.updateActivity(activityId, {
    detail: formatVerificationSummary(report),
    error: report.status === "passed" ? undefined : formatVerificationFailure(report),
    finishActivity: true,
    status: report.status === "passed" ? "succeeded" : "failed",
  });
  return report;
}

async function buildAgentStepContext({
  context,
  project,
  session,
  store,
  userRequest,
}: {
  context: RunContextBundle;
  project: ProjectInfo;
  session: RuntimeSessionState;
  store: StoreAccess;
  userRequest: string;
}) {
  const state = store.get();
  const recentMessages = (state.currentConversation?.messages ?? [])
    .filter((message) => message.id !== "welcome" && !message.isStreaming)
    .slice(-8)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));
  const backendIntentText = [
    userRequest,
    ...recentMessages.map((message) => message.content),
  ].join("\n");
  const backendContext = await buildProjectBackendContext(project.id, {
    includeSchema: hasBackendIntent(backendIntentText),
  });
  const observations = context.observations.map((item, index) =>
    toAgentObservation(item, index + 1),
  );
  const dynamicContext = await buildDynamicAgentContext({
    changeHistory: state.changeHistory,
    fileTree: state.fileTree,
    observations,
    project,
    readFiles: Array.from(session.runState.readFiles.values()),
    recentMessages,
    userRequest,
  });
  const siteSpec = await agentRuntimeApi.readSiteSpec(project.id);

  return {
    backend: backendContext,
    diagnostics: buildAgentDiagnostics(state.projectError, state.terminalLogs),
    devServerStatus: state.devServerStatus,
    fileTree: state.fileTree ? formatProjectFileTree(state.fileTree) : null,
    memory: {
      ...dynamicContext.memory,
      selectedSiteNodeId: state.selectedSiteNodeId,
      siteSpecPages: siteSpec?.pages.map((page) => ({
        id: page.id,
        route: page.route,
        title: page.title,
      })),
    },
    observations: dynamicContext.observations,
    previewUrl: state.previewUrl,
    projectName: project.name,
    recentMessages,
    steering: context.steering,
    taskLedger: {
      ...dynamicContext.taskLedger,
      objective: context.run.contract.objective,
    },
    workingSummary: dynamicContext.workingSummary,
  };
}

function createApprovalPort(
  projectId: string,
  store: StoreAccess,
): RunControllerPorts["approvals"] {
  return {
    create: async (approval) => {
      const created = await agentRuntimeApi.createApproval(projectId, approval);
      const run = await agentRuntimeApi.getRun(projectId, created.runId);
      const events = await agentRuntimeApi.listEvents(projectId, created.runId);
      store.set((state) => ({
        agentEvents: events,
        agentRuns: run
          ? [run, ...state.agentRuns.filter((item) => item.id !== run.id)]
          : state.agentRuns,
        currentAgentApproval: created,
        currentAgentRun: run ?? state.currentAgentRun,
      }));
      return created;
    },
    getLatestResolved: async (runId) => {
      const approvals = await agentRuntimeApi.listApprovals(projectId, runId);
      return [...approvals]
        .reverse()
        .find((approval) => approval.decision && approval.resolvedAt) ?? null;
    },
    getLatestUnresolved: async (runId) => {
      const approvals = await agentRuntimeApi.listApprovals(projectId, runId);
      return [...approvals]
        .reverse()
        .find((approval) => !approval.decision && !approval.resolvedAt) ?? null;
    },
    getPending: (runId) => agentRuntimeApi.getPendingApproval(projectId, runId),
    listApprovedHashes: async (runId) => {
      const approvals = await agentRuntimeApi.listApprovals(projectId, runId);
      return new Set(
        approvals
          .filter(
            (approval) =>
              approval.decision === "approved" &&
              approval.resolvedAt &&
              wasResolvedBeforeExpiry(approval),
          )
          .map((approval) => approval.normalizedArgsHash),
      );
    },
    resolve: async (runId, approvalId, decision, resolvedAt) => {
      const resolved = await agentRuntimeApi.resolveApproval(
        projectId,
        runId,
        approvalId,
        decision,
        resolvedAt,
      );
      store.set((state) => ({
        currentAgentApproval:
          state.currentAgentApproval?.id === approvalId
            ? null
            : state.currentAgentApproval,
      }));
      return resolved;
    },
  };
}

function wasResolvedBeforeExpiry(approval: AgentApproval) {
  if (!approval.resolvedAt) {
    return false;
  }

  return new Date(approval.resolvedAt).getTime() <= new Date(approval.expiresAt).getTime();
}

function createEmptyBaseline(): {
  commandResults?: BaselineCommandResults;
  packageJson: string | null;
} {
  return {
    commandResults: undefined,
    packageJson: null,
  };
}

async function captureBaseline(store: StoreAccess, project: ProjectInfo) {
  const packageJson = await readOptionalProjectFile(project.id, "package.json");

  if (!packageJson) {
    return {
      commandResults: {
        build: null,
        install: null,
        lint: null,
        test: null,
      } satisfies BaselineCommandResults,
      packageJson: null,
    };
  }

  const parsed = safeParsePackageJson(packageJson);
  const manager = await detectPackageManager(project.id, store.get().fileTree);
  const commandResults: BaselineCommandResults = {
    build: await runBaselineScript(store, project, manager, parsed, "build"),
    lint: await runBaselineScript(store, project, manager, parsed, "lint"),
    test: await runBaselineScript(store, project, manager, parsed, "test"),
  };

  return { commandResults, packageJson };
}

async function writeBaselineArtifact(
  projectId: string,
  runId: string,
  session: RuntimeSessionState,
) {
  if (!session.baselineCommandResults && !session.baselinePackageJson) {
    return;
  }

  const artifact = await agentRuntimeApi.writeArtifact(
    projectId,
    runId,
    "baseline/verification-baseline.json",
    JSON.stringify(
      {
        baselineCommandResults: session.baselineCommandResults,
        packageJsonPresent: session.baselinePackageJson !== null,
      },
      null,
      2,
    ),
  );
  session.baselineArtifactId = artifact.id;
}

async function runBaselineScript(
  store: StoreAccess,
  project: ProjectInfo,
  manager: "npm" | "pnpm",
  packageJson: PackageJson | null,
  script: "build" | "lint" | "test",
) {
  if (typeof packageJson?.scripts?.[script] !== "string") {
    return null;
  }

  const command = manager === "pnpm" ? `pnpm ${script}` : `npm run ${script}`;
  return runVerifierCommand(store, project, command);
}

async function runVerifierCommand(
  store: StoreAccess,
  project: ProjectInfo,
  command: string,
) {
  const result = await store.get().runProjectCommand(project.id, command);

  if (!result) {
    return null;
  }

  return {
    command: result.command,
    exitCode: result.exitCode,
    output: result.output,
    success: result.success,
  };
}

async function collectSessionPreviewDiagnostics(
  store: StoreAccess,
  input: {
    runId: string;
    sessionId: string;
    startedAt: string;
    url: string;
    windowMs: number;
  },
) {
  const session: PreviewVerificationSession = {
    id: input.sessionId,
    previewUrl: input.url,
    runId: input.runId,
    startedAt: input.startedAt,
  };
  store.set((state) => ({
    previewVerificationSession: session,
    previewVerificationSessions: [...state.previewVerificationSessions, session],
  }));
  await delay(input.windowMs);
  const endedAt = new Date().toISOString();
  store.set((state) => ({
    previewVerificationSession:
      state.previewVerificationSession?.id === input.sessionId
        ? null
        : state.previewVerificationSession,
    previewVerificationSessions: state.previewVerificationSessions.map((item) =>
      item.id === input.sessionId ? { ...item, endedAt } : item,
    ),
  }));

  return store
    .get()
    .previewDiagnostics.filter(
      (diagnostic) =>
        diagnostic.runId === input.runId &&
        diagnostic.sessionId === input.sessionId &&
        diagnostic.timestamp >= input.startedAt &&
        (!diagnostic.url || diagnostic.url === input.url),
    );
}

async function restoreAdapterState(
  project: ProjectInfo,
  run: AgentRun,
  session: RuntimeSessionState,
) {
  const checkpoint = await agentRuntimeApi.getLatestCheckpoint(project.id, run.id);

  if (!checkpoint) {
    return;
  }

  session.runState.packageBaselineJson = checkpoint.packageBaselineJson ?? null;

  for (const snapshot of checkpoint.readSnapshots) {
    if (!isReadSnapshot(snapshot)) {
      continue;
    }

    try {
      const content = await projectApi.readFile(project.id, snapshot.path);

      if (hashText(content) === snapshot.contentHash) {
        session.runState.readFiles.set(snapshot.path, {
          content,
          contentHash: snapshot.contentHash,
          path: snapshot.path,
          readAt: snapshot.readAt,
        });
      }
    } catch {
      // A missing file will be surfaced by the next tool that depends on it.
    }
  }
}

async function refreshProjectStateAfterWrite(store: StoreAccess, project: ProjectInfo) {
  const fileTree = await projectApi.listFiles(project.id);
  store.set({ fileTree });
  await refreshSiteIndex(project, fileTree);
  store.set((state) => ({
    previewRefreshKey: state.previewRefreshKey + 1,
  }));
}

async function ensureFileTree(store: StoreAccess, project: ProjectInfo) {
  if (store.get().fileTree) {
    return store.get().fileTree;
  }

  const fileTree = await projectApi.listFiles(project.id);
  store.set({ fileTree });
  return fileTree;
}

async function computeWorkspaceFingerprint(project: ProjectInfo) {
  const fileTree = await projectApi.listFiles(project.id);
  const paths = flattenFileTree(fileTree)
    .map((file) => file.path)
    .filter(Boolean)
    .sort();
  const hashes = await Promise.all(
    paths.map(async (path) => {
      try {
        return `${path}:${hashText(await projectApi.readFile(project.id, path))}`;
      } catch {
        return `${path}:unreadable`;
      }
    }),
  );

  return hashText(hashes.join("\n"));
}

function flattenFileTree(fileTree: FileTree): FileTree[] {
  return [
    fileTree,
    ...(fileTree.children ?? []).flatMap((child) => flattenFileTree(child)),
  ];
}

function projectRunToStore(store: StoreAccess, run: AgentRun, event: AgentEvent) {
  store.set((state) => ({
    agentEvents: [...state.agentEvents, event],
    agentRuns: [run, ...state.agentRuns.filter((item) => item.id !== run.id)],
    currentAgentRun: run,
  }));
}

function collectReadSnapshots(runState: AgentRunState) {
  return Array.from(runState.readFiles.values()).map((file) => ({
    contentHash: file.contentHash,
    path: file.path,
    readAt: file.readAt,
  }));
}

async function validateReadSnapshotsForProject(
  project: ProjectInfo,
  snapshots: Array<{ contentHash: string; path: string; readAt: string }>,
) {
  const validSnapshots = [];

  for (const snapshot of snapshots) {
    if (!isReadSnapshot(snapshot)) {
      continue;
    }

    try {
      const content = await projectApi.readFile(project.id, snapshot.path);

      if (hashText(content) === snapshot.contentHash) {
        validSnapshots.push(snapshot);
      }
    } catch {
      // Missing or unreadable files invalidate only that read-before-write snapshot.
    }
  }

  return validSnapshots;
}

async function cleanupRunAfterRuntimeError({
  message,
  projectId,
  runId,
  signalAborted,
  store,
}: {
  message: string;
  projectId: string;
  runId: string;
  signalAborted: boolean;
  store: StoreAccess;
}): Promise<{ message: string; run: AgentRun | null }> {
  try {
    const latestRun = await agentRuntimeApi.getRun(projectId, runId);

    if (!latestRun || shouldLeaveRunStateAfterError(latestRun)) {
      return { message, run: latestRun };
    }

    const transition = latestRun.cancelRequested || signalAborted
      ? new RunStateMachine().transition(latestRun, { type: "cancel" })
      : new RunStateMachine().transition(latestRun, { type: "fail", reason: message });
    const { run, event } = await agentRuntimeApi.transitionRun(
      projectId,
      latestRun,
      transition,
    );
    projectRunToStore(store, run, event);
    return { message, run };
  } catch (cleanupError) {
    return {
      message: [
        message,
        `Cleanup failed: ${getProjectErrorMessage(cleanupError)}`,
      ].join("\n"),
      run: null,
    };
  }
}

function shouldLeaveRunStateAfterError(run: AgentRun) {
  return (
    isTerminalAgentRunStatus(run.status) ||
    run.status === "waiting_approval" ||
    run.status === "paused"
  );
}

async function completeStreamForRun(
  projectId: string,
  store: StoreAccess,
  stream: AgentStreamController,
  run: AgentRun,
) {
  if (run.status === "completed") {
    const report = store.get().currentVerificationReport;
    const checkpoint = await agentRuntimeApi.getLatestCheckpoint(projectId, run.id);
    const metadata = checkpoint
      ? readRunDriveStateMetadata(checkpoint.plan)
      : { userPlan: null };
    const modelSummary = run.contract.taskType === "answer"
      ? metadata.answerMessage
      : metadata.finishSummary;
    stream.completeWithTypewriter(
      [
        modelSummary?.trim() || "Run completed.",
        report ? `Verification: ${report.status}.` : "Verification: completed.",
      ].join("\n\n"),
    );
    return;
  }

  if (run.status === "waiting_approval") {
    stream.completeWithTypewriter("Waiting for approval before continuing this run.");
    return;
  }

  if (run.status === "paused") {
    stream.completeWithTypewriter("Run paused at a boundary.");
    return;
  }

  if (run.status === "cancelled") {
    stream.completeWithTypewriter("Run cancelled.");
    return;
  }

  stream.failWithTypewriter(`Run ended with status ${run.status}.`);
}

async function loadApprovedPackageChangeKeys(projectId: string, runId: string) {
  const approvals = await agentRuntimeApi.listApprovals(projectId, runId);
  const hasApprovedPackageChange = approvals.some(
    (approval) =>
      approval.decision === "approved" &&
      wasResolvedBeforeExpiry(approval) &&
      approval.targetResources.some(
        (resource) => resource.replace(/\\/g, "/") === "package.json",
      ),
  );

  return hasApprovedPackageChange ? ["*"] : [];
}

async function loadApprovedDeletionPaths(projectId: string, runId: string) {
  const approvals = await agentRuntimeApi.listApprovals(projectId, runId);

  return approvals
    .filter(
      (approval) =>
        approval.decision === "approved" &&
        wasResolvedBeforeExpiry(approval) &&
        approval.toolName === "delete_files",
    )
    .flatMap((approval) => approval.targetResources)
    .map((resource) => resource.replace(/\\/g, "/"));
}

type PackageJson = {
  scripts?: Record<string, unknown>;
};

function safeParsePackageJson(content: string): PackageJson | null {
  try {
    return JSON.parse(content) as PackageJson;
  } catch {
    return null;
  }
}

async function detectPackageManager(
  projectId: string,
  fileTree: FileTree | null,
): Promise<"npm" | "pnpm"> {
  if (fileTree && hasFilePath(fileTree, "pnpm-lock.yaml")) {
    return "pnpm";
  }

  try {
    await projectApi.readFile(projectId, "pnpm-lock.yaml");
    return "pnpm";
  } catch {
    return "npm";
  }
}

async function readOptionalProjectFile(projectId: string, path: string) {
  try {
    return await projectApi.readFile(projectId, path);
  } catch (error) {
    if (getProjectErrorMessage(error).toLowerCase().includes("not found")) {
      return null;
    }

    throw error;
  }
}

function hasFilePath(fileTree: FileTree, path: string): boolean {
  return fileTree.path === path || (fileTree.children ?? []).some((child) => hasFilePath(child, path));
}

function toAgentObservation(value: string, step: number): AgentObservation {
  try {
    const parsed = JSON.parse(value) as Partial<AgentObservation>;

    if (
      typeof parsed.summary === "string" &&
      typeof parsed.tool === "string" &&
      typeof parsed.ok === "boolean"
    ) {
      return {
        content: typeof parsed.content === "string" ? parsed.content : undefined,
        ok: parsed.ok,
        step,
        summary: parsed.summary,
        tool: parsed.tool,
      };
    }
  } catch {
    // Plain string observations are expected.
  }

  return {
    content: value,
    ok: true,
    step,
    summary: value,
    tool: "observation",
  };
}

function buildAgentDiagnostics(projectError: string | null, terminalLogs: string[]) {
  const lines = terminalLogs.slice(-36);
  const parts = [
    projectError ? `Current project error: ${projectError}` : "",
    lines.length > 0 ? `Recent logs:\n${lines.join("\n")}` : "",
  ].filter(Boolean);

  return parts.length > 0 ? parts.join("\n\n").slice(-6_000) : null;
}

function formatVerificationSummary(report: VerificationReport) {
  return report.checks
    .map((check) => `${check.title}: ${check.status} - ${check.summary}`)
    .join("\n");
}

function formatVerificationFailure(report: VerificationReport) {
  const feedback = report.repairFeedback.length > 0
    ? report.repairFeedback.join("\n")
    : report.missingEvidence.join("\n");

  return [
    `Verification ${report.status}.`,
    feedback || "The verifier did not produce enough evidence to complete the run.",
  ].join("\n");
}

function isReadSnapshot(value: unknown): value is {
  contentHash: string;
  path: string;
  readAt: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { contentHash?: unknown }).contentHash === "string" &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { readAt?: unknown }).readAt === "string"
  );
}

function hashText(content: string) {
  let hash = 2166136261;

  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

function createRuntimeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
