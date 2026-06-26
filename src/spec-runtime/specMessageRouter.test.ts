import { describe, expect, it } from "vitest";
import type { AiProviderConfig } from "../services/keyStore";
import type { DevelopmentSpec, SpecRevision } from "../spec-core/types";
import { routeSpecUserMessage } from "./specMessageRouter";

describe("routeSpecUserMessage", () => {
  it("routes review change requests to request_revision", async () => {
    await expect(expectIntent("把登录改成微信登录", "review"))
      .resolves.toBe("request_revision");
  });

  it("routes review approval to approve_and_run", async () => {
    await expect(expectIntent("没问题，开始做", "review"))
      .resolves.toBe("approve_and_run");
  });

  it("routes blocked retry notes to retry_with_note", async () => {
    const result = await route("这次注意不要改首页布局，重试", "blocked");

    expect(result.intent).toBe("retry_with_note");
    expect(result.retryNote).toContain("不要改首页布局");
  });

  it("routes blocked diagnostics to diagnose_block", async () => {
    await expect(expectIntent("看看为什么失败", "blocked"))
      .resolves.toBe("diagnose_block");
  });

  it("routes building plan changes to request_revision before retry", async () => {
    await expect(expectIntent("改方案，换做法", "building"))
      .resolves.toBe("request_revision");
  });

  it("routes building retry requests to retry_with_note", async () => {
    await expect(expectIntent("同步状态并重试当前任务", "building"))
      .resolves.toBe("retry_with_note");
  });

  it("routes approved diagnostics to diagnose_block", async () => {
    await expect(expectIntent("看看为什么没有继续执行", "approved"))
      .resolves.toBe("diagnose_block");
  });
});

async function expectIntent(
  message: string,
  status: DevelopmentSpec["status"],
) {
  return (await route(message, status)).intent;
}

function route(message: string, status: DevelopmentSpec["status"]) {
  const revision = createRevision();

  return routeSpecUserMessage({
    message,
    spec: createSpec(revision, status),
    currentRevision: revision,
    conversationMessages: [],
    status,
    config: createConfig(),
  });
}

function createConfig(): AiProviderConfig {
  return {
    apiKeyConfigured: false,
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    models: ["deepseek-v4-pro"],
    provider: "deepseek",
    updatedAt: "",
  };
}

function createSpec(
  revision: SpecRevision,
  status: DevelopmentSpec["status"],
): DevelopmentSpec {
  return {
    conversationId: "conv-1",
    createdAt: "2026-01-01T00:00:00Z",
    currentRevisionId: revision.id,
    failureMessage: status === "blocked" ? "Blocked." : undefined,
    id: "spec-1",
    kind: "feature",
    projectId: "project-1",
    revisions: [revision],
    status,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function createRevision(): SpecRevision {
  return {
    approvedAt: undefined,
    brief: "Feature",
    createdAt: "2026-01-01T00:00:00Z",
    design: {
      components: [],
      dataModel: [],
      integrations: [],
      pages: [],
      summary: "Design",
      technicalDecisions: [],
      verificationStrategy: [],
    },
    id: "rev-1",
    requirements: {
      acceptanceCriteria: [
        { id: "criterion-1", description: "Works", required: true },
      ],
      constraints: [],
      goal: "Goal",
      outOfScope: [],
      unresolvedQuestions: [],
      userStories: [{ id: "story-1", description: "Story" }],
    },
    tasks: [],
    version: 1,
  };
}
