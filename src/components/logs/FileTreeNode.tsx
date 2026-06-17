import {
  ChevronRight,
  File,
  FileBraces,
  FileCode2,
  FileImage,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Package,
  Settings,
} from "lucide-react";
import { useState } from "react";
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
  const [isExpanded, setIsExpanded] = useState(true);
  const hasChildren = children.length > 0;
  const fileMeta = isFile ? getFileMeta(node.path) : null;

  function handleClick() {
    if (isFile) {
      void onReadFile(node.path);
      return;
    }

    if (hasChildren) {
      setIsExpanded((current) => !current);
    }
  }

  return (
    <div>
      <button
        aria-expanded={!isFile && hasChildren ? isExpanded : undefined}
        className={`group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition ${
          isSelected
            ? "bg-teal-400/15 text-teal-50 ring-1 ring-inset ring-teal-300/20"
            : isFile
              ? "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
              : "font-medium text-zinc-300 hover:bg-zinc-900 hover:text-zinc-50"
        }`}
        onClick={handleClick}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={node.path || node.name}
        type="button"
      >
        {isFile ? (
          fileMeta?.icon
        ) : (
          <>
            {hasChildren ? (
              <ChevronRight
                size={13}
                className={`shrink-0 transition duration-200 ease-out ${
                  isExpanded
                    ? "rotate-90 text-zinc-300"
                    : "rotate-0 text-zinc-500"
                }`}
                aria-hidden="true"
              />
            ) : (
              <span className="w-[13px] shrink-0" aria-hidden="true" />
            )}
            {hasChildren && isExpanded ? (
              <FolderOpen
                size={14}
                className="shrink-0 text-amber-300/90"
                aria-hidden="true"
              />
            ) : (
              <Folder
                size={14}
                className="shrink-0 text-amber-300/75"
                aria-hidden="true"
              />
            )}
          </>
        )}
        <span className="min-w-0 truncate">{node.name}</span>
        {fileMeta?.label ? (
          <span className="ml-auto shrink-0 rounded border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none text-zinc-500 group-hover:border-zinc-700 group-hover:text-zinc-300">
            {fileMeta.label}
          </span>
        ) : null}
      </button>

      {hasChildren ? (
        <div
          aria-hidden={!isExpanded}
          className={`grid overflow-hidden ${
            isExpanded ? "" : "pointer-events-none"
          }`}
          inert={!isExpanded ? true : undefined}
          style={{
            gridTemplateRows: isExpanded ? "1fr" : "0fr",
            opacity: isExpanded ? 1 : 0,
            transition:
              "grid-template-rows 200ms ease-out, opacity 160ms ease-out",
          }}
        >
          <div className="min-h-0 overflow-hidden">
            {children.map((child) => (
              <FileTreeNode
                depth={depth + 1}
                key={child.path || `${node.path}/${child.name}`}
                node={child}
                onReadFile={onReadFile}
                selectedFilePath={selectedFilePath}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function getFileMeta(path: string) {
  const normalizedPath = path.toLowerCase();
  const fileName = normalizedPath.split("/").pop() ?? normalizedPath;

  if (fileName === "package.json") {
    return {
      icon: (
        <Package
          size={14}
          className="shrink-0 text-red-300"
          aria-hidden="true"
        />
      ),
      label: "npm",
    };
  }

  if (
    fileName.endsWith(".config.js") ||
    fileName.endsWith(".config.mjs") ||
    fileName.endsWith(".config.ts") ||
    fileName.startsWith(".")
  ) {
    return {
      icon: (
        <Settings
          size={14}
          className="shrink-0 text-zinc-300"
          aria-hidden="true"
        />
      ),
      label: getFileExtension(fileName),
    };
  }

  if (/\.(tsx?|jsx?|mjs|cjs)$/.test(fileName)) {
    return {
      icon: (
        <FileCode2
          size={14}
          className="shrink-0 text-sky-300"
          aria-hidden="true"
        />
      ),
      label: getFileExtension(fileName),
    };
  }

  if (/\.(css|scss|less)$/.test(fileName)) {
    return {
      icon: (
        <FileType
          size={14}
          className="shrink-0 text-pink-300"
          aria-hidden="true"
        />
      ),
      label: getFileExtension(fileName),
    };
  }

  if (/\.(json|jsonc|yml|yaml|xml|svg)$/.test(fileName)) {
    return {
      icon: (
        <FileBraces
          size={14}
          className="shrink-0 text-emerald-300"
          aria-hidden="true"
        />
      ),
      label: getFileExtension(fileName),
    };
  }

  if (/\.(png|jpe?g|gif|webp|avif|ico)$/.test(fileName)) {
    return {
      icon: (
        <FileImage
          size={14}
          className="shrink-0 text-violet-300"
          aria-hidden="true"
        />
      ),
      label: getFileExtension(fileName),
    };
  }

  if (/\.(md|txt)$/.test(fileName)) {
    return {
      icon: (
        <FileText
          size={14}
          className="shrink-0 text-zinc-300"
          aria-hidden="true"
        />
      ),
      label: getFileExtension(fileName),
    };
  }

  return {
    icon: (
      <File
        size={14}
        className="shrink-0 text-zinc-500"
        aria-hidden="true"
      />
    ),
    label: getFileExtension(fileName),
  };
}

function getFileExtension(fileName: string) {
  if (fileName.endsWith(".module.css")) {
    return "css";
  }

  const extension = fileName.match(/\.([a-z0-9]+)$/)?.[1];

  return extension && extension.length <= 5 ? extension : "";
}
