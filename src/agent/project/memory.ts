import type { ChangeRecord } from "../../store/changeHistory";
import type { FileTree, ProjectInfo } from "../../services/projects";
import type {
  AgentObservation,
  ProjectChatMessage,
} from "./types";
import {
  readAppStorageValue,
  writeAppStorageValue,
} from "../../services/appStorage";
import {
  flattenProjectFileTree,
  getAllowedFilePaths,
} from "./pathRules";

const PROJECT_MEMORY_STORAGE_ID = "project-memory";
const MAX_RECENT_CHANGES = 8;
const MAX_OBSERVATION_SUMMARIES = 10;
const MAX_FILE_SUMMARIES = 40;

export type AgentReadSnapshot = {
  content: string;
  contentHash: string;
  path: string;
  readAt: string;
};

export type ProjectMemoryContext = {
  designConventions: string[];
  fileSummaries: Array<{
    contentHash: string;
    path: string;
    summary: string;
    updatedAt: string;
  }>;
  objective: string;
  projectIndex: ProjectMemoryIndex;
  recentChanges: string[];
  structureSummary: string;
  techStack: string[];
  updatedAt: string;
};

export type ProjectMemoryIndex = {
  components: string[];
  dataFiles: string[];
  dependencies: string[];
  fileTreeHash: string;
  libFiles: string[];
  packageManager: "npm" | "pnpm";
  routes: string[];
  totalEditableFiles: number;
};

export type WorkingSummary = {
  changedFiles: string[];
  errors: string[];
  importantFindings: string[];
  observationCount: number;
  summary: string;
};

export type TaskLedger = {
  completed: string[];
  nextStep: string;
  objective: string;
  pending: string[];
  risks: string[];
};

export type DynamicContext = {
  memory: ProjectMemoryContext;
  observations: AgentObservation[];
  taskLedger: TaskLedger;
  workingSummary: WorkingSummary;
};

type ProjectMemoryStorage = Record<string, ProjectMemoryContext>;

export async function buildDynamicAgentContext({
  changeHistory,
  fileTree,
  observations,
  project,
  readFiles,
  recentMessages,
  userRequest,
}: {
  changeHistory: ChangeRecord[];
  fileTree: FileTree | null;
  observations: AgentObservation[];
  project: ProjectInfo;
  readFiles: AgentReadSnapshot[];
  recentMessages: ProjectChatMessage[];
  userRequest: string;
}): Promise<DynamicContext> {
  const storedMemory = await loadProjectMemory(project.id);
  const projectIndex = fileTree
    ? buildProjectIndex(fileTree)
    : storedMemory?.projectIndex ?? createEmptyProjectIndex();
  const memory: ProjectMemoryContext = {
    designConventions: deriveDesignConventions(recentMessages, storedMemory),
    fileSummaries: mergeFileSummaries(storedMemory, readFiles, changeHistory),
    objective: deriveObjective(userRequest, recentMessages, storedMemory),
    projectIndex,
    recentChanges: changeHistory
      .filter((change) => change.projectId === project.id)
      .slice(0, MAX_RECENT_CHANGES)
      .map((change) => formatChangeSummary(change)),
    structureSummary: summarizeProjectStructure(projectIndex),
    techStack: deriveTechStack(projectIndex),
    updatedAt: new Date().toISOString(),
  };
  const workingSummary = buildWorkingSummary(observations, changeHistory, project.id);
  const taskLedger = buildTaskLedger(userRequest, observations, workingSummary);
  const compressedObservations = compressObservations(observations);

  try {
    await saveProjectMemory(project.id, memory);
  } catch {
    // Memory persistence should not block the agent workflow.
  }

  return {
    memory,
    observations: compressedObservations,
    taskLedger,
    workingSummary,
  };
}

