import { describe, expect, it } from "vitest";
import type {
  ProjectConversation,
  ProjectConversationSummary,
} from "../../services/projects";
import type { DevelopmentSpec } from "../../spec-core/types";
import {
  canArchiveConversation,
  canUseNewIterationShortcut,
  formatConversationMarker,
} from "./ProjectSidebar";

describe("ProjectSidebar", () => {
  it("enables New iteration only for the selected project after Initial Spec completion", () => {
    expect(
      canUseNewIterationShortcut({
        initialBuildCompleted: true,
        isCurrentProject: false,
        iterationBusy: false,
      }),
    ).toBe(false);

    expect(
      canUseNewIterationShortcut({
        initialBuildCompleted: false,
        isCurrentProject: true,
        iterationBusy: false,
      }),
    ).toBe(false);

    expect(
      canUseNewIterationShortcut({
        initialBuildCompleted: true,
        isCurrentProject: true,
        iterationBusy: true,
      }),
    ).toBe(false);

    expect(
      canUseNewIterationShortcut({
        initialBuildCompleted: true,
        isCurrentProject: true,
        iterationBusy: false,
      }),
    ).toBe(true);
  });

  it("hides Archive for Initial Build until the Initial Spec is completed", () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
    });
    const currentConversation = createConversation({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      specIds: ["spec-initial"],
    });

    expect(
      canArchiveConversation(
        initialBuild,
        currentConversation,
        createSpec({ status: "review" }),
        [],
      ),
    ).toBe(false);

    expect(
      canArchiveConversation(
        initialBuild,
        currentConversation,
        createSpec({ status: "completed" }),
        [],
      ),
    ).toBe(true);

    expect(formatConversationMarker(initialBuild)).toBe("Spec · Locked");
  });

  it("allows archive for normal iterations regardless of Initial Build state", () => {
    expect(
      canArchiveConversation(
        createSummary({ id: "conversation-chat", mode: "chat" }),
        null,
        null,
        [],
      ),
    ).toBe(true);
    expect(
      canArchiveConversation(
        createSummary({
          activeSpecId: "spec-feature",
          id: "conversation-spec",
          mode: "spec",
        }),
        null,
        null,
        [],
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

function createConversation(
  patch: Partial<ProjectConversation> = {},
): ProjectConversation {
  return {
    ...createSummary(),
    messages: [],
    modeChangedAt: "2026-01-01T00:00:00.000Z",
    specIds: [],
    ...patch,
  };
}

function createSpec(
  patch: Partial<DevelopmentSpec> = {},
): DevelopmentSpec {
  return {
    conversationId: "conversation-initial",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentRevisionId: "rev-1",
    id: "spec-initial",
    kind: "initial_build",
    projectId: "project-1",
    revisions: [],
    status: "review",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}
