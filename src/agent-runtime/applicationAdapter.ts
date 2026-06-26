import {
  formatProjectFileTree,
  getContextFilePaths,
  requestAgentStep,
  requestProjectGeneration,
  type AgentObservation,
  type AgentStepContext,
  type AgentStepResponse,
  type AgentToolCallStep,
  type CompactSpecContext,
} from "../agent/projectModifier";
import {
  buildProjectBackendContext,
  hasBackendIntent,
} from "../agent/project/backendContext";
import {
  buildAgentBudgetState,
  compressAgentStepContext,
} from "../agent/project/contextCompression";
import { buildDynamicAgentContext } from "../agent/project/memory";
import {
  AgentStepValidationError,
  requestRunContextSummary,
} from "../agent/project/requests";
import { LlmClientError } from "../agent/llm/errors";
import { AgentVerifier, type BaselineCommandResults } from "../agent-core/verifier/verifier";
import { compileTaskContract } from "../agent-core/contract/taskContract";
import type { TaskContract } from "../agent-core/types";
import {
  RunController,
  type HeadlessModelAction,
  readRunDriveStateMetadata,
  type RunContextBundle,
  type RunControllerPorts,
} from "../agent-core/runtime/runController";
import { isTerminalAgentRunStatus, RunStateMachine } from "../agent-core/runtime/runStateMachine";
import type {
  AgentEvent,
  AgentRunFailureKind,
  AgentRun,
  AgentRunCheckpoint,
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
  type PreviewProbeResult,
  type ProjectInfo,
} from "../services/projects";
import { agentRuntimeApi } from "../services/agentRuntime";
import { specApi } from "../services/specs";
import type { DevelopmentSpec, SpecRevision, SpecTask } from "../spec-core/types";
import { appendLogs } from "../store/commandLogs";
import { persistCurrentConversation } from "../store/conversationState";
import type { AppState } from "../store/appStore";
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
  contract?: TaskContract;
  conversationId?: string;
  existingRun?: AgentRun;
  mode: ApplicationRuntimeMode;
  project: ProjectInfo;
  resumeObservation?: AgentObservation;
  runId?: string;
  store: StoreAccess;
  userRequest: string;
};

export type ApplicationRunResult = {
  failureKind?: AgentRunFailureKind;
  failureReason?: string;
  run: AgentRun | null;
  verificationReport: VerificationReport | null;
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
  const result = await runApplicationRuntime({
    mode: "generate",
    project,
    store,
    userRequest: projectPrompt,
  });

  return result.run?.status === "completed";
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

  const result = await runApplicationRuntime({
    existingRun: options.existingRun,
    mode: "modify",
    project,
    resumeObservation: options.resumeObservation,
    store,
    userRequest,
  });

  return result.run?.status === "completed";
}

export async function runSpecTaskRuntime({
  contract,
  conversationId,
  executionMode,
  existingRun,
  project,
  resumeObservation,
  runId,
  store,
  taskObjective,
}: {
  contract: TaskContract;
  conversationId: string;
  executionMode: ApplicationRuntimeMode;
  existingRun?: AgentRun;
  project: ProjectInfo;
  resumeObservation?: AgentObservation;
  runId?: string;
  store: StoreAccess;
  taskObjective: string;
}): Promise<ApplicationRunResult> {
  return runApplicationRuntime({
    contract,
    conversationId,
    existingRun,
    mode: executionMode,
    project,
    resumeObservation,
    runId,
    store,
    userRequest: taskObjective,
  });
}

