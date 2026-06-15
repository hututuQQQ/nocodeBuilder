import {
  ChevronRight,
  File,
  Folder,
} from "lucide-react";
import { FileTree } from "../../services/projects";

type FileTreeNodeProps = {
  node: FileTree;
  depth: number;
  onReadFile: (path: string) => Promise<void>;
  selectedFilePath: string | null;
};

export function FileTreeNode({
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
