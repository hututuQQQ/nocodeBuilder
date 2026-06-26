import { modifyCurrentProject } from "./agentWorkflow";
import { buildProjectBackendContext } from "../agent/project/backendContext";
import type { AppState } from "./appStore";
import { createChatMessage } from "./chatMessages";
import { appendLogs } from "./commandLogs";
import {
  appendConversationMessage,
  persistConversation,
} from "./conversationState";
import type { StoreAccess } from "./storeAccess";
import type { DevelopmentSpec, SpecTask } from "../spec-core/types";
import { keyStore } from "../services/keyStore";
import { getProjectErrorMessage } from "../services/projects";
import { requestSpecChatAnswer } from "../spec-runtime/requests";
import {
  canRetrySpecVerification,
  getCurrentSpecRevision,
} from "../spec-core/validators";
import { localizeUserFacingMessage } from "../agent/languagePolicy";

type ChatActions = Pick<AppState, "sendMessage">;

export function createChatActions({ get, set }: StoreAccess): ChatActions {
  const store = { get, set };

  return {
    sendMessage: async (content) => {
      const message = content.trim();

      if (!message) {
        return;
      }

      if (!get().currentProject) {
        return;
      }

      if (get().currentConversation?.archivedAt) {
        return;
      }

      if (!get().currentConversation) {
        set((state) => ({
          projectError: localizeUserFacingMessage(message, {
            en: "Create a new iteration before sending chat messages.",
            zhHans: "发送聊天消息前，请先创建一个新的迭代。",
          }),
          terminalLogs: appendLogs(state.terminalLogs, [
            "[chat] No active iteration is available for this message.",
          ]),
        }));
        return;
      }

      if (get().currentConversation?.mode === "spec") {
        if (get().isRevisingSpec) {
          set((state) => ({
            projectError: localizeUserFacingMessage(message, {
              en: "Wait for the Spec revision to finish before sending messages.",
              zhHans: "请等 Spec 修订完成后再发送消息。",
            }),
            terminalLogs: appendLogs(state.terminalLogs, [
              "[spec] Message blocked while revision is in progress.",
            ]),
          }));
          return;
        }

        if (isSpecMessageBlockedByWorkflow(get())) {
          set((state) => ({
            projectError: localizeUserFacingMessage(message, {
              en: "Wait for the active Spec operation to finish before sending messages.",
              zhHans: "请等当前 Spec 操作完成后再发送消息。",
            }),
            terminalLogs: appendLogs(state.terminalLogs, [
              "[spec] Message blocked while a Spec operation is in progress.",
            ]),
          }));
          return;
        }

        await handleSpecConversationMessage(store, message);
        return;
      }

      const activeRun = get().currentAgentRun;

      if (activeRun && !isTerminalRun(activeRun)) {
        const userMessage = createChatMessage("user", message);
        const conversation = appendConversationMessage(store, userMessage);
        void persistConversation(store, conversation);
        await get().sendAgentSteering(message);

        set((state) => ({
          terminalLogs: appendLogs(state.terminalLogs, [
            `[chat] Added message as steering for run ${activeRun.id}.`,
          ]),
        }));

        return;
      }

      if (
        get().isModifyingProject ||
        get().isGeneratingProject
      ) {
        const userMessage = createChatMessage("user", message);
        const conversation = appendConversationMessage(store, userMessage);
        void persistConversation(store, conversation);
        await get().sendAgentSteering(message);

        return;
      }

      if (get().changeHistory.length > 0) {
        set((state) => ({
          terminalLogs: appendLogs(state.terminalLogs, [
            "[chat] Continuing from the current draft; pending changes were not auto-accepted.",
          ]),
        }));
      }

      const userMessage = createChatMessage("user", message);
      const conversation = appendConversationMessage(store, userMessage);
      void persistConversation(store, conversation);

      set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [`[chat] ${message}`]),
      }));

      await modifyCurrentProject(store, message);
    },
  };
}

