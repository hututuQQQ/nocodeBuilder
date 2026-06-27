import { describe, expect, it } from "vitest";

const SOURCE_MODULES = import.meta.glob("/src/**/*.{ts,tsx}", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const MOJIBAKE_PATTERN = new RegExp(
  [
    "\u9359",
    "\u95b8",
    "\u9427",
    "\u93c1",
    "\u6434",
    "\u8bfb",
    "\u5f74",
    "\u938c",
    "\u6d63",
    "\u7487",
    "\u74ba",
    "\u7f01",
    "\u6168",
    "\u9420",
    "\ufffd",
  ].join("|"),
);

describe("source encoding", () => {
  it("keeps TypeScript sources UTF-8 without BOM or mojibake fixtures", () => {
    const offenders = Object.entries(SOURCE_MODULES).flatMap(([path, text]) => {
      const issues: string[] = [];

      if (text.charCodeAt(0) === 0xfeff) {
        issues.push("BOM");
      }

      if (MOJIBAKE_PATTERN.test(text)) {
        issues.push("mojibake");
      }

      return issues.length > 0 ? [`${path}: ${issues.join(", ")}`] : [];
    });

    expect(offenders).toEqual([]);
  });
});
