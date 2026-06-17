import {
  PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  FileCode2,
  Loader2,
} from "lucide-react";
import { FileTree } from "../../services/projects";
import { CodeViewer } from "./CodeViewer";
import { EmptyState } from "./EmptyState";
import { FileTreeNode } from "./FileTreeNode";

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

export function FilesWorkspace({
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
