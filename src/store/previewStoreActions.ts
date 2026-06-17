import {
  getProjectErrorMessage,
  projectApi,
} from "../services/projects";
import type { AppState } from "./appStore";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

type PreviewActions = Pick<AppState, "openPreviewInBrowser" | "refreshPreview">;

export function createPreviewActions({ get, set }: StoreAccess): PreviewActions {
  return {
    openPreviewInBrowser: async (url) => {
      const previewUrl = url ?? get().previewUrl;

      if (!previewUrl) {
        return;
      }

      try {
        await projectApi.openPreviewInBrowser(previewUrl);
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[preview:error] ${message}`,
          ]),
        }));
      }
    },

    refreshPreview: () => {
      set((state) => ({ previewRefreshKey: state.previewRefreshKey + 1 }));
    },
  };
}
