import { describe, expect, it } from "vitest";
import {
  assertReadOnlyBatch,
  getCoreToolDefinition,
  validateCoreToolInput,
} from "./toolRegistry";

describe("Core tool registry", () => {
  it("exposes policy metadata and validates input object shape", () => {
    const editFile = getCoreToolDefinition("edit_file");

    expect(editFile?.sideEffect).toBe("workspace_write");
    expect(editFile?.requiresVerification).toBe(true);
    expect(() => validateCoreToolInput("edit_file", null)).toThrow();
    expect(() => validateCoreToolInput("edit_file", {})).not.toThrow();
  });

  it("limits parallel calls to read-only tools", () => {
    expect(() => assertReadOnlyBatch(["read_files", "grep_files"])).not.toThrow();
    expect(() => assertReadOnlyBatch(["read_files", "edit_file"])).toThrow(/read-only/);
  });
});
