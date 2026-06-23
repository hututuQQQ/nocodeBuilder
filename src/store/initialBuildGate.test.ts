import { describe, expect, it } from "vitest";
import type { ProjectConversationSummary } from "../services/projects";
import type { DevelopmentSpec } from "../spec-core/types";
import { hasCompletedInitialBuildEvidence } from "./initialBuildGate";

describe("initial build gate evidence", () => {
  it("does not treat existing iterations as completed Initial Build evidence", () => {
    expect(
      hasCompletedInitialBuildEvidence(
        {
          conversationSummaries: [
            createSummary({
              activeSpecId: "spec-initial",
              id: "conversation-initial",
              kind: "initial_build",
              mode: "spec",
            }),
            createSummary({
              id: "conversation-iteration",
              kind: "iteration",
              mode: "chat",
            }),
          ],
          currentProject: { id: "project-1" },
          currentSpec: null,
          historicalSpecs: [],
          initialBuildSpec: null,
        },
        "project-1",
      ),
    ).toBe(false);
  });

  it("accepts a completed Initial Build Spec as project-level evidence", () => {
    expect(
      hasCompletedInitialBuildEvidence(
        {
          conversationSummaries: [
            createSummary({
              activeSpecId: "spec-initial",
              id: "conversation-initial",
              kind: "initial_build",
              mode: "spec",
            }),
          ],
          currentProject: { id: "project-1" },
          currentSpec: null,
          historicalSpecs: [],
          initialBuildSpec: createSpec({
            conversationId: "conversation-initial",
            id: "spec-initial",
            status: "completed",
          }),
        },
        "project-1",
      ),
    ).toBe(true);
  });
});

function createSummary(
  patch: Partial<ProjectConversationSummary> = {},
): ProjectConversationSummary {
  return {
    activeSpecId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "conversation-1",
    kind: "iteration",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    mode: "chat",
    projectId: "project-1",
    title: "Iteration",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function createSpec(patch: Partial<DevelopmentSpec> = {}): DevelopmentSpec {
  return {
    conversationId: "conversation-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentRevisionId: "rev-1",
    id: "spec-1",
    kind: "initial_build",
    projectId: "project-1",
    revisions: [],
    status: "review",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}