function buildProjectIndex(fileTree: FileTree): ProjectMemoryIndex {
  const files = getAllowedFilePaths(fileTree);
  const allFiles = flattenProjectFileTree(fileTree)
    .filter((node) => node.kind === "file")
    .map((node) => node.path);

  return {
    components: files
      .filter((path) => path.startsWith("components/") && /\.tsx?$/.test(path))
      .slice(0, 80),
    dataFiles: files.filter((path) => path.startsWith("data/")).slice(0, 60),
    dependencies: ["next", "react", "react-dom", "typescript", "tailwindcss"],
    fileTreeHash: hashText(files.join("\n")),
    libFiles: files.filter((path) => path.startsWith("lib/")).slice(0, 60),
    packageManager: allFiles.includes("pnpm-lock.yaml") ? "pnpm" : "npm",
    routes: files
      .filter(
        (path) =>
          path.startsWith("app/") &&
          (path.endsWith("/page.tsx") || path === "app/page.tsx"),
      )
      .slice(0, 80),
    totalEditableFiles: files.length,
  };
}

function createEmptyProjectIndex(): ProjectMemoryIndex {
  return {
    components: [],
    dataFiles: [],
    dependencies: ["next", "react", "react-dom", "typescript", "tailwindcss"],
    fileTreeHash: "empty",
    libFiles: [],
    packageManager: "npm",
    routes: [],
    totalEditableFiles: 0,
  };
}

function deriveObjective(
  userRequest: string,
  recentMessages: ProjectChatMessage[],
  storedMemory: ProjectMemoryContext | null,
) {
  const firstUserMessage = recentMessages.find((message) => message.role === "user");
  const seed = firstUserMessage?.content ?? storedMemory?.objective ?? userRequest;
  return compactText(seed, 360);
}

function deriveDesignConventions(
  recentMessages: ProjectChatMessage[],
  storedMemory: ProjectMemoryContext | null,
) {
  const text = recentMessages.map((message) => message.content).join("\n");
  const conventions = new Set(storedMemory?.designConventions ?? []);

  if (/[\u4e00-\u9fff]/.test(text)) {
    conventions.add("Use Simplified Chinese for new visible UI copy when reasonable.");
  }

  conventions.add("Preserve the existing visual direction unless the user asks to change it.");
  conventions.add("Keep the app responsive and buildable.");

  return Array.from(conventions).slice(0, 8);
}

function deriveTechStack(projectIndex: ProjectMemoryIndex) {
  return [
    "Next.js App Router",
    "React",
    "TypeScript",
    "Tailwind CSS",
    `${projectIndex.packageManager} package manager`,
  ];
}

function mergeFileSummaries(
  storedMemory: ProjectMemoryContext | null,
  readFiles: AgentReadSnapshot[],
  changeHistory: ChangeRecord[],
) {
  const summaries = new Map<
    string,
    ProjectMemoryContext["fileSummaries"][number]
  >();

  for (const summary of storedMemory?.fileSummaries ?? []) {
    summaries.set(summary.path, summary);
  }

  for (const file of readFiles) {
    summaries.set(file.path, {
      contentHash: file.contentHash,
      path: file.path,
      summary: summarizeFileContent(file.path, file.content),
      updatedAt: file.readAt,
    });
  }

  for (const change of changeHistory.slice(0, MAX_RECENT_CHANGES)) {
    for (const file of change.files) {
      if (!file.afterContent) {
        summaries.delete(file.path);
        continue;
      }

      summaries.set(file.path, {
        contentHash: hashText(file.afterContent),
        path: file.path,
        summary: summarizeFileContent(file.path, file.afterContent),
        updatedAt: change.createdAt,
      });
    }
  }

  return Array.from(summaries.values())
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_FILE_SUMMARIES);
}

function summarizeProjectStructure(projectIndex: ProjectMemoryIndex) {
  return [
    `${projectIndex.totalEditableFiles} editable files`,
    `${projectIndex.routes.length} route page(s)`,
    `${projectIndex.components.length} component file(s)`,
    `${projectIndex.libFiles.length} lib file(s)`,
    `${projectIndex.dataFiles.length} data file(s)`,
  ].join("; ");
}

