import { describe, expect, it } from "vitest";
import { getAcceptanceStatusSymbol } from "./SpecPanel";

describe("SpecPanel acceptance criteria projection", () => {
  it("uses explicit status symbols for acceptance criteria", () => {
    expect(getAcceptanceStatusSymbol("passed")).toBe("✓");
    expect(getAcceptanceStatusSymbol("failed")).toBe("✕");
    expect(getAcceptanceStatusSymbol("pending")).toBe("○");
  });
});
