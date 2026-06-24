import type {
  AgentApproval,
  AgentApprovalDecision,
  AgentRun,
  VerificationReport,
} from "../agent-core/types";
import {
  getLegalRunTransitions,
  RunStateMachine,
} from "../agent-core/runtime/runStateMachine";
import { agentRuntimeApi } from "../services/agentRuntime";
import { getProjectErrorMessage } from "../services/projects";
import {
  modifyCurrentProjectRuntime,
  runSpecTaskRuntime,
} from "../agent-runtime/runController";
import {
  isRunControllerActive,
  requestRunAbort,
} from "../agent-runtime/agentRunControl";
import type { AppState } from "./appStore";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

type AgentRunActions = Pick<
  AppState,
  | "cancelCurrentAgentRun"
  | "cancelCurrentAgentRunAndWait"
  | "approveCurrentAgentApproval"
  | "clearSelectedSiteNode"
  | "denyCurrentAgentApproval"
  | "loadAgentRuns"
  | "pauseCurrentAgentRun"
  | "recoverCurrentAgentRun"
  | "resumeCurrentAgentRun"
  | "sendAgentSteering"
  | "setSelectedSiteNode"
>;

const stateMachine = new RunStateMachine();

export function createAgentRunActions({ get, set }: StoreAccess): AgentRunActions {
  const store = { get, set };

  return {
    approveCurrentAgentApproval: () => resolveCurrentAgentApproval(store, "approved"),

    cancelCurrentAgentRun: async () => {
      const project = get().currentProject;
      const run = get().currentAgentRun;

      if (!project || !run || isTerminalRun(run)) {
        return;
      }

      try {
        assertCurrentSpecRunControl(get(), run);
        const persistedRun = await agentRuntimeApi.getRun(project.id, run.id) ?? run;
        const result = stateMachine.transition(persistedRun, { type: "request_cancel" });
        const { run: nextRun, event } = await agentRuntimeApi.transitionRun(
          project.id,
          persistedRun,
          result,
        );
        const hasActiveController = requestRunAbort(run.id);

        if (hasActiveController) {
          set((state) => ({
            agentEvents: [...state.agentEvents, event],
            agentRuns: [
              nextRun,
              ...state.agentRuns.filter((item) => item.id !== nextRun.id),
            ],
            currentAgentRun: nextRun,
            terminalLogs: appendLogs(state.terminalLogs, [
              `[agent] Cancel requested for run ${run.id}`,
            ]),
          }));
          return;
        }

        const cancelResult = stateMachine.transition(nextRun, { type: "cancel" });
        const { run: cancelledRun, event: cancelEvent } =
          await agentRuntimeApi.transitionRun(project.id, nextRun, cancelResult);

        set((state) => ({
          agentEvents: [...state.agentEvents, event, cancelEvent],
          agentRuns: [
            cancelledRun,
            ...state.agentRuns.filter((item) => item.id !== cancelledRun.id),
          ],
          currentAgentApproval: null,
          currentAgentRun: cancelledRun,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[agent] Run ${run.id} cancelled.`,
          ]),
        }));
      } catch (error) {
        recordAgentActionError(set, error);
      }
    },

    cancelCurrentAgentRunAndWait: async () => {
      const project = get().currentProject;
      const run = get().currentAgentRun;

      if (!project || !run) {
        return null;
      }

      assertCurrentSpecRunControl(get(), run);

      if (isTerminalRun(run)) {
        return run;
      }

      await get().cancelCurrentAgentRun();
      return waitForTerminalRun(store, project.id, run.id);
    },

    clearSelectedSiteNode: () => {
      set({ selectedSiteNodeId: null });
    },

    loadAgentRuns: async (projectId) => {
      try {
        const runs = await agentRuntimeApi.listRuns(projectId);
        const currentRun = selectCurrentAgentRun(runs, get());
        const [events, report, approvals] = currentRun
          ? await Promise.all([
              agentRuntimeApi.listEvents(projectId, currentRun.id),
              agentRuntimeApi.getLatestVerificationReport(projectId, currentRun.id),
              agentRuntimeApi.listApprovals(projectId, currentRun.id),
            ])
          : [[], null as VerificationReport | null, [] as AgentApproval[]];

        set({
          agentEvents: events,
          agentRuns: runs,
          currentAgentApproval: selectApprovalForRun(currentRun, approvals),
          currentAgentRun: currentRun,
          currentVerificationReport: report,
        });
      } catch (error) {
        recordAgentActionError(set, error);
      }
    },

    denyCurrentAgentApproval: () => resolveCurrentAgentApproval(store, "denied"),

    pauseCurrentAgentRun: async () => {
      const project = get().currentProject;
      const run = get().currentAgentRun;

      if (
        !project ||
        !run ||
        isTerminalRun(run) ||
        !isRunControllerActive(run.id) ||
        !getLegalRunTransitions(run.status).includes("request_pause")
      ) {
        return;
      }

      try {
        assertCurrentSpecRunControl(get(), run);
        const result = stateMachine.transition(run, { type: "request_pause" });
        const { run: nextRun, event } = await agentRuntimeApi.transitionRun(
          project.id,
          run,
          result,
        );
        set((state) => ({
          agentEvents: [...state.agentEvents, event],
          agentRuns: [
            nextRun,
            ...state.agentRuns.filter((item) => item.id !== nextRun.id),
          ],
          currentAgentRun: nextRun,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[agent] Pause requested for run ${run.id}`,
          ]),
        }));
      } catch (error) {
        recordAgentActionError(set, error);
      }
    },

    recoverCurrentAgentRun: () => recoverCurrentAgentRun(store),

    resumeCurrentAgentRun: () => recoverCurrentAgentRun(store),

    sendAgentSteering: async (content) => {
      const project = get().currentProject;
      const run = get().currentAgentRun;
      const message = content.trim();

      if (!project || !run || isTerminalRun(run) || !message) {
        return;
      }

      try {
        assertCurrentSpecRunControl(get(), run);
        const event = await agentRuntimeApi.appendEvent(project.id, {
          runId: run.id,
          type: "steering.received",
          timestamp: new Date().toISOString(),
          payload: { content: message },
        });
        set((state) => ({
          agentEvents: [...state.agentEvents, event],
          terminalLogs: appendLogs(state.terminalLogs, [
            `[agent] Steering received for run ${run.id}`,
          ]),
        }));

        if (!isRunControllerActive(run.id)) {
          await get().resumeCurrentAgentRun();
        }
      } catch (error) {
        recordAgentActionError(set, error);
      }
    },

    setSelectedSiteNode: (nodeId) => {
      set({ selectedSiteNodeId: nodeId });
    },
  };
}

