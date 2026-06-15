import type { FileTree } from "../../services/projects";

const ROOT_ALLOWED_FILES = new Set([
  "package.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "postcss.config.js",
  "postcss.config.mjs",
  "tailwind.config.js",
  "tailwind.config.ts",
  "tsconfig.json",
  "vercel.json",
  "middleware.ts",
]);

const ALLOWED_PROJECT_DIRECTORIES = [
  "app/",
  "components/",
  "lib/",
  "data/",
  "public/",
];

const ALLOWED_TEXT_FILE_EXTENSIONS = [
  ".css",
  ".cjs",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
];

export function formatProjectFileTree(fileTree: FileTree) {
  return formatFileTree(fileTree);
}

export function getContextFilePaths(fileTree: FileTree) {
  const paths = flattenFileTree(fileTree)
    .filter((node) => node.kind === "file")
    .map((node) => normalizeProjectPath(node.path))
    .filter((path): path is string => Boolean(path))
    .filter(isAllowedProjectPath);

  return uniquePaths(sortContextPaths(paths));
}

export function normalizeProjectPath(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const path = value.trim().replace(/\\/g, "/");

  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\0")
  ) {
    return null;
  }

  const segments = path.split("/").filter(Boolean);

  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
}

export function isAllowedProjectPath(path: string) {
  if (path.startsWith(".env") || path.includes("/.env")) {
    return false;
  }

  const isAllowedLocation =
    ROOT_ALLOWED_FILES.has(path) ||
    ALLOWED_PROJECT_DIRECTORIES.some((directory) => path.startsWith(directory));

  return isAllowedLocation && hasAllowedTextExtension(path);
}

export function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths));
}

function formatFileTree(fileTree: FileTree) {
  const lines: string[] = [];

  function visit(node: FileTree, depth: number) {
    const prefix = depth === 0 ? "" : `${"  ".repeat(depth - 1)}- `;
    const suffix = node.kind === "directory" ? "/" : "";
    lines.push(`${prefix}${node.path || node.name}${suffix}`);

    for (const child of node.children ?? []) {
      visit(child, depth + 1);
    }
  }

  visit(fileTree, 0);
  return lines.join("\n");
}

function flattenFileTree(fileTree: FileTree): FileTree[] {
  return [
    fileTree,
    ...(fileTree.children ?? []).flatMap((child) => flattenFileTree(child)),
  ];
}

function sortContextPaths(paths: string[]) {
  const priority = new Map([
    ["package.json", 0],
    ["app/layout.tsx", 1],
    ["app/page.tsx", 2],
    ["app/globals.css", 3],
    ["tailwind.config.ts", 4],
    ["tailwind.config.js", 4],
    ["tsconfig.json", 5],
  ]);

  return [...paths].sort((left, right) => {
    const leftPriority = priority.get(left) ?? 10;
    const rightPriority = priority.get(right) ?? 10;

    return leftPriority - rightPriority || left.localeCompare(right);
  });
}

function hasAllowedTextExtension(path: string) {
  return ALLOWED_TEXT_FILE_EXTENSIONS.some((extension) =>
    path.endsWith(extension),
  );
}
