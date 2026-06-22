import {
  CommandResult,
  getProjectErrorMessage,
  projectApi,
} from "../services/projects";
import type { AppState } from "./appStore";
import {
  appendLogs,
  appendCommandOutputPreview,
  calculateElapsedMs,
  type CommandRun,
  type CommandRunLink,
  type CommandRunStatus,
  formatCommandFailure,
  formatCommandOutput,
  formatCommandStatus,
  isDeployCommand,
  isDevCommand,
  isInstallCommand,
} from "./commandLogs";
import { updateConversationMessage } from "./conversationState";
import type { StoreAccess } from "./storeAccess";

const MAX_COMMAND_RUNS = 40;

type CommandActions = Pick<
  AppState,
  | "handleCommandOutput"
  | "handleCommandStatus"
  | "runProjectCommand"
  | "startDevServer"
  | "stopDevServer"
>;

export function createCommandActions({ get, set }: StoreAccess): CommandActions {
  const store = { get, set };

  return {
    handleCommandOutput: (event) => {
      const updatedRun = updateCommandRun(
        get().commandRuns,
        event.projectId,
        event.command,
        (run) => ({
          ...run,
          elapsedMs: calculateElapsedMs(run.startedAt),
          outputLineCount: run.outputLineCount + 1,
          outputPreview: appendCommandOutputPreview(
            run.outputPreview,
            formatCommandPreviewLine(event.stream, event.line),
          ),
        }),
        {
          projectId: event.projectId,
          command: event.command,
          startedAt: event.timestamp,
        },
      );

      set((state) => ({
        activeCommandRunId:
          updatedRun.run.status === "running"
            ? updatedRun.run.id
            : state.activeCommandRunId,
        commandRuns: updatedRun.runs,
        terminalLogs: appendLogs(state.terminalLogs, [formatCommandOutput(event)]),
      }));

      syncCommandRunToChatActivity(store, updatedRun.run);
    },

    handleCommandStatus: (event) => {
      const isCurrentProject = get().currentProject?.id === event.projectId;
      const isInstall = isInstallCommand(event.command);
      const isDev = isDevCommand(event.command);
      const isDeploy = isDeployCommand(event.command);
      const updatedRun = updateCommandRun(
        get().commandRuns,
        event.projectId,
        event.command,
        (run) => {
          const status = normalizeCommandStatus(event.status);
          const finishedAt = isTerminalCommandRunStatus(status)
            ? event.timestamp
            : undefined;

          return {
            ...run,
            elapsedMs: calculateElapsedMs(
              run.startedAt,
              finishedAt ?? run.finishedAt,
            ),
            exitCode: event.exitCode,
            finishedAt: finishedAt ?? run.finishedAt,
            message: event.message,
            startedAt: event.status === "started" ? event.timestamp : run.startedAt,
            status,
            url: event.url ?? run.url,
          };
        },
        {
          projectId: event.projectId,
          command: event.command,
          startedAt: event.timestamp,
        },
      );

      set((state) => {
        const nextState: Partial<AppState> = {
          commandRuns: updatedRun.runs,
          terminalLogs: appendLogs(state.terminalLogs, [
            formatCommandStatus(event),
          ]),
        };

        if (event.status === "started") {
          nextState.activeCommand = event.command;
          nextState.activeCommandRunId = updatedRun.run.id;
          nextState.isRunningCommand = true;
          nextState.projectError = null;

          if (isInstall) {
            nextState.isInstallingDependencies = true;
          }

          if (isDev && isCurrentProject) {
            nextState.devServerStatus = "starting";
            nextState.isStartingDevServer = true;
            nextState.previewUrl = null;
          }

          if (isDeploy && isCurrentProject) {
            nextState.isDeploying = true;
          }
        }

        if (event.status === "succeeded") {
          nextState.activeCommand = null;
          nextState.activeCommandRunId =
            state.activeCommandRunId === updatedRun.run.id
              ? null
              : state.activeCommandRunId;
          nextState.isRunningCommand = false;

          if (isInstall) {
            nextState.isInstallingDependencies = false;
          }

          if (isDeploy && isCurrentProject) {
            nextState.isDeploying = false;
            nextState.lastDeploymentUrl = event.url ?? state.lastDeploymentUrl;
          }
        }

        if (event.status === "ready" && isDev && isCurrentProject && event.url) {
          nextState.activeCommand = null;
          nextState.activeCommandRunId =
            state.activeCommandRunId === updatedRun.run.id
              ? null
              : state.activeCommandRunId;
          nextState.devServerStatus = "running";
          nextState.isRunningCommand = false;
          nextState.isStartingDevServer = false;
          nextState.previewUrl = event.url;
        }

        if (event.status === "stopped" && isDev && isCurrentProject) {
          nextState.activeCommand = null;
          nextState.activeCommandRunId =
            state.activeCommandRunId === updatedRun.run.id
              ? null
              : state.activeCommandRunId;
          nextState.devServerStatus = "stopped";
          nextState.isRunningCommand = false;
          nextState.isStartingDevServer = false;
          nextState.previewUrl = null;
        }

        if (event.status === "failed") {
          nextState.activeCommand = null;
          nextState.activeCommandRunId =
            state.activeCommandRunId === updatedRun.run.id
              ? null
              : state.activeCommandRunId;
          nextState.isRunningCommand = false;
          nextState.projectError = formatCommandFailure(event);

          if (isInstall) {
            nextState.isInstallingDependencies = false;
          }

          if (isDev && isCurrentProject) {
            nextState.devServerStatus = "failed";
            nextState.isStartingDevServer = false;
            nextState.previewUrl = null;
          }

          if (isDeploy && isCurrentProject) {
            nextState.isDeploying = false;
          }
        }

        return nextState;
      });

      syncCommandRunToChatActivity(store, updatedRun.run);
    },

    runProjectCommand: async (projectId, command, link) => {
      const commandRun = createCommandRun(projectId, command, link);

      set({
        activeCommand: command,
        activeCommandRunId: commandRun.id,
        commandRuns: appendCommandRun(get().commandRuns, commandRun),
        isInstallingDependencies: isInstallCommand(command),
        isRunningCommand: true,
        projectError: null,
      });
      syncCommandRunToChatActivity(store, commandRun);

      try {
        const result = await projectApi.runCommand(projectId, command);
        const finalizedRun = finalizeCommandRunFromResult(
          get().commandRuns,
          commandRun.id,
          result,
        );

        set({
          commandRuns: finalizedRun.runs,
        });
        syncCommandRunToChatActivity(store, finalizedRun.run);

        if (!result.success) {
          const exitCode = result.exitCode ?? "unknown";
          const message = `command: '${command}' exited with code ${exitCode}`;

          set((state) => ({
            projectError: message,
            terminalLogs: appendLogs(state.terminalLogs, [
              `[command:error] ${message}`,
            ]),
          }));
        }

        return result;
      } catch (error) {
        const message = getProjectErrorMessage(error);
        const failedRun = finalizeCommandRunWithError(
          get().commandRuns,
          commandRun.id,
          message,
        );

        set((state) => ({
          commandRuns: failedRun.runs,
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[command:error] ${message}`,
          ]),
        }));
        syncCommandRunToChatActivity(store, failedRun.run);

        return null;
      } finally {
        set((state) => ({
          activeCommand: state.activeCommand === command ? null : state.activeCommand,
          activeCommandRunId:
            state.activeCommandRunId === commandRun.id
              ? null
              : state.activeCommandRunId,
          isInstallingDependencies: isInstallCommand(command)
            ? false
            : state.isInstallingDependencies,
          isRunningCommand:
            state.activeCommand === command ? false : state.isRunningCommand,
        }));
      }
    },

    startDevServer: async (projectId) => {
      const state = get();

      if (
        state.currentProject?.id !== projectId ||
        state.devServerStatus === "starting" ||
        state.devServerStatus === "running"
      ) {
        return;
      }

      set({
        devServerStatus: "starting",
        isStartingDevServer: true,
        projectError: null,
        previewUrl: null,
      });

      try {
        const server = await projectApi.startDevServer(projectId);

        if (get().currentProject?.id === projectId) {
          set({
            devServerStatus: "running",
            isStartingDevServer: false,
            previewUrl: server.url,
          });
        }
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          ...(state.currentProject?.id === projectId
            ? {
                devServerStatus: "failed" as const,
                isStartingDevServer: false,
                previewUrl: null,
                projectError: message,
              }
            : {}),
          terminalLogs: appendLogs(state.terminalLogs, [
            `[dev-server:error] ${message}`,
          ]),
        }));
      }
    },

    stopDevServer: async (projectId) => {
      try {
        await projectApi.stopDevServer(projectId);

        if (get().currentProject?.id === projectId) {
          set({
            devServerStatus: "stopped",
            isStartingDevServer: false,
            previewUrl: null,
          });
        }
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[dev-server:error] ${message}`,
          ]),
        }));
      }
    },
  };
}

