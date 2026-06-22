import { useEffect, useRef, useState } from "react";
import {
  FileCode2,
  FileDiff,
  Loader2,
  TerminalSquare,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { getPendingReviewFiles } from "../../store/changeHistory";
import { formatElapsedTime } from "../../store/commandLogs";
import { EmptyState } from "./EmptyState";
import { FilesWorkspace } from "./FilesWorkspace";
import { ReviewPanel } from "./ReviewPanel";

type WorkspaceTab = "files" | "logs" | "review";

export function LogsPanel() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("files");
  const activeCommand = useAppStore((state) => state.activeCommand);
  const activeCommandRunId = useAppStore((state) => state.activeCommandRunId);
  const commandRuns = useAppStore((state) => state.commandRuns);
  const changeHistory = useAppStore((state) => state.changeHistory);
  const currentProject = useAppStore((state) => state.currentProject);
  const fileTree = useAppStore((state) => state.fileTree);
  const isInstallingDependencies = useAppStore(
    (state) => state.isInstallingDependencies,
  );
  const isDeploying = useAppStore((state) => state.isDeploying);
  const isGeneratingProject = useAppStore((state) => state.isGeneratingProject);
  const isLoadingFiles = useAppStore((state) => state.isLoadingFiles);
  const isReadingFile = useAppStore((state) => state.isReadingFile);
  const isRevertingChange = useAppStore((state) => state.isRevertingChange);
  const isRunningCommand = useAppStore((state) => state.isRunningCommand);
  const isStartingDevServer = useAppStore((state) => state.isStartingDevServer);
  const projectError = useAppStore((state) => state.projectError);
  const readProjectFile = useAppStore((state) => state.readProjectFile);
  const acceptAllChanges = useAppStore((state) => state.acceptAllChanges);
  const acceptChangedFile = useAppStore((state) => state.acceptChangedFile);
  const revertAllChanges = useAppStore((state) => state.revertAllChanges);
  const revertChangedFile = useAppStore((state) => state.revertChangedFile);
  const selectReviewFile = useAppStore((state) => state.selectReviewFile);
  const selectedChangeFilePath = useAppStore(
    (state) => state.selectedChangeFilePath,
  );
  const selectedFileContent = useAppStore((state) => state.selectedFileContent);
  const selectedFilePath = useAppStore((state) => state.selectedFilePath);
  const terminalLogs = useAppStore((state) => state.terminalLogs);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(Date.now());
  const activeCommandRun =
    commandRuns.find((run) => run.id === activeCommandRunId) ??
    commandRuns.find((run) => run.status === "running") ??
    null;
  const activeCommandElapsed = activeCommandRun
    ? formatElapsedTime(
        activeCommandRun.elapsedMs ??
          (activeCommandRun.status === "running"
            ? Math.max(
                0,
                now - new Date(activeCommandRun.startedAt).getTime(),
              )
            : undefined),
      )
    : "";
  const shouldFocusLogs =
    isDeploying ||
    isGeneratingProject ||
    isInstallingDependencies ||
    isRunningCommand ||
    isStartingDevServer;
  const pendingReviewFiles = getPendingReviewFiles(changeHistory);

  useEffect(() => {
    if (shouldFocusLogs) {
      setActiveTab("logs");
    }
  }, [shouldFocusLogs]);

  useEffect(() => {
    if (!shouldFocusLogs && pendingReviewFiles.length > 0) {
      setActiveTab("review");
    }
  }, [pendingReviewFiles.length, shouldFocusLogs]);

  useEffect(() => {
    if (activeTab === "logs") {
      logsEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [activeTab, terminalLogs.length]);

  useEffect(() => {
    if (!activeCommandRun || activeCommandRun.status !== "running") {
      return;
    }

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(intervalId);
  }, [activeCommandRun]);

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-[#0f0f12]">
      <header className="flex h-12 shrink-0 items-center border-b border-zinc-800 px-3">
        <div className="flex rounded-md border border-zinc-800 bg-zinc-950 p-1">
          <button
            className={`flex h-8 items-center gap-2 rounded px-3 text-sm transition ${
              activeTab === "files"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => setActiveTab("files")}
            type="button"
          >
            <FileCode2 size={15} aria-hidden="true" />
            Files
          </button>
          <button
            className={`flex h-8 items-center gap-2 rounded px-3 text-sm transition ${
              activeTab === "logs"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => setActiveTab("logs")}
            type="button"
          >
            <TerminalSquare size={15} aria-hidden="true" />
            Logs
          </button>
          <button
            className={`flex h-8 items-center gap-2 rounded px-3 text-sm transition ${
              activeTab === "review"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => setActiveTab("review")}
            type="button"
          >
            <FileDiff size={15} aria-hidden="true" />
            Review
            {pendingReviewFiles.length > 0 ? (
              <span className="rounded bg-teal-400/10 px-1.5 py-0.5 text-[10px] text-teal-200">
                {pendingReviewFiles.length}
              </span>
            ) : null}
          </button>
        </div>
        {activeCommandRun ?? activeCommand ? (
          <div className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
            {activeCommandRun?.status === "running" || !activeCommandRun ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : null}
            <span className="max-w-[260px] truncate">
              {activeCommandRun?.command ?? activeCommand}
            </span>
            {activeCommandRun ? (
              <span className="shrink-0 text-zinc-600">
                {activeCommandRun.status}
                {activeCommandElapsed ? ` / ${activeCommandElapsed}` : ""}
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      <div
        className={`min-h-0 flex-1 p-4 ${
          activeTab === "review" ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        {activeTab === "files" ? (
          <FilesWorkspace
            currentProjectName={currentProject?.name ?? null}
            fileTree={fileTree}
            isLoadingFiles={isLoadingFiles}
            isReadingFile={isReadingFile}
            onReadFile={readProjectFile}
            projectError={projectError}
            selectedFileContent={selectedFileContent}
            selectedFilePath={selectedFilePath}
          />
        ) : activeTab === "review" ? (
          <ReviewPanel
            changeHistory={changeHistory}
            currentProjectName={currentProject?.name ?? null}
            isRevertingChange={isRevertingChange}
            onAcceptAll={acceptAllChanges}
            onAcceptFile={acceptChangedFile}
            onRevertAll={revertAllChanges}
            onRevertFile={revertChangedFile}
            onSelectFile={selectReviewFile}
            selectedFilePath={selectedChangeFilePath}
          />
        ) : terminalLogs.length === 0 ? (
          <EmptyState
            icon={<TerminalSquare size={18} aria-hidden="true" />}
            title="No logs yet"
            detail="Build and agent logs will appear here later."
          />
        ) : (
          <div className="space-y-2 font-mono text-xs text-zinc-400">
            {terminalLogs.map((log, index) => (
              <div
                className="whitespace-pre-wrap break-words rounded border border-zinc-800 bg-zinc-950 px-3 py-2"
                key={`${log}-${index}`}
              >
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </section>
  );
}
