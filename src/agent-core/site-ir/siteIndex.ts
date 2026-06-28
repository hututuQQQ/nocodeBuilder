import type { FileTree } from "../../services/projects";
import type { PageSpec, SiteNode, SiteSourceMap, SiteSpec } from "../types";

export function createEmptySiteSpec(projectId: string, projectName: string): SiteSpec {
  return {
    version: 1,
    projectId,
    product: {
      name: projectName,
      description: "Generated no-code site",
      language: "unknown",
    },
    designSystem: {
      colors: {},
      typography: {},
      spacing: {},
      radii: {},
    },
    pages: [],
    reusableComponents: [],
  };
}

export function buildSiteIndexFromFileTree({
  fileContents = {},
  fileTree,
  projectId,
  projectName,
}: {
  fileContents?: Record<string, string>;
  fileTree: FileTree;
  projectId: string;
  projectName: string;
}): { sourceMap: SiteSourceMap; siteSpec: SiteSpec } {
  const files = flattenFileTree(fileTree);
  const pages = files
    .filter((file) => isPageFile(file.path))
    .map((file) => createPageSpec(file.path, fileContents[file.path]));
  const siteSpec: SiteSpec = {
    ...createEmptySiteSpec(projectId, projectName),
    pages,
    reusableComponents: files
      .filter((file) => file.path.startsWith("components/") && /\.tsx?$/.test(file.path))
      .map((file) => ({
        id: pathToNodeId(file.path),
        name: file.name.replace(/\.[^.]+$/, ""),
        source: { path: file.path },
      })),
  };
  const sourceMap: SiteSourceMap = {
    version: 1,
    projectId,
    entries: pages.flatMap((page) => flattenNodes(page.nodes)).map((node) => ({
      nodeId: node.id,
      path: node.source?.path ?? "unknown",
      startLine: node.source?.startLine,
      endLine: node.source?.endLine,
    })),
    updatedAt: new Date().toISOString(),
  };

  return { siteSpec, sourceMap };
}

export function findSiteNode(siteSpec: SiteSpec, query: string): SiteNode | null {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  for (const page of siteSpec.pages) {
    const node = flattenNodes(page.nodes).find(
      (candidate) =>
        candidate.id.toLowerCase() === normalized ||
        candidate.label?.toLowerCase().includes(normalized) ||
        candidate.type.toLowerCase().includes(normalized),
    );

    if (node) {
      return node;
    }
  }

  return null;
}

export function validateUniqueSiteNodeIds(siteSpec: SiteSpec) {
  const ids = new Set<string>();

  for (const page of siteSpec.pages) {
    for (const node of flattenNodes(page.nodes)) {
      if (ids.has(node.id)) {
        throw new Error(`Duplicate SiteSpec node id: ${node.id}`);
      }

      ids.add(node.id);
    }
  }
}

export function preserveSiteSpecMetadata(existing: SiteSpec | null, next: SiteSpec): SiteSpec {
  if (!existing) {
    return next;
  }

  return {
    ...next,
    designSystem: existing.designSystem,
    product: existing.product,
  };
}

export function flattenNodes(nodes: SiteNode[]): SiteNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])]);
}

function createPageSpec(path: string, content?: string): PageSpec {
  const route = pagePathToRoute(path);
  const pageId = route === "/" ? "home" : route.replace(/[^\w]+/g, ".").replace(/^\.+/, "");
  const nodeId = `${pageId || "page"}.root`;
  const childNodes = content === undefined
    ? []
    : extractDataNodesFromContent(path, content, nodeId);
  const lineCount = content ? content.split(/\r?\n/).length : undefined;
  const rootLine = content ? findDataNodeLine(content, nodeId) : undefined;

  return {
    id: pageId || "page",
    route,
    title: route === "/" ? "Home" : route,
    nodes: [
      {
        id: nodeId,
        type: "page",
        label: route,
        source: { path, startLine: rootLine ?? 1, endLine: rootLine ?? lineCount },
        children: childNodes,
      },
    ],
  };
}

function extractDataNodesFromContent(
  path: string,
  content: string,
  parentId: string,
): SiteNode[] {
  const nodes: SiteNode[] = [];
  const dataAttributePattern =
    /data-ncb-id\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*"([^"]+)"\s*\}|\{\s*'([^']+)'\s*\}|\{\s*`([^`]+)`\s*\})/g;

  for (const match of content.matchAll(dataAttributePattern)) {
    const id = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];

    if (!id) {
      continue;
    }

    if (id === parentId) {
      continue;
    }

    const line = lineNumberAt(content, match.index ?? 0);
    const tagName = inferJsxTagName(content, match.index ?? 0);

    const labelParts = id.split(".").filter(Boolean);

    nodes.push({
      id,
      type: tagName ? tagNameToNodeType(tagName) : "element",
      label: labelParts[labelParts.length - 1] ?? id,
      parentId,
      source: { path, startLine: line, endLine: line },
      props: { tagName: tagName ?? "unknown" },
    });
  }

  return nodes;
}

function findDataNodeLine(content: string, nodeId: string) {
  const dataAttributePattern =
    /data-ncb-id\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*"([^"]+)"\s*\}|\{\s*'([^']+)'\s*\}|\{\s*`([^`]+)`\s*\})/g;

  for (const match of content.matchAll(dataAttributePattern)) {
    const id = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];

    if (id === nodeId) {
      return lineNumberAt(content, match.index ?? 0);
    }
  }

  return undefined;
}

function inferJsxTagName(content: string, attributeIndex: number) {
  const prefix = content.slice(Math.max(0, attributeIndex - 240), attributeIndex);
  const match = prefix.match(/<([A-Za-z][\w.]*)[^<>]*$/);
  return match?.[1] ?? null;
}

function tagNameToNodeType(tagName: string) {
  if (/^[A-Z]/.test(tagName)) {
    return "component";
  }

  return tagName.toLowerCase();
}

function lineNumberAt(content: string, index: number) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function pagePathToRoute(path: string) {
  if (path === "app/page.tsx" || path === "app/page.jsx") {
    return "/";
  }

  return path
    .replace(/^app\//, "/")
    .replace(/\/page\.[tj]sx$/, "")
    .replace(/\[[^\]]+\]/g, ":param");
}

function isPageFile(path: string) {
  return /^app\/(?:.*\/)?page\.[tj]sx$/.test(path);
}

function flattenFileTree(fileTree: FileTree): FileTree[] {
  return [
    fileTree,
    ...(fileTree.children ?? []).flatMap((child) => flattenFileTree(child)),
  ].filter((item) => item.kind === "file");
}

function pathToNodeId(path: string) {
  return path
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}