function createCommandRun(
  projectId: string,
  command: string,
  link: CommandRunLink = {},
): CommandRun {
  return {
    ...link,
    command,
    exitCode: null,
    id: `command-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    outputLineCount: 0,
    outputPreview: [],
    projectId,
    startedAt: new Date().toISOString(),
    status: "running",
  };
}

function appendCommandRun(runs: CommandRun[], run: CommandRun) {
  return [run, ...runs.filter((currentRun) => currentRun.id !== run.id)].slice(
    0,
    MAX_COMMAND_RUNS,
  );
}

function updateCommandRun(
  runs: CommandRun[],
  projectId: string,
  command: string,
  updater: (run: CommandRun) => CommandRun,
  fallback: { command: string; projectId: string; startedAt: string },
) {
  const existingRun = findLatestCommandRun(runs, projectId, command);
  const baseRun =
    existingRun ??
    ({
      command: fallback.command,
      exitCode: null,
      id: `command-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      outputLineCount: 0,
      outputPreview: [],
      projectId: fallback.projectId,
      startedAt: fallback.startedAt,
      status: "running",
    } satisfies CommandRun);
  const run = updater(baseRun);

  return {
    run,
    runs: appendCommandRun(runs, run),
  };
}

function findLatestCommandRun(
  runs: CommandRun[],
  projectId: string,
  command: string,
) {
  return (
    runs.find(
      (run) =>
        run.projectId === projectId &&
        run.command === command &&
        run.status === "running",
    ) ??
    runs.find((run) => run.projectId === projectId && run.command === command)
  );
}

