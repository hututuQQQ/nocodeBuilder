import { describe, expect, it } from "vitest";
import {
  buildFeatureSpecMessages,
  buildInitialSpecMessages,
  buildSpecQuestionMessages,
  buildSpecRevisionMessages,
} from "./prompts";

const CHINESE_RULE =
  "If the latest request is primarily Chinese, use Simplified Chinese.";

describe("Spec prompts", () => {
  it("instructs Initial Spec fields to match the project brief language", () => {
    const messages = buildInitialSpecMessages({
      projectBrief: "做一个客服工单系统",
      projectName: "Support",
    });
    const systemContent = String(messages[0].content);

    expect(systemContent).toContain(
      "User-facing Spec fields such as brief, requirements, design text, task titles, task objectives, summaries, and unresolved questions must match the dominant natural language",
    );
    expect(systemContent).toContain(CHINESE_RULE);
    expect(systemContent).toContain(
      "Every task must include at least one acceptanceCriteriaIds entry that references an existing acceptance criterion.",
    );
    expect(systemContent).toContain(
      "If Supabase is configured and the user request implies backend, persistence, rooms, multiplayer, online play, realtime sync, or server-managed state, plan a Supabase-backed implementation.",
    );
  });

  it("instructs Feature Spec fields to match the feature brief language", () => {
    const messages = buildFeatureSpecMessages({
      brief: "增加订单筛选",
      context: { routes: ["/orders"] },
    });
    const systemContent = String(messages[0].content);

    expect(systemContent).toContain(CHINESE_RULE);
  });

  it("instructs revised Spec fields to match feedback language", () => {
    const messages = buildSpecRevisionMessages({
      currentRevision: { brief: "Orders" },
      feedback: "把验收标准写成中文",
    });
    const systemContent = String(messages[0].content);

    expect(systemContent).toContain(CHINESE_RULE);
  });

  it("builds a review question prompt without mutating the Spec", () => {
    const messages = buildSpecQuestionMessages({
      currentRevision: { brief: "Poker" },
      planningContext: { backendContext: { supabase: { configured: true } } },
      question: "Why use Supabase?",
    });
    const systemContent = String(messages[0].content);
    const userContent = String(messages[1].content);

    expect(systemContent).toContain(
      "Answer questions about the current Spec revision without changing it.",
    );
    expect(systemContent).toContain(
      "If Supabase is configured and the Spec chose an in-memory or custom WebSocket backend",
    );
    expect(userContent).toContain("Why use Supabase?");
    expect(userContent).toContain("backendContext");
  });
});
