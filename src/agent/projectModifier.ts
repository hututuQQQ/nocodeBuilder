import { DeepSeekClient } from "./llm/DeepSeekClient";
import type { ChatMessage as LlmChatMessage } from "./llm/types";
import type { FileTree, ProjectFileInput } from "../services/projects";
import type { DeepSeekConfig } from "../services/keyStore";

export type GenerateProjectResponse = {
  type: "write_files";
  summary: string;
  files: ProjectFileInput[];
};

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
const REQUIRED_GENERATED_FILES = [
  "package.json",
  "app/layout.tsx",
  "app/page.tsx",
  "app/globals.css",
];
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
const PINNED_PACKAGE_VERSIONS = new Map([
  ["next", "14.2.35"],
  ["react", "18.3.1"],
  ["react-dom", "18.3.1"],
  ["typescript", "5.4.5"],
  ["tailwindcss", "3.4.17"],
  ["postcss", "8.4.49"],
  ["autoprefixer", "10.4.20"],
  ["@types/node", "20.14.11"],
  ["@types/react", "18.3.3"],
  ["@types/react-dom", "18.3.0"],
]);

export async function requestProjectGeneration({
  config,
  onDelta,
  projectName,
  userPrompt,
}: {
  config: DeepSeekConfig;
  onDelta?: (delta: string) => void;
  projectName: string;
  userPrompt: string;
}) {
  const client = new DeepSeekClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });

  const response = await client.chatJson<unknown>(
    buildGenerateProjectMessages(projectName, userPrompt),
    { onDelta },
  );

  return validateGeneratedProjectResponse(response);
}

export async function requestProjectModification({
  config,
  context,
  onDelta,
  userRequest,
}: {
  config: DeepSeekConfig;
  context: ModificationContext;
  onDelta?: (delta: string) => void;
  userRequest: string;
}) {
  const client = new DeepSeekClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });

  const response = await client.chatJson<unknown>(
    buildModifyProjectMessages(context, userRequest),
    { onDelta },
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
    .filter(isAllowedProjectPath);

  return uniquePaths(sortContextPaths(paths));
}

export function validateGeneratedProjectResponse(
  value: unknown,
): GenerateProjectResponse {
  const response = validateProjectFileResponse(value, "write_files");
  const paths = new Set(response.files.map((file) => file.path));

  for (const requiredPath of REQUIRED_GENERATED_FILES) {
    if (!paths.has(requiredPath)) {
      throw new Error(
        `Invalid DeepSeek response: generated project is missing ${requiredPath}.`,
      );
    }
  }

  validateGeneratedPackageJson(response.files);
  return response;
}

export function validateModifyProjectResponse(
  value: unknown,
): ModifyProjectResponse {
  const response = validateProjectFileResponse(value, "modify_files");
  const packageFile = response.files.find((file) => file.path === "package.json");

  if (packageFile) {
    validatePackageJsonContent(packageFile.content);
  }

  return response;
}

