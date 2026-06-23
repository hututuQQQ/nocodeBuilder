import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevelopmentSpec } from "../spec-core/types";
import { specApi } from "./specs";

const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => fake.invoke(...args),
}));

describe("specApi", () => {
  beforeEach(() => {
    fake.invoke.mockReset();
  });

  it("rejects malformed Spec payloads before saving", async () => {
    const invalidSpec = {
      ...createSpec(),
      status: "mystery",
    } as unknown as DevelopmentSpec;

    await expect(
      specApi.saveSpec("project-1", invalidSpec),
    ).rejects.toThrow(/status is invalid/i);

    expect(fake.invoke).not.toHaveBeenCalled();
  });

  it("validates Specs returned from Host reads", async () => {
    fake.invoke.mockResolvedValue({
      ...createSpec(),
      status: "mystery",
    });

    await expect(
      specApi.readSpec("project-1", "spec-1"),
    ).rejects.toThrow(/status is invalid/i);

    expect(fake.invoke).toHaveBeenCalledWith("read_development_spec", {
      projectId: "project-1",
      specId: "spec-1",
    });
  });

  it("validates Specs returned after Host creates", async () => {
    const spec = createSpec();
    fake.invoke.mockResolvedValue({
      ...spec,
      revisions: [],
    });

    await expect(
      specApi.createSpec("project-1", spec),
    ).rejects.toThrow(/at least one revision/i);

    expect(fake.invoke).toHaveBeenCalledWith("create_development_spec", {
      projectId: "project-1",
      spec,
    });
  });
});

function createSpec(): DevelopmentSpec {
  return {
    conversationId: "conversation-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentRevisionId: "rev-1",
    id: "spec-1",
    kind: "feature",
    projectId: "project-1",
    revisions: [
      {
        brief: "Add saved searches",
        createdAt: "2026-01-01T00:00:00.000Z",
        design: {
          components: [],
          dataModel: [],
          integrations: [],
          pages: [],
          summary: "Add a saved searches UI.",
          technicalDecisions: [],
          verificationStrategy: ["Run npm run build."],
        },
        id: "rev-1",
        requirements: {
          acceptanceCriteria: [
            {
              description: "Saved searches can be opened again.",
              id: "criterion-1",
              required: true,
            },
          ],
          constraints: [],
          goal: "Let users save searches.",
          outOfScope: [],
          unresolvedQuestions: [],
          userStories: [
            {
              description: "As a user, I can reopen a saved search.",
              id: "story-1",
            },
          ],
        },
        tasks: [
          {
            acceptanceCriteriaIds: ["criterion-1"],
            allowedPaths: ["app/page.tsx"],
            dependencyIds: [],
            expectedFiles: ["app/page.tsx"],
            id: "task-1",
            objective: "Implement saved searches.",
            requirementIds: ["story-1"],
            status: "pending",
            title: "Saved searches",
          },
        ],
        version: 1,
      },
    ],
    status: "review",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
