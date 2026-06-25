import { describe, expect, it } from "vitest";
import {
  formatUserLanguageInstruction,
  localizeUserFacingMessage,
  prefersSimplifiedChinese,
} from "./languagePolicy";

describe("language policy", () => {
  it("detects Simplified Chinese preference from Han text", () => {
    expect(prefersSimplifiedChinese("帮我修一下这个错误")).toBe(true);
    expect(prefersSimplifiedChinese("Please fix this error")).toBe(false);
  });

  it("localizes deterministic user-facing messages for Chinese input", () => {
    expect(
      localizeUserFacingMessage("请重试一下", {
        en: "Retrying now.",
        zhHans: "现在重试。",
      }),
    ).toBe("现在重试。");
  });

  it("formats prompt instructions for matching the user's language", () => {
    expect(formatUserLanguageInstruction("User-facing output")).toEqual([
      "User-facing output must match the dominant natural language of the user's latest request, project brief, or revision feedback.",
      "If the latest request is primarily Chinese, use Simplified Chinese.",
      "If the user explicitly asks for a different output language, follow that instruction.",
      "For mixed-language input, use the dominant natural language unless the user explicitly asks otherwise.",
      "Preserve code, identifiers, file paths, package names, commands, API names, log excerpts, and quoted source text in their original language.",
    ]);
  });
});
