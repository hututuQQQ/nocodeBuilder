import {
  getProjectErrorMessage,
  projectApi,
} from "../services/projects";
import type { AppState } from "./appStore";
import { createChatMessage } from "./chatMessages";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

type RollbackActions = Pick<AppState, "rollbackLastChange">;

export function createRollbackActions({
  get,
  set,
}: StoreAccess): RollbackActions {
  return {
    rollbackLastChange: async () => {
      const project = get().currentProject;

      if (!project || get().isRollingBack) {
        return;
      }

      const record = get().changeHistory.find(
        (change) => change.projectId === project.id,
      );

      if (!record) {
        set({ projectError: "No agent change is available to roll back." });
        return;
      }

      set((state) => ({
        isRollingBack: true,
        projectError: null,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[rollback] Restoring ${record.files.length} files from ${record.id}`,
        ]),
      }));

      try {
        const filesToRestore = record.files
          .filter((file) => file.beforeContent !== null)
          .map((file) => ({
            path: file.path,
            content: file.beforeContent ?? "",
          }));
        const filesToDelete = record.files
          .filter((file) => file.beforeContent === null)
          .map((file) => file.path);

        if (filesToRestore.length > 0) {
          await projectApi.writeFiles(project.id, filesToRestore);
        }

        if (filesToDelete.length > 0) {
          await projectApi.deleteFiles(project.id, filesToDelete);
        }

        const refreshedFileTree = await projectApi.listFiles(project.id);
        const selectedFilePath = get().selectedFilePath;
        let selectedFileContent = get().selectedFileContent;
        let selectedFilePathAfterRollback = selectedFilePath;

        if (selectedFilePath) {
          if (filesToDelete.includes(selectedFilePath)) {
            selectedFileContent = "";
            selectedFilePathAfterRollback = null;
          } else if (
            filesToRestore.some((file) => file.path === selectedFilePath)
          ) {
            selectedFileContent = await projectApi.readFile(
              project.id,
              selectedFilePath,
            );
          }
        }

        set((state) => ({
          changeHistory: state.changeHistory.filter(
            (change) => change.id !== record.id,
          ),
          chatMessages: [
            ...state.chatMessages,
            createChatMessage(
              "assistant",
              `Rolled back ${record.files.length} file change(s): ${record.files
                .map((file) => file.path)
                .join(", ")}`,
            ),
          ],
          fileTree: refreshedFileTree,
          previewRefreshKey: state.previewRefreshKey + 1,
          selectedFileContent,
          selectedFilePath: selectedFilePathAfterRollback,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[rollback] Restored ${record.files.length} files`,
          ]),
        }));
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[rollback:error] ${message}`,
          ]),
        }));
      } finally {
        set({ isRollingBack: false });
      }
    },
  };
}
