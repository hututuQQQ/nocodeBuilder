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
import { useI18n } from "../../i18n";
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
  onClearSelectedSiteNode: () => void;
  onDeployClick: () => void;
  onOpenBrowser: () => void;
  onOpenVercelDialog: () => void;
  onRefresh: () => void;
  onSelectTab: (tab: PreviewTab) => void;
  onStartPreview: () => void;
  onStopPreview: () => void;
  selectedSiteNodeId: string | null;
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
  onClearSelectedSiteNode,
  onDeployClick,
  onOpenBrowser,
  onOpenVercelDialog,
  onRefresh,
  onSelectTab,
  onStartPreview,
  onStopPreview,
  selectedSiteNodeId,
}: PreviewHeaderProps) {
  const { t } = useI18n();

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
        <h2 className="text-sm font-semibold text-zinc-100">
          {t("workspace.preview")}
        </h2>
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
            {t("preview.local")}
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
                aria-label={t("preview.closeVercelTab")}
                className="grid h-full w-6 place-items-center rounded-r text-zinc-500 transition hover:bg-zinc-700 hover:text-zinc-100"
                onClick={onCloseDeploymentTab}
                title={t("preview.closeVercelTab")}
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
        {selectedSiteNodeId ? (
          <span className="flex max-w-44 min-w-0 items-center rounded border border-teal-400/30 bg-teal-400/10 pl-2 text-xs text-teal-100">
            <span className="truncate">{selectedSiteNodeId}</span>
            <button
              aria-label={t("preview.clearNode")}
              className="grid size-6 shrink-0 place-items-center text-teal-200/70 transition hover:text-teal-50"
              onClick={onClearSelectedSiteNode}
              title={t("preview.clearNode")}
              type="button"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <button
          aria-label={t("preview.deployToVercel")}
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-blue-400/40 hover:text-blue-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canDeploy}
          onClick={onDeployClick}
          title={t("preview.deployToVercel")}
          type="button"
        >
          {isDeploying ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <Rocket size={14} aria-hidden="true" />
          )}
        </button>
        <button
          aria-label={t("preview.vercelSettings")}
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
          onClick={onOpenVercelDialog}
          title={t("preview.vercelSettings")}
          type="button"
        >
          <KeyRound size={14} aria-hidden="true" />
        </button>
        <button
          aria-label={t("preview.start")}
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canStartPreview}
          onClick={onStartPreview}
          title={t("preview.start")}
          type="button"
        >
          <Play size={14} aria-hidden="true" />
        </button>
        <button
          aria-label={t("preview.refresh")}
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canUsePreview}
          onClick={onRefresh}
          title={t("preview.refresh")}
          type="button"
        >
          <RefreshCcw size={14} aria-hidden="true" />
        </button>
        <button
          aria-label={t("preview.openBrowser")}
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canUsePreview}
          onClick={onOpenBrowser}
          title={t("preview.openBrowser")}
          type="button"
        >
          <ExternalLink size={14} aria-hidden="true" />
        </button>
        <button
          aria-label={t("preview.stop")}
          className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!canStopPreview}
          onClick={onStopPreview}
          title={t("preview.stop")}
          type="button"
        >
          <Square size={13} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
