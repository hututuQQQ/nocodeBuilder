import { FormEvent, useEffect, useState } from "react";
import {
  CheckCircle2,
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
import { useAppStore } from "../../store/appStore";
import {
  DEFAULT_VERCEL_DEPLOY_TARGET,
  keyStore,
  VercelDeployTarget,
} from "../../services/keyStore";
import { getProjectErrorMessage, projectApi } from "../../services/projects";

type Notice = {
  tone: "error" | "success";
  message: string;
};

type PreviewTab = "local" | "deployment";

function getExplicitVercelProjectName(
  value: string | null | undefined,
  localProjectId: string | undefined,
) {
  const projectName = value?.trim() ?? "";

  if (!projectName || projectName === localProjectId) {
    return undefined;
  }

  return projectName;
}

export function PreviewPanel() {
  const currentProject = useAppStore((state) => state.currentProject);
  const deployCurrentProject = useAppStore((state) => state.deployCurrentProject);
  const devServerStatus = useAppStore((state) => state.devServerStatus);
  const isDeploying = useAppStore((state) => state.isDeploying);
  const isStartingDevServer = useAppStore((state) => state.isStartingDevServer);
  const lastDeploymentUrl = useAppStore((state) => state.lastDeploymentUrl);
  const openPreviewInBrowser = useAppStore((state) => state.openPreviewInBrowser);
  const previewRefreshKey = useAppStore((state) => state.previewRefreshKey);
  const previewUrl = useAppStore((state) => state.previewUrl);
  const refreshPreview = useAppStore((state) => state.refreshPreview);
  const startDevServer = useAppStore((state) => state.startDevServer);
  const stopDevServer = useAppStore((state) => state.stopDevServer);
  const [isVercelDialogOpen, setIsVercelDialogOpen] = useState(false);
  const [token, setToken] = useState("");
  const [scope, setScope] = useState("");
  const [projectName, setProjectName] = useState("");
  const [target, setTarget] = useState<VercelDeployTarget>(
    DEFAULT_VERCEL_DEPLOY_TARGET,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isTestingToken, setIsTestingToken] = useState(false);
  const [activePreviewTab, setActivePreviewTab] = useState<PreviewTab>("local");
  const [isDeploymentTabOpen, setIsDeploymentTabOpen] = useState(false);
  const [deploymentRefreshKey, setDeploymentRefreshKey] = useState(0);

  const hasDeploymentPreview = Boolean(lastDeploymentUrl && isDeploymentTabOpen);
  const activePreviewUrl =
    activePreviewTab === "deployment" && hasDeploymentPreview
      ? lastDeploymentUrl
      : previewUrl;
  const canUsePreview = Boolean(activePreviewUrl);
  const canStartPreview =
    Boolean(currentProject) &&
    !isStartingDevServer &&
    devServerStatus !== "running";
  const canStopPreview = Boolean(currentProject) && devServerStatus !== "stopped";
  const canDeploy = Boolean(currentProject) && !isDeploying;

  useEffect(() => {
    if (!lastDeploymentUrl) {
      setIsDeploymentTabOpen(false);
      setActivePreviewTab("local");
      return;
    }

    setIsDeploymentTabOpen(true);
    setActivePreviewTab("deployment");
  }, [lastDeploymentUrl]);

  useEffect(() => {
    if (activePreviewTab === "deployment" && !hasDeploymentPreview) {
      setActivePreviewTab("local");
    }
  }, [activePreviewTab, hasDeploymentPreview]);

  async function openVercelDialog() {
    const config = await keyStore.getVercelConfig();

    setToken(config?.token ?? "");
    setScope(config?.scope ?? "");
    setProjectName(
      getExplicitVercelProjectName(config?.projectName, currentProject?.id) ??
        "",
    );
    setTarget(config?.defaultTarget ?? DEFAULT_VERCEL_DEPLOY_TARGET);
    setNotice(null);
    setIsVercelDialogOpen(true);
  }

  async function handleDeployClick() {
    const config = await keyStore.getVercelConfig();

    if (!config?.token) {
      await openVercelDialog();
      return;
    }

    await deployCurrentProject({
      projectName: getExplicitVercelProjectName(
        config.projectName,
        currentProject?.id,
      ),
      scope: config.scope || undefined,
      target: config.defaultTarget,
      token: config.token,
    });
  }

  function handleRefreshActivePreview() {
    if (activePreviewTab === "deployment") {
      setDeploymentRefreshKey((currentKey) => currentKey + 1);
      return;
    }

    refreshPreview();
  }

  function handleCloseDeploymentTab() {
    setIsDeploymentTabOpen(false);
    setActivePreviewTab("local");
  }

  async function handleTestToken() {
    if (!token.trim()) {
      setNotice({ tone: "error", message: "Enter a Vercel token first." });
      return;
    }

    setIsTestingToken(true);
    setNotice(null);

    try {
      const user = await projectApi.testVercelToken(token.trim());
      setNotice({
        tone: "success",
        message: `Token verified for ${user.username}.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: getProjectErrorMessage(error),
      });
    } finally {
      setIsTestingToken(false);
    }
  }

  async function handleSaveAndDeploy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!token.trim()) {
      setNotice({ tone: "error", message: "Enter a Vercel token first." });
      return;
    }

    const savedConfig = await keyStore.saveVercelConfig({
      defaultTarget: target,
      projectName,
      scope,
      token,
    });

    setIsVercelDialogOpen(false);

    await deployCurrentProject({
      projectName: getExplicitVercelProjectName(
        savedConfig.projectName,
        currentProject?.id,
      ),
      scope: savedConfig.scope || undefined,
      target: savedConfig.defaultTarget,
      token: savedConfig.token,
    });
  }

  return (
    <section className="relative flex min-h-0 min-w-0 flex-col border-b border-zinc-800 bg-[#0b0b0d]">
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
              onClick={() => setActivePreviewTab("local")}
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
                  onClick={() => setActivePreviewTab("deployment")}
                  type="button"
                >
                  Vercel
                </button>
                <button
                  aria-label="Close Vercel preview tab"
                  className="grid h-full w-6 place-items-center rounded-r text-zinc-500 transition hover:bg-zinc-700 hover:text-zinc-100"
                  onClick={handleCloseDeploymentTab}
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
            onClick={() => void handleDeployClick()}
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
            onClick={() => void openVercelDialog()}
            title="Vercel settings"
            type="button"
          >
            <KeyRound size={14} aria-hidden="true" />
          </button>
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
            onClick={handleRefreshActivePreview}
            title="Refresh"
            type="button"
          >
            <RefreshCcw size={14} aria-hidden="true" />
          </button>
          <button
            aria-label="Open preview in browser"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!canUsePreview}
            onClick={() => void openPreviewInBrowser(activePreviewUrl ?? undefined)}
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
        {activePreviewUrl ? (
          <iframe
            key={`${activePreviewUrl}-${previewRefreshKey}-${deploymentRefreshKey}`}
            className="h-full w-full rounded-md border border-zinc-800 bg-white"
            src={activePreviewUrl}
            title={activePreviewTab === "deployment" ? "Vercel deployment" : "Local preview"}
          />
        ) : (
          <div className="flex w-full max-w-sm flex-col items-center rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center">
            <div className="mb-3 grid size-10 place-items-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-500">
              <MonitorPlay size={18} aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-zinc-300">No preview running</p>
            <p className="mt-1 text-xs text-zinc-600">
              Generated Next.js apps will appear here.
            </p>
          </div>
        )}
      </div>

      {isVercelDialogOpen ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-black/70 px-4">
          <form
            className="w-full max-w-[440px] rounded-md border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
            onSubmit={handleSaveAndDeploy}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">
                  Vercel Deploy
                </h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Token stays in builder settings and is never written to project files.
                </p>
              </div>
              <button
                className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
                onClick={() => setIsVercelDialogOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <label className="mb-3 block">
              <span className="mb-2 block text-xs font-medium text-zinc-400">
                Vercel token
              </span>
              <input
                className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
                onChange={(event) => setToken(event.currentTarget.value)}
                placeholder="vercel token"
                type="password"
                value={token}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-xs font-medium text-zinc-400">
                  Scope
                </span>
                <input
                  className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
                  onChange={(event) => setScope(event.currentTarget.value)}
                  placeholder="team-slug"
                  value={scope}
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-medium text-zinc-400">
                  Existing Vercel project
                </span>
                <input
                  className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
                  onChange={(event) => setProjectName(event.currentTarget.value)}
                  placeholder="optional existing name or ID"
                  value={projectName}
                />
                <span className="mt-2 block text-xs leading-5 text-zinc-500">
                  Leave empty to let Vercel create or use the linked project.
                </span>
              </label>
            </div>

            <label className="mt-3 block">
              <span className="mb-2 block text-xs font-medium text-zinc-400">
                Default target
              </span>
              <select
                className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
                onChange={(event) =>
                  setTarget(event.currentTarget.value as VercelDeployTarget)
                }
                value={target}
              >
                <option value="preview">Preview</option>
                <option value="production">Production</option>
              </select>
            </label>

            <div
              aria-live="polite"
              className={`mt-3 min-h-10 rounded-md border px-3 py-2 text-xs ${
                notice?.tone === "error"
                  ? "border-red-400/30 bg-red-400/10 text-red-100"
                  : notice?.tone === "success"
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                    : "border-zinc-800 bg-zinc-900 text-zinc-600"
              }`}
            >
              {notice?.message ?? "Token test result will appear here."}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="flex h-9 items-center gap-2 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                disabled={!token.trim() || isTestingToken}
                onClick={() => void handleTestToken()}
                type="button"
              >
                {isTestingToken ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={14} aria-hidden="true" />
                )}
                Test
              </button>
              <button
                className="flex h-9 items-center gap-2 rounded-md border border-blue-400/30 bg-blue-400/10 px-3 text-sm font-medium text-blue-100 transition hover:border-blue-300/60 hover:bg-blue-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                disabled={!token.trim() || isDeploying}
                type="submit"
              >
                {isDeploying ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Rocket size={14} aria-hidden="true" />
                )}
                Save and deploy
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
