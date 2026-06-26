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
import { keyStore, type AiProviderConfig } from "../services/keyStore";
import { getProjectErrorMessage } from "../services/projects";
import { agentRuntimeApi } from "../services/agentRuntime";
import { requestSpecChatAnswer } from "../spec-runtime/requests";
import { routeSpecUserMessage } from "../spec-runtime/specMessageRouter";
import {
  diagnoseSpecBlock,
  type SpecBlockDiagnosis,
} from "../spec-core/blockTriage";
import {
  getDefaultAiBaseUrl,
  getDefaultAiModel,
  DEFAULT_AI_PROVIDER,
} from "../services/aiProviders";
import {
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
    await handleReviewSpecMessage(store, message, spec);
    return;
  }

  if (spec?.status === "blocked") {
    await handleBlockedSpecMessage(store, message, spec);
    return;
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

async function handleReviewSpecMessage(
  store: StoreAccess,
  message: string,
  spec: NonNullable<AppState["currentSpec"]>,
) {
  const routed = await routeSpecUserMessage({
    message,
    spec,
    currentRevision: getCurrentSpecRevision(spec),
    conversationMessages: store.get().currentConversation?.messages.slice(-12) ?? [],
    status: spec.status,
    config: await getSpecRouterConfig(),
  });

  if (routed.intent === "approve_and_run") {
    appendSpecAssistantMessage(store, message, {
      en: "Approved. I’ll start executing this Spec now.",
      zhHans: "已确认，我现在开始执行这个 Spec。",
    });
    store.set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        "[spec] Chat intent routed to approve_and_run.",
      ]),
    }));
    await store.get().approveAndExecuteCurrentSpec();
    return;
  }

  if (
    routed.intent === "request_revision" ||
    routed.intent === "add_implementation_note"
  ) {
    if (typeof store.get().reviseCurrentSpec !== "function") {
      await answerReviewSpecQuestion(store, message, spec);
      return;
    }

    const feedback =
      routed.revisionFeedback ??
      routed.implementationNote ??
      message;
    appendSpecAssistantMessage(store, message, {
      en: "I’ll revise the Spec with that direction.",
      zhHans: "我会按这条说明修订 Spec。",
    });
    store.set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        `[spec] Chat intent routed to ${routed.intent}.`,
      ]),
    }));
    await store.get().reviseCurrentSpec(feedback);
    return;
  }

  if (routed.intent === "ask_question") {
    await answerReviewSpecQuestion(store, message, spec);
    return;
  }

  appendSpecAssistantMessage(store, message, {
    en: routed.answer ?? "Tell me whether you want to revise the Spec or approve it for execution.",
    zhHans: routed.answer ?? "你可以直接说明要修订 Spec，还是确认并开始执行。",
  });
}

async function handleBlockedSpecMessage(
  store: StoreAccess,
  message: string,
  spec: NonNullable<AppState["currentSpec"]>,
) {
  const diagnosis = await diagnoseCurrentSpecBlock(store, spec);
  const routed = await routeSpecUserMessage({
    message,
    spec,
    currentRevision: getCurrentSpecRevision(spec),
    conversationMessages: store.get().currentConversation?.messages.slice(-12) ?? [],
    status: spec.status,
    blockDiagnosis: diagnosis,
    config: await getSpecRouterConfig(),
  });

  if (routed.intent === "diagnose_block") {
    appendSpecAssistantMessage(store, message, {
      en: formatBlockDiagnosisForUser(diagnosis),
      zhHans: formatBlockDiagnosisForUser(diagnosis),
    });
    return;
  }

  if (routed.intent === "retry_with_note") {
    await applyBlockedSpecRecovery(store, diagnosis, routed.retryNote ?? message);
    return;
  }

  if (routed.intent === "request_revision") {
    appendSpecAssistantMessage(store, message, {
      en: "I’ll create a revised Spec plan from this blocked state.",
      zhHans: "我会基于当前阻塞状态创建一个新的 Spec 修订版本。",
    });
    await store.get().reviseCurrentSpec(routed.revisionFeedback ?? message);
    return;
  }

  if (routed.intent === "switch_to_chat") {
    appendSpecAssistantMessage(store, message, {
      en: "Switching this iteration back to Chat.",
      zhHans: "正在把这个迭代切回 Chat。",
    });
    await store.get().switchCurrentIterationToChat({ cancelActiveSpec: true });
    return;
  }

  if (isActionableRecovery(diagnosis)) {
    await applyBlockedSpecRecovery(store, diagnosis, "");
    return;
  }

  appendSpecAssistantMessage(store, message, {
    en: formatBlockDiagnosisForUser(diagnosis),
    zhHans: formatBlockDiagnosisForUser(diagnosis),
  });
}