function normalizeCommandStatus(status: string): CommandRunStatus {
  if (
    status === "failed" ||
    status === "ready" ||
    status === "stopped" ||
    status === "succeeded"
  ) {
    return status;
  }

  return "running";
}

function isTerminalCommandRunStatus(status: CommandRunStatus) {
  return status === "failed" || status === "ready" || status === "stopped" || status === "succeeded";
}

function finalizeCommandRunFromResult(
  runs: CommandRun[],
  runId: string,
  result: CommandResult,
) {
  const existingRun = runs.find((run) => run.id === runId);
  const outputPreview =
    existingRun && existingRun.outputLineCount > 0
      ? existingRun.outputPreview
      : result.output
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8);
  const outputLineCount =
    existingRun && existingRun.outputLineCount > 0
      ? existingRun.outputLineCount
      : outputPreview.length;
  const run: CommandRun = {
    ...(existingRun ?? createCommandRun(result.projectId, result.command)),
    elapsedMs: calculateElapsedMs(result.startedAt, result.finishedAt),
    exitCode: result.exitCode,
    finishedAt: result.finishedAt,
    outputLineCount,
    outputPreview,
    startedAt: result.startedAt,
    status: result.success ? "succeeded" : "failed",
  };

  return {
    run,
    runs: appendCommandRun(runs, run),
  };
}

function finalizeCommandRunWithError(
  runs: CommandRun[],
  runId: string,
  message: string,
) {
  const existingRun = runs.find((run) => run.id === runId);
  const finishedAt = new Date().toISOString();
  const run: CommandRun = {
    ...(existingRun ?? createCommandRun("", "")),
    elapsedMs: calculateElapsedMs(existingRun?.startedAt, finishedAt),
    exitCode: existingRun?.exitCode ?? null,
    finishedAt,
    message,
    outputPreview: appendCommandOutputPreview(
      existingRun?.outputPreview ?? [],
      message,
    ),
    outputLineCount: (existingRun?.outputLineCount ?? 0) + 1,
    status: "failed",
  };

  return {
    run,
    runs: appendCommandRun(runs, run),
  };
}

function syncCommandRunToChatActivity(store: StoreAccess, run: CommandRun) {
  if (!run.chatActivityId || !run.chatMessageId) {
    return;
  }

  updateConversationMessage(store, run.chatMessageId, (message) => ({
    ...message,
    activities: (message.activities ?? []).map((activity) => {
      if (activity.id !== run.chatActivityId) {
        return activity;
      }

      const status = toChatActivityStatus(run.status);

      return {
        ...activity,
        command: run.command,
        detail: formatCommandRunDetail(run),
        elapsedMs: run.elapsedMs,
        error: status === "failed" ? run.message ?? "Command failed." : undefined,
        finishedAt: run.finishedAt,
        outputLineCount: run.outputLineCount,
        outputPreview: run.outputPreview.slice(-6),
        status,
      };
    }),
  }));
}

function toChatActivityStatus(status: CommandRunStatus) {
  return status === "failed"
    ? "failed"
    : isTerminalCommandRunStatus(status)
      ? "succeeded"
      : "running";
}

function formatCommandRunDetail(run: CommandRun) {
  if (run.status === "running") {
    return "Running command. Logs are streaming in the Logs panel.";
  }

  if (run.status === "ready" && run.url) {
    return `Ready at ${run.url}.`;
  }

  if (run.status === "failed") {
    const exitCode =
      run.exitCode === null || run.exitCode === undefined
        ? "unknown"
        : run.exitCode;

    return run.message ?? `Command failed with exit code ${exitCode}.`;
  }

  return run.message ?? "Command completed.";
}

function formatCommandPreviewLine(stream: string, line: string) {
  return `[${stream === "stderr" ? "err" : "out"}] ${line}`;
}
