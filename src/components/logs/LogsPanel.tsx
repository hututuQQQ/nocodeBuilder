import { useEffect, useRef, useState } from "react";
import {
  FileCode2,
  Loader2,
  TerminalSquare,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { EmptyState } from "./EmptyState";
import { FilesWorkspace } from "./FilesWorkspace";

type WorkspaceTab = "files" | "logs";

export function LogsPanel() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("files");
  const activeCommand = useAppStore((state) => state.activeCommand);
  const currentProject = useAppStore((state) => state.currentProject);
  const fileTree = useAppStore((state) => state.fileTree);
  const isInstallingDependencies = useAppStore(
    (state) => state.isInstallingDependencies,
  );
  const isDeploying = useAppStore((state) => state.isDeploying);
  const isGeneratingProject = useAppStore((state) => state.isGeneratingProject);
  const isLoadingFiles = useAppStore((state) => state.isLoadingFiles);
  const isReadingFile = useAppStore((state) => state.isReadingFile);
  const isRunningCommand = useAppStore((state) => state.isRunningCommand);
  const isStartingDevServer = useAppStore((state) => state.isStartingDevServer);
  const projectError = useAppStore((state) => state.projectError);
  const readProjectFile = useAppStore((state) => state.readProjectFile);
  const selectedFileContent = useAppStore((state) => state.selectedFileContent);
  const selectedFilePath = useAppStore((state) => state.selectedFilePath);
  const terminalLogs = useAppStore((state) => state.terminalLogs);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const shouldFocusLogs =
    isDeploying ||
    isGeneratingProject ||
    isInstallingDependencies ||
    isRunningCommand ||
    isStartingDevServer;

  useEffect(() => {
    if (shouldFocusLogs) {
      setActiveTab("logs");
    }
  }, [shouldFocusLogs]);

  useEffect(() => {
    if (activeTab === "logs") {
      logsEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [activeTab, terminalLogs.length]);

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
        </div>
        {activeCommand ? (
          <div className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            <span className="max-w-[220px] truncate">{activeCommand}</span>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
