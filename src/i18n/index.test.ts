import { describe, expect, it } from "vitest";
import {
  isLocalePreference,
  resolveLocalePreference,
  translate,
} from "./index";

describe("i18n", () => {
  it("resolves system language to Simplified Chinese for zh locales", () => {
    expect(resolveLocalePreference("system", ["zh-CN", "en-US"])).toBe(
      "zh-CN",
    );
    expect(resolveLocalePreference("system", ["en-US"])).toBe("en");
  });

  it("honors explicit locale preferences", () => {
    expect(resolveLocalePreference("en", ["zh-CN"])).toBe("en");
    expect(resolveLocalePreference("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("interpolates translation params", () => {
    expect(
      translate("en", "database.connectedTables", {
        count: 2,
        project: "demo",
      }),
    ).toBe("Connected to 2 table(s) for demo.");
  });

  it("validates persisted locale preference values", () => {
    expect(isLocalePreference("system")).toBe(true);
    expect(isLocalePreference("zh-CN")).toBe(true);
    expect(isLocalePreference("fr")).toBe(false);
  });
});
