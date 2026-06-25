import type { AgentRunStatus } from "../agent-core/types";

export const WORKSPACE_NAVIGATION_LOCK_MESSAGE =
  "Finish, pause and cancel, or explicitly cancel the current run before switching workspace context.";

type WorkspaceNavigationState = {
  activeCommandRunId?: string | null;
  commandRuns?: Array<{ id: string; projectId: string; status: string }>;
  currentAgentRun?: { status: AgentRunStatus } | null;
  currentProject?: { id: string } | null;
  isExecutingSpec?: boolean;
  isGeneratingProject?: boolean;
  isGeneratingSpec?: boolean;
  isModifyingProject?: boolean;
  isRevisingSpec?: boolean;
  isRunningCommand?: boolean;
  isSwitchingIterationMode?: boolean;
  isVerifyingSpec?: boolean;
};

const ACTIVE_RUN_STATUSES = new Set<AgentRunStatus>([
  "created",
  "planning",
  "exploring",
  "mutating",
  "waiting_approval",
  "verifying",
  "repairing",
  "paused",
]);

export function isWorkspaceNavigationLocked(state: WorkspaceNavigationState) {
  return Boolean(
    (state.currentAgentRun && ACTIVE_RUN_STATUSES.has(state.currentAgentRun.status)) ||
      state.isGeneratingProject ||
      state.isModifyingProject ||
      state.isExecutingSpec ||
      state.isVerifyingSpec ||
      state.isGeneratingSpec ||
      state.isRevisingSpec ||
      state.isSwitchingIterationMode ||
      hasCurrentProjectCommandRun(state),
  );
}

function hasCurrentProjectCommandRun(state: WorkspaceNavigationState) {
  if (!state.isRunningCommand || !state.activeCommandRunId || !state.currentProject) {
    return false;
  }

  const activeRun = state.commandRuns?.find(
    (run) => run.id === state.activeCommandRunId,
  );

  return activeRun?.projectId === state.currentProject.id && activeRun.status === "running";
}
