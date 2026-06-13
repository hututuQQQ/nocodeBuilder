import {
  ExternalLink,
  Loader2,
  MonitorPlay,
  Play,
  RefreshCcw,
  Square,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";

export function PreviewPanel() {
  const currentProject = useAppStore((state) => state.currentProject);
  const devServerStatus = useAppStore((state) => state.devServerStatus);
  const isStartingDevServer = useAppStore((state) => state.isStartingDevServer);
  const openPreviewInBrowser = useAppStore((state) => state.openPreviewInBrowser);
  const previewRefreshKey = useAppStore((state) => state.previewRefreshKey);
  const previewUrl = useAppStore((state) => state.previewUrl);
  const refreshPreview = useAppStore((state) => state.refreshPreview);
  const startDevServer = useAppStore((state) => state.startDevServer);
  const stopDevServer = useAppStore((state) => state.stopDevServer);

  const canUsePreview = Boolean(previewUrl);
  const canStartPreview =
    Boolean(currentProject) &&
    !isStartingDevServer &&
    devServerStatus !== "running";
  const canStopPreview = Boolean(currentProject) && devServerStatus !== "stopped";

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-b border-zinc-800 bg-[#0b0b0d]">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
        <div className="flex min-w-0 items-center gap-2">
          {isStartingDevServer ? (
            <Loader2
              size={16}
              className="shrink-0 animate-spin text-amber-300"
              aria-hidden="true"
            />
          ) : (
            <MonitorPlay
              size={16}
              className="shrink-0 text-amber-300"
              aria-hidden="true"
            />
          )}
          <h2 className="text-sm font-semibold text-zinc-100">Preview</h2>
          <span className="min-w-0 truncate rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-500">
            {previewUrl ?? devServerStatus}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            aria-label="Start dev server"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!canStartPreview}
            onClick={() => {
              if (currentProject) {
                void startDevServer(currentProject.id);
              }
            }}
            title="Start"
            type="button"
          >
            <Play size={14} aria-hidden="true" />
          </button>
          <button
            aria-label="Refresh preview"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!canUsePreview}
            onClick={refreshPreview}
            title="Refresh"
            type="button"
          >
            <RefreshCcw size={14} aria-hidden="true" />
          </button>
          <button
            aria-label="Open preview in browser"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!canUsePreview}
            onClick={() => void openPreviewInBrowser()}
            title="Open in browser"
            type="button"
          >
            <ExternalLink size={14} aria-hidden="true" />
          </button>
          <button
            aria-label="Stop dev server"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!canStopPreview}
            onClick={() => {
              if (currentProject) {
                void stopDevServer(currentProject.id);
              }
            }}
            title="Stop"
            type="button"
          >
            <Square size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 place-items-center p-5">
        {previewUrl ? (
          <iframe
            key={`${previewUrl}-${previewRefreshKey}`}
            className="h-full w-full rounded-md border border-zinc-800 bg-white"
            src={previewUrl}
            title="Preview"
          />
        ) : (
          <div className="flex w-full max-w-sm flex-col items-center rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center">
            <div className="mb-3 grid size-10 place-items-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-500">
              <MonitorPlay size={18} aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-zinc-300">No preview running</p>
            <p className="mt-1 text-xs text-zinc-600">
              Generated apps will appear here later.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
