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

  it("does not require approval before writing package.json even when dependency changes ask", () => {
    const machine = new RunStateMachine();
    const contract = compileTaskContract({ objective: "Add animation dependency" });
    const run = machine.createRun({
      contract: {
        ...contract,
        permissions: {
          ...contract.permissions,
          dependencyChange: "ask",
        },
      },
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
      throw new Error("Expected package.json write to be allowed.");
    }

    expect(decision.approvalRequired).toBe(false);
  });

  it("requires approval before running package installation", () => {
    const machine = new RunStateMachine();
    const run = machine.createRun({
      contract: compileTaskContract({ objective: "Initialize dependencies" }),
      conversationId: "conversation-1",
      projectId: "project-1",
    });
    const tool = getCoreToolDefinition("run_command");
    const decision = new PolicyEngine().evaluate({
      args: { command: "npm install" },
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      throw new Error("Expected npm install to be allowed.");
    }

    expect(decision.approvalRequired).toBe(true);
  });

  it("denies package installation when dependency changes are denied", () => {
    const machine = new RunStateMachine();
    const contract = compileTaskContract({ objective: "Answer a question" });
    const run = machine.createRun({
      contract: {
        ...contract,
        permissions: {
          ...contract.permissions,
          dependencyChange: "deny",
        },
      },
      conversationId: "conversation-1",
      projectId: "project-1",
    });
    const tool = getCoreToolDefinition("run_command");
    const decision = new PolicyEngine().evaluate({
      args: { command: "pnpm install" },
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(false);
  });

  it("allows workspace writes inside allowed paths", () => {
    const run = createScopedRun(["app/**"]);
    const tool = getCoreToolDefinition("write_files");
    const decision = new PolicyEngine().evaluate({
      args: {
        files: [{ content: "export default null;", path: "app/page.tsx" }],
      },
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(true);
  });

  it("allows workspace writes outside allowed paths as soft scope guidance", () => {
    const run = createScopedRun(["app/**"]);
    const tool = getCoreToolDefinition("write_files");
    const decision = new PolicyEngine().evaluate({
      args: {
        files: [{ content: "export const secret = true;", path: "lib/secret.ts" }],
      },
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      throw new Error("Expected soft-scope workspace write to be allowed.");
    }

    expect(decision.approvalRequired).toBe(false);
  });

  it("allows exact allowed edit paths", () => {
    const run = createScopedRun(["package.json"]);
    const tool = getCoreToolDefinition("edit_file");
    const decision = new PolicyEngine().evaluate({
      args: {
        new_string: "{\"scripts\":{}}",
        old_string: "{}",
        path: "package.json",
      },
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(true);
  });

  it("requires approval for deletes outside allowed paths", () => {
    const run = createScopedRun(["app/**"]);
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

  it("keeps forbidden paths higher priority than allowed paths", () => {
    const run = createScopedRun([".aibuilder/**", "app/**"]);
    const tool = getCoreToolDefinition("write_files");
    const decision = new PolicyEngine().evaluate({
      args: { files: [{ content: "{}", path: ".aibuilder/site-spec.json" }] },
      run,
      tool: tool!,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "Tool target is inside a forbidden path such as .aibuilder or .env.",
    });
  });

  it("normalizes paths before applying forbidden path checks", () => {
    const run = createScopedRun(["app/**"]);
    const tool = getCoreToolDefinition("write_files");
    const allowedDecision = new PolicyEngine().evaluate({
      args: { files: [{ content: "ok", path: "app\\page.tsx" }] },
      run,
      tool: tool!,
    });
    const traversalDecision = new PolicyEngine().evaluate({
      args: { files: [{ content: "bad", path: "app/../lib/secret.ts" }] },
      run,
      tool: tool!,
    });

    expect(allowedDecision.allowed).toBe(true);
    expect(traversalDecision.allowed).toBe(false);
  });

  it("does not scope-deny controlled workspace tools without path arguments", () => {
    const run = createScopedRun(["app/**"]);
    const tool = getCoreToolDefinition("refresh_site_index");
    const decision = new PolicyEngine().evaluate({
      args: { reason: "after edits" },
      run,
      tool: tool!,
    });

    expect(decision.allowed).toBe(true);
  });
});

function createScopedRun(allowedPaths: string[]) {
  const machine = new RunStateMachine();
  const contract = compileTaskContract({ objective: "Change scoped files" });

  return machine.createRun({
    contract: {
      ...contract,
      permissions: {
        ...contract.permissions,
        dependencyChange: "allow",
        fileDelete: "ask",
      },
      scope: {
        ...contract.scope,
        allowedPaths,
      },
    },
    conversationId: "conversation-1",
    projectId: "project-1",
  });
}
