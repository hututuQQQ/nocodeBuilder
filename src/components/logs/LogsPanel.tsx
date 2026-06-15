import {
  PointerEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker.js?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker.js?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";
import "monaco-editor/esm/vs/language/css/monaco.contribution.js";
import "monaco-editor/esm/vs/language/html/monaco.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import {
  ChevronRight,
  File,
  FileCode2,
  Folder,
  Loader2,
  TerminalSquare,
} from "lucide-react";
import { FileTree } from "../../services/projects";
import { useAppStore } from "../../store/appStore";

type MonacoEnvironmentHost = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, label: string) => Worker;
  };
};

(globalThis as MonacoEnvironmentHost).MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label === "json") {
      return new jsonWorker();
    }

    if (label === "css" || label === "scss" || label === "less") {
      return new cssWorker();
    }

    if (label === "html" || label === "handlebars" || label === "razor") {
      return new htmlWorker();
    }

    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }

    return new editorWorker();
  },
};

loader.config({ monaco });

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

type FilesWorkspaceProps = {
  currentProjectName: string | null;
  fileTree: FileTree | null;
  isLoadingFiles: boolean;
  isReadingFile: boolean;
  onReadFile: (path: string) => Promise<void>;
  projectError: string | null;
  selectedFileContent: string;
  selectedFilePath: string | null;
};

