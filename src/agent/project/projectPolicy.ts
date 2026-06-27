export type ProjectPackagePolicy = {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly requiredScripts: Readonly<Record<string, string>>;
};

export type ProjectPolicy = {
  readonly id: string;
  readonly label: string;
  readonly generatorRole: string;
  readonly modifierRole: string;
  readonly agentRole: string;
  readonly generationTask: string;
  readonly modificationTask: string;
  readonly stackRequirement: string;
  readonly preferredStackInstruction: string;
  readonly requiredFiles: readonly string[];
  readonly rootAllowedFiles: readonly string[];
  readonly allowedDirectories: readonly string[];
  readonly allowedTextExtensions: readonly string[];
  readonly contextPriorities: Readonly<Record<string, number>>;
  readonly packageJson: ProjectPackagePolicy;
};

// Prompt construction and runtime validation must read from the same contract.
export const NEXTJS_APP_ROUTER_PROJECT_POLICY = {
  id: "nextjs-app-router",
  label: "Next.js App Router",
  generatorRole: "You are a senior full-stack Next.js App Router project generator.",
  modifierRole: "You are a full-stack Next.js App Router project modification agent.",
  agentRole: "You are a careful project agent for a generated Next.js App Router app.",
  generationTask: "Generate a complete Next.js App Router project.",
  modificationTask: "Modify the existing Next.js project according to the user request.",
  stackRequirement:
    "The project must use Next.js App Router, React, TypeScript, and Tailwind CSS.",
  preferredStackInstruction:
    "Prefer React, TypeScript, Tailwind CSS, Next.js App Router, and lucide-react when available.",
  requiredFiles: [
    "package.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
  ],
  rootAllowedFiles: [
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
  ],
  allowedDirectories: ["app", "components", "lib", "data", "public"],
  allowedTextExtensions: [
    ".css",
    ".cjs",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".mjs",
    ".svg",
    ".sql",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
  ],
  contextPriorities: {
    "package.json": 0,
    "app/layout.tsx": 1,
    "app/page.tsx": 2,
    "app/globals.css": 3,
    "tailwind.config.ts": 4,
    "tailwind.config.js": 4,
    "tsconfig.json": 5,
  },
  packageJson: {
    dependencies: {
      next: "14.2.35",
      react: "18.3.1",
      "react-dom": "18.3.1",
    },
    devDependencies: {
      typescript: "5.4.5",
      tailwindcss: "3.4.17",
      postcss: "8.4.49",
      autoprefixer: "10.4.20",
      "@types/node": "20.14.11",
      "@types/react": "18.3.3",
      "@types/react-dom": "18.3.0",
    },
    requiredScripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
    },
  },
} as const satisfies ProjectPolicy;

export const DEFAULT_PROJECT_POLICY: ProjectPolicy =
  NEXTJS_APP_ROUTER_PROJECT_POLICY;

export function extendProjectPolicyWithAllowedPaths(
  policy: ProjectPolicy,
  allowedPaths: readonly string[],
): ProjectPolicy {
  const rootAllowedFiles = new Set(policy.rootAllowedFiles);
  const allowedDirectories = new Set(policy.allowedDirectories);
  const allowedTextExtensions = new Set(policy.allowedTextExtensions);

  for (const rawPath of allowedPaths) {
    const path = rawPath.trim().replace(/\\/g, "/").replace(/^\.?\//, "");

    if (!path || path.includes("\0")) {
      continue;
    }

    if (path.endsWith("/**")) {
      const directory = path.slice(0, -3).replace(/\/+$/, "");

      if (directory && !directory.includes("*")) {
        allowedDirectories.add(directory);
      }

      continue;
    }

    if (path.endsWith("/*")) {
      const directory = path.slice(0, -2).replace(/\/+$/, "");

      if (directory && !directory.includes("*")) {
        allowedDirectories.add(directory);
      }

      continue;
    }

    if (path.includes("*")) {
      continue;
    }

    rootAllowedFiles.add(path);
    const extension = fileExtension(path);

    if (extension) {
      allowedTextExtensions.add(extension);
    }
  }

  return {
    ...policy,
    allowedDirectories: Array.from(allowedDirectories),
    allowedTextExtensions: Array.from(allowedTextExtensions),
    rootAllowedFiles: Array.from(rootAllowedFiles),
  };
}

export function getPinnedPackageVersions(
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
) {
  return {
    ...policy.packageJson.dependencies,
    ...policy.packageJson.devDependencies,
  };
}

export function formatRequiredFilesForPrompt(
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
) {
  return ["Required files:", ...policy.requiredFiles.map((path) => `- ${path}`)];
}

export function formatPackageJsonRequirementsForPrompt(
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
) {
  return [
    "package.json requirements:",
    ...Object.entries(policy.packageJson.requiredScripts).map(
      ([name, command]) => `- scripts.${name} must run ${command}`,
    ),
    `- dependencies must include at least: ${formatPackageList(
      policy.packageJson.dependencies,
    )}`,
    `- devDependencies must include at least: ${formatPackageList(
      policy.packageJson.devDependencies,
    )}`,
    "- Dependency versions must be pinned exact strings. Do not use ^, ~, >=, latest, *, x ranges, or tag names.",
  ];
}

export function formatCorePackageVersionRule(
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
) {
  return `Keep the core versions exactly pinned as: ${formatPackageList(
    getPinnedPackageVersions(policy),
  )}.`;
}

export function formatAllowedPathsForPrompt(
  heading: string,
  policy: ProjectPolicy = DEFAULT_PROJECT_POLICY,
) {
  return [
    heading,
    `- Root files: ${policy.rootAllowedFiles.join(", ")}`,
    `- Allowed directories: ${policy.allowedDirectories
      .map((directory) => `${directory}/**`)
      .join(", ")}`,
    `- Allowed text extensions: ${policy.allowedTextExtensions.join(", ")}`,
    "- Forbidden: node_modules, .next, dist, .env files, absolute paths, parent-directory traversal, and files outside the allowed locations",
  ];
}

function formatPackageList(packages: Readonly<Record<string, string>>) {
  return Object.entries(packages)
    .map(([name, version]) => `${name} ${version}`)
    .join(", ");
}

function fileExtension(path: string) {
  const fileName = path.split("/").pop() ?? "";
  const dot = fileName.lastIndexOf(".");

  return dot > 0 ? fileName.slice(dot) : "";
}
