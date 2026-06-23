import type { ChatMessage as LlmChatMessage } from "../agent/llm/types";
import type { ProjectPolicy } from "../agent/project/projectPolicy";
import {
  DEFAULT_PROJECT_POLICY,
  formatAllowedPathsForPrompt,
  formatCorePackageVersionRule,
} from "../agent/project/projectPolicy";

const SPEC_RESPONSE_SHAPE = `{
  "brief": "string",
  "requirements": {
    "goal": "string",
    "userStories": [{"id": "story-1", "description": "string"}],
    "acceptanceCriteria": [{"id": "criterion-1", "description": "string", "required": true}],
    "outOfScope": ["string"],
    "constraints": ["string"],
    "unresolvedQuestions": []
  },
  "design": {
    "summary": "string",
    "pages": [{"route": "/", "purpose": "string"}],
    "components": [{"name": "ComponentName", "responsibility": "string"}],
    "dataModel": ["string"],
    "integrations": ["string"],
    "technicalDecisions": ["string"],
    "verificationStrategy": ["string"]
  },
  "tasks": [{
    "id": "task-1",
    "title": "string",
    "objective": "string",
    "requirementIds": ["story-1"],
    "acceptanceCriteriaIds": ["criterion-1"],
    "dependencyIds": [],
    "allowedPaths": ["app/**", "components/**", "lib/**", "public/**", "package.json"],
    "expectedFiles": ["app/page.tsx"]
  }]
}`;

export function buildInitialSpecMessages({
  policy = DEFAULT_PROJECT_POLICY,
  projectBrief,
  projectName,
}: {
  policy?: ProjectPolicy;
  projectBrief: string;
  projectName: string;
}): LlmChatMessage[] {
  return buildSpecMessages({
    policy,
    task: "Create the Initial Build Spec for a new Next.js App Router project.",
    payload: {
      fixedStack: policy.preferredStackInstruction,
      projectBrief,
      projectName,
      requirements: [
        "Do not write project files. Only design the Spec.",
        "The first task must create the foundation project and include package.json in expectedFiles.",
        "Use enough tasks to build the requested product incrementally.",
      ],
    },
  });
}

export function buildFeatureSpecMessages({
  brief,
  context,
  policy = DEFAULT_PROJECT_POLICY,
}: {
  brief: string;
  context: unknown;
  policy?: ProjectPolicy;
}): LlmChatMessage[] {
  return buildSpecMessages({
    policy,
    task: "Create a Feature Spec for an existing project based on its current workspace.",
    payload: {
      brief,
      context,
      requirements: [
        "Base the Spec on the current workspace context, not historical specs.",
        "Do not include any automatic execution step.",
        "Tasks must be incremental modifications.",
      ],
    },
  });
}

export function buildSpecRevisionMessages({
  currentRevision,
  feedback,
  policy = DEFAULT_PROJECT_POLICY,
}: {
  currentRevision: unknown;
  feedback: string;
  policy?: ProjectPolicy;
}): LlmChatMessage[] {
  return buildSpecMessages({
    policy,
    task: "Create a new Spec revision from the current revision and user feedback.",
    payload: {
      currentRevision,
      feedback,
      requirements: [
        "Return a complete replacement revision payload.",
        "Do not mutate or omit accepted constraints unless feedback requires it.",
        "Keep ids stable when possible, but add or remove ids when the revision requires it.",
      ],
    },
  });
}

function buildSpecMessages({
  payload,
  policy,
  task,
}: {
  payload: unknown;
  policy: ProjectPolicy;
  task: string;
}): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the Spec Coding planner for nocodeBuilder.",
        "Return JSON only. Do not output Markdown, prose, comments, or code fences.",
        "Generate Requirements, Design, and Tasks in one response.",
        "Every required acceptance criterion must be covered by at least one task.",
        "Every task must include non-empty allowedPaths and expectedFiles where useful.",
        "Task dependencyIds must form an acyclic graph.",
        "Use complete, execution-ready task objectives. The runtime will execute one task per AgentRun.",
        "Never include real API keys, secrets, tokens, or credentials.",
        "Do not create .env files unless the user explicitly asks.",
        "Keep package.json dependencies exact and pinned when tasks mention dependency changes.",
        formatCorePackageVersionRule(policy),
        "",
        ...formatAllowedPathsForPrompt("Allowed implementation paths:", policy),
        "",
        "The response shape must strictly match:",
        SPEC_RESPONSE_SHAPE,
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task,
          payload,
        },
        null,
        2,
      ),
    },
  ];
}
