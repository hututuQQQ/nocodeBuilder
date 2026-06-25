import { describe, expect, it } from "vitest";
import {
  buildFeatureSpecMessages,
  buildInitialSpecMessages,
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
});