async function handleSpecConversationMessage(
  store: StoreAccess,
  message: string,
) {
  const { get, set } = store;
  const userMessage = createChatMessage("user", message);
  const conversation = appendConversationMessage(store, userMessage);
  void persistConversation(store, conversation);

  const spec = get().currentSpec;
  const activeRun = get().currentAgentRun;

  if (
    spec &&
    ["approved", "building"].includes(spec.status) &&
    activeRun &&
    !isTerminalRun(activeRun)
  ) {
    if (!isCurrentSpecTaskRun(get(), activeRun)) {
      const assistantMessage = createChatMessage(
        "assistant",
        localizeUserFacingMessage(message, {
          en: "The active AgentRun is not attached to the current Spec task, so this message was not applied as steering. Wait for the Spec state to reconcile or use the Spec controls.",
          zhHans:
            "当前 AgentRun 没有关联到这个 Spec 任务，所以这条消息没有作为 steering 应用。请等待 Spec 状态同步，或使用 Spec 控件继续。",
        }),
      );
      const nextConversation = appendConversationMessage(store, assistantMessage);
      void persistConversation(store, nextConversation);
      set((state) => ({
        projectError: localizeUserFacingMessage(message, {
          en: "AgentRun does not belong to the current Spec task.",
          zhHans: "AgentRun 不属于当前 Spec 任务。",
        }),
        terminalLogs: appendLogs(state.terminalLogs, [
          "[spec] Steering blocked because the active AgentRun does not belong to the current Spec task.",
        ]),
      }));
      return;
    }

    await get().sendAgentSteering(message);
    const assistantMessage = createChatMessage(
      "assistant",
      localizeUserFacingMessage(message, {
        en: "I sent this to the running Spec task as steering. The agent will use it on the next model step.",
        zhHans:
          "我已把这条消息发送给正在运行的 Spec 任务作为 steering，AI 会在下一步参考它。",
      }),
    );
    const nextConversation = appendConversationMessage(store, assistantMessage);
    void persistConversation(store, nextConversation);
    set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        `[spec] Added message as steering for run ${activeRun.id}.`,
      ]),
    }));
    return;
  }

  if (spec && ["approved", "building"].includes(spec.status)) {
    const before = getSpecExecutionSnapshot(spec);
    const assistantMessage = createChatMessage(
      "assistant",
      localizeUserFacingMessage(message, {
        en: "I found no live Spec task run that can accept steering. I am syncing the Spec state now and checking whether the current task can be retried.",
        zhHans:
          "我没有找到可接收 steering 的实时 Spec 任务运行。现在会同步 Spec 状态，并检查当前任务是否可以重试。",
      }),
    );
    const nextConversation = appendConversationMessage(store, assistantMessage);
    void persistConversation(store, nextConversation);
    set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        "[spec] Chat message requested execution reconciliation.",
      ]),
    }));
    await get().retryCurrentSpecTaskExecution();
    const resultMessage = describeSpecExecutionReconcileResult(
      before,
      get(),
      message,
    );
    const resultAssistantMessage = createChatMessage("assistant", resultMessage);
    const resultConversation = appendConversationMessage(
      store,
      resultAssistantMessage,
    );
    void persistConversation(store, resultConversation);
    return;
  }

  if (spec?.status === "review") {
    await answerReviewSpecQuestion(store, message, spec);
    return;
  }

  if (spec?.status === "blocked") {
    const recovery = getBlockedSpecChatRecovery(spec);

    if (recovery?.type === "verification") {
      const assistantMessage = createChatMessage(
        "assistant",
        localizeUserFacingMessage(message, {
          en: "I'll retry final verification with your note in the conversation context.",
          zhHans: "我会结合你在对话里的说明，重试最终验证。",
        }),
      );
      const nextConversation = appendConversationMessage(store, assistantMessage);
      void persistConversation(store, nextConversation);
      set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [
          "[spec] Chat message requested final verification retry.",
        ]),
      }));
      await get().retrySpecVerification();
      return;
    }

    if (recovery?.type === "task") {
      const assistantMessage = createChatMessage(
        "assistant",
        localizeUserFacingMessage(message, {
          en: `I'll retry ${recovery.task.title} with your note in the conversation context.`,
          zhHans: `我会结合你在对话里的说明，重试 ${recovery.task.title}。`,
        }),
      );
      const nextConversation = appendConversationMessage(store, assistantMessage);
      void persistConversation(store, nextConversation);
      set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [
          `[spec] Chat message requested retry for task ${recovery.task.id}.`,
        ]),
      }));
      await get().retrySpecTask(recovery.task.id);
      return;
    }
  }

  const guidance = spec
    ? guidanceForSpecStatus(spec.status, message)
    : localizeUserFacingMessage(message, {
        en: "Spec mode is active. Use the Spec review controls to continue.",
        zhHans: "当前处于 Spec 模式。请使用 Spec 审查控件继续。",
      });
  const assistantMessage = createChatMessage("assistant", guidance);
  const nextConversation = appendConversationMessage(store, assistantMessage);
  void persistConversation(store, nextConversation);
}

