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

  it("denies dangerous paths inside array path fields", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Remove obsolete component" }),
      conversationId: "conversation-1",
      projectId: "project-1",
    });
    const tool = getCoreToolDefinition("delete_files");
    const decision = new PolicyEngine().evaluate({
      args: {
        paths: [".env", "components/Old.tsx"],
        summary: "Remove obsolete component",
      },
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(false);
  });

  it("denies dangerous nested file paths but ignores ordinary summary text", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Change text" }),
      conversationId: "conversation-1",
      projectId: "project-1",
    });
    const tool = getCoreToolDefinition("write_files");
    const metadataDecision = new PolicyEngine().evaluate({
      args: {
        files: [{ content: "{}", path: ".aibuilder/site-spec.json" }],
        summary: "This summary mentions .env but is not itself a file path.",
      },
      run,
      tool: tool!,
    });
    const summaryOnlyDecision = new PolicyEngine().evaluate({
      args: {
        files: [{ content: "export default null;", path: "app/page.tsx" }],
        summary: "Mention .env in plain text without targeting it.",
      },
      run,
      tool: tool!,
    });

    expect(metadataDecision.allowed).toBe(false);
    expect(summaryOnlyDecision.allowed).toBe(true);
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

  it("requires approval before writing package.json when dependency changes ask", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Add animation dependency" }),
      conversationId: "conversation-1",
      projectId: "project-1",
    });
    const tool = getCoreToolDefinition("write_files");
    const args = {
      files: [
        {
          content: JSON.stringify({
            dependencies: { "framer-motion": "11.0.0", next: "15.0.0" },
            scripts: { build: "next build" },
          }),
          path: "package.json",
        },
      ],
    };
    const decision = new PolicyEngine().evaluate({
      args,
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      throw new Error("Expected package.json write to be allowed with approval.");
    }

    expect(decision.approvalRequired).toBe(true);
  });
});