function buildWorkingSummary(
  observations: AgentObservation[],
  changeHistory: ChangeRecord[],
  projectId: string,
): WorkingSummary {
  const recentObservations = observations.slice(-MAX_OBSERVATION_SUMMARIES);
  const errors = recentObservations
    .filter((observation) => !observation.ok)
    .map((observation) => observation.summary)
    .slice(-6);
  const importantFindings = recentObservations
    .filter((observation) => observation.ok)
    .map((observation) => observation.summary)
    .slice(-8);
  const changedFiles = changeHistory
    .filter((change) => change.projectId === projectId)
    .slice(0, 4)
    .flatMap((change) => change.files.map((file) => file.path));

  return {
    changedFiles: Array.from(new Set(changedFiles)).slice(0, 20),
    errors,
    importantFindings,
    observationCount: observations.length,
    summary:
      recentObservations.length === 0
        ? "No tool observations yet in this run."
        : compactText(
            recentObservations.map((observation) => observation.summary).join(" "),
            520,
          ),
  };
}

function buildTaskLedger(
  userRequest: string,
  observations: AgentObservation[],
  workingSummary: WorkingSummary,
): TaskLedger {
  const completed = observations
    .filter((observation) => observation.ok)
    .map((observation) => observation.summary)
    .slice(-8);
  const risks = observations
    .filter((observation) => !observation.ok)
    .map((observation) => observation.summary)
    .slice(-6);
  const pending = risks.length > 0 ? ["Repair the latest failing observation."] : [];

  if (workingSummary.changedFiles.length > 0 && risks.length === 0) {
    pending.push("Verify changed files and finish when the user request is handled.");
  }

  return {
    completed,
    nextStep:
      risks.length > 0
        ? "Use the latest error and relevant file context for a focused repair."
        : "Choose the smallest useful next tool call or finish if complete.",
    objective: compactText(userRequest, 360),
    pending,
    risks,
  };
}

function compressObservations(observations: AgentObservation[]) {
  const recent = observations.slice(-MAX_OBSERVATION_SUMMARIES);
  const failures = observations.filter((observation) => !observation.ok).slice(-4);
  const selected = new Map<number, AgentObservation>();

  for (const observation of [...failures, ...recent]) {
    selected.set(observation.step, {
      ...observation,
      content: observation.content
        ? compactObservationContent(observation.content)
        : undefined,
    });
  }

  return Array.from(selected.values()).sort((left, right) => left.step - right.step);
}

function compactObservationContent(content: string) {
  const maxLength = 7_000;

  if (content.length <= maxLength) {
    return content;
  }

  const headLength = 3_600;
  const tailLength = maxLength - headLength;
  return `${content.slice(0, headLength)}\n\n[Observation compressed. Showing tail.]\n\n${content.slice(-tailLength)}`;
}

function summarizeFileContent(path: string, content: string) {
  const lines = content.split(/\r?\n/);
  const signals = lines
    .map((line) => line.trim())
    .filter((line) =>
      /^(export |function |const |type |interface |class |import |<main|<section|<div)/.test(
        line,
      ),
    )
    .slice(0, 10);

  return compactText(
    [`${path}: ${lines.length} lines`, ...signals].join(" | "),
    520,
  );
}

function formatChangeSummary(change: ChangeRecord) {
  return compactText(
    `${change.summary}: ${change.files
      .map((file) => `${file.path} ${file.action} +${file.additions}/-${file.deletions}`)
      .join(", ")}`,
    520,
  );
}

async function loadProjectMemory(projectId: string): Promise<ProjectMemoryContext | null> {
  try {
    const stored = await readAppStorageValue<ProjectMemoryStorage>(
      PROJECT_MEMORY_STORAGE_ID,
    );

    return stored?.[projectId] ?? null;
  } catch {
    return null;
  }
}

async function saveProjectMemory(projectId: string, memory: ProjectMemoryContext) {
  try {
    const stored =
      (await readAppStorageValue<ProjectMemoryStorage>(
        PROJECT_MEMORY_STORAGE_ID,
      )) ?? {};
    await writeAppStorageValue(PROJECT_MEMORY_STORAGE_ID, {
      ...stored,
      [projectId]: memory,
    });
  } catch {
    try {
      await writeAppStorageValue(PROJECT_MEMORY_STORAGE_ID, {
        [projectId]: memory,
      });
    } catch {
      // Ignore cache persistence failures.
    }
  }
}

function compactText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 3)}...`
    : compact;
}

function hashText(content: string) {
  let hash = 2166136261;

  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${content.length}:${(hash >>> 0).toString(16)}`;
}
