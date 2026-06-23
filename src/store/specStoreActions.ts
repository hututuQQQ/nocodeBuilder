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
  canRetrySpecVerification,
  getCurrentSpecRevision,
  computeAcceptanceResults,
  validateSpecForApproval,
} from "../spec-core/validators";
import {
  isTerminalSpecStatus,
  markSpecBlocked,
  markSpecCancelled,
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
import { ensureInitialBuildCompletedForIteration } from "./initialBuildGate";
import type { StoreAccess } from "./storeAccess";

type SpecActions = Pick<
  AppState,
  | "approveAndExecuteCurrentSpec"
  | "continueCurrentSpecExecution"
  | "createFeatureSpecIteration"
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

      if (!project || !conversation) {
        set({ currentSpec: null, historicalSpecs: [] });
        return;
      }

      if (!conversation.activeSpecId) {
        set({ currentSpec: null });
        await get().loadConversationSpecHistory();
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

        set({
          currentSpec: spec,
          initialBuildSpec:
            spec.kind === "initial_build" ? spec : get().initialBuildSpec,
        });
        await get().loadConversationSpecHistory();
        if (["approved", "building", "verifying"].includes(spec.status)) {
          void get().continueCurrentSpecExecution();
        }
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
        const results = await Promise.allSettled(
          conversation.specIds.map((specId) => specApi.readSpec(project.id, specId)),
        );

        if (
          get().currentProject?.id !== project.id ||
          get().currentConversation?.id !== conversation.id
        ) {
          return;
        }

        const specs = results
          .filter((result): result is PromiseFulfilledResult<DevelopmentSpec> =>
            result.status === "fulfilled",
          )
          .map((result) => result.value);
        const failedLoads = results.flatMap((result, index) =>
          result.status === "rejected"
            ? [
                `${conversation.specIds[index]}: ${getProjectErrorMessage(
                  result.reason,
                )}`,
              ]
            : [],
        );

        set({ historicalSpecs: specs });

        if (failedLoads.length > 0) {
          recordSpecError(
            set,
            new Error(`Failed to load Spec history: ${failedLoads.join("; ")}`),
          );
        }
      } catch (error) {
        set({ historicalSpecs: [] });
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
          await cleanupUnattachedSpec(store, project.id, spec.id);
          throw error;
        }

        set((state) => ({
          chatMessages: conversation.messages,
          conversationSummaries: upsertConversationSummary(
            state.conversationSummaries,
            conversationToSummary(conversation),
          ),
          currentConversation: conversation,
          initialBuildSpec: spec,
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

    createFeatureSpecIteration: async (projectId, title, brief) => {
      const project = get().projects.find((item) => item.id === projectId);
      const trimmedTitle = title.trim();
      const message = brief.trim();

      if (!project || !message) {
        return null;
      }

      if (isSpecWorkflowBusy(get()) || get().isCreatingConversation) {
        set({
          projectError:
            "Wait for the current Spec operation to finish before creating a new iteration.",
        });
        return null;
      }

      try {
        await ensureInitialBuildCompletedForIteration(project.id, get());
      } catch (error) {
        recordSpecError(set, error);
        return null;
      }

      const config = await keyStore.getAiProviderConfig();

      if (!config) {
        set({ projectError: "Configure your AI provider first." });
        return null;
      }

      const conversationId = createId("conv");
      const specId = createId("spec");

      set({
        isCreatingConversation: true,
        isGeneratingSpec: true,
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
          conversationId,
          kind: "feature",
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
            kind: "iteration",
            mode: "spec",
            specIds: [spec.id],
            title: trimmedTitle || spec.revisions[0]?.brief || "Spec iteration",
          });
        } catch (error) {
          await cleanupUnattachedSpec(store, project.id, spec.id);
          throw error;
        }

        set((state) => ({
          chatMessages: conversation.messages,
          conversationSummaries: upsertConversationSummary(
            state.conversationSummaries.filter((summary) => !summary.archivedAt),
            conversationToSummary(conversation),
          ),
          currentConversation: conversation,
          currentSpec: spec,
          historicalSpecs: [spec],
          showArchivedConversations: false,
          terminalLogs: appendLogs(state.terminalLogs, [
            "[spec] Feature Spec review is ready.",
          ]),
        }));

        const userMessage = createChatMessage("user", message);
        const updatedConversation = appendConversationMessage(store, userMessage);
        void persistConversation(store, updatedConversation);

        return updatedConversation ?? conversation;
      } catch (error) {
        recordSpecError(set, error);
        return null;
      } finally {
        set({
          isCreatingConversation: false,
          isGeneratingSpec: false,
        });
      }
    },

    continueCurrentSpecExecution: async () => {
      const spec = get().currentSpec;

      if (
        !spec ||
        get().isExecutingSpec ||
        !["approved", "building", "verifying"].includes(spec.status)
      ) {
        return;
      }

      set({ isExecutingSpec: true, projectError: null });

      try {
        await reconcileAndContinueSpecExecution(store, spec.id);
      } catch (error) {
        recordSpecError(set, error);
      } finally {
        set({ isExecutingSpec: false });
      }
    },

    reviseCurrentSpec: async (feedback) => {
      const project = get().currentProject;
      const conversation = get().currentConversation;
      const spec = get().currentSpec;
      const message = feedback.trim();

      if (
        !project ||
        !conversation ||
        !spec ||
        conversation.mode !== "spec" ||
        conversation.activeSpecId !== spec.id ||
        spec.status !== "review" ||
        get().isRevisingSpec ||
        !message
      ) {
        return;
      }

      const config = await keyStore.getAiProviderConfig();

      if (!config) {
        set({ projectError: "Configure your AI provider first." });
        return;
      }

      set({ isRevisingSpec: true, projectError: null });
      const revisionSnapshot = {
        conversationId: conversation.id,
        currentRevisionId: spec.currentRevisionId,
        modeChangedAt: conversation.modeChangedAt,
        projectId: project.id,
        specId: spec.id,
      };

      try {
        const revisingSpec = transitionSpecStatus(spec, "revising");
        await saveSpecToStore(store, revisingSpec);

        const currentRevision = getCurrentSpecRevision(spec);
        const payload = await requestSpecRevision({
          config,
          currentRevision,
          feedback: message,
        });

        if (!isCurrentSpecSnapshot(store, revisionSnapshot)) {
          return;
        }

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
        if (isCurrentSpecSnapshot(store, revisionSnapshot)) {
          await saveSpecToStore(store, spec).catch(() => undefined);
        }
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
        get().isExecutingSpec ||
        get().isRevisingSpec
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

      if (!spec || get().isExecutingSpec || spec.status !== "blocked") {
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

      const resetRevision = restoreRetryableTaskGraph(revision, taskId);
      const resetBase = {
        ...spec,
        currentRevisionId: resetRevision.id,
        failureMessage: undefined,
        revisions: spec.revisions.map((item) =>
          item.id === resetRevision.id ? resetRevision : item,
        ),
        updatedAt: new Date().toISOString(),
      };
      const resetSpec =
        resetBase.status === "blocked"
          ? transitionSpecStatus(resetBase, "building")
          : resetBase;

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

      if (!spec || !canRetrySpecVerification(spec)) {
        return;
      }

      set({ isVerifyingSpec: true, projectError: null });

      try {
        await verifyCompletedTasks(
          store,
          transitionSpecStatus(spec, "verifying"),
        );
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
        isSpecWorkflowBusy(get()) ||
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
        const modeSnapshot = {
          conversationId: conversation.id,
          modeChangedAt: conversation.modeChangedAt,
          projectId: project.id,
        };
        const context = await buildFeatureSpecContext(store, project.id);
        const payload = await requestFeatureSpec({
          brief: message,
          config,
          context,
        });

        if (!isCurrentModeSnapshot(store, modeSnapshot, "chat")) {
          return;
        }

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
          await cleanupUnattachedSpec(store, project.id, spec.id);
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

      if (spec.status === "revising" || get().isRevisingSpec) {
        set({
          projectError: "Wait for the Spec revision to finish before switching modes.",
        });
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
          const runForCancellation = activeRun && !isTerminalRunStatus(activeRun.status)
            ? activeRun
            : await loadRunningSpecRun(store, project.id, spec);

          if (runForCancellation) {
            if (!isRunForSpec(runForCancellation, spec)) {
              throw new Error("Active AgentRun does not belong to the current Spec task.");
            }

            if (
              isTerminalRunStatus(runForCancellation.status) &&
              runForCancellation.status !== "cancelled"
            ) {
              throw new Error("AgentRun cancellation did not reach cancelled state.");
            }

            const latestRun = runForCancellation.status === "cancelled"
              ? runForCancellation
              : await get().cancelCurrentAgentRunAndWait();

            if (latestRun?.status !== "cancelled") {
              throw new Error("AgentRun cancellation did not reach cancelled state.");
            }
          }

          nextSpec = cancelRunningTasks(spec);
        }

        if (["drafting", "review", "revising", "blocked"].includes(nextSpec.status)) {
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

async function loadRunningSpecRun(
  store: StoreAccess,
  projectId: string,
  spec: DevelopmentSpec,
) {
  const revision = getCurrentSpecRevision(spec);
  const runningTask = revision.tasks.find((task) => task.status === "running");

  if (!runningTask) {
    return null;
  }

  if (!runningTask.runId) {
    throw new Error("Running task is missing its AgentRun id.");
  }

  const run = await agentRuntimeApi.getRun(projectId, runningTask.runId);

  if (!run) {
    throw new Error(`AgentRun ${runningTask.runId} was not found.`);
  }

  store.set((state) => ({
    agentRuns: [run, ...state.agentRuns.filter((item) => item.id !== run.id)],
    currentAgentRun: run,
  }));

  return run;
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
        const blockedSpec = markSpecBlocked(
          spec,
          "Task dependencies could not advance.",
        );
        await saveSpecToStore(store, markBlockedPendingTasks(blockedSpec));
        return;
      }

      const verifyingSpec = transitionSpecStatus(spec, "verifying");
      await saveSpecToStore(store, verifyingSpec);
      await verifyCompletedTasks(store, verifyingSpec);
      return;
    }

    const runId = createId("run");
    const runningSpec = updateTask(spec, task.id, {
      error: undefined,
      runId,
      status: "running",
    });
    await saveSpecToStore(store, runningSpec);

    const runningRevision = getCurrentSpecRevision(runningSpec);
    const runningTask = runningRevision.tasks.find((item) => item.id === task.id);

    if (!runningTask) {
      throw new Error(`Spec task ${task.id} was not found.`);
    }

    const executionMode =
      runningSpec.kind === "initial_build" && isFirstTask(runningRevision, runningTask)
        ? "generate"
        : "modify";
    const contract = compileSpecTaskContract({
      executionMode,
      revision: runningRevision,
      spec: runningSpec,
      task: runningTask,
    });
    const result = await runSpecTaskRuntime({
      contract,
      conversationId: runningSpec.conversationId,
      executionMode,
      project,
      runId,
      store,
      taskObjective: runningTask.objective,
    });
    const run = result.run;
    const report = result.verificationReport;

    if (run && ["waiting_approval", "paused"].includes(run.status)) {
      return;
    }

    if (run?.status === "completed" && report?.status === "passed") {
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
    if (run?.status === "cancelled") {
      await saveSpecToStore(
        store,
        markSpecCancelled(markBlockedDownstreamTasks(failedTaskSpec, task.id)),
      );
      return;
    }

    const failedSpec = markSpecBlocked(
      markBlockedDownstreamTasks(failedTaskSpec, task.id),
      `Task ${task.title} failed.`,
    );
    await saveSpecToStore(store, failedSpec);
    return;
  }
}

async function reconcileAndContinueSpecExecution(
  store: StoreAccess,
  specId: string,
) {
  const project = store.get().currentProject;
  let spec = store.get().currentSpec;

  if (!project || !spec || spec.id !== specId) {
    return;
  }

  if (spec.status === "verifying") {
    await verifyCompletedTasks(store, spec);
    return;
  }

  if (spec.status === "approved") {
    await executeSpecTasks(store, spec.id);
    return;
  }

  if (spec.status !== "building") {
    return;
  }

  const revision = getCurrentSpecRevision(spec);
  const runningTask = revision.tasks.find((task) => task.status === "running");

  if (!runningTask) {
    await executeSpecTasks(store, spec.id);
    return;
  }

  if (!runningTask.runId) {
    await saveSpecToStore(
      store,
      markSpecBlocked(
        updateTask(spec, runningTask.id, {
          error: "Running task is missing its AgentRun id.",
          status: "failed",
        }),
        `Task ${runningTask.title} failed.`,
      ),
    );
    return;
  }

  const run = await agentRuntimeApi.getRun(project.id, runningTask.runId);

  if (!run) {
    await saveSpecToStore(
      store,
      markSpecBlocked(
        updateTask(spec, runningTask.id, {
          error: `AgentRun ${runningTask.runId} was not found.`,
          status: "failed",
        }),
        `Task ${runningTask.title} failed.`,
      ),
    );
    return;
  }

  if (!isTerminalRunStatus(run.status)) {
    return;
  }

  const report = await agentRuntimeApi
    .getLatestVerificationReport(project.id, run.id)
    .catch(() => null);

  if (run.status === "completed" && report?.status === "passed") {
    await saveSpecToStore(
      store,
      updateTask(spec, runningTask.id, {
        error: undefined,
        runId: run.id,
        status: "passed",
      }),
    );
    await executeSpecTasks(store, spec.id);
    return;
  }

  const failedTaskSpec = updateTask(spec, runningTask.id, {
    error:
      report?.repairFeedback.join("\n") ||
      report?.missingEvidence.join("\n") ||
      `AgentRun ended with status ${run.status}.`,
    runId: run.id,
    status: run.status === "cancelled" ? "cancelled" : "failed",
  });

  if (run.status === "cancelled") {
    await saveSpecToStore(
      store,
      markSpecCancelled(
        markBlockedDownstreamTasks(failedTaskSpec, runningTask.id),
      ),
    );
    return;
  }

  await saveSpecToStore(
    store,
    markSpecBlocked(
      markBlockedDownstreamTasks(failedTaskSpec, runningTask.id),
      `Task ${runningTask.title} failed.`,
    ),
  );
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
      markSpecBlocked(spec, "All tasks must pass before final verification."),
    );
    return;
  }

  const verificationReports = new Map<string, "passed" | "failed" | "pending">();

  for (const task of revision.tasks) {
    if (!task.runId) {
      continue;
    }

    const run = await agentRuntimeApi
      .getRun(project.id, task.runId)
      .catch(() => null);

    if (run?.status !== "completed") {
      verificationReports.set(task.runId, "pending");
      continue;
    }

    const report = await agentRuntimeApi
      .getLatestVerificationReport(project.id, task.runId)
      .catch(() => null);
    verificationReports.set(
      task.runId,
      report?.status === "passed" || report?.status === "failed"
        ? report.status
        : "pending",
    );
  }

  const acceptanceResults = computeAcceptanceResults(
    revision,
    verificationReports,
  );
  const requiredCriteria = revision.requirements.acceptanceCriteria.filter(
    (criterion) => criterion.required,
  );
  const failedCriteria = requiredCriteria.filter((criterion) => {
    const result = acceptanceResults.find(
      (item) => item.criterionId === criterion.id,
    );
    return result?.status !== "passed";
  });

  if (failedCriteria.length > 0) {
    const output = `Required acceptance criteria are not all passing: ${failedCriteria
      .map((criterion) => criterion.id)
      .join(", ")}.`;
    await saveSpecToStore(
      store,
      markSpecBlocked(
        markFinalVerificationFailed(spec, "acceptance criteria", output),
        output,
      ),
    );
    return;
  }

  const incompleteTaskReports = revision.tasks.filter((task) => {
    if (!task.runId) {
      return true;
    }

    return verificationReports.get(task.runId) !== "passed";
  });

  if (incompleteTaskReports.length > 0) {
    const output = `Task verification reports are not all passing: ${incompleteTaskReports
      .map((task) => task.id)
      .join(", ")}.`;
    await saveSpecToStore(
      store,
      markSpecBlocked(
        markFinalVerificationFailed(spec, "task verification reports", output),
        output,
      ),
    );
    return;
  }

  const installRequired =
    spec.kind === "initial_build" ||
    (await didSpecChangePackageJson(project.id, revision.tasks));
  const installResult = installRequired
    ? await store.get().runProjectCommand(project.id, "npm install")
    : null;

  if (installResult && !installResult.success) {
    await saveSpecToStore(
      store,
      markSpecBlocked(
        markFinalVerificationFailed(spec, "npm install", installResult.output),
        `Final npm install failed:\n${installResult.output}`,
      ),
    );
    return;
  }

  const buildResult = await store.get().runProjectCommand(project.id, "npm run build");

  if (!buildResult?.success) {
    const output = buildResult?.output ?? "No command output.";
    await saveSpecToStore(
      store,
      markSpecBlocked(
        markFinalVerificationFailed(
          spec,
          installRequired ? "npm install && npm run build" : "npm run build",
          output,
        ),
        `Final npm run build failed:\n${output}`,
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
          command: installRequired ? "npm install && npm run build" : "npm run build",
          output: [
            installResult?.output,
            buildResult.output,
          ].filter(Boolean).join("\n"),
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
    initialBuildSpec:
      saved.kind === "initial_build" ? saved : state.initialBuildSpec,
    historicalSpecs: upsertSpec(state.historicalSpecs, saved),
  }));

  return saved;
}

async function cleanupUnattachedSpec(
  store: StoreAccess,
  projectId: string,
  specId: string,
) {
  try {
    await specApi.deleteUnattachedSpec(projectId, specId);
  } catch (error) {
    const message = getProjectErrorMessage(error);

    store.set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        `[spec:error] Failed to clean up unattached Spec ${specId}: ${message}`,
      ]),
    }));
  }
}

