import { formatProjectFileTree, getContextFilePaths } from "../agent/projectModifier";
import { runSpecTaskRuntime } from "../agent-runtime/runController";
import { agentRuntimeApi } from "../services/agentRuntime";
import { keyStore } from "../services/keyStore";
import {
  getProjectErrorMessage,
  projectApi,
  type FileTree,
  type ProjectConversation,
} from "../services/projects";
import { specApi } from "../services/specs";
import { compileSpecTaskContract } from "../spec-core/taskCompiler";
import type {
  DevelopmentSpec,
  GeneratedSpecRevisionPayload,
  SpecRevision,
  SpecTask,
} from "../spec-core/types";
import {
  getCurrentSpecRevision,
  validateSpecForApproval,
} from "../spec-core/validators";
import {
  isTerminalSpecStatus,
  markSpecCancelled,
  markSpecFailed,
  transitionSpecStatus,
} from "../spec-core/specStateMachine";
import {
  requestFeatureSpec,
  requestInitialSpec,
  requestSpecRevision,
} from "../spec-runtime/requests";
import type { AppState } from "./appStore";
import { createChatMessage } from "./chatMessages";
import { appendLogs } from "./commandLogs";
import {
  appendConversationMessage,
  conversationToSummary,
  persistConversation,
  upsertConversationSummary,
} from "./conversationState";
import type { StoreAccess } from "./storeAccess";

type SpecActions = Pick<
  AppState,
  | "approveAndExecuteCurrentSpec"
  | "createInitialSpec"
  | "loadConversationSpecHistory"
  | "loadCurrentSpec"
  | "retrySpecTask"
  | "retrySpecVerification"
  | "reviseCurrentSpec"
  | "switchCurrentIterationToChat"
  | "switchCurrentIterationToSpec"
>;

