import { DeepSeekClient } from "./llm/DeepSeekClient";
import type { ChatMessage as LlmChatMessage } from "./llm/types";
import type { FileTree, ProjectFileInput } from "../services/projects";
import type { DeepSeekConfig } from "../services/keyStore";

export type ModifyProjectResponse = {
  type: "modify_files";
  summary: string;
  files: ProjectFileInput[];
};

type ProjectContextFile = {
  path: string;
  content: string;
};

type ProjectChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
};

type ModificationContext = {
  fileTree: string;
  files: ProjectContextFile[];
  recentMessages: ProjectChatMessage[];
};

const MAX_RECENT_MESSAGES = 8;
const MAX_CONTEXT_FILE_CHARS = 80_000;
const ALLOWED_MODIFY_FILE_EXTENSIONS = [".css", ".js", ".jsx", ".json", ".ts", ".tsx"];

export async function requestProjectModification({
  config,
  context,
  userRequest,
}: {
  config: DeepSeekConfig;
  context: ModificationContext;
  userRequest: string;
}) {
  const client = new DeepSeekClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });

  const response = await client.chatJson<unknown>(
    buildModifyProjectMessages(context, userRequest),
  );

  return validateModifyProjectResponse(response);
}

export function buildModificationContext({
  chatMessages,
  fileContents,
  fileTree,
}: {
  chatMessages: ProjectChatMessage[];
  fileContents: ProjectContextFile[];
  fileTree: FileTree;
}): ModificationContext {
  return {
    fileTree: formatFileTree(fileTree),
    files: fileContents.map((file) => ({
      path: file.path,
      content: truncateContextFile(file.content),
    })),
    recentMessages: chatMessages
      .filter((message) => message.id !== "welcome")
      .slice(-MAX_RECENT_MESSAGES),
  };
}

export function getContextFilePaths(fileTree: FileTree) {
  const paths = flattenFileTree(fileTree)
    .filter((node) => node.kind === "file")
    .map((node) => normalizeProjectPath(node.path))
    .filter((path): path is string => Boolean(path))
    .filter(isAllowedModifyPath);

  return uniquePaths(sortContextPaths(paths));
}

export function validateModifyProjectResponse(
  value: unknown,
): ModifyProjectResponse {
  if (!isRecord(value)) {
    throw new Error("Invalid DeepSeek response: root value must be a JSON object.");
  }

  if (value.type !== "modify_files") {
    throw new Error('Invalid DeepSeek response: type must be "modify_files".');
  }

  if (typeof value.summary !== "string" || !value.summary.trim()) {
    throw new Error("Invalid DeepSeek response: summary is required.");
  }

  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("DeepSeek did not return any writable files.");
  }

  const filesByPath = new Map<string, ProjectFileInput>();

  for (const file of value.files) {
    if (!isRecord(file)) {
      throw new Error("Invalid DeepSeek response: every file entry must be an object.");
    }

    const path = normalizeProjectPath(file.path);

    if (!path || !isAllowedModifyPath(path)) {
      throw new Error(
        `DeepSeek attempted to modify a forbidden path: ${String(file.path ?? "")}`,
      );
    }

    if (typeof file.content !== "string") {
      throw new Error(`Invalid DeepSeek response: ${path} content must be a string.`);
    }

    filesByPath.set(path, {
      path,
      content: file.content,
    });
  }

  return {
    type: "modify_files",
    summary: value.summary.trim(),
    files: Array.from(filesByPath.values()),
  };
}

function buildModifyProjectMessages(
  context: ModificationContext,
  userRequest: string,
): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a frontend project modification agent.",
        "You can only modify frontend files inside the current project.",
        "You must return complete file contents based on the user request, not diffs.",
        "You must output JSON only. Do not output Markdown or explanations.",
        "Do not delete important existing content unless the user asked for that.",
        "Keep the project runnable.",
        "If the user asks for backend, database, auth, orders, or admin features, create frontend mock UI and mock data only.",
        "Match the user's language for the response summary. If the user request is Chinese, write summary in Simplified Chinese.",
        "When adding or rewriting visible page copy, prefer the user's language unless the existing project clearly uses a different language or the user asks otherwise.",
        "",
        "The response shape must strictly match:",
        '{"type":"modify_files","summary":"string","files":[{"path":"src/App.tsx","content":"string"}]}',
        "",
        "Path restrictions:",
        "- You may modify src/App.tsx",
        "- You may modify src/index.css",
        "- You may modify src/components/*",
        "- You may modify src/data/*",
        "- Files must be text frontend files: .ts, .tsx, .js, .jsx, .css, or .json",
        "- Forbidden: package.json, vite.config.ts, tsconfig.json, files outside the project, absolute paths, and ../ paths",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Modify the existing frontend project according to the user request.",
          userRequest,
          projectContext: {
            recentMessages: context.recentMessages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            fileTree: context.fileTree,
            files: context.files,
          },
          instructions: [
            "Return only the files that need to be written.",
            "Each returned file must contain the complete final file content.",
            "Preserve useful existing code and content unless the user asked to replace it.",
            "Prefer React, TypeScript, Tailwind CSS, and lucide-react when available.",
            "The project must keep compiling after the change.",
            "Write the summary in the same language as userRequest.",
            "Use the same language as userRequest for newly created visible UI text when that is reasonable.",
          ],
        },
        null,
        2,
      ),
    },
  ];
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
    ["src/App.tsx", 0],
    ["src/index.css", 1],
  ]);

  return [...paths].sort((left, right) => {
    const leftPriority = priority.get(left) ?? 2;
    const rightPriority = priority.get(right) ?? 2;

    return leftPriority - rightPriority || left.localeCompare(right);
  });
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths));
}

function truncateContextFile(content: string) {
  if (content.length <= MAX_CONTEXT_FILE_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_CONTEXT_FILE_CHARS)}\n\n/* Context truncated for prompt size. Return the complete file if you modify it. */`;
}

function normalizeProjectPath(value: unknown) {
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

function isAllowedModifyPath(path: string) {
  const isAllowedLocation =
    path === "src/App.tsx" ||
    path === "src/index.css" ||
    path.startsWith("src/components/") ||
    path.startsWith("src/data/");

  return isAllowedLocation && hasAllowedTextExtension(path);
}

function hasAllowedTextExtension(path: string) {
  return ALLOWED_MODIFY_FILE_EXTENSIONS.some((extension) =>
    path.endsWith(extension),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