function buildGenerateProjectMessages(
  projectName: string,
  userPrompt: string,
): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a senior frontend project generator.",
        "Generate a complete, runnable web project from the user's prompt.",
        "The project must use Next.js App Router, React, TypeScript, and Tailwind CSS.",
        "Return complete file contents, not diffs.",
        "You must output JSON only. Do not output Markdown or explanations.",
        "Keep the project deployable on Vercel without extra manual file edits.",
        "Do not create .env, .env.local, or .env.example files unless the user explicitly asks for them.",
        "Never include real API keys, secrets, tokens, or credentials in generated files.",
        "If the user explicitly asks for AI, chat, assistant, agent, or content generation features, use the Vercel AI SDK with the `ai` package and an appropriate provider package such as `@ai-sdk/deepseek` inside App Router route handlers.",
        "If the user does not ask for AI features, do not add AI SDK dependencies or API routes just for decoration.",
        "Use visible UI text in the user's language when the request language is clear.",
        "Make the first screen the actual website/app experience, not a marketing page for the builder.",
        "Use real layout, responsive CSS, and visual assets or CSS-driven visuals that make the site feel complete.",
        "",
        "The response shape must strictly match:",
        '{"type":"write_files","summary":"string","files":[{"path":"package.json","content":"string"}]}',
        "",
        "Required files:",
        "- package.json",
        "- app/layout.tsx",
        "- app/page.tsx",
        "- app/globals.css",
        "",
        "package.json requirements:",
        "- scripts.dev must run next dev",
        "- scripts.build must run next build",
        "- scripts.start must run next start",
        "- dependencies must include exactly: next 14.2.35, react 18.3.1, react-dom 18.3.1",
        "- devDependencies must include exactly: typescript 5.4.5, tailwindcss 3.4.17, postcss 8.4.49, autoprefixer 10.4.20, @types/node 20.14.11, @types/react 18.3.3, @types/react-dom 18.3.0",
        "- Dependency versions must be pinned exact strings. Do not use ^, ~, >=, latest, *, x ranges, or tag names.",
        "",
        "Allowed paths:",
        "- Root config files: package.json, next.config.*, postcss.config.*, tailwind.config.*, tsconfig.json, vercel.json, middleware.ts",
        "- app/**",
        "- components/**",
        "- lib/**",
        "- data/**",
        "- public/** text assets such as .svg, .txt, .json, .md",
        "- Files must be text files: .ts, .tsx, .js, .jsx, .mjs, .cjs, .css, .json, .md, .txt, or .svg",
        "- Forbidden: node_modules, .next, dist, .env files, absolute paths, and ../ paths",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Generate a complete Next.js App Router project.",
          projectName,
          userPrompt,
        },
        null,
        2,
      ),
    },
  ];
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
        "The current project is a generated Next.js App Router project.",
        "You can only modify frontend and App Router files inside the current project.",
        "You must return complete file contents based on the user request, not diffs.",
        "You must output JSON only. Do not output Markdown or explanations.",
        "Do not delete important existing content unless the user asked for that.",
        "Keep the project runnable with npm run build.",
        "If the user asks for backend, database, auth, orders, or admin features, create frontend mock UI and mock data only unless the request explicitly asks for a Next.js route handler.",
        "If the user explicitly asks for AI, chat, assistant, agent, or content generation features, use the Vercel AI SDK with the `ai` package and an appropriate provider package such as `@ai-sdk/deepseek` inside App Router route handlers.",
        "If you add or remove dependencies, return a complete updated package.json.",
        "package.json must keep pinned exact dependency versions. Do not use ^, ~, >=, latest, *, x ranges, or tag names.",
        "Keep the core versions exactly pinned as: next 14.2.35, react 18.3.1, react-dom 18.3.1, typescript 5.4.5, tailwindcss 3.4.17, postcss 8.4.49, autoprefixer 10.4.20, @types/node 20.14.11, @types/react 18.3.3, @types/react-dom 18.3.0.",
        "Do not create .env, .env.local, or .env.example files unless the user explicitly asks for them.",
        "Never include real API keys, secrets, tokens, or credentials in generated files.",
        "Match the user's language for the response summary. If the user request is Chinese, write summary in Simplified Chinese.",
        "When adding or rewriting visible page copy, prefer the user's language unless the existing project clearly uses a different language or the user asks otherwise.",
        "",
        "The response shape must strictly match:",
        '{"type":"modify_files","summary":"string","files":[{"path":"app/page.tsx","content":"string"}]}',
        "",
        "Path restrictions:",
        "- You may modify package.json and root Next/Tailwind/TypeScript/Vercel config files",
        "- You may modify app/**",
        "- You may modify components/**",
        "- You may modify lib/**",
        "- You may modify data/**",
        "- You may modify public/** text assets such as .svg, .txt, .json, .md",
        "- Files must be text files: .ts, .tsx, .js, .jsx, .mjs, .cjs, .css, .json, .md, .txt, or .svg",
        "- Forbidden: node_modules, .next, dist, .env files, files outside the project, absolute paths, and ../ paths",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Modify the existing Next.js project according to the user request.",
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
            "Prefer React, TypeScript, Tailwind CSS, Next.js App Router, and lucide-react when available.",
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