export function createSpecActions({ get, set }: StoreAccess): SpecActions {
  const store = { get, set };

  return {
    loadCurrentSpec: async () => {
      const project = get().currentProject;
      const conversation = get().currentConversation;

      if (!project || !conversation?.activeSpecId) {
        set({ currentSpec: null, historicalSpecs: [] });
        return;
      }

      set({ isLoadingSpec: true, projectError: null });

      try {
        const spec = await specApi.readSpec(project.id, conversation.activeSpecId);

        if (
          get().currentProject?.id !== project.id ||
          get().currentConversation?.id !== conversation.id
        ) {
          return;
        }

        set({ currentSpec: spec });
        await get().loadConversationSpecHistory();
      } catch (error) {
        recordSpecError(set, error);
      } finally {
        set({ isLoadingSpec: false });
      }
    },

    loadConversationSpecHistory: async () => {
      const project = get().currentProject;
      const conversation = get().currentConversation;

      if (!project || !conversation) {
        set({ historicalSpecs: [] });
        return;
      }

      try {
        const specs = await Promise.all(
          conversation.specIds.map((specId) => specApi.readSpec(project.id, specId)),
        );

        if (
          get().currentProject?.id !== project.id ||
          get().currentConversation?.id !== conversation.id
        ) {
          return;
        }

        set({ historicalSpecs: specs });
      } catch (error) {
        recordSpecError(set, error);
      }
    },

    createInitialSpec: async (projectId, projectBrief, conversationTitle) => {
      const project = get().projects.find((item) => item.id === projectId);

      if (!project) {
        return null;
      }

      const config = await keyStore.getAiProviderConfig();

      if (!config) {
        set({ projectError: "Configure your AI provider first." });
        return null;
      }

      const conversationId = createId("conv");
      const specId = createId("spec");

      set({ isGeneratingSpec: true, projectError: null });

      try {
        const payload = await requestInitialSpec({
          config,
          projectBrief,
          projectName: project.name,
        });
        const spec = createDevelopmentSpecFromPayload({
          conversationId,
          kind: "initial_build",
          payload,
          projectId: project.id,
          specId,
        });

        await specApi.createSpec(project.id, spec);

        let conversation: ProjectConversation | null = null;

        try {
          conversation = await projectApi.createProjectConversation(project.id, {
            activeSpecId: spec.id,
            conversationId,
            kind: "initial_build",
            mode: "spec",
            specIds: [spec.id],
            title: conversationTitle ?? "Initial build",
          });
        } catch (error) {
          await specApi.deleteUnattachedSpec(project.id, spec.id);
          throw error;
        }

        set((state) => ({
          chatMessages: conversation.messages,
          conversationSummaries: upsertConversationSummary(
            state.conversationSummaries,
            conversationToSummary(conversation),
          ),
          currentConversation: conversation,
          currentSpec: spec,
          historicalSpecs: [spec],
          showArchivedConversations: false,
          terminalLogs: appendLogs(state.terminalLogs, [
            "[spec] Initial Spec review is ready.",
          ]),
        }));

        const userMessage = createChatMessage("user", projectBrief);
        const updatedConversation = appendConversationMessage(store, userMessage);
        void persistConversation(store, updatedConversation);

        return updatedConversation ?? conversation;
      } catch (error) {
        recordSpecError(set, error);
        return null;
      } finally {
        set({ isGeneratingSpec: false });
      }
    },

    reviseCurrentSpec: async (feedback) => {
      const project = get().currentProject;
      const spec = get().currentSpec;
      const message = feedback.trim();

      if (!project || !spec || spec.status !== "review" || !message) {
        return;
      }

      const config = await keyStore.getAiProviderConfig();

      if (!config) {
        set({ projectError: "Configure your AI provider first." });
        return;
      }

      set({ isRevisingSpec: true, projectError: null });

      try {
        const revisingSpec = transitionSpecStatus(spec, "revising");
        await saveSpecToStore(store, revisingSpec);

        const currentRevision = getCurrentSpecRevision(spec);
        const payload = await requestSpecRevision({
          config,
          currentRevision,
          feedback: message,
        });
        const nextRevision = createRevisionFromPayload(
          payload,
          currentRevision.version + 1,
        );
        const nextSpec = transitionSpecStatus(
          {
            ...revisingSpec,
            currentRevisionId: nextRevision.id,
            revisions: [...revisingSpec.revisions, nextRevision],
          },
          "review",
        );

        await saveSpecToStore(store, nextSpec);
      } catch (error) {
        recordSpecError(set, error);
      } finally {
        set({ isRevisingSpec: false });
      }
    },

    approveAndExecuteCurrentSpec: async () => {
      const project = get().currentProject;
      const conversation = get().currentConversation;
      const spec = get().currentSpec;

      if (
        !project ||
        !conversation ||
        !spec ||
        conversation.mode !== "spec" ||
        conversation.activeSpecId !== spec.id ||
        get().isExecutingSpec
      ) {
        return;
      }

      set({ isExecutingSpec: true, projectError: null });

      try {
        const revision = validateSpecForApproval(spec);
        const now = new Date().toISOString();
        const approvedRevision: SpecRevision = {
          ...revision,
          approvedAt: now,
        };
        const approvedSpec = transitionSpecStatus(
          {
            ...spec,
            revisions: spec.revisions.map((item) =>
              item.id === revision.id ? approvedRevision : item,
            ),
          },
          "approved",
          { now },
        );

        await saveSpecToStore(store, approvedSpec);
        await executeSpecTasks(store, approvedSpec.id);
      } catch (error) {
        recordSpecError(set, error);
      } finally {
        set({ isExecutingSpec: false });
      }
    },

    retrySpecTask: async (taskId) => {
      const spec = get().currentSpec;

      if (!spec || get().isExecutingSpec) {
        return;
      }

      const revision = getCurrentSpecRevision(spec);
      const target = revision.tasks.find((task) => task.id === taskId);

      if (
        !target ||
        !["failed", "cancelled", "blocked"].includes(target.status)
      ) {
        return;
      }

      const resetRevision = {
        ...revision,
        tasks: revision.tasks.map((task) => {
          if (task.id === taskId) {
            return {
              ...task,
              blockedByTaskId: undefined,
              error: undefined,
              runId: undefined,
              status: "pending" as const,
            };
          }

          if (task.blockedByTaskId === taskId) {
            return {
              ...task,
              blockedByTaskId: undefined,
              error: undefined,
              status: "pending" as const,
            };
          }

          return task;
        }),
      };
      const resetSpec = {
        ...spec,
        currentRevisionId: resetRevision.id,
        failureMessage: undefined,
        revisions: spec.revisions.map((item) =>
          item.id === resetRevision.id ? resetRevision : item,
        ),
        status: "building" as const,
        updatedAt: new Date().toISOString(),
      };

      set({ isExecutingSpec: true, projectError: null });

      try {
        await saveSpecToStore(store, resetSpec);
        await executeSpecTasks(store, resetSpec.id);
      } catch (error) {
        recordSpecError(set, error);
      } finally {
        set({ isExecutingSpec: false });
      }
    },

    retrySpecVerification: async () => {
      const spec = get().currentSpec;

      if (!spec) {
        return;
      }

      set({ isVerifyingSpec: true, projectError: null });

      try {
        await verifyCompletedTasks(store, {
          ...spec,
          status: "verifying",
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        recordSpecError(set, error);
      } finally {
        set({ isVerifyingSpec: false });
      }
    },

    switchCurrentIterationToSpec: async (brief) => {
      const project = get().currentProject;
      const conversation = get().currentConversation;
      const message = brief.trim();

      if (
        !project ||
        !conversation ||
        conversation.kind !== "iteration" ||
        conversation.mode !== "chat" ||
        !message ||
        get().isSwitchingIterationMode ||
        hasActiveRun(get())
      ) {
        return;
      }

      const config = await keyStore.getAiProviderConfig();

      if (!config) {
        set({ projectError: "Configure your AI provider first." });
        return;
      }

      const specId = createId("spec");

      set({
        isGeneratingSpec: true,
        isSwitchingIterationMode: true,
        projectError: null,
      });

      try {
        const context = await buildFeatureSpecContext(store, project.id);
        const payload = await requestFeatureSpec({
          brief: message,
          config,
          context,
        });
        const spec = createDevelopmentSpecFromPayload({
          conversationId: conversation.id,
          kind: "feature",
          payload,
          projectId: project.id,
          specId,
        });

        await specApi.createSpec(project.id, spec);

        try {
          const updatedConversation =
            await projectApi.switchProjectConversationMode(project.id, {
              activeSpecId: spec.id,
              conversationId: conversation.id,
              specIds: appendUnique(conversation.specIds, spec.id),
              targetMode: "spec",
            });

          applyConversationAndSpec(store, updatedConversation, spec);
        } catch (error) {
          await specApi.deleteUnattachedSpec(project.id, spec.id);
          throw error;
        }
      } catch (error) {
        recordSpecError(set, error);
      } finally {
        set({
          isGeneratingSpec: false,
          isSwitchingIterationMode: false,
        });
      }
    },

    switchCurrentIterationToChat: async (options = {}) => {
      const project = get().currentProject;
      const conversation = get().currentConversation;
      const spec = get().currentSpec;

      if (
        !project ||
        !conversation ||
        conversation.kind !== "iteration" ||
        conversation.mode !== "spec" ||
        !spec ||
        get().isSwitchingIterationMode
      ) {
        return;
      }

      const activeRun = get().currentAgentRun;
      const executionLocked =
        ["approved", "building", "verifying"].includes(spec.status) ||
        hasActiveRun(get());

      if (executionLocked && !options.cancelActiveSpec) {
        set({
          projectError:
            "Cancel the active Spec execution before switching to Chat.",
        });
        return;
      }

      set({ isSwitchingIterationMode: true, projectError: null });

      try {
        let nextSpec = spec;

        if (executionLocked) {
          if (activeRun && !isTerminalRunStatus(activeRun.status)) {
            await get().cancelCurrentAgentRun();
            const latestRun = get().currentAgentRun;

            if (latestRun && !isTerminalRunStatus(latestRun.status)) {
              throw new Error("AgentRun cancellation did not reach a terminal state.");
            }
          }

          nextSpec = cancelRunningTasks(spec);
        }

        if (["drafting", "review", "revising"].includes(nextSpec.status)) {
          nextSpec = markSpecCancelled(nextSpec);
        }

        if (nextSpec !== spec) {
          await saveSpecToStore(store, nextSpec);
        }

        const updatedConversation =
          await projectApi.switchProjectConversationMode(project.id, {
            activeSpecId: null,
            conversationId: conversation.id,
            specIds: conversation.specIds,
            targetMode: "chat",
          });

        applyConversationAndSpec(store, updatedConversation, null);
      } catch (error) {
        recordSpecError(set, error);
      } finally {
        set({ isSwitchingIterationMode: false });
      }
    },
  };
}

async function executeSpecTasks(store: StoreAccess, specId: string) {
  const project = store.get().currentProject;

  if (!project) {
    return;
  }

  let spec = store.get().currentSpec;

  if (!spec || spec.id !== specId) {
    return;
  }

  if (spec.status === "approved") {
    spec = transitionSpecStatus(spec, "building");
    await saveSpecToStore(store, spec);
  }

  while (true) {
    spec = store.get().currentSpec;

    if (!spec || spec.id !== specId || spec.status !== "building") {
      return;
    }

    const revision = getCurrentSpecRevision(spec);
    const task = selectNextRunnableTask(revision.tasks);

    if (!task) {
      const pendingTasks = revision.tasks.filter((item) => item.status === "pending");

      if (pendingTasks.length > 0) {
        const failedSpec = markSpecFailed(
          spec,
          "Task dependencies could not advance.",
        );
        await saveSpecToStore(store, markBlockedPendingTasks(failedSpec));
        return;
      }

      const verifyingSpec = transitionSpecStatus(spec, "verifying");
      await saveSpecToStore(store, verifyingSpec);
      await verifyCompletedTasks(store, verifyingSpec);
      return;
    }

    const runningSpec = updateTask(spec, task.id, {
      error: undefined,
      status: "running",
    });
    await saveSpecToStore(store, runningSpec);

    const runningRevision = getCurrentSpecRevision(runningSpec);
    const runningTask = runningRevision.tasks.find((item) => item.id === task.id);

    if (!runningTask) {
      throw new Error(`Spec task ${task.id} was not found.`);
    }

    const contract = compileSpecTaskContract({
      revision: runningRevision,
      spec: runningSpec,
      task: runningTask,
    });
    const didComplete = await runSpecTaskRuntime({
      contract,
      conversationId: runningSpec.conversationId,
      executionMode:
        runningSpec.kind === "initial_build" && isFirstTask(runningRevision, runningTask)
          ? "generate"
          : "modify",
      project,
      store,
      taskObjective: runningTask.objective,
    });
    const run = store.get().currentAgentRun;
    const report = run
      ? await agentRuntimeApi.getLatestVerificationReport(project.id, run.id)
      : null;

    if (didComplete && run && report?.status === "passed") {
      await saveSpecToStore(
        store,
        updateTask(store.get().currentSpec ?? runningSpec, task.id, {
          error: undefined,
          runId: run.id,
          status: "passed",
        }),
      );
      continue;
    }

    const failedTaskSpec = updateTask(store.get().currentSpec ?? runningSpec, task.id, {
      error:
        report?.repairFeedback.join("\n") ||
        report?.missingEvidence.join("\n") ||
        `AgentRun ended without a passed verification report.`,
      runId: run?.id,
      status: run?.status === "cancelled" ? "cancelled" : "failed",
    });
    const failedSpec = markSpecFailed(
      markBlockedDownstreamTasks(failedTaskSpec, task.id),
      `Task ${task.title} failed.`,
    );
    await saveSpecToStore(store, failedSpec);
    return;
  }
}

async function verifyCompletedTasks(store: StoreAccess, spec: DevelopmentSpec) {
  const project = store.get().currentProject;

  if (!project) {
    return;
  }

  const revision = getCurrentSpecRevision(spec);

  if (revision.tasks.some((task) => task.status !== "passed" || !task.runId)) {
    await saveSpecToStore(
      store,
      markSpecFailed(spec, "All tasks must pass before final verification."),
    );
    return;
  }

  const installRequired = spec.kind === "initial_build";
  const installResult = installRequired
    ? await store.get().runProjectCommand(project.id, "npm install")
    : null;

  if (installResult && !installResult.success) {
    await saveSpecToStore(
      store,
      markSpecFailed(spec, `Final npm install failed:\n${installResult.output}`),
    );
    return;
  }

  const buildResult = await store.get().runProjectCommand(project.id, "npm run build");

  if (!buildResult?.success) {
    await saveSpecToStore(
      store,
      markSpecFailed(
        spec,
        `Final npm run build failed:\n${buildResult?.output ?? "No command output."}`,
      ),
    );
    return;
  }

  await saveSpecToStore(
    store,
    transitionSpecStatus(
      {
        ...spec,
        finalVerification: {
          checkedAt: new Date().toISOString(),
          command: "npm run build",
          output: buildResult.output,
          success: true,
        },
      },
      "completed",
    ),
  );
}

async function saveSpecToStore(store: StoreAccess, spec: DevelopmentSpec) {
  const saved = await specApi.saveSpec(spec.projectId, spec);

  store.set((state) => ({
    currentSpec:
      state.currentSpec?.id === saved.id || state.currentConversation?.activeSpecId === saved.id
        ? saved
        : state.currentSpec,
    historicalSpecs: upsertSpec(state.historicalSpecs, saved),
  }));

  return saved;
}

function applyConversationAndSpec(
  store: StoreAccess,
  conversation: ProjectConversation,
  spec: DevelopmentSpec | null,
) {
  store.set((state) => ({
    chatMessages: conversation.messages,
    conversationSummaries: upsertConversationSummary(
      state.conversationSummaries,
      conversationToSummary(conversation),
    ),
    currentConversation: conversation,
    currentSpec: spec,
    historicalSpecs: spec ? upsertSpec(state.historicalSpecs, spec) : state.historicalSpecs,
  }));
}

function createDevelopmentSpecFromPayload({
  conversationId,
  kind,
  payload,
  projectId,
  specId,
}: {
  conversationId: string;
  kind: DevelopmentSpec["kind"];
  payload: GeneratedSpecRevisionPayload;
  projectId: string;
  specId: string;
}): DevelopmentSpec {
  const revision = createRevisionFromPayload(payload, 1);
  const now = new Date().toISOString();

  return {
    conversationId,
    createdAt: now,
    currentRevisionId: revision.id,
    id: specId,
    kind,
    projectId,
    revisions: [revision],
    status: "review",
    updatedAt: now,
  };
}

function createRevisionFromPayload(
  payload: GeneratedSpecRevisionPayload,
  version: number,
): SpecRevision {
  return {
    brief: payload.brief,
    createdAt: new Date().toISOString(),
    design: payload.design,
    id: createId("rev"),
    requirements: payload.requirements,
    tasks: payload.tasks.map((task) => ({
      ...task,
      status: "pending",
    })),
    version,
  };
}

function updateTask(
  spec: DevelopmentSpec,
  taskId: string,
  patch: Partial<SpecTask>,
): DevelopmentSpec {
  const revision = getCurrentSpecRevision(spec);
  const nextRevision = {
    ...revision,
    tasks: revision.tasks.map((task) =>
      task.id === taskId ? { ...task, ...patch } : task,
    ),
  };

  return {
    ...spec,
    revisions: spec.revisions.map((item) =>
      item.id === nextRevision.id ? nextRevision : item,
    ),
    updatedAt: new Date().toISOString(),
  };
}

function markBlockedDownstreamTasks(
  spec: DevelopmentSpec,
  failedTaskId: string,
): DevelopmentSpec {
  const revision = getCurrentSpecRevision(spec);
  const nextRevision = {
    ...revision,
    tasks: revision.tasks.map((task) =>
      task.status === "pending" && task.dependencyIds.includes(failedTaskId)
        ? {
            ...task,
            blockedByTaskId: failedTaskId,
            error: `Blocked because dependency ${failedTaskId} failed.`,
            status: "blocked" as const,
          }
        : task,
    ),
  };

  return {
    ...spec,
    revisions: spec.revisions.map((item) =>
      item.id === nextRevision.id ? nextRevision : item,
    ),
    updatedAt: new Date().toISOString(),
  };
}

function markBlockedPendingTasks(spec: DevelopmentSpec): DevelopmentSpec {
  const revision = getCurrentSpecRevision(spec);
  const nextRevision = {
    ...revision,
    tasks: revision.tasks.map((task) =>
      task.status === "pending"
        ? {
            ...task,
            error: "Blocked because dependencies could not advance.",
            status: "blocked" as const,
          }
        : task,
    ),
  };

  return {
    ...spec,
    revisions: spec.revisions.map((item) =>
      item.id === nextRevision.id ? nextRevision : item,
    ),
    updatedAt: new Date().toISOString(),
  };
}

function cancelRunningTasks(spec: DevelopmentSpec): DevelopmentSpec {
  const revision = getCurrentSpecRevision(spec);
  const nextRevision = {
    ...revision,
    tasks: revision.tasks.map((task) => {
      if (task.status === "running") {
        return {
          ...task,
          error: "Cancelled while switching to Chat.",
          status: "cancelled" as const,
        };
      }

      if (task.status === "pending") {
        return {
          ...task,
          error: "Cancelled while switching to Chat.",
          status: "cancelled" as const,
        };
      }

      return task;
    }),
  };

  return markSpecCancelled({
    ...spec,
    revisions: spec.revisions.map((item) =>
      item.id === nextRevision.id ? nextRevision : item,
    ),
    updatedAt: new Date().toISOString(),
  });
}

function selectNextRunnableTask(tasks: SpecTask[]) {
  return tasks.find(
    (task) =>
      task.status === "pending" &&
      task.dependencyIds.every((dependencyId) =>
        tasks.some(
          (candidate) =>
            candidate.id === dependencyId && candidate.status === "passed",
        ),
      ),
  );
}

function isFirstTask(revision: SpecRevision, task: SpecTask) {
  return revision.tasks[0]?.id === task.id;
}

async function buildFeatureSpecContext(store: StoreAccess, projectId: string) {
  const state = store.get();
  const fileTree = state.fileTree ?? await projectApi.listFiles(projectId);
  const contextPaths = getContextFilePaths(fileTree).slice(0, 12);
  const files = await readContextFiles(projectId, fileTree, contextPaths);
  const [siteSpec, sourceMap] = await Promise.all([
    agentRuntimeApi.readSiteSpec(projectId).catch(() => null),
    agentRuntimeApi.readSiteSourceMap(projectId).catch(() => null),
  ]);

  return {
    changeHistory: state.changeHistory.slice(0, 8),
    currentConversation: {
      id: state.currentConversation?.id,
      messages: state.currentConversation?.messages.slice(-12) ?? [],
      title: state.currentConversation?.title,
    },
    fileTree: formatProjectFileTree(fileTree),
    files,
    siteSpec,
    sourceMap,
  };
}

async function readContextFiles(
  projectId: string,
  fileTree: FileTree,
  paths: string[],
) {
  const readablePaths = paths.length > 0 ? paths : getContextFilePaths(fileTree).slice(0, 8);
  const entries = await Promise.all(
    readablePaths.map(async (path) => {
      try {
        return {
          content: await projectApi.readFile(projectId, path),
          path,
        };
      } catch (error) {
        return {
          error: getProjectErrorMessage(error),
          path,
        };
      }
    }),
  );

  return entries;
}

function appendUnique(values: string[], value: string) {
  return values.includes(value) ? values : [...values, value];
}

function upsertSpec(specs: DevelopmentSpec[], spec: DevelopmentSpec) {
  return [spec, ...specs.filter((item) => item.id !== spec.id)].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function hasActiveRun(state: AppState) {
  const run = state.currentAgentRun;
  return Boolean(run && !isTerminalRunStatus(run.status));
}

function isTerminalRunStatus(status: string) {
  return ["completed", "failed", "cancelled", "budget_exceeded"].includes(status);
}

function recordSpecError(set: StoreAccess["set"], error: unknown) {
  const message = getProjectErrorMessage(error);

  set((state) => ({
    projectError: message,
    terminalLogs: appendLogs(state.terminalLogs, [`[spec:error] ${message}`]),
  }));
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function canSwitchSpecStatusToChat(spec: DevelopmentSpec | null) {
  return !spec || isTerminalSpecStatus(spec.status) || ["drafting", "review", "revising"].includes(spec.status);
}
