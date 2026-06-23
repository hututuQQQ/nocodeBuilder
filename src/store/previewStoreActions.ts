import {
  getProjectErrorMessage,
  projectApi,
} from "../services/projects";
import type { AppState } from "./appStore";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

type PreviewActions = Pick<
  AppState,
  "openPreviewInBrowser" | "recordPreviewDiagnostic" | "refreshPreview"
>;

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

    recordPreviewDiagnostic: (diagnostic) => {
      set((state) => {
        const session = state.previewVerificationSession;
        const runId = session?.runId ?? state.currentAgentRun?.id ?? null;
        const record = {
          ...diagnostic,
          id: `preview-diagnostic-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          runId,
          sessionId: session?.id ?? diagnostic.sessionId ?? null,
          url: diagnostic.url ?? session?.previewUrl,
          timestamp: new Date().toISOString(),
        };

        return {
          previewDiagnostics: [...state.previewDiagnostics, record].slice(-100),
          terminalLogs:
            diagnostic.level === "error"
              ? appendLogs(state.terminalLogs, [
                  `[preview:${diagnostic.kind}] ${diagnostic.message}`,
                ])
              : state.terminalLogs,
        };
      });
    },
  };
}