function validateProjectFileResponse<TType extends "write_files" | "modify_files">(
  value: unknown,
  expectedType: TType,
): TType extends "write_files" ? GenerateProjectResponse : ModifyProjectResponse {
  if (!isRecord(value)) {
    throw new Error("Invalid DeepSeek response: root value must be a JSON object.");
  }

  if (value.type !== expectedType) {
    throw new Error(`Invalid DeepSeek response: type must be "${expectedType}".`);
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

    if (!path || !isAllowedProjectPath(path)) {
      throw new Error(
        `DeepSeek attempted to write a forbidden path: ${String(file.path ?? "")}`,
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
    type: expectedType,
    summary: value.summary.trim(),
    files: Array.from(filesByPath.values()),
  } as TType extends "write_files" ? GenerateProjectResponse : ModifyProjectResponse;
}

function validateGeneratedPackageJson(files: ProjectFileInput[]) {
  const packageFile = files.find((file) => file.path === "package.json");

  if (!packageFile) {
    throw new Error("Invalid DeepSeek response: generated project is missing package.json.");
  }

  validatePackageJsonContent(packageFile.content);
}

function validatePackageJsonContent(content: string) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid package.json generated by DeepSeek: ${String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid package.json generated by DeepSeek: root must be an object.");
  }

  const scripts = isRecord(parsed.scripts) ? parsed.scripts : {};
  const dependencies = isRecord(parsed.dependencies) ? parsed.dependencies : {};
  const devDependencies = isRecord(parsed.devDependencies)
    ? parsed.devDependencies
    : {};
  const allDependencies = {
    ...dependencies,
    ...devDependencies,
  };

  for (const [dependency, version] of Object.entries(allDependencies)) {
    if (typeof version !== "string" || !isPinnedSemver(version)) {
      throw new Error(
        `Invalid package.json generated by DeepSeek: ${dependency} must use an exact pinned semver version, got "${String(version)}".`,
      );
    }
  }

  for (const [dependency, expectedVersion] of PINNED_PACKAGE_VERSIONS) {
    const actualVersion = allDependencies[dependency];

    if (typeof actualVersion !== "string") {
      throw new Error(
        `Invalid package.json generated by DeepSeek: missing ${dependency}.`,
      );
    }

    if (actualVersion !== expectedVersion) {
      throw new Error(
        `Invalid package.json generated by DeepSeek: ${dependency} must be pinned to "${expectedVersion}", got "${actualVersion}".`,
      );
    }
  }

  const requiredScripts = new Map([
    ["dev", "next dev"],
    ["build", "next build"],
    ["start", "next start"],
  ]);

  for (const [name, expectedCommand] of requiredScripts) {
    if (typeof scripts[name] !== "string" || !scripts[name].includes(expectedCommand)) {
      throw new Error(
        `Invalid package.json generated by DeepSeek: scripts.${name} must include "${expectedCommand}".`,
      );
    }
  }
}

function isPinnedSemver(version: string) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
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

function isAllowedProjectPath(path: string) {
  if (path.startsWith(".env") || path.includes("/.env")) {
    return false;
  }

  const isAllowedLocation =
    ROOT_ALLOWED_FILES.has(path) ||
    ALLOWED_PROJECT_DIRECTORIES.some((directory) => path.startsWith(directory));

  return isAllowedLocation && hasAllowedTextExtension(path);
}

function hasAllowedTextExtension(path: string) {
  return ALLOWED_TEXT_FILE_EXTENSIONS.some((extension) =>
    path.endsWith(extension),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