async function diagnoseCurrentSpecBlock(
  store: StoreAccess,
  spec: NonNullable<AppState["currentSpec"]>,
): Promise<SpecBlockDiagnosis> {
  const revision = getCurrentSpecRevision(spec);
  const task =
    revision.tasks.find((candidate) =>
      ["failed", "blocked", "cancelled"].includes(candidate.status),
    ) ??
    revision.tasks.find((candidate) => candidate.status === "running") ??
    null;
  const latestRun = task?.runId
    ? await agentRuntimeApi.getRun(spec.projectId, task.runId).catch(() => null)
    : null;
  const latestVerificationReport = latestRun?.id
    ? await agentRuntimeApi
        .getLatestVerificationReport(spec.projectId, latestRun.id)
        .catch(() => null)
    : null;
  const diagnosis = diagnoseSpecBlock({
    spec,
    revision,
    latestRun,
    latestVerificationReport,
    projectError: store.get().projectError,
  });

  store.set((state) => ({
    currentSpec: state.currentSpec?.id === spec.id
      ? { ...state.currentSpec, blockDiagnosis: diagnosis }
      : state.currentSpec,
    historicalSpecs: (state.historicalSpecs ?? []).map((item) =>
      item.id === spec.id ? { ...item, blockDiagnosis: diagnosis } : item,
    ),
    terminalLogs: appendLogs(state.terminalLogs, [
      `[spec:block] ${diagnosis.kind}: ${diagnosis.summary}`,
      `[spec:block] recovery=${diagnosis.recommendedPlan.action}`,
    ]),
  }));

  return diagnosis;
}

async function applyBlockedSpecRecovery(
  store: StoreAccess,
  diagnosis: SpecBlockDiagnosis,
  retryNote: string,
) {
  const plan = diagnosis.recommendedPlan;

  if (plan.action === "retry_verification") {
    appendSpecAssistantMessage(store, retryNote, {
      en: "I'll retry final verification with your note in the conversation context.",
      zhHans: "我会结合你的说明重试最终验证。",
    });
    await store.get().retrySpecVerification();
    return;
  }

  if (plan.action === "retry_task" || plan.action === "expand_scope_and_retry") {
    const taskTitle = getSpecRecoveryTaskTitle(store, plan.taskId);
    appendSpecAssistantMessage(store, retryNote, {
      en: `I'll retry ${taskTitle} with your note in the conversation context.`,
      zhHans: "我会带上你的说明重试这个阻塞任务。",
    });
    store.set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        `[spec] Chat message requested retry for task ${plan.taskId}.`,
      ]),
    }));
    if (retryNote.trim()) {
      await store.get().retrySpecTask(plan.taskId, retryNote);
    } else {
      await store.get().retrySpecTask(plan.taskId);
    }
    return;
  }

  if (plan.action === "revise_spec") {
    if (typeof store.get().reviseCurrentSpec !== "function") {
      appendSpecAssistantMessage(store, retryNote, {
        en: "This Spec is blocked. Retry the failed task from the Spec summary, or request a revision if the plan needs to change.",
        zhHans:
          "这个 Spec 已经阻塞。可以在 Spec 摘要里重试失败任务；如果计划需要调整，请请求修订。",
      });
      return;
    }

    appendSpecAssistantMessage(store, retryNote, {
      en: "This looks like a plan issue, so I’ll revise the Spec instead of blindly retrying.",
      zhHans: "这更像是计划问题，我会修订 Spec，而不是直接重试。",
    });
    await store.get().reviseCurrentSpec(plan.feedback);
    return;
  }

  if (plan.action === "continue_in_chat") {
    appendSpecAssistantMessage(store, retryNote, {
      en: plan.reason,
      zhHans: plan.reason,
    });
    await store.get().switchCurrentIterationToChat({ cancelActiveSpec: true });
    return;
  }

  appendSpecAssistantMessage(store, retryNote, {
    en: plan.question,
    zhHans: plan.question,
  });
}

function getSpecRecoveryTaskTitle(store: StoreAccess, taskId: string) {
  const spec = store.get().currentSpec;

  if (!spec) {
    return "the blocked task";
  }

  const task = getCurrentSpecRevision(spec).tasks.find((item) => item.id === taskId);

  return task?.title ?? "the blocked task";
}

function appendSpecAssistantMessage(
  store: StoreAccess,
  userMessage: string,
  message: { en: string; zhHans: string },
) {
  const assistantMessage = createChatMessage(
    "assistant",
    localizeUserFacingMessage(userMessage, message),
  );
  const conversation = appendConversationMessage(store, assistantMessage);
  void persistConversation(store, conversation);
}

async function getSpecRouterConfig(): Promise<AiProviderConfig> {
  return {
    provider: DEFAULT_AI_PROVIDER,
    apiKeyConfigured: false,
    model: getDefaultAiModel(DEFAULT_AI_PROVIDER),
    models: [getDefaultAiModel(DEFAULT_AI_PROVIDER)],
    baseUrl: getDefaultAiBaseUrl(DEFAULT_AI_PROVIDER),
    updatedAt: "",
  };
}

function isActionableRecovery(diagnosis: SpecBlockDiagnosis) {
  return [
    "retry_task",
    "expand_scope_and_retry",
    "retry_verification",
    "revise_spec",
  ].includes(diagnosis.recommendedPlan.action);
}

function formatBlockDiagnosisForUser(diagnosis: SpecBlockDiagnosis) {
  return [
    `Block kind: ${diagnosis.kind}`,
    diagnosis.summary,
    `Recovery plan: ${diagnosis.recommendedPlan.action}`,
  ].join("\n");
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