function FilesWorkspace({
  currentProjectName,
  fileTree,
  isLoadingFiles,
  isReadingFile,
  onReadFile,
  projectError,
  selectedFileContent,
  selectedFilePath,
}: FilesWorkspaceProps) {
  const [treeWidth, setTreeWidth] = useState(270);
  const [isResizingTree, setIsResizingTree] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      setTreeWidth((currentWidth) =>
        clampTreeWidth(entry.contentRect.width, currentWidth),
      );
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!isResizingTree) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(event: globalThis.PointerEvent) {
      const container = containerRef.current;

      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      setTreeWidth(clampTreeWidth(rect.width, event.clientX - rect.left));
    }

    function handlePointerUp() {
      setIsResizingTree(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizingTree]);

  function handleTreeResizeStart(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsResizingTree(true);
  }

  if (!currentProjectName) {
    return (
      <EmptyState
        icon={<FileCode2 size={18} aria-hidden="true" />}
        title="No project selected"
        detail="Create or select a project to inspect local files."
      />
    );
  }

  if (isLoadingFiles) {
    return (
      <div className="grid h-full min-h-[180px] place-items-center rounded-md border border-zinc-800 bg-zinc-900/30 px-6 text-sm text-zinc-500">
        <div className="flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Loading files
        </div>
      </div>
    );
  }

  if (!fileTree) {
    return (
      <EmptyState
        icon={<FileCode2 size={18} aria-hidden="true" />}
        title="No file tree"
        detail="The selected project did not return a file tree."
      />
    );
  }

  return (
    <div
      className="grid h-full min-h-[180px] min-w-0"
      ref={containerRef}
      style={{
        gridTemplateColumns: `${treeWidth}px 6px minmax(0, 1fr)`,
      }}
    >
      <div className="min-h-0 min-w-0 overflow-y-auto rounded-l-md border border-r-0 border-zinc-800 bg-zinc-950 p-2">
        <FileTreeNode
          node={fileTree}
          depth={0}
          onReadFile={onReadFile}
          selectedFilePath={selectedFilePath}
        />
      </div>
      <div
        aria-label="Resize file tree and code viewer"
        aria-orientation="vertical"
        className={`group grid cursor-col-resize place-items-center border-y border-zinc-800 bg-zinc-950 transition hover:bg-teal-400/10 ${
          isResizingTree ? "bg-teal-400/15" : ""
        }`}
        onPointerDown={handleTreeResizeStart}
        role="separator"
        tabIndex={0}
      >
        <div
          className={`h-10 w-0.5 rounded-full bg-zinc-700 transition group-hover:bg-teal-300 ${
            isResizingTree ? "bg-teal-300" : ""
          }`}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-col rounded-r-md border border-l-0 border-zinc-800 bg-zinc-950">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
          <div className="min-w-0 truncate text-xs font-medium text-zinc-400">
            {selectedFilePath ?? currentProjectName}
          </div>
          {isReadingFile ? (
            <Loader2
              size={15}
              className="shrink-0 animate-spin text-zinc-500"
              aria-hidden="true"
            />
          ) : null}
        </div>

        {selectedFilePath ? (
          <CodeViewer
            content={selectedFileContent}
            isLoading={isReadingFile}
            path={selectedFilePath}
          />
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-center text-sm text-zinc-600">
            Select a file to view its contents.
          </div>
        )}

        {projectError ? (
          <div className="border-t border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">
            {projectError}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type CodeViewerProps = {
  content: string;
  isLoading: boolean;
  path: string;
};

function CodeViewer({ content, isLoading, path }: CodeViewerProps) {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0b0b0d]">
      <Editor
        height="100%"
        language={getMonacoLanguage(path)}
        loading={
          <div className="grid h-full place-items-center text-xs text-zinc-600">
            Loading editor
          </div>
        }
        options={{
          automaticLayout: true,
          contextmenu: true,
          cursorBlinking: "smooth",
          domReadOnly: true,
          fontFamily:
            'JetBrains Mono, "Cascadia Code", "Fira Code", Consolas, monospace',
          fontLigatures: true,
          fontSize: 12,
          lineHeight: 19,
          lineNumbers: "on",
          minimap: {
            enabled: true,
            maxColumn: 90,
            renderCharacters: false,
            scale: 0.8,
          },
          padding: {
            bottom: 14,
            top: 14,
          },
          readOnly: true,
          renderLineHighlight: "line",
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
          wordWrap: "on",
        }}
        path={path}
        theme="vs-dark"
        value={content}
      />

      {isLoading ? (
        <div className="absolute right-3 top-3 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/90 px-2 py-1 text-xs text-zinc-500 shadow-lg shadow-black/30">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Loading
        </div>
      ) : null}
    </div>
  );
}

function getMonacoLanguage(path: string) {
  const normalizedPath = path.toLowerCase();

  if (normalizedPath.endsWith(".tsx") || normalizedPath.endsWith(".ts")) {
    return "typescript";
  }

  if (normalizedPath.endsWith(".jsx") || normalizedPath.endsWith(".js")) {
    return "javascript";
  }

  if (normalizedPath.endsWith(".css")) {
    return "css";
  }

  if (normalizedPath.endsWith(".json")) {
    return "json";
  }

  if (normalizedPath.endsWith(".md")) {
    return "markdown";
  }

  if (normalizedPath.endsWith(".html")) {
    return "html";
  }

  if (normalizedPath.endsWith(".svg") || normalizedPath.endsWith(".xml")) {
    return "xml";
  }

  if (normalizedPath.endsWith(".yml") || normalizedPath.endsWith(".yaml")) {
    return "yaml";
  }

  if (
    normalizedPath.endsWith(".sh") ||
    normalizedPath.endsWith(".bash") ||
    normalizedPath.endsWith(".env")
  ) {
    return "shell";
  }

  return "plaintext";
}

function clampTreeWidth(containerWidth: number, width: number) {
  const minTreeWidth = 170;
  const minCodeWidth = 260;
  const handleWidth = 6;
  const maxTreeWidth = Math.max(
    minTreeWidth,
    containerWidth - minCodeWidth - handleWidth,
  );

  return Math.round(Math.min(Math.max(width, minTreeWidth), maxTreeWidth));
}

type FileTreeNodeProps = {
  node: FileTree;
  depth: number;
  onReadFile: (path: string) => Promise<void>;
  selectedFilePath: string | null;
};

function FileTreeNode({
  node,
  depth,
  onReadFile,
  selectedFilePath,
}: FileTreeNodeProps) {
  const isFile = node.kind === "file";
  const isSelected = isFile && selectedFilePath === node.path;
  const children = node.children ?? [];

  return (
    <div>
      <button
        className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs transition ${
          isSelected
            ? "bg-teal-400/10 text-teal-100"
            : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
        } ${isFile ? "" : "font-medium text-zinc-300"}`}
        disabled={!isFile}
        onClick={() => {
          if (isFile) {
            void onReadFile(node.path);
          }
        }}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={node.path || node.name}
        type="button"
      >
        {isFile ? (
          <File size={14} className="shrink-0" aria-hidden="true" />
        ) : (
          <>
            <ChevronRight size={13} className="shrink-0" aria-hidden="true" />
            <Folder size={14} className="shrink-0" aria-hidden="true" />
          </>
        )}
        <span className="min-w-0 truncate">{node.name}</span>
      </button>

      {children.length > 0 ? (
        <div>
          {children.map((child) => (
            <FileTreeNode
              depth={depth + 1}
              key={child.path || child.name}
              node={child}
              onReadFile={onReadFile}
              selectedFilePath={selectedFilePath}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type EmptyStateProps = {
  icon: ReactNode;
  title: string;
  detail: string;
};

function EmptyState({ icon, title, detail }: EmptyStateProps) {
  return (
    <div className="grid h-full min-h-[180px] place-items-center rounded-md border border-dashed border-zinc-800 bg-zinc-900/30 px-6 text-center">
      <div>
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-500">
          {icon}
        </div>
        <p className="text-sm font-medium text-zinc-300">{title}</p>
        <p className="mt-1 max-w-xs text-xs leading-5 text-zinc-600">{detail}</p>
      </div>
    </div>
  );
}
