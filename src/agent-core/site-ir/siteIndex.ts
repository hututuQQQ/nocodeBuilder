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
  fileTree,
  projectId,
  projectName,
}: {
  fileTree: FileTree;
  projectId: string;
  projectName: string;
}): { sourceMap: SiteSourceMap; siteSpec: SiteSpec } {
  const pages = flattenFileTree(fileTree)
    .filter((file) => isPageFile(file.path))
    .map((file) => createPageSpec(file.path));
  const siteSpec: SiteSpec = {
    ...createEmptySiteSpec(projectId, projectName),
    pages,
    reusableComponents: flattenFileTree(fileTree)
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

export function flattenNodes(nodes: SiteNode[]): SiteNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])]);
}

function createPageSpec(path: string): PageSpec {
  const route = pagePathToRoute(path);
  const pageId = route === "/" ? "home" : route.replace(/[^\w]+/g, ".").replace(/^\.+/, "");
  const nodeId = `${pageId || "page"}.root`;

  return {
    id: pageId || "page",
    route,
    title: route === "/" ? "Home" : route,
    nodes: [
      {
        id: nodeId,
        type: "page",
        label: route,
        source: { path },
      },
    ],
  };
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