async function answerReviewSpecQuestion(
  store: StoreAccess,
  message: string,
  spec: NonNullable<AppState["currentSpec"]>,
) {
  const { get, set } = store;
  const config = await keyStore.getAiProviderConfig();

  if (!config) {
    const assistantMessage = createChatMessage(
      "assistant",
      localizeUserFacingMessage(message, {
        en: "Configure your AI provider first, then I can answer questions about this Spec.",
        zhHans: "请先配置 AI provider，然后我就可以回答这个 Spec 相关的问题。",
      }),
    );
    const nextConversation = appendConversationMessage(store, assistantMessage);
    void persistConversation(store, nextConversation);
    set({ projectError: "Configure your AI provider first." });
    return;
  }

  try {
    const projectId = get().currentProject?.id ?? spec.projectId;
    const answer = await requestSpecChatAnswer({
      config,
      conversationMessages: get().currentConversation?.messages.slice(-12) ?? [],
      currentRevision: getCurrentSpecRevision(spec),
      planningContext: await buildSpecChatPlanningContext(projectId),
      question: message,
    });
    const assistantMessage = createChatMessage("assistant", answer);
    const nextConversation = appendConversationMessage(store, assistantMessage);
    void persistConversation(store, nextConversation);
    set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        "[spec] Answered review question with model context.",
      ]),
    }));
  } catch (error) {
    const details = getProjectErrorMessage(error);
    const assistantMessage = createChatMessage(
      "assistant",
      localizeUserFacingMessage(message, {
        en: `I could not answer this Spec question: ${details}`,
        zhHans: `我暂时没法回答这个 Spec 问题：${details}`,
      }),
    );
    const nextConversation = appendConversationMessage(store, assistantMessage);
    void persistConversation(store, nextConversation);
    set({ projectError: details });
  }
}

async function buildSpecChatPlanningContext(projectId: string) {
  try {
    return {
      backendContext: await buildProjectBackendContext(projectId, {
        includeSchema: true,
      }),
    };
  } catch (error) {
    return {
      backendContextError: getProjectErrorMessage(error),
    };
  }
}

function getBlockedSpecChatRecovery(spec: NonNullable<AppState["currentSpec"]>):
  | { type: "task"; task: SpecTask }
  | { type: "verification" }
  | null {
  if (canRetrySpecVerification(spec)) {
    return { type: "verification" };
  }

  const revision = getCurrentSpecRevision(spec);
  const task =
    revision.tasks.find((candidate) =>
      canRetrySpecTaskFromChat(candidate, revision.tasks),
    ) ?? null;

  return task ? { task, type: "task" } : null;
}

function canRetrySpecTaskFromChat(
  task: SpecTask,
  tasks: SpecTask[],
) {
  if (task.status === "failed" || task.status === "cancelled") {
    return true;
  }

  if (task.status !== "blocked") {
    return false;
  }

  return task.dependencyIds.every((dependencyId) =>
    tasks.some(
      (candidate) =>
        candidate.id === dependencyId && candidate.status === "passed",
    ),
  );
}