async function runApplicationRuntime(
  input: RunApplicationRuntimeInput,
): Promise<ApplicationRunResult> {
  const { existingRun, mode, project, store, userRequest } = input;
  const stream = startStreamingAgentMessage(
    store,
    mode === "generate"
      ? `Generating ${project.name} with the headless runtime`
      : "Working with the headless runtime",
  );
  const controllerRunId = input.runId ?? existingRun?.id ?? createRuntimeId("run");
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
    : input.contract ?? compileTaskContract({
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
            conversationId:
              input.conversationId ??
              store.get().currentConversation?.id ??
              "conversation-default",
            initialObservations: input.resumeObservation
              ? [JSON.stringify(input.resumeObservation)]
              : undefined,
            projectId: project.id,
            runId: controllerRunId,
          },
          runAbortController.signal,
        );

    await completeStreamForRun(project.id, store, stream, finalRun);
    const failureDetails = await getRunTerminalFailureDetails(project.id, finalRun);
    void persistRuntimeCurrentConversation(store, finalRun);
    return {
      failureKind: failureDetails.failureKind,
      failureReason: failureDetails.failureReason,
      run: finalRun,
      verificationReport: await getRunVerificationReport(project.id, finalRun),
    };
  } catch (error) {
    const message = getProjectErrorMessage(error);
    const failureDetails = classifyRuntimeFailure(error, message);
    const cleanupResult = await cleanupRunAfterRuntimeError({
      failureKind: failureDetails.failureKind,
      message,
      projectId: project.id,
      runId: controllerRunId,
      signalAborted: runAbortController.signal.aborted,
      store,
    });
    const cleanupMessage = cleanupResult.message;

    if (cleanupResult.run?.status === "cancelled") {
      stream.completeWithTypewriter("Run cancelled.");
      void persistRuntimeCurrentConversation(store, cleanupResult.run);
      store.set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [
          `[agent] Run ${cleanupResult.run?.id ?? controllerRunId} cancelled.`,
        ]),
      }));
      return {
        failureKind: cleanupResult.failureKind,
        failureReason: cleanupResult.message,
        run: cleanupResult.run,
        verificationReport: await getRunVerificationReport(
          project.id,
          cleanupResult.run,
        ),
      };
    }

    stream.failWithTypewriter(`Agent run failed: ${cleanupMessage}`);
    void persistRuntimeCurrentConversation(store, cleanupResult.run);
    store.set((state) => ({
      projectError: cleanupMessage,
      terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${cleanupMessage}`]),
    }));
    return {
      failureKind: cleanupResult.failureKind,
      failureReason: cleanupResult.message,
      run: cleanupResult.run,
      verificationReport: await getRunVerificationReport(
        project.id,
        cleanupResult.run,
      ),
    };
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

async function getRunVerificationReport(
  projectId: string,
  run: AgentRun | null,
) {
  if (!run) {
    return null;
  }

  try {
    return await agentRuntimeApi.getLatestVerificationReport(projectId, run.id);
  } catch {
    return null;
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
    contextSummarizer: {
      summarize: async (input) => {
        const config = await keyStore.getAiProviderConfig();

        if (!config) {
          throw new Error("Configure your AI provider first.");
        }

        return requestRunContextSummary({
          ...input,
          config,
        });
      },
    },
    clock: {
      now: () => new Date().toISOString(),
    },
    eventStore: {
      append: async (event) => {
        const record = await agentRuntimeApi.appendEvent(project.id, event);
        store.set((state) => ({
          agentEvents:
            state.currentAgentRun?.id === record.runId
              ? [...state.agentEvents, record]
              : state.agentEvents,
        }));
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
        store.set((state) => {
          const canProject = canProjectRunToCurrentUi(state, created);

          return {
            agentEvents: canProject ? events : state.agentEvents,
            agentRuns: [
              created,
              ...state.agentRuns.filter((item) => item.id !== created.id),
            ],
            currentAgentRun: canProject ? created : state.currentAgentRun,
          };
        });
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
        store.set((state) => ({
          currentVerificationReport: canProjectRunToCurrentUi(
            state,
            verificationInput.run,
          )
            ? report
            : state.currentVerificationReport,
        }));
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
    const specContext = await buildCompactSpecContext({
      project,
      run: context.run,
      state: store.get(),
    });
    const generationPrompt = specContext
      ? appendSpecContextToPrompt(userRequest, specContext)
      : userRequest;
    const backendContext = await buildProjectBackendContext(project.id, {
      includeSchema: hasBackendIntent(generationPrompt),
    });
    const response = await requestProjectGeneration({
      backendContext,
      config,
      onDelta: stream.onModelDelta,
      projectName: project.name,
      signal,
      userPrompt: generationPrompt,
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
  appendContextReportLog(store, agentContext);
  updateAgentStatus(
    stream,
    session.statusLines,
    `Planning step ${context.run.modelTurns + 1}.`,
  );
  let step: AgentStepResponse;

  try {
    step = await requestAgentStep({
      config,
      context: agentContext,
      onDelta: stream.onModelDelta,
      signal,
      userRequest,
    });
  } catch (error) {
    if (error instanceof AgentStepValidationError) {
      const status = "Model response failed validation; feeding error back as observation.";
      appendTerminalLog(
        store,
        `[agent] ${status} ${error.validationError}`,
      );
      updateAgentStatus(stream, session.statusLines, status);
      return {
        attempts: error.attempts,
        invalidResponsePreview: error.invalidResponsePreview,
        message: error.message,
        type: "model_validation_error",
        validationError: error.validationError,
      };
    }

    throw error;
  }

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
      externalEffects: result.externalEffects ?? [],
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
    externalEffects: string[];
    packageChanged: boolean;
    readSnapshots?: AgentRunCheckpoint["readSnapshots"];
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
    httpProbe: (url) =>
      probePreviewWithDevServerRecovery({
        project,
        store,
        url,
      }),
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
    externalEffects: input.externalEffects,
    packageChanged: input.packageChanged,
    previewUrl: store.get().previewUrl,
    readSnapshots: input.readSnapshots,
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

async function probePreviewWithDevServerRecovery({
  project,
  store,
  url,
}: {
  project: ProjectInfo;
  store: StoreAccess;
  url: string;
}): Promise<PreviewProbeResult> {
  const firstProbe = await projectApi.probePreviewUrl(url);

  if (!isPreviewServerError(firstProbe)) {
    return firstProbe;
  }

  appendTerminalLog(
    store,
    `[preview] Probe returned HTTP ${firstProbe.status}; restarting preview server and retrying once.`,
  );

  try {
    await store.get().stopDevServer(project.id);
    await store.get().startDevServer(project.id);
    const retryUrl = store.get().previewUrl ?? url;
    return await projectApi.probePreviewUrl(retryUrl);
  } catch (error) {
    appendTerminalLog(
      store,
      `[preview:error] Failed to restart preview after HTTP ${firstProbe.status}: ${getProjectErrorMessage(error)}`,
    );
    return firstProbe;
  }
}

function isPreviewServerError(result: PreviewProbeResult) {
  return !result.ok && result.status >= 500 && result.status < 600;
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
  const specContext = await buildCompactSpecContext({
    project,
    run: context.run,
    state,
  });
  const backendIntentText = [
    userRequest,
    specContext ? stringifySpecContextForBackendIntent(specContext) : "",
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

  const agentContext: AgentStepContext = {
    backend: backendContext,
    budgetState: buildAgentBudgetState(context.run),
    contextReport: {
      finalChars: 0,
      rawChars: 0,
      retainedObservations: dynamicContext.observations.length,
      summarizedObservations: 0,
    },
    diagnostics: buildAgentDiagnostics(state.projectError, state.terminalLogs),
    devServerStatus: state.devServerStatus,
    fileTree: state.fileTree ? formatProjectFileTree(state.fileTree) : null,
    memory: dynamicContext.memory
      ? {
          ...dynamicContext.memory,
          selectedSiteNodeId: state.selectedSiteNodeId,
          siteSpecPages: siteSpec?.pages.map((page) => ({
            id: page.id,
            route: page.route,
            title: page.title,
          })),
        }
      : null,
    observations: dynamicContext.observations,
    previewUrl: state.previewUrl,
    projectName: project.name,
    recentMessages,
    runContextSummary: context.runContextSummary,
    specContext: specContext ?? undefined,
    steering: context.steering,
    taskLedger: dynamicContext.taskLedger
      ? {
          ...dynamicContext.taskLedger,
          objective: context.run.contract.objective,
        }
      : {
          completed: [],
          nextStep: "Choose the smallest useful next tool call or finish_candidate if complete.",
          objective: context.run.contract.objective,
          pending: [],
          risks: [],
        },
    workingSummary: dynamicContext.workingSummary,
  };

  return compressAgentStepContext(agentContext);
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
      store.set((state) => {
        const canProject = run ? canProjectRunToCurrentUi(state, run) : false;

        return {
          agentEvents: canProject ? events : state.agentEvents,
          agentRuns: run
            ? [run, ...state.agentRuns.filter((item) => item.id !== run.id)]
            : state.agentRuns,
          currentAgentApproval: canProject ? created : state.currentAgentApproval,
          currentAgentRun: canProject && run ? run : state.currentAgentRun,
        };
      });
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
    listApprovedAuthorizations: async (runId) => {
      const approvals = await agentRuntimeApi.listApprovals(projectId, runId);
      return approvals.filter(
        (approval) =>
          approval.decision === "approved" &&
          approval.resolvedAt &&
          !approval.consumedAt,
      );
    },
    claimApprovedAuthorization: (input) =>
      agentRuntimeApi.claimApproval(projectId, input),
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
  store.set((state) => {
    const canProject = canProjectRunToCurrentUi(state, run);

    return {
      agentEvents: canProject ? [...state.agentEvents, event] : state.agentEvents,
      agentRuns: [run, ...state.agentRuns.filter((item) => item.id !== run.id)],
      currentAgentRun: canProject ? run : state.currentAgentRun,
    };
  });
}

function canProjectRunToCurrentUi(state: AppState, run: AgentRun) {
  if (
    state.currentProject?.id !== run.projectId ||
    state.currentConversation?.id !== run.conversationId
  ) {
    return false;
  }

  const source = run.contract.source;

  if (source?.mode !== "spec") {
    return state.currentConversation.mode !== "spec";
  }

  const spec = state.currentSpec;

  if (
    state.currentConversation.mode !== "spec" ||
    !spec ||
    state.currentConversation.activeSpecId !== spec.id ||
    source.specId !== spec.id ||
    source.revisionId !== spec.currentRevisionId
  ) {
    return false;
  }

  const revision = spec.revisions.find((item) => item.id === source.revisionId);
  const runningTask = revision?.tasks.find((task) => task.id === source.taskId);

  return Boolean(
    revision &&
      runningTask &&
      runningTask.runId === run.id &&
      source.taskId === runningTask.id,
  );
}

function persistRuntimeCurrentConversation(
  store: StoreAccess,
  run: AgentRun | null,
) {
  if (!run) {
    return;
  }

  const state = store.get();

  if (
    state.currentProject?.id === run.projectId &&
    state.currentConversation?.id === run.conversationId
  ) {
    return persistCurrentConversation(store);
  }
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
  failureKind,
  message,
  projectId,
  runId,
  signalAborted,
  store,
}: {
  failureKind?: AgentRunFailureKind;
  message: string;
  projectId: string;
  runId: string;
  signalAborted: boolean;
  store: StoreAccess;
}): Promise<{ failureKind?: AgentRunFailureKind; message: string; run: AgentRun | null }> {
  try {
    const latestRun = await agentRuntimeApi.getRun(projectId, runId);

    if (!latestRun || shouldLeaveRunStateAfterError(latestRun)) {
      const details = latestRun
        ? await getRunTerminalFailureDetails(projectId, latestRun)
        : {};
      return {
        failureKind: details.failureKind ?? failureKind,
        message: details.failureReason ?? message,
        run: latestRun,
      };
    }

    const transition = latestRun.cancelRequested || signalAborted
      ? new RunStateMachine().transition(latestRun, { type: "cancel" })
      : failureKind === "context_budget"
        ? new RunStateMachine().transition(latestRun, {
            budget: "maxModelTurns",
            failureKind,
            reason: message,
            type: "budget_exceeded",
          })
        : new RunStateMachine().transition(latestRun, { type: "fail", reason: message });
    const { run, event } = await agentRuntimeApi.transitionRun(
      projectId,
      latestRun,
      transition,
    );
    projectRunToStore(store, run, event);
    return {
      failureKind: readFailureKindFromEvent(event) ?? failureKind,
      message: readFailureReasonFromEvent(event) ?? message,
      run,
    };
  } catch (cleanupError) {
    return {
      failureKind,
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
    const report = canProjectRunToCurrentUi(store.get(), run)
      ? store.get().currentVerificationReport
      : await agentRuntimeApi
          .getLatestVerificationReport(projectId, run.id)
          .catch(() => null);
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

  const failureDetails = await getRunTerminalFailureDetails(projectId, run);
  stream.failWithTypewriter(
    failureDetails.failureReason ?? `Run ended with status ${run.status}.`,
  );
}

async function getRunTerminalFailureDetails(
  projectId: string,
  run: AgentRun | null,
): Promise<{ failureKind?: AgentRunFailureKind; failureReason?: string }> {
  if (!run || !["failed", "budget_exceeded"].includes(run.status)) {
    return {};
  }

  const events = await agentRuntimeApi.listEvents(projectId, run.id).catch(() => []);
  const terminalEvent = [...events]
    .reverse()
    .find((event) => event.type === "run.budget_exceeded" || event.type === "run.failed");

  if (!terminalEvent) {
    return {};
  }

  return {
    failureKind: readFailureKindFromEvent(terminalEvent),
    failureReason: readFailureReasonFromEvent(terminalEvent),
  };
}

function classifyRuntimeFailure(
  error: unknown,
  message: string,
): { failureKind?: AgentRunFailureKind; reason: string } {
  if (
    error instanceof LlmClientError &&
    error.code === "context_budget"
  ) {
    return { failureKind: "context_budget", reason: message };
  }

  if (isContextBudgetMessage(message)) {
    return { failureKind: "context_budget", reason: message };
  }

  return { reason: message };
}

function readFailureReasonFromEvent(event: AgentEvent) {
  return isRecord(event.payload) && typeof event.payload.reason === "string"
    ? event.payload.reason
    : undefined;
}

function readFailureKindFromEvent(event: AgentEvent): AgentRunFailureKind | undefined {
  if (!isRecord(event.payload)) {
    return undefined;
  }

  return isAgentRunFailureKind(event.payload.failureKind)
    ? event.payload.failureKind
    : undefined;
}

function isAgentRunFailureKind(value: unknown): value is AgentRunFailureKind {
  return value === "local_budget" ||
    value === "context_budget" ||
    value === "loop_exhausted";
}

function isContextBudgetMessage(message: string) {
  const normalized = message.toLowerCase();

  return [
    "context_length_exceeded",
    "context length",
    "context window",
    "maximum context",
    "max context",
    "too many tokens",
    "token limit",
    "tokens exceed",
    "input tokens",
    "input too long",
    "prompt too long",
    "request too large",
    "reduce the length",
    "exceeds the model",
    "exceeded the model",
  ].some((pattern) => normalized.includes(pattern));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadApprovedPackageChangeKeys(projectId: string, runId: string) {
  const approvals = await agentRuntimeApi.listApprovals(projectId, runId);
  const hasApprovedPackageChange = approvals.some(
    (approval) =>
      approval.decision === "approved" &&
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

async function buildCompactSpecContext({
  project,
  run,
  state,
}: {
  project: ProjectInfo;
  run: AgentRun;
  state: AppState;
}): Promise<CompactSpecContext | null> {
  const source = run.contract.source;

  if (source?.mode !== "spec") {
    return null;
  }

  const spec = await loadSpecForRun(project.id, source.specId, state);

  if (!spec) {
    return null;
  }

  const revision = spec.revisions.find((item) => item.id === source.revisionId);
  const task = revision?.tasks.find((item) => item.id === source.taskId);

  if (!revision || !task) {
    return null;
  }

  const requirementIds = new Set(
    task.requirementIds.length > 0 ? task.requirementIds : source.requirementIds,
  );
  const acceptanceCriteriaIds = new Set(
    task.acceptanceCriteriaIds.length > 0
      ? task.acceptanceCriteriaIds
      : source.acceptanceCriteriaIds,
  );

  return {
    acceptanceCriteria: revision.requirements.acceptanceCriteria
      .filter((criterion) => acceptanceCriteriaIds.has(criterion.id))
      .map((criterion) => ({
        description: criterion.description,
        id: criterion.id,
        required: criterion.required,
      })),
    brief: revision.brief,
    currentTask: {
      acceptanceCriteriaIds: task.acceptanceCriteriaIds,
      allowedPaths: task.allowedPaths,
      dependencyIds: task.dependencyIds,
      expectedFiles: task.expectedFiles,
      id: task.id,
      objective: task.objective,
      requirementIds: task.requirementIds,
      status: task.status,
      title: task.title,
    },
    design: {
      dataModel: revision.design.dataModel,
      integrations: revision.design.integrations,
      summary: revision.design.summary,
      technicalDecisions: revision.design.technicalDecisions,
      verificationStrategy: revision.design.verificationStrategy,
    },
    executionMode: source.executionMode,
    goal: revision.requirements.goal,
    kind: spec.kind,
    relatedTasks: selectRelatedSpecTasks(revision, task).map((relatedTask) => ({
      id: relatedTask.id,
      status: relatedTask.status,
      title: relatedTask.title,
    })),
    requirements: revision.requirements.userStories
      .filter((story) => requirementIds.has(story.id))
      .map((story) => ({
        description: story.description,
        id: story.id,
      })),
    revisionId: revision.id,
    specId: spec.id,
    specStatus: spec.status,
    taskProgress: countSpecTaskProgress(revision.tasks),
  };
}

async function loadSpecForRun(
  projectId: string,
  specId: string,
  state: AppState,
): Promise<DevelopmentSpec | null> {
  if (state.currentSpec?.id === specId && state.currentSpec.projectId === projectId) {
    return state.currentSpec;
  }

  try {
    return await specApi.readSpec(projectId, specId);
  } catch {
    return null;
  }
}

function selectRelatedSpecTasks(revision: SpecRevision, task: SpecTask) {
  const relatedIds = new Set([task.id, ...task.dependencyIds]);

  for (const candidate of revision.tasks) {
    if (candidate.dependencyIds.includes(task.id)) {
      relatedIds.add(candidate.id);
    }
  }

  return revision.tasks.filter((candidate) => relatedIds.has(candidate.id));
}

function countSpecTaskProgress(tasks: SpecTask[]) {
  return {
    blocked: tasks.filter((task) => task.status === "blocked").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    passed: tasks.filter((task) => task.status === "passed").length,
    pending: tasks.filter((task) => task.status === "pending").length,
    running: tasks.filter((task) => task.status === "running").length,
    total: tasks.length,
  };
}

function stringifySpecContextForBackendIntent(specContext: CompactSpecContext) {
  return JSON.stringify({
    acceptanceCriteria: specContext.acceptanceCriteria,
    currentTask: specContext.currentTask,
    design: {
      dataModel: specContext.design.dataModel,
      integrations: specContext.design.integrations,
      technicalDecisions: specContext.design.technicalDecisions,
    },
    goal: specContext.goal,
    requirements: specContext.requirements,
  });
}

function appendSpecContextToPrompt(
  userRequest: string,
  specContext: CompactSpecContext,
) {
  return [
    userRequest,
    "",
    "Spec task context:",
    JSON.stringify(specContext, null, 2),
  ].join("\n");
}

function appendContextReportLog(store: StoreAccess, context: AgentStepContext) {
  const report = context.contextReport;

  if (report.rawChars <= 0) {
    return;
  }

  appendTerminalLog(
    store,
    `[agent] Context envelope ${report.finalChars}/${report.rawChars} chars; observations retained ${report.retainedObservations}, summarized ${report.summarizedObservations}.`,
  );
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
