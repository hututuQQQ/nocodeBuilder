import { FormEvent, useEffect, useState } from "react";
import { useAppStore } from "../../store/appStore";
import {
  DEFAULT_VERCEL_DEPLOY_TARGET,
  keyStore,
  VercelDeployTarget,
} from "../../services/keyStore";
import { getProjectErrorMessage, projectApi } from "../../services/projects";
import { PreviewFrame } from "./PreviewFrame";
import { PreviewHeader } from "./PreviewHeader";
import { VercelDeployDialog } from "./VercelDeployDialog";
import {
  getExplicitVercelProjectName,
  Notice,
  PreviewTab,
} from "./previewPanelTypes";

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
      <PreviewHeader
        activePreviewTab={activePreviewTab}
        activePreviewUrl={activePreviewUrl}
        canDeploy={canDeploy}
        canStartPreview={canStartPreview}
        canStopPreview={canStopPreview}
        canUsePreview={canUsePreview}
        devServerStatus={devServerStatus}
        hasDeploymentPreview={hasDeploymentPreview}
        isDeploying={isDeploying}
        isStartingDevServer={isStartingDevServer}
        onCloseDeploymentTab={handleCloseDeploymentTab}
        onDeployClick={() => void handleDeployClick()}
        onOpenBrowser={() => void openPreviewInBrowser(activePreviewUrl ?? undefined)}
        onOpenVercelDialog={() => void openVercelDialog()}
        onRefresh={handleRefreshActivePreview}
        onSelectTab={setActivePreviewTab}
        onStartPreview={() => {
          if (currentProject) {
            void startDevServer(currentProject.id);
          }
        }}
        onStopPreview={() => {
          if (currentProject) {
            void stopDevServer(currentProject.id);
          }
        }}
      />

      <PreviewFrame
        activePreviewTab={activePreviewTab}
        activePreviewUrl={activePreviewUrl}
        deploymentRefreshKey={deploymentRefreshKey}
        previewRefreshKey={previewRefreshKey}
      />

      {isVercelDialogOpen ? (
        <VercelDeployDialog
          isDeploying={isDeploying}
          isTestingToken={isTestingToken}
          notice={notice}
          onClose={() => setIsVercelDialogOpen(false)}
          onProjectNameChange={setProjectName}
          onScopeChange={setScope}
          onSubmit={handleSaveAndDeploy}
          onTargetChange={setTarget}
          onTestToken={() => void handleTestToken()}
          onTokenChange={setToken}
          projectName={projectName}
          scope={scope}
          target={target}
          token={token}
        />
      ) : null}
    </section>
  );
}