async function recoverCurrentAgentRun(store: StoreAccess) {
  const { get } = store;
  const project = get().currentProject;
  const run = get().currentAgentRun;

  if (!project || !run || isTerminalRun(run) || isRunControllerActive(run.id)) {
    return;
  }

  if (!validateCurrentSpecRunControl(store, run)) {
    return;
  }

  if (run.contract.source?.mode === "spec") {
    await runSpecTaskRuntime({
      contract: run.contract,
      conversationId: run.conversationId,
      executionMode: run.contract.source.executionMode ?? "modify",
      existingRun: run,
      project,
      store,
      taskObjective: run.contract.objective,
    });
    await get().continueCurrentSpecExecution();
    return;
  }

  await modifyCurrentProjectRuntime(store, run.contract.objective, {
    existingRun: run,
  });
}

async function resolveCurrentAgentApproval(
  store: StoreAccess,
  decision: AgentApprovalDecision,
) {
  const { get, set } = store;
  const project = get().currentProject;
  const run = get().currentAgentRun;
  const approval = get().currentAgentApproval;

  if (!project || !run || !approval || run.status !== "waiting_approval") {
    return;
  }

  try {
    assertCurrentSpecRunControl(get(), run);
    assertApprovalBelongsToRun(run, approval);
    const resolved = await agentRuntimeApi.resolveApproval(
      project.id,
      run.id,
      approval.id,
      decision,
    );

    set((state) => ({
      agentRuns: [run, ...state.agentRuns.filter((item) => item.id !== run.id)],
      currentAgentApproval: null,
      currentAgentRun: run,
      terminalLogs: appendLogs(state.terminalLogs, [
        `[agent] Approval ${decision} for ${approval.toolName}`,
      ]),
    }));

    const resumeObservation =
      decision === "denied"
        ? {
            content: [
              `Approval denied for ${approval.toolName}.`,
              `Reason: ${resolved.exactSideEffect}`,
              "Choose a non-destructive alternative, request a different approval, or explain why the task cannot continue.",
            ].join("\n"),
            ok: false,
            step: 1,
            summary: `Approval denied for ${approval.toolName}.`,
            tool: approval.toolName,
          }
        : undefined;

    if (run.contract.source?.mode === "spec") {
      await runSpecTaskRuntime({
        contract: run.contract,
        conversationId: run.conversationId,
        executionMode: run.contract.source.executionMode ?? "modify",
        existingRun: run,
        project,
        resumeObservation,
        store,
        taskObjective: run.contract.objective,
      });
      await get().continueCurrentSpecExecution();
      return;
    }

    await modifyCurrentProjectRuntime(store, run.contract.objective, {
      existingRun: run,
      resumeObservation,
    });
  } catch (error) {
    recordAgentActionError(set, error);
  }
}

