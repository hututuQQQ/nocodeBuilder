import { describe, expect, it } from "vitest";
import type { DevelopmentSpec } from "./types";
import {
  canRetrySpecVerification,
  computeAcceptanceResults,
  computePersistedAcceptanceResults,
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

  it("rejects invalid persisted runtime status fields", () => {
    expect(() =>
      validateDevelopmentSpec({
        ...createSpec(),
        status: "mystery" as DevelopmentSpec["status"],
      }),
    ).toThrow(/status is invalid/i);

    expect(() =>
      validateDevelopmentSpec(
        createSpec({
          tasks: [
            {
              ...createGeneratedPayload().tasks[0],
              status: "weird" as DevelopmentSpec["revisions"][number]["tasks"][number]["status"],
            },
          ],
        }),
      ),
    ).toThrow(/invalid status/i);
  });

  it("rejects malformed persisted Spec structures explicitly", () => {
    expect(() =>
      validateDevelopmentSpec({
        ...createSpec(),
        revisions: "not-an-array",
      } as unknown),
    ).toThrow(/Spec revisions must be an array/i);

    expect(() =>
      validateDevelopmentSpec({
        ...createSpec(),
        finalVerification: "",
      } as unknown),
    ).toThrow(/finalVerification must be an object/i);
  });

  it("requires persisted acceptance criteria to keep explicit required flags", () => {
    const spec = createSpec({
      requirements: {
        ...createGeneratedPayload().requirements,
        acceptanceCriteria: [
          {
            description: "The hero content is visible.",
            id: "criterion-1",
          } as never,
        ],
      },
    });

    expect(() => validateDevelopmentSpec(spec)).toThrow(
      /acceptanceCriterion\.required must be a boolean/i,
    );
  });

  it("requires completed specs to include successful final verification", () => {
    expect(() =>
      validateDevelopmentSpec({
        ...createSpec(),
        completedAt: "2026-06-24T00:01:00Z",
        status: "completed",
      }),
    ).toThrow(/finalVerification/i);
  });

  it("rejects lifecycle timestamps that contradict Spec status", () => {
    expect(() =>
      validateDevelopmentSpec({
        ...createSpec(),
        completedAt: "2026-06-24T00:01:00Z",
      }),
    ).toThrow(/completedAt is only valid/i);

    expect(() =>
      validateDevelopmentSpec({
        ...createSpec(),
        cancelledAt: "2026-06-24T00:01:00Z",
      }),
    ).toThrow(/cancelledAt is only valid/i);

    expect(() =>
      validateDevelopmentSpec({
        ...createSpec(),
        status: "cancelled",
      }),
    ).toThrow(/requires cancelledAt/i);
  });

  it("requires revision versions to be consecutive", () => {
    const spec = createSpec();
    const secondRevision = {
      ...spec.revisions[0],
      id: "rev-2",
      version: 3,
    };

    expect(() =>
      validateDevelopmentSpec({
        ...spec,
        revisions: [...spec.revisions, secondRevision],
      }),
    ).toThrow(/consecutive/i);
  });

  it("gates verification retry on failed final verification evidence", () => {
    const retryable = {
      ...createSpec({
        tasks: [
          {
            ...createGeneratedPayload().tasks[0],
            runId: "run-1",
            status: "passed",
          },
        ],
      }),
      failureMessage: "Final npm run build failed.",
      finalVerification: {
        checkedAt: "2026-06-24T00:01:00Z",
        command: "npm run build",
        output: "failed",
        success: false,
      },
      status: "blocked" as const,
    };

    expect(canRetrySpecVerification(retryable)).toBe(true);
    expect(canRetrySpecVerification({
      ...retryable,
      status: "failed",
    })).toBe(false);
    expect(canRetrySpecVerification({
      ...retryable,
      finalVerification: undefined,
    })).toBe(false);
    expect(canRetrySpecVerification({
      ...retryable,
      revisions: [
        {
          ...retryable.revisions[0],
          tasks: [
            {
              ...retryable.revisions[0].tasks[0],
              status: "pending",
            },
          ],
        },
      ],
    })).toBe(false);
  });

  it("computes acceptance results from task and report evidence", () => {
    const spec = createSpec({
      tasks: [
        {
          ...createGeneratedPayload().tasks[0],
          runId: "run-1",
          status: "passed",
        },
      ],
    });
    const [result] = computeAcceptanceResults(spec.revisions[0], new Map([
      ["run-1", "passed"],
    ]));

    expect(result).toMatchObject({
      criterionId: "criterion-1",
      runIds: ["run-1"],
      status: "passed",
      taskIds: ["task-1"],
    });

    const [pending] = computeAcceptanceResults(spec.revisions[0], new Map());
    expect(pending.status).toBe("pending");

    const failedSpec = createSpec({
      tasks: [
        {
          ...createGeneratedPayload().tasks[0],
          runId: "run-1",
          status: "failed",
        },
      ],
    });
    const [failed] = computeAcceptanceResults(failedSpec.revisions[0], new Map([
      ["run-1", "passed"],
    ]));
    expect(failed.status).toBe("failed");
  });

  it("keeps persisted acceptance results pending until final evidence exists", () => {
    const spec = createSpec({
      tasks: [
        {
          ...createGeneratedPayload().tasks[0],
          runId: "run-1",
          status: "passed",
        },
      ],
    });
    const [result] = computePersistedAcceptanceResults(spec);

    expect(result).toMatchObject({
      criterionId: "criterion-1",
      runIds: ["run-1"],
      status: "pending",
      summary: "Waiting for verification report evidence from linked task runs.",
      taskIds: ["task-1"],
    });
  });

  it("uses successful final verification as persisted acceptance evidence", () => {
    const spec = {
      ...createSpec({
        tasks: [
          {
            ...createGeneratedPayload().tasks[0],
            runId: "run-1",
            status: "passed" as const,
          },
        ],
      }),
      completedAt: "2026-06-24T00:02:00Z",
      finalVerification: {
        checkedAt: "2026-06-24T00:02:00Z",
        command: "npm run build",
        output: "build ok",
        success: true,
      },
      status: "completed" as const,
    };
    const [result] = computePersistedAcceptanceResults(spec);

    expect(result).toMatchObject({
      criterionId: "criterion-1",
      runIds: ["run-1"],
      status: "passed",
      taskIds: ["task-1"],
    });
  });

  it("projects failed final acceptance evidence with a failure summary", () => {
    const spec = {
      ...createSpec({
        tasks: [
          {
            ...createGeneratedPayload().tasks[0],
            runId: "run-1",
            status: "passed" as const,
          },
        ],
      }),
      failureMessage: "Required acceptance criteria are not all passing: criterion-1.",
      finalVerification: {
        checkedAt: "2026-06-24T00:02:00Z",
        command: "acceptance criteria",
        output: "Required acceptance criteria are not all passing: criterion-1.",
        success: false,
      },
      status: "blocked" as const,
    };
    const [result] = computePersistedAcceptanceResults(spec);

    expect(result).toMatchObject({
      criterionId: "criterion-1",
      status: "failed",
      summary: "Required acceptance criteria are not all passing: criterion-1.",
    });
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
