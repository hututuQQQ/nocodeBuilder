import { describe, expect, it } from "vitest";
import type { DevelopmentSpec } from "./types";
import {
  validateDevelopmentSpec,
  validateGeneratedSpecRevisionPayload,
  validateSpecForApproval,
} from "./validators";

describe("Spec validators", () => {
  it("accepts a valid review Spec", () => {
    expect(validateSpecForApproval(createSpec())).toBeDefined();
  });

  it("rejects a generated payload without tasks", () => {
    const payload = createGeneratedPayload();

    expect(() =>
      validateGeneratedSpecRevisionPayload({
        ...payload,
        tasks: [],
      }),
    ).toThrow(/at least one task/i);
  });

  it("rejects unknown acceptance criterion references", () => {
    const spec = createSpec({
      tasks: [
        {
          ...createGeneratedPayload().tasks[0],
          acceptanceCriteriaIds: ["missing-criterion"],
          status: "pending",
        },
      ],
    });

    expect(() => validateDevelopmentSpec(spec)).toThrow(/unknown acceptance criterion/i);
  });

  it("rejects self dependencies and cycles", () => {
    const selfDependency = createSpec({
      tasks: [
        {
          ...createGeneratedPayload().tasks[0],
          dependencyIds: ["task-1"],
          status: "pending",
        },
      ],
    });

    expect(() => validateDevelopmentSpec(selfDependency)).toThrow(/cannot depend on itself/i);

    const cyclic = createSpec({
      tasks: [
        {
          ...createGeneratedPayload().tasks[0],
          dependencyIds: ["task-2"],
          status: "pending",
        },
        {
          ...createGeneratedPayload().tasks[0],
          id: "task-2",
          dependencyIds: ["task-1"],
          status: "pending",
        },
      ],
    });

    expect(() => validateDevelopmentSpec(cyclic)).toThrow(/cycle/i);
  });

  it("rejects uncovered required criteria before approval", () => {
    const spec = createSpec({
      requirements: {
        ...createGeneratedPayload().requirements,
        acceptanceCriteria: [
          ...createGeneratedPayload().requirements.acceptanceCriteria,
          {
            description: "Another required behavior is covered.",
            id: "criterion-2",
            required: true,
          },
        ],
      },
    });

    expect(() => validateSpecForApproval(spec)).toThrow(/not covered/i);
  });
});

function createSpec(
  overrides: Partial<DevelopmentSpec["revisions"][number]> = {},
): DevelopmentSpec {
  const payload = createGeneratedPayload();
  const revision = {
    brief: payload.brief,
    createdAt: "2026-06-24T00:00:00Z",
    design: payload.design,
    id: "rev-1",
    requirements: payload.requirements,
    tasks: payload.tasks.map((task) => ({
      ...task,
      status: "pending" as const,
    })),
    version: 1,
    ...overrides,
  };

  return {
    conversationId: "conv-1",
    createdAt: "2026-06-24T00:00:00Z",
    currentRevisionId: revision.id,
    id: "spec-1",
    kind: "feature",
    projectId: "project-1",
    revisions: [revision],
    status: "review",
    updatedAt: "2026-06-24T00:00:00Z",
  };
}

function createGeneratedPayload() {
  return {
    brief: "Add a hero section",
    design: {
      components: [
        {
          name: "Hero",
          responsibility: "Render the primary page heading.",
        },
      ],
      dataModel: [],
      integrations: [],
      pages: [
        {
          purpose: "Home page",
          route: "/",
        },
      ],
      summary: "A focused page update.",
      technicalDecisions: ["Use existing App Router structure."],
      verificationStrategy: ["Run npm run build."],
    },
    requirements: {
      acceptanceCriteria: [
        {
          description: "The hero content is visible.",
          id: "criterion-1",
          required: true,
        },
      ],
      constraints: ["Keep existing styling conventions."],
      goal: "Add a hero section.",
      outOfScope: [],
      unresolvedQuestions: [],
      userStories: [
        {
          description: "As a visitor, I can understand the page.",
          id: "story-1",
        },
      ],
    },
    tasks: [
      {
        acceptanceCriteriaIds: ["criterion-1"],
        allowedPaths: ["app/**", "components/**"],
        dependencyIds: [],
        expectedFiles: ["app/page.tsx"],
        id: "task-1",
        objective: "Update the home page hero.",
        requirementIds: ["story-1"],
        title: "Hero update",
      },
    ],
  };
}