function markFinalVerificationFailed(
  spec: DevelopmentSpec,
  command: string,
  output: string,
): DevelopmentSpec {
  return {
    ...spec,
    finalVerification: {
      checkedAt: new Date().toISOString(),
      command,
      output,
      success: false,
    },
  };
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
    initialBuildSpec:
      spec?.kind === "initial_build" ? spec : state.initialBuildSpec,
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

function restoreRetryableTaskGraph(
  revision: SpecRevision,
  taskId: string,
): SpecRevision {
  const restoreIds = new Set([taskId]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const task of revision.tasks) {
      if (
        task.status === "blocked" &&
        task.blockedByTaskId &&
        restoreIds.has(task.blockedByTaskId) &&
        !restoreIds.has(task.id)
      ) {
        restoreIds.add(task.id);
        changed = true;
      }
    }
  }

  return {
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

      if (restoreIds.has(task.id) && task.status === "blocked") {
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
}

function markBlockedDownstreamTasks(
  spec: DevelopmentSpec,
  failedTaskId: string,
): DevelopmentSpec {
  const revision = getCurrentSpecRevision(spec);
  const blockedIds = new Set([failedTaskId]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const task of revision.tasks) {
      if (
        task.status === "pending" &&
        task.dependencyIds.some((dependencyId) => blockedIds.has(dependencyId)) &&
        !blockedIds.has(task.id)
      ) {
        blockedIds.add(task.id);
        changed = true;
      }
    }
  }

  const nextRevision = {
    ...revision,
    tasks: revision.tasks.map((task) => {
      if (task.id === failedTaskId || !blockedIds.has(task.id) || task.status !== "pending") {
        return task;
      }

      const blockingDependency =
        task.dependencyIds.find((dependencyId) => blockedIds.has(dependencyId)) ??
        failedTaskId;

      return {
        ...task,
        blockedByTaskId: blockingDependency,
        error: `Blocked because dependency ${blockingDependency} failed.`,
        status: "blocked" as const,
      };
    }),
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

async function didSpecChangePackageJson(projectId: string, tasks: SpecTask[]) {
  for (const task of tasks) {
    if (!task.runId) {
      continue;
    }

    const checkpoint = await agentRuntimeApi
      .getLatestCheckpoint(projectId, task.runId)
      .catch(() => null);

    if (checkpoint?.packageChanged) {
      return true;
    }
  }

  return false;
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

function isSpecWorkflowBusy(state: AppState) {
  return Boolean(
    state.isGeneratingSpec ||
      state.isRevisingSpec ||
      state.isExecutingSpec ||
      state.isVerifyingSpec ||
      state.isSwitchingIterationMode,
  );
}

function isRunForSpec(
  run: AppState["currentAgentRun"],
  spec: DevelopmentSpec,
) {
  if (!run || run.contract.source?.mode !== "spec") {
    return false;
  }

  const revision = getCurrentSpecRevision(spec);
  const runningTask = revision.tasks.find((task) => task.status === "running");

  return (
    run.conversationId === spec.conversationId &&
    run.contract.source.specId === spec.id &&
    run.contract.source.revisionId === revision.id &&
    Boolean(runningTask) &&
    runningTask?.runId === run.id &&
    runningTask?.id === run.contract.source.taskId
  );
}

function isTerminalRunStatus(status: string) {
  return ["completed", "failed", "cancelled", "budget_exceeded"].includes(status);
}

function isCurrentSpecSnapshot(
  store: StoreAccess,
  snapshot: {
    conversationId?: string;
    currentRevisionId: string;
    modeChangedAt?: string;
    projectId: string;
    specId: string;
  },
) {
  const state = store.get();

  return (
    state.currentProject?.id === snapshot.projectId &&
    state.currentConversation?.id === snapshot.conversationId &&
    state.currentConversation?.mode === "spec" &&
    state.currentConversation?.activeSpecId === snapshot.specId &&
    state.currentConversation?.modeChangedAt === snapshot.modeChangedAt &&
    state.currentSpec?.id === snapshot.specId &&
    state.currentSpec.currentRevisionId === snapshot.currentRevisionId &&
    state.currentSpec.status !== "cancelled"
  );
}

function isCurrentModeSnapshot(
  store: StoreAccess,
  snapshot: {
    conversationId: string;
    modeChangedAt: string;
    projectId: string;
  },
  expectedMode: "chat" | "spec",
) {
  const state = store.get();

  return (
    state.currentProject?.id === snapshot.projectId &&
    state.currentConversation?.id === snapshot.conversationId &&
    state.currentConversation.mode === expectedMode &&
    state.currentConversation.modeChangedAt === snapshot.modeChangedAt
  );
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
  return !spec || isTerminalSpecStatus(spec.status) || ["drafting", "review"].includes(spec.status);
}

export const __specStoreActionsTestUtils = {
  markBlockedDownstreamTasks,
  restoreRetryableTaskGraph,
};
