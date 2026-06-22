import type { AgentRun, VerificationReport } from "../agent-core/types";
import { RunStateMachine } from "../agent-core/runtime/runStateMachine";
import { agentRuntimeApi } from "../services/agentRuntime";
import { getProjectErrorMessage } from "../services/projects";
import { modifyCurrentProjectRuntime } from "../agent-runtime/runController";
import { requestRunAbort } from "../agent-runtime/agentRunControl";
import type { AppState } from "./appStore";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

type AgentRunActions = Pick<
  AppState,
  | "cancelCurrentAgentRun"
  | "clearSelectedSiteNode"
  | "loadAgentRuns"
  | "pauseCurrentAgentRun"
  | "resumeCurrentAgentRun"
  | "sendAgentSteering"
  | "setSelectedSiteNode"
>;

const stateMachine = new RunStateMachine();

export function createAgentRunActions({ get, set }: StoreAccess): AgentRunActions {
  const store = { get, set };

  return {
    cancelCurrentAgentRun: async () => {
      const project = get().currentProject;
      const run = get().currentAgentRun;

      if (!project || !run || isTerminalRun(run)) {
        return;
      }

      try {
        const result = stateMachine.transition(run, { type: "request_cancel" });
        const { run: nextRun, event } = await agentRuntimeApi.transitionRun(
          project.id,
          run,
          result,
        );
        requestRunAbort(run.id);
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
      } catch (error) {
        recordAgentActionError(set, error);
      }
    },

    clearSelectedSiteNode: () => {
      set({ selectedSiteNodeId: null });
    },

    loadAgentRuns: async (projectId) => {
      try {
        const runs = await agentRuntimeApi.listRuns(projectId);
        const currentRun = runs.find((run) => !isTerminalRun(run)) ?? runs[0] ?? null;
        const [events, report] = currentRun
          ? await Promise.all([
              agentRuntimeApi.listEvents(projectId, currentRun.id),
              agentRuntimeApi.getLatestVerificationReport(projectId, currentRun.id),
            ])
          : [[], null as VerificationReport | null];

        set({
          agentEvents: events,
          agentRuns: runs,
          currentAgentRun: currentRun,
          currentVerificationReport: report,
        });
      } catch (error) {
        recordAgentActionError(set, error);
      }
    },

    pauseCurrentAgentRun: async () => {
      const project = get().currentProject;
      const run = get().currentAgentRun;

      if (!project || !run || isTerminalRun(run) || run.status === "paused") {
        return;
      }

      try {
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

    resumeCurrentAgentRun: async () => {
      const run = get().currentAgentRun;

      if (!run || run.status !== "paused") {
        return;
      }

      await modifyCurrentProjectRuntime(store, run.contract.objective, {
        existingRun: run,
      });
    },

    sendAgentSteering: async (content) => {
      const project = get().currentProject;
      const run = get().currentAgentRun;
      const message = content.trim();

      if (!project || !run || isTerminalRun(run) || !message) {
        return;
      }

      try {
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
      } catch (error) {
        recordAgentActionError(set, error);
      }
    },

    setSelectedSiteNode: (nodeId) => {
      set({ selectedSiteNodeId: nodeId });
    },
  };
}

function isTerminalRun(run: AgentRun) {
  return ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status);
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