function guidanceForSpecStatus(status: string, userMessage: string) {
  switch (status) {
    case "review":
      return localizeUserFacingMessage(userMessage, {
        en: "Use Request revision to change this Spec, or Approve and start build when it is ready.",
        zhHans:
          "使用 Request revision 修改这个 Spec，或者在准备好后点击 Approve 并开始构建。",
      });
    case "revising":
    case "drafting":
      return localizeUserFacingMessage(userMessage, {
        en: "Spec generation is already in progress.",
        zhHans: "Spec 正在生成中。",
      });
    case "approved":
    case "building":
      return localizeUserFacingMessage(userMessage, {
        en: "This Spec is still executing, but there is no current task run to steer. The executor may be preparing the next step or an automatic retry; watch the task and run status above.",
        zhHans:
          "这个 Spec 仍在执行，但当前没有可接收 steering 的任务运行。执行器可能正在准备下一步或自动重试，请看上方任务/运行状态。",
      });
    case "verifying":
      return localizeUserFacingMessage(userMessage, {
        en: "Final verification is running. Wait for the result before changing modes.",
        zhHans: "最终验证正在运行。请等待结果后再切换模式。",
      });
    case "blocked":
      return localizeUserFacingMessage(userMessage, {
        en: "This Spec is blocked. Retry the failed task from the Spec summary, or request a revision if the plan needs to change.",
        zhHans:
          "这个 Spec 已经阻塞。可以在 Spec 摘要里重试失败任务；如果计划需要调整，请请求修订。",
      });
    case "completed":
      return localizeUserFacingMessage(userMessage, {
        en: "This Spec is complete. Switch to Chat or create a new iteration for follow-up work.",
        zhHans: "这个 Spec 已完成。请切换到 Chat，或创建新迭代继续后续工作。",
      });
    case "failed":
    case "cancelled":
      return localizeUserFacingMessage(userMessage, {
        en: "This Spec cannot be resumed with a normal message. Switch to Chat or retry a failed task when available.",
        zhHans:
          "这个 Spec 不能通过普通消息恢复。请切换到 Chat，或在可用时重试失败任务。",
      });
    default:
      return localizeUserFacingMessage(userMessage, {
        en: "Spec mode is active. Use the Spec controls to continue.",
        zhHans: "当前处于 Spec 模式。请使用 Spec 控件继续。",
      });
  }
}

type SpecExecutionSnapshot = {
  runningTask: Pick<SpecTask, "id" | "runId" | "status" | "title"> | null;
  specId: string;
  specStatus: DevelopmentSpec["status"];
  tasks: Array<Pick<SpecTask, "error" | "id" | "runId" | "status" | "title">>;
};

function getSpecExecutionSnapshot(spec: DevelopmentSpec): SpecExecutionSnapshot {
  const revision = getCurrentSpecRevision(spec);
  const tasks = revision.tasks.map((task) => ({
    error: task.error,
    id: task.id,
    runId: task.runId,
    status: task.status,
    title: task.title,
  }));

  return {
    runningTask:
      tasks.find((task) => task.status === "running") ?? null,
    specId: spec.id,
    specStatus: spec.status,
    tasks,
  };
}

