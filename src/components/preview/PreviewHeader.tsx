import {
  ExternalLink,
  KeyRound,
  Loader2,
  MonitorPlay,
  Play,
  RefreshCcw,
  Rocket,
  Square,
  X,
} from "lucide-react";
import { PreviewTab } from "./previewPanelTypes";

type PreviewHeaderProps = {
  activePreviewTab: PreviewTab;
  activePreviewUrl: string | null;
  canDeploy: boolean;
  canStartPreview: boolean;
  canStopPreview: boolean;
  canUsePreview: boolean;
  devServerStatus: string;
  hasDeploymentPreview: boolean;
  isDeploying: boolean;
  isStartingDevServer: boolean;
  onCloseDeploymentTab: () => void;
  onDeployClick: () => void;
  onOpenBrowser: () => void;
  onOpenVercelDialog: () => void;
  onRefresh: () => void;
  onSelectTab: (tab: PreviewTab) => void;
  onStartPreview: () => void;
  onStopPreview: () => void;
};

export function PreviewHeader({
  activePreviewTab,
  activePreviewUrl,
  canDeploy,
  canStartPreview,
  canStopPreview,
  canUsePreview,
  devServerStatus,
  hasDeploymentPreview,
  isDeploying,
  isStartingDevServer,
  onCloseDeploymentTab,
  onDeployClick,
  onOpenBrowser,
  onOpenVercelDialog,
  onRefresh,
  onSelectTab,
  onStartPreview,
  onStopPreview,
}: PreviewHeaderProps) {
  return (
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
        <div className="flex min-w-0 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
          <button
            className={`h-7 rounded px-2 text-xs transition ${
              activePreviewTab === "local"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => onSelectTab("local")}
            type="button"
          >
            Local
          </button>
          {hasDeploymentPreview ? (
            <div
              className={`ml-0.5 flex h-7 items-center rounded transition ${
                activePreviewTab === "deployment"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <button
                className="h-full px-2 text-xs"
                onClick={() => onSelectTab("deployment")}
                type="button"
              >
                Vercel
              </button>
              <button
                aria-label="Close Vercel preview tab"
                className="grid h-full w-6 place-items-center rounded-r text-zinc-500 transition hover:bg-zinc-700 hover:text-zinc-100"
                onClick={onCloseDeploymentTab}
                title="Close Vercel preview tab"
                type="button"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
        <span className="min-w-0 truncate rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-500">
          {activePreviewUrl ?? devServerStatus}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          aria-label="Deploy to Vercel"
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-blue-400/40 hover:text-blue-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canDeploy}
          onClick={onDeployClick}
          title="Deploy to Vercel"
          type="button"
        >
          {isDeploying ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <Rocket size={14} aria-hidden="true" />
          )}
        </button>
        <button
          aria-label="Configure Vercel"
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
          onClick={onOpenVercelDialog}
          title="Vercel settings"
          type="button"
        >
          <KeyRound size={14} aria-hidden="true" />
        </button>
        <button
          aria-label="Start dev server"
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canStartPreview}
          onClick={onStartPreview}
          title="Start"
          type="button"
        >
          <Play size={14} aria-hidden="true" />
        </button>
        <button
          aria-label="Refresh preview"
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canUsePreview}
          onClick={onRefresh}
          title="Refresh"
          type="button"
        >
          <RefreshCcw size={14} aria-hidden="true" />
        </button>
        <button
          aria-label="Open preview in browser"
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canUsePreview}
          onClick={onOpenBrowser}
          title="Open in browser"
          type="button"
        >
          <ExternalLink size={14} aria-hidden="true" />
        </button>
        <button
          aria-label="Stop dev server"
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canStopPreview}
          onClick={onStopPreview}
          title="Stop"
          type="button"
        >
          <Square size={13} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