function isTerminalRun(run: AgentRun) {
  return ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status);
}

function selectCurrentAgentRun(runs: AgentRun[], state: AppState) {
  return (
    runs.find((run) => isCurrentSpecRun(state, run)) ??
    runs.find((run) => !isTerminalRun(run)) ??
    runs[0] ??
    null
  );
}

function validateCurrentSpecRunControl(store: StoreAccess, run: AgentRun) {
  try {
    assertCurrentSpecRunControl(store.get(), run);
    return true;
  } catch (error) {
    recordAgentActionError(store.set, error);
    return false;
  }
}

function assertCurrentSpecRunControl(state: AppState, run: AgentRun) {
  if (run.contract.source?.mode !== "spec" && state.currentConversation?.mode !== "spec") {
    return;
  }

  if (!isCurrentSpecRun(state, run)) {
    throw new Error("AgentRun does not belong to the current Spec task.");
  }
}

function assertApprovalBelongsToRun(run: AgentRun, approval: AgentApproval) {
  if (approval.runId !== run.id) {
    throw new Error("Approval does not belong to the current AgentRun.");
  }
}

function isCurrentSpecRun(state: AppState, run: AgentRun) {
  const conversation = state.currentConversation;
  const spec = state.currentSpec;
  const source = run.contract.source;

  if (!conversation || !spec || source?.mode !== "spec") {
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

async function waitForTerminalRun(
  store: StoreAccess,
  projectId: string,
  runId: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const run = await agentRuntimeApi.getRun(projectId, runId);

    if (!run) {
      return null;
    }

    store.set((state) => ({
      agentRuns: [run, ...state.agentRuns.filter((item) => item.id !== run.id)],
      currentAgentRun: run,
    }));

    if (isTerminalRun(run)) {
      return run;
    }

    await delay(300);
  }

  throw new Error(`AgentRun ${runId} did not reach a terminal state after cancellation.`);
}

function delay(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function selectApprovalForRun(
  run: AgentRun | null,
  approvals: AgentApproval[],
): AgentApproval | null {
  if (!run || run.status !== "waiting_approval") {
    return null;
  }

  return [...approvals]
    .sort(compareApprovalsDescending)
    .find((approval) => !approval.consumedAt) ?? null;
}

function compareApprovalsDescending(left: AgentApproval, right: AgentApproval) {
  const leftTime = new Date(left.createdAt).getTime();
  const rightTime = new Date(right.createdAt).getTime();

  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return right.id.localeCompare(left.id);
}

function recordAgentActionError(
  set: StoreAccess["set"],
  error: unknown,
) {
  const message = getProjectErrorMessage(error);

  set((state) => ({
    projectError: message,
    terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${message}`]),
  }));
}
