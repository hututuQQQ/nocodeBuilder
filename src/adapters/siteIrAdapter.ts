import {
  buildSiteIndexFromFileTree,
  createEmptySiteSpec,
  findSiteNode,
  preserveSiteSpecMetadata,
  validateUniqueSiteNodeIds,
} from "../agent-core/site-ir/siteIndex";
import type { SiteNode, SiteSpec } from "../agent-core/types";
import type { FileTree, ProjectInfo, ProjectFileInput } from "../services/projects";
import { agentRuntimeApi } from "../services/agentRuntime";
import { projectApi } from "../services/projects";

const PREVIEW_BRIDGE_COMPONENT_PATH = "components/NocodeBuilderPreviewBridge.tsx";

export async function ensureSiteIndex(project: ProjectInfo, fileTree: FileTree | null) {
  const existing = await agentRuntimeApi.readSiteSpec(project.id);

  if (existing) {
    validateUniqueSiteNodeIds(existing);
    return existing;
  }

  const resolvedFileTree = fileTree ?? (await projectApi.listFiles(project.id));
  const fileContents = await readSiteIndexFileContents(project.id, resolvedFileTree);
  const { siteSpec, sourceMap } = buildSiteIndexFromFileTree({
    fileContents,
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
  const existing = await agentRuntimeApi.readSiteSpec(project.id);
  const resolvedFileTree = fileTree ?? (await projectApi.listFiles(project.id));
  const fileContents = await readSiteIndexFileContents(project.id, resolvedFileTree);
  const { siteSpec, sourceMap } = buildSiteIndexFromFileTree({
    fileContents,
    fileTree: resolvedFileTree,
    projectId: project.id,
    projectName: project.name,
  });
  const mergedSiteSpec = preserveSiteSpecMetadata(existing, siteSpec);

  validateUniqueSiteNodeIds(mergedSiteSpec);
  await agentRuntimeApi.writeSiteSpec(project.id, mergedSiteSpec);
  await agentRuntimeApi.writeSiteSourceMap(project.id, sourceMap);
  return mergedSiteSpec;
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
  let sawPageFile = false;
  const nextFiles = files.map((file) => {
    if (!/^app\/(?:.*\/)?page\.[tj]sx$/.test(file.path)) {
      return file;
    }

    sawPageFile = true;
    const nodeId = `${pagePathToNodeId(file.path)}.root`;
    const withNodeId = file.content.includes("data-ncb-id=")
      ? file.content
      : file.content.replace(/<main(\s|>)/, `<main data-ncb-id="${nodeId}"$1`);

    return {
      ...file,
      content: injectPreviewBridgeComponent(withNodeId, file.path),
    };
  });

  if (!sawPageFile) {
    return nextFiles;
  }

  const bridgeIndex = nextFiles.findIndex(
    (file) => file.path === PREVIEW_BRIDGE_COMPONENT_PATH,
  );

  if (bridgeIndex >= 0) {
    return nextFiles.map((file, index) =>
      index === bridgeIndex
        ? { ...file, content: PREVIEW_BRIDGE_COMPONENT }
        : file,
    );
  }

  return [
    ...nextFiles,
    {
      path: PREVIEW_BRIDGE_COMPONENT_PATH,
      content: PREVIEW_BRIDGE_COMPONENT,
    },
  ];
}

async function readSiteIndexFileContents(projectId: string, fileTree: FileTree) {
  const files = flattenFileTree(fileTree)
    .filter((file) => isSiteIndexSourceFile(file.path))
    .map((file) => file.path);
  const entries = await Promise.all(
    files.map(async (path) => {
      try {
        return [path, await projectApi.readFile(projectId, path)] as const;
      } catch {
        return null;
      }
    }),
  );

  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
}

function isSiteIndexSourceFile(path: string) {
  return /^app\/(?:.*\/)?page\.[tj]sx$/.test(path) ||
    (path.startsWith("components/") && /\.tsx?$/.test(path));
}

function flattenFileTree(fileTree: FileTree): FileTree[] {
  return [
    fileTree,
    ...(fileTree.children ?? []).flatMap((child) => flattenFileTree(child)),
  ].filter((item) => item.kind === "file");
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

function injectPreviewBridgeComponent(content: string, pagePath: string) {
  if (content.includes("<NocodeBuilderPreviewBridge")) {
    return content;
  }

  if (!/<main[^>]*>/.test(content)) {
    return content;
  }

  const withImport = ensurePreviewBridgeImport(content, pagePath);
  return withImport.replace(
    /(<main[^>]*>)/,
    `$1\n      <NocodeBuilderPreviewBridge />`,
  );
}

function ensurePreviewBridgeImport(content: string, pagePath: string) {
  if (content.includes("NocodeBuilderPreviewBridge")) {
    return content;
  }

  const importLine = `import NocodeBuilderPreviewBridge from "${relativeBridgeImport(pagePath)}";`;
  const lines = content.split(/\r?\n/);
  let insertIndex = 0;

  while (insertIndex < lines.length && isModuleDirective(lines[insertIndex].trim())) {
    insertIndex += 1;
  }

  while (insertIndex < lines.length && lines[insertIndex].trim() === "") {
    insertIndex += 1;
  }

  lines.splice(insertIndex, 0, importLine);
  return lines.join("\n");
}

function isModuleDirective(line: string) {
  return /^["']use (?:client|server)["'];?$/.test(line);
}

function relativeBridgeImport(pagePath: string) {
  const directory = pagePath.split("/").slice(0, -1);
  const prefix = "../".repeat(directory.length);
  return `${prefix}${PREVIEW_BRIDGE_COMPONENT_PATH.replace(/\.tsx$/, "")}`;
}

const PREVIEW_BRIDGE_COMPONENT = `"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    __ncbPreviewBridge?: boolean;
  }
}

type DiagnosticLevel = "error" | "warning" | "info";
type DiagnosticKind =
  | "window-error"
  | "unhandled-rejection"
  | "console-error"
  | "failed-image"
  | "failed-resource"
  | "horizontal-overflow";

export default function NocodeBuilderPreviewBridge() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (typeof window === "undefined" || window.__ncbPreviewBridge) return;
    if (window.parent === window) return;

    let targetOrigin = "";

    try {
      const parsedReferrer = new URL(document.referrer);
      const host = parsedReferrer.hostname;
      const isLocalBuilder =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "tauri.localhost" ||
        host.endsWith(".localhost");

      if (!isLocalBuilder) return;
      targetOrigin = parsedReferrer.origin;
    } catch {
      return;
    }

    window.__ncbPreviewBridge = true;
    const report = (type: string, payload: Record<string, unknown>) => {
      if (!window.parent || !targetOrigin) return;
      window.parent.postMessage({ source: "nocode-builder-preview", type, ...payload }, targetOrigin);
    };
    const diagnostic = (
      kind: DiagnosticKind,
      level: DiagnosticLevel,
      message: unknown,
      details: Record<string, unknown> = {},
    ) => report("diagnostic", { kind, level, message: String(message || kind), ...details });
    const originalConsoleError = console.error;

    console.error = (...args: unknown[]) => {
      diagnostic("console-error", "error", args.map((item) => String(item)).join(" "));
      originalConsoleError(...args);
    };

    const handleError = (event: ErrorEvent) => {
      const target = event.target;

      if (target && target !== window) {
        const element = target as HTMLElement & {
          currentSrc?: string;
          href?: string;
          src?: string;
          tagName?: string;
        };
        const url = element.currentSrc || element.src || element.href || "";
        diagnostic(
          element.tagName === "IMG" ? "failed-image" : "failed-resource",
          "error",
          url ? "Resource failed to load: " + url : "Resource failed to load.",
          { url },
        );
        return;
      }

      diagnostic("window-error", "error", event.message || "Window error");
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      diagnostic("unhandled-rejection", "error", String(event.reason || "unhandled rejection"));
    };
    const handleLoad = () => {
      window.setTimeout(() => {
        const body = document.body;

        if (body && body.scrollWidth > window.innerWidth + 2) {
          diagnostic("horizontal-overflow", "error", "Body horizontal overflow detected.", {
            scrollWidth: body.scrollWidth,
            viewportWidth: window.innerWidth,
          });
        }
      }, 0);
    };
    const handleClick = (event: MouseEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest("[data-ncb-id]")
        : null;

      if (!target) return;
      report("node-selected", { nodeId: target.getAttribute("data-ncb-id") });
    };

    window.addEventListener("error", handleError, true);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("load", handleLoad);
    document.addEventListener("click", handleClick, true);

    return () => {
      console.error = originalConsoleError;
      window.removeEventListener("error", handleError, true);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener("load", handleLoad);
      document.removeEventListener("click", handleClick, true);
      window.__ncbPreviewBridge = false;
    };
  }, []);

  return null;
}
`;
