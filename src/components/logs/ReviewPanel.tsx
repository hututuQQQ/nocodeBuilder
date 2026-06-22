import { DiffEditor } from "@monaco-editor/react";
import {
  Check,
  CheckCircle2,
  FileDiff,
  Loader2,
  RotateCcw,
} from "lucide-react";
import {
  getPendingReviewFiles,
  type PendingReviewFile,
} from "../../store/changeHistory";
import { EmptyState } from "./EmptyState";
import { getLanguageLabel, getMonacoLanguage } from "./CodeViewer";
import "./monacoSetup";

type ReviewPanelProps = {
  changeHistory: Parameters<typeof getPendingReviewFiles>[0];
  currentProjectName: string | null;
  isRevertingChange: boolean;
  onAcceptAll: () => Promise<void>;
  onAcceptFile: (path: string) => Promise<void>;
  onRevertAll: () => Promise<void>;
  onRevertFile: (path: string) => Promise<void>;
  onSelectFile: (path: string | null) => void;
  selectedFilePath: string | null;
};

export function ReviewPanel({
  changeHistory,
  currentProjectName,
  isRevertingChange,
  onAcceptAll,
  onAcceptFile,
  onRevertAll,
  onRevertFile,
  onSelectFile,
  selectedFilePath,
}: ReviewPanelProps) {
  const pendingFiles = getPendingReviewFiles(changeHistory);

  if (!currentProjectName) {
    return (
      <EmptyState
        icon={<FileDiff size={18} aria-hidden="true" />}
        title="No project selected"
        detail="Select a project to review code changes."
      />
    );
  }

  if (pendingFiles.length === 0) {
    return (
      <EmptyState
        icon={<FileDiff size={18} aria-hidden="true" />}
        title="No code changes yet"
        detail="Agent edits from the current chat will appear here."
      />
    );
  }

  const selectedFile =
    pendingFiles.find((file) => file.path === selectedFilePath) ??
    pendingFiles[0];

  return (
    <div className="grid h-full min-h-[180px] min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      <header className="flex min-h-12 items-center gap-3 border-b border-zinc-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">
            Pending review
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>{pendingFiles.length} file(s)</span>
            <span>
              +{sumBy(pendingFiles, "additions")} / -
              {sumBy(pendingFiles, "deletions")}
            </span>
            <span>current chat</span>
          </div>
        </div>
        <button
          className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-emerald-400/25 bg-emerald-400/10 px-3 text-xs font-medium text-emerald-100 transition hover:border-emerald-300/50 disabled:cursor-not-allowed disabled:text-zinc-600"
          disabled={isRevertingChange}
          onClick={() => void onAcceptAll()}
          type="button"
        >
          <Check size={13} aria-hidden="true" />
          Accept all
        </button>
        <button
          className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
          disabled={isRevertingChange}
          onClick={() => void onRevertAll()}
          type="button"
        >
          {isRevertingChange ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw size={13} aria-hidden="true" />
          )}
          Revert all
        </button>
      </header>

      <div className="min-w-0 border-b border-zinc-800 px-3 py-2">
        <div className="mb-2 text-xs font-medium text-zinc-500">
          Changed files
        </div>
        <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
          {pendingFiles.map((file) => (
            <button
              className={`flex min-h-12 min-w-[190px] max-w-[280px] items-start gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition ${
                file.path === selectedFile.path
                  ? "border-teal-400/35 bg-teal-400/10 text-zinc-100"
                  : "border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
              }`}
              key={file.path}
              onClick={() => onSelectFile(file.path)}
              type="button"
            >
              <FileDiff
                size={13}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{file.path}</span>
                <span className="mt-0.5 block text-[11px] text-zinc-500">
                  {file.action} +{file.additions} / -{file.deletions}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <DiffPane
        file={selectedFile}
        isRevertingChange={isRevertingChange}
        onAcceptFile={onAcceptFile}
        onRevertFile={onRevertFile}
      />
    </div>
  );
}

function DiffPane({
  file,
  isRevertingChange,
  onAcceptFile,
  onRevertFile,
}: {
  file: PendingReviewFile;
  isRevertingChange: boolean;
  onAcceptFile: (path: string) => Promise<void>;
  onRevertFile: (path: string) => Promise<void>;
}) {
  const language = getMonacoLanguage(file.path);
  const languageLabel = getLanguageLabel(language, file.path);

  return (
    <div className="grid min-h-0 min-w-0 grid-rows-[40px_minmax(0,1fr)]">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-3">
        <div className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-300">
          {file.path}
        </div>
        <span className="shrink-0 text-xs text-zinc-500">
          {file.action} +{file.additions} / -{file.deletions}
        </span>
        {languageLabel ? (
          <span className="shrink-0 rounded border border-zinc-800 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
            {languageLabel}
          </span>
        ) : null}
        <button
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-emerald-400/25 bg-emerald-400/10 px-2 text-xs text-emerald-100 transition hover:border-emerald-300/50 disabled:cursor-not-allowed disabled:text-zinc-600"
          disabled={isRevertingChange}
          onClick={() => void onAcceptFile(file.path)}
          type="button"
        >
          <CheckCircle2 size={12} aria-hidden="true" />
          Accept file
        </button>
        <button
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
          disabled={isRevertingChange}
          onClick={() => void onRevertFile(file.path)}
          type="button"
        >
          {isRevertingChange ? (
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw size={12} aria-hidden="true" />
          )}
          Revert file
        </button>
      </div>
      <div className="min-h-0 min-w-0">
        <DiffEditor
          height="100%"
          language={language}
          modified={file.afterContent ?? ""}
          original={file.beforeContent ?? ""}
          options={{
            automaticLayout: true,
            domReadOnly: true,
            fontFamily:
              'JetBrains Mono, "Cascadia Code", "Fira Code", Consolas, monospace',
            fontLigatures: true,
            fontSize: 12,
            lineHeight: 19,
            minimap: {
              enabled: true,
              maxColumn: 90,
              renderCharacters: false,
              scale: 0.8,
            },
            originalEditable: false,
            readOnly: true,
            renderSideBySide: true,
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            wordWrap: "on",
          }}
          theme="nocode-dark"
        />
      </div>
    </div>
  );
}

function sumBy(files: PendingReviewFile[], key: "additions" | "deletions") {
  return files.reduce((sum, file) => sum + file[key], 0);
}
