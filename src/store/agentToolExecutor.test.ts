import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteSpec } from "../agent-core/types";
import type { AgentToolCallStep } from "../agent/projectModifier";
import { createAgentRunState, executeAgentTool } from "./agentToolExecutor";

const fake = vi.hoisted(() => ({
  deleteAgentFiles: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  siteSpec: null as SiteSpec | null,
  writeAgentFiles: vi.fn(),
  writeSiteSpec: vi.fn(),
}));

vi.mock("../services/projects", () => ({
  getProjectErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  projectApi: {
    listFiles: fake.listFiles,
    readFile: fake.readFile,
  },
}));

vi.mock("../adapters/siteIrAdapter", () => ({
  ensureSiteIndex: vi.fn(async () => fake.siteSpec),
  refreshSiteIndex: vi.fn(async () => fake.siteSpec),
}));

vi.mock("../services/agentRuntime", () => ({
  agentRuntimeApi: {
    readSiteSourceMap: vi.fn(),
    writeSiteSpec: fake.writeSiteSpec,
  },
}));

vi.mock("./agentFileChanges", () => ({
  deleteAgentFiles: fake.deleteAgentFiles,
  writeAgentFiles: fake.writeAgentFiles,
}));

vi.mock("./agentHooks", () => ({
  runPostToolUseHooks: vi.fn(() => []),
  runPreToolUseHooks: vi.fn(() => ({ ok: true })),
}));

describe("agentToolExecutor update_design_tokens", () => {
  beforeEach(() => {
    fake.deleteAgentFiles.mockReset();
    fake.listFiles.mockReset();
    fake.readFile.mockReset();
    fake.writeAgentFiles.mockReset();
    fake.writeSiteSpec.mockReset();
    fake.siteSpec = createSiteSpec();
    fake.listFiles.mockResolvedValue({
      kind: "directory",
      name: "",
      path: "",
      children: [{ kind: "file", name: "nocode-tokens.css", path: "styles/nocode-tokens.css" }],
    });
    fake.readFile.mockResolvedValue(":root { --old: value; }");
    fake.writeAgentFiles.mockResolvedValue({
      files: [{ path: "styles/nocode-tokens.css" }],
    });
  });

  it("updates CSS and SiteSpec together on success", async () => {
    const result = await executeAgentTool(
      createFakeStore(),
      createProject(),
      updateDesignTokensStep(),
      1,
      createAgentRunState(),
    );

    expect(result.didChangeFiles).toBe(true);
    expect(result.changedFiles).toEqual(["styles/nocode-tokens.css"]);
    expect(fake.writeAgentFiles).toHaveBeenCalledTimes(1);
    expect(fake.writeSiteSpec).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        designSystem: expect.objectContaining({
          colors: expect.objectContaining({ primary: "#0f766e" }),
        }),
      }),
    );
  });

  it("rolls back CSS when SiteSpec persistence fails", async () => {
    fake.writeSiteSpec.mockRejectedValueOnce(new Error("metadata write failed"));

    const result = await executeAgentTool(
      createFakeStore(),
      createProject(),
      updateDesignTokensStep(),
      1,
      createAgentRunState(),
    );

    expect(result.didChangeFiles).toBeUndefined();
    expect(result.observation.ok).toBe(false);
    expect(result.observation.summary).toContain("update_design_tokens failed");
    expect(fake.writeAgentFiles).toHaveBeenCalledTimes(2);
    expect(fake.writeAgentFiles.mock.calls[1]?.[2]).toEqual([
      { content: ":root { --old: value; }", path: "styles/nocode-tokens.css" },
    ]);
  });
});

function updateDesignTokensStep(): AgentToolCallStep {
  return {
    args: {
      summary: "Update primary color",
      tokens: {
        colors: {
          primary: "#0f766e",
        },
      },
    },
    rationale: "Keep design metadata synced.",
    tool: "update_design_tokens",
    type: "tool_call",
  };
}

function createSiteSpec(): SiteSpec {
  return {
    designSystem: {
      colors: {},
      radii: {},
      spacing: {},
      typography: {},
    },
    pages: [],
    product: {
      description: "",
      language: "en",
      name: "Project",
    },
    projectId: "project-1",
    reusableComponents: [],
    version: 1,
  };
}

function createProject() {
  return {
    createdAt: "",
    framework: "next-app-router" as const,
    id: "project-1",
    lastOpenedAt: "",
    name: "Project",
    path: "C:/project",
    updatedAt: "",
  };
}

function createFakeStore() {
  let state = {
    currentProject: { id: "project-1" },
    fileTree: {
      kind: "directory" as const,
      name: "",
      path: "",
      children: [
        {
          kind: "file" as const,
          name: "nocode-tokens.css",
          path: "styles/nocode-tokens.css",
        },
      ],
    },
  };

  return {
    get: () => state,
    set: (patch: Partial<typeof state>) => {
      state = { ...state, ...patch };
    },
  } as never;
}
