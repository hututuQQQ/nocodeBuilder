import {
  buildSiteIndexFromFileTree,
  createEmptySiteSpec,
  findSiteNode,
  validateUniqueSiteNodeIds,
} from "../agent-core/site-ir/siteIndex";
import type { SiteNode, SiteSpec } from "../agent-core/types";
import type { FileTree, ProjectInfo, ProjectFileInput } from "../services/projects";
import { agentRuntimeApi } from "../services/agentRuntime";
import { projectApi } from "../services/projects";

export async function ensureSiteIndex(project: ProjectInfo, fileTree: FileTree | null) {
  const existing = await agentRuntimeApi.readSiteSpec(project.id);

  if (existing) {
    validateUniqueSiteNodeIds(existing);
    return existing;
  }

  const resolvedFileTree = fileTree ?? (await projectApi.listFiles(project.id));
  const { siteSpec, sourceMap } = buildSiteIndexFromFileTree({
    fileTree: resolvedFileTree,
    projectId: project.id,
    projectName: project.name,
  });

  validateUniqueSiteNodeIds(siteSpec);
  await agentRuntimeApi.writeSiteSpec(project.id, siteSpec);
  await agentRuntimeApi.writeSiteSourceMap(project.id, sourceMap);
  return siteSpec;
}

export async function refreshSiteIndex(project: ProjectInfo, fileTree: FileTree | null) {
  const resolvedFileTree = fileTree ?? (await projectApi.listFiles(project.id));
  const { siteSpec, sourceMap } = buildSiteIndexFromFileTree({
    fileTree: resolvedFileTree,
    projectId: project.id,
    projectName: project.name,
  });

  validateUniqueSiteNodeIds(siteSpec);
  await agentRuntimeApi.writeSiteSpec(project.id, siteSpec);
  await agentRuntimeApi.writeSiteSourceMap(project.id, sourceMap);
  return siteSpec;
}

export async function resolveSelectedSiteNode(
  projectId: string,
  selectedSiteNodeId: string | null,
): Promise<SiteNode | null> {
  if (!selectedSiteNodeId) {
    return null;
  }

  const siteSpec = await agentRuntimeApi.readSiteSpec(projectId);
  return siteSpec ? findSiteNode(siteSpec, selectedSiteNodeId) : null;
}

export function createFallbackSiteSpec(project: ProjectInfo): SiteSpec {
  return createEmptySiteSpec(project.id, project.name);
}

export function addStableNodeIdsToGeneratedFiles(files: ProjectFileInput[]) {
  return files.map((file) => {
    if (!/^app\/(?:.*\/)?page\.[tj]sx$/.test(file.path)) {
      return file;
    }

    const nodeId = `${pagePathToNodeId(file.path)}.root`;
    const withNodeId = file.content.includes("data-ncb-id=")
      ? file.content
      : file.content.replace(/<main(\s|>)/, `<main data-ncb-id="${nodeId}"$1`);

    return {
      ...file,
      content: injectPreviewBridge(withNodeId),
    };
  });
}

function pagePathToNodeId(path: string) {
  if (path === "app/page.tsx" || path === "app/page.jsx") {
    return "home";
  }

  return path
    .replace(/^app\//, "")
    .replace(/\/page\.[tj]sx$/, "")
    .replace(/[^\w]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

function injectPreviewBridge(content: string) {
  if (content.includes("nocode-builder-preview")) {
    return content;
  }

  return content.replace(/(<main[^>]*>)/, `$1\n${PREVIEW_BRIDGE_SCRIPT}`);
}

const PREVIEW_BRIDGE_SCRIPT = `<script dangerouslySetInnerHTML={{__html: \`
(() => {
  if (typeof window === "undefined" || window.__ncbPreviewBridge) return;
  window.__ncbPreviewBridge = true;
  const report = (type, payload) => window.parent && window.parent.postMessage({ source: "nocode-builder-preview", type, ...payload }, "*");
  window.addEventListener("error", (event) => report("diagnostic", { level: "error", message: event.message }));
  window.addEventListener("unhandledrejection", (event) => report("diagnostic", { level: "error", message: String(event.reason || "unhandled rejection") }));
  document.addEventListener("click", (event) => {
    const target = event.target && event.target.closest ? event.target.closest("[data-ncb-id]") : null;
    if (!target) return;
    report("node-selected", { nodeId: target.getAttribute("data-ncb-id") });
  }, true);
})();
\`}} />`;