function describeSpecExecutionReconcileResult(
  before: SpecExecutionSnapshot,
  state: AppState,
  userMessage: string,
) {
  const spec = state.currentSpec;

  if (!spec || spec.id !== before.specId) {
    return localizeUserFacingMessage(userMessage, {
      en: "Spec sync finished, but the active Spec changed before I could verify the retry result.",
      zhHans: "Spec 同步已结束，但当前 Spec 已切换，所以我没法确认这次重试结果。",
    });
  }

  const after = getSpecExecutionSnapshot(spec);
  const beforeRunning = before.runningTask;
  const afterRunning = after.runningTask;

  if (
    afterRunning?.runId &&
    afterRunning.runId !== beforeRunning?.runId
  ) {
    return localizeUserFacingMessage(userMessage, {
      en: `Synced and retried ${afterRunning.title}. New AgentRun: ${afterRunning.runId}.`,
      zhHans: `已同步状态并重试 ${afterRunning.title}。新的 AgentRun 是 ${afterRunning.runId}。`,
    });
  }

  const knownRuns = state.currentAgentRun
    ? [state.currentAgentRun, ...state.agentRuns]
    : state.agentRuns;
  const terminalRunForRunningTask =
    afterRunning?.runId
      ? knownRuns.find(
          (run) =>
            run.id === afterRunning.runId &&
            ["completed", "failed", "cancelled", "budget_exceeded"].includes(
              run.status,
            ),
        )
      : null;

  if (afterRunning?.runId && terminalRunForRunningTask) {
    return localizeUserFacingMessage(userMessage, {
      en: `Spec sync did not start a retry. ${afterRunning.title} still points at terminal AgentRun ${afterRunning.runId} (${terminalRunForRunningTask.status}).`,
      zhHans: `Spec 同步没有启动重试。${afterRunning.title} 仍然指向已结束的 AgentRun ${afterRunning.runId}（${terminalRunForRunningTask.status}）。`,
    });
  }

  if (afterRunning?.runId) {
    return localizeUserFacingMessage(userMessage, {
      en: `Synced state. ${afterRunning.title} is still running on AgentRun ${afterRunning.runId}.`,
      zhHans: `已同步状态。${afterRunning.title} 仍在运行，AgentRun 是 ${afterRunning.runId}。`,
    });
  }

  const failedTask =
    after.tasks.find((task) =>
      ["failed", "cancelled", "blocked"].includes(task.status),
    ) ?? null;

  if (failedTask) {
    const detail = failedTask.error ? `: ${failedTask.error}` : ".";
    return localizeUserFacingMessage(userMessage, {
      en: `Synced state. ${failedTask.title} is ${failedTask.status}${detail}`,
      zhHans: `已同步状态。${failedTask.title} 当前是 ${failedTask.status}${detail}`,
    });
  }

  if (spec.status === "verifying") {
    return localizeUserFacingMessage(userMessage, {
      en: "Synced state. All tasks are done and final verification is running.",
      zhHans: "已同步状态。所有任务已完成，正在进行最终验证。",
    });
  }

  if (spec.status === "completed") {
    return localizeUserFacingMessage(userMessage, {
      en: "Synced state. This Spec is already complete.",
      zhHans: "已同步状态。这个 Spec 已经完成。",
    });
  }

  if (state.projectError) {
    return localizeUserFacingMessage(userMessage, {
      en: `Spec sync did not start a retry: ${state.projectError}`,
      zhHans: `Spec 同步没有启动重试：${state.projectError}`,
    });
  }

  const previousRun = beforeRunning?.runId
    ? ` Previous AgentRun: ${beforeRunning.runId}.`
    : "";

  return localizeUserFacingMessage(userMessage, {
    en: `Spec sync finished, but no retry started.${previousRun}`,
    zhHans: `Spec 同步已结束，但没有启动新的重试。${beforeRunning?.runId ? `上一个 AgentRun 是 ${beforeRunning.runId}。` : ""}`,
  });
}

function isTerminalRun(run: AppState["currentAgentRun"]) {
  return (
    !run ||
    ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status)
  );
}

function isSpecMessageBlockedByWorkflow(state: AppState) {
  return Boolean(
    state.isGeneratingSpec ||
      state.isVerifyingSpec ||
      state.isSwitchingIterationMode,
  );
}

function isCurrentSpecTaskRun(state: AppState, run: AppState["currentAgentRun"]) {
  const conversation = state.currentConversation;
  const spec = state.currentSpec;
  const source = run?.contract.source;

  if (!run || !conversation || !spec || source?.mode !== "spec") {
    return false;
  }

  const revision = spec.revisions.find(
    (item) => item.id === spec.currentRevisionId,
  );
  const runningTask = revision?.tasks.find((task) => task.status === "running");

  return (
    conversation.mode === "spec" &&
    conversation.activeSpecId === spec.id &&
    run.conversationId === conversation.id &&
    source.specId === spec.id &&
    source.revisionId === revision?.id &&
    Boolean(runningTask) &&
    runningTask?.runId === run.id &&
    source.taskId === runningTask?.id
  );
}
