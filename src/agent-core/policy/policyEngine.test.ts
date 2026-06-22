import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../contract/taskContract";
import { RunStateMachine } from "../runtime/runStateMachine";
import { getCoreToolDefinition } from "../tools/toolRegistry";
import { PolicyEngine } from "./policyEngine";

describe("PolicyEngine", () => {
  it("denies metadata and env writes", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Change text" }),
      conversationId: "conversation-1",
      projectId: "project-1",
    });
    const tool = getCoreToolDefinition("write_files");
    const decision = new PolicyEngine().evaluate({
      args: { files: [{ path: ".aibuilder/site-spec.json", content: "{}" }] },
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(false);
  });

  it("requires approval for destructive file deletion", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Remove obsolete component" }),
      conversationId: "conversation-1",
      projectId: "project-1",
    });
    const tool = getCoreToolDefinition("delete_files");
    const decision = new PolicyEngine().evaluate({
      args: { paths: ["components/Old.tsx"] },
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      throw new Error("Expected delete_files to be allowed with approval.");
    }

    expect(decision.approvalRequired).toBe(true);
  });
});
