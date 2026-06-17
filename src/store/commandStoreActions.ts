import {
  getProjectErrorMessage,
  projectApi,
} from "../services/projects";
import type { AppState } from "./appStore";
import {
  appendLogs,
  formatCommandFailure,
  formatCommandOutput,
  formatCommandStatus,
  isDeployCommand,
  isDevCommand,
  isInstallCommand,
} from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

type CommandActions = Pick<
  AppState,
  | "handleCommandOutput"
  | "handleCommandStatus"
  | "runProjectCommand"
  | "startDevServer"
  | "stopDevServer"
>;

export function createCommandActions({ get, set }: StoreAccess): CommandActions {
  return {
    handleCommandOutput: (event) => {
      set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [formatCommandOutput(event)]),
      }));
    },

    handleCommandStatus: (event) => {
      const isCurrentProject = get().currentProject?.id === event.projectId;
      const isInstall = isInstallCommand(event.command);
      const isDev = isDevCommand(event.command);
      const isDeploy = isDeployCommand(event.command);

      set((state) => {
        const nextState: Partial<AppState> = {
          terminalLogs: appendLogs(state.terminalLogs, [
            formatCommandStatus(event),
          ]),
        };

        if (event.status === "started") {
          nextState.activeCommand = event.command;
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
          nextState.devServerStatus = "running";
          nextState.isStartingDevServer = false;
          nextState.previewUrl = event.url;
        }

        if (event.status === "stopped" && isDev && isCurrentProject) {
          nextState.devServerStatus = "stopped";
          nextState.isStartingDevServer = false;
          nextState.previewUrl = null;
        }

        if (event.status === "failed") {
          nextState.activeCommand = null;
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
    },

    runProjectCommand: async (projectId, command) => {
      set({
        activeCommand: command,
        isInstallingDependencies: isInstallCommand(command),
        isRunningCommand: true,
        projectError: null,
      });

      try {
        const result = await projectApi.runCommand(projectId, command);

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

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[command:error] ${message}`,
          ]),
        }));

        return null;
      } finally {
        set((state) => ({
          activeCommand: state.activeCommand === command ? null : state.activeCommand,
          isInstallingDependencies: isInstallCommand(command)
            ? false
            : state.isInstallingDependencies,
          isRunningCommand:
            state.activeCommand === command ? false : state.isRunningCommand,
        }));
      }
    },

    startDevServer: async (projectId) => {
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
          devServerStatus: "failed",
          isStartingDevServer: false,
          projectError: message,
          previewUrl: null,
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
