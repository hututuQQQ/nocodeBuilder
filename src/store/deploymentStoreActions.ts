import {
  getProjectErrorMessage,
  projectApi,
} from "../services/projects";
import type { AppState } from "./appStore";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

type DeploymentActions = Pick<AppState, "deployCurrentProject">;

export function createDeploymentActions({
  get,
  set,
}: StoreAccess): DeploymentActions {
  return {
    deployCurrentProject: async (options) => {
      const project = get().currentProject;

      if (!project) {
        set({ projectError: "Select a project before deploying to Vercel." });
        return null;
      }

      set((state) => ({
        isDeploying: true,
        projectError: null,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[vercel] Deploying ${project.name} to ${options.target}`,
        ]),
      }));

      try {
        const deployment = await projectApi.deployToVercel(project.id, options);

        if (get().currentProject?.id === project.id) {
          set((state) => ({
            lastDeploymentUrl: deployment.url,
            terminalLogs: appendLogs(state.terminalLogs, [
              `[vercel] Deployment ready: ${deployment.url}`,
            ]),
          }));
        }

        return deployment;
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[vercel:error] ${message}`,
          ]),
        }));

        return null;
      } finally {
        set({ isDeploying: false });
      }
    },
  };
}
