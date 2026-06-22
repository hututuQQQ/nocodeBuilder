import type { FileTree } from "../../services/projects";
import {
  DEFAULT_PROJECT_POLICY,
  type ProjectPolicy,
} from "./projectPolicy";

export function formatProjectFileTree(fileTree: FileTree) {
  return formatFileTree(fileTree);
}

export function getContextFilePaths(
  fileTree: FileTree,
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
) {
  const paths = flattenProjectFileTree(fileTree)
    .filter((node) => node.kind === "file")
    .map((node) => normalizeProjectPath(node.path))
    .filter((path): path is string => Boolean(path))
    .filter((path) => isAllowedProjectPath(path, policy));

  return uniquePaths(sortContextPaths(paths, policy));
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

export function isAllowedProjectPath(
  path: string,
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
) {
  if (path.startsWith(".env") || path.includes("/.env")) {
    return false;
  }

  const isAllowedLocation =
    policy.rootAllowedFiles.includes(path) ||
    policy.allowedDirectories.some((directory) =>
      path.startsWith(`${directory}/`),
    );

  return isAllowedLocation && hasAllowedTextExtension(path, policy);
}

export function isAllowedProjectSearchPath(
  path: string,
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
) {
  if (isAllowedProjectPath(path, policy)) {
    return true;
  }

  const directoryPath = path.endsWith("/") ? path : `${path}/`;

  return policy.allowedDirectories.some(
    (directory) => directoryPath === `${directory}/`,
  );
}

export function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths));
}

export function flattenProjectFileTree(fileTree: FileTree): FileTree[] {
  return [
    fileTree,
    ...(fileTree.children ?? []).flatMap((child) => flattenProjectFileTree(child)),
  ];
}

export function getAllowedFilePaths(
  fileTree: FileTree,
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
) {
  return flattenProjectFileTree(fileTree)
    .filter((node) => node.kind === "file")
    .map((node) => normalizeProjectPath(node.path))
    .filter((path): path is string => Boolean(path))
    .filter((path) => isAllowedProjectPath(path, policy));
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

function sortContextPaths(paths: string[], policy: ProjectPolicy) {
  return [...paths].sort((left, right) => {
    const leftPriority = policy.contextPriorities[left] ?? 10;
    const rightPriority = policy.contextPriorities[right] ?? 10;

    return leftPriority - rightPriority || left.localeCompare(right);
  });
}

function hasAllowedTextExtension(path: string, policy: ProjectPolicy) {
  return policy.allowedTextExtensions.some((extension) =>
    path.endsWith(extension),
  );
}
