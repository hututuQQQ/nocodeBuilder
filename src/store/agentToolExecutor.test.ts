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

  it("preserves existing tokens during incremental updates", async () => {
    fake.siteSpec = {
      ...createSiteSpec(),
      designSystem: {
        colors: {
          primary: "#111111",
          secondary: "#222222",
        },
        radii: {
          card: "12px",
        },
        spacing: {},
        typography: {},
      },
    };
    fake.readFile.mockResolvedValue([
      "/* nocode-builder-design-tokens:start */",
      ":root {",
      "  --ncb-colors-primary: #111111;",
      "  --ncb-colors-secondary: #222222;",
      "  --ncb-radii-card: 12px;",
      "}",
      "/* nocode-builder-design-tokens:end */",
    ].join("\n"));

    const result = await executeAgentTool(
      createFakeStore(),
      createProject(),
      updateDesignTokensStep(),
      1,
      createAgentRunState(),
    );
    const writtenFiles = fake.writeAgentFiles.mock.calls[0]?.[2] as Array<{
      content: string;
      path: string;
    }>;
    const writtenCss = writtenFiles[0]?.content ?? "";

    expect(result.observation.ok).toBe(true);
    expect(writtenCss).toContain("--ncb-colors-primary: #0f766e;");
    expect(writtenCss).toContain("--ncb-colors-secondary: #222222;");
    expect(writtenCss).toContain("--ncb-radii-card: 12px;");
    expect(fake.writeSiteSpec).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        designSystem: {
          colors: {
            primary: "#0f766e",
            secondary: "#222222",
          },
          radii: {
            card: "12px",
          },
          spacing: {},
          typography: {},
        },
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

  it("keeps command diagnostics locations and code frames", async () => {
    const result = await executeAgentTool(
      createFakeStore({
        command: "npm run build",
        exitCode: 1,
        output: [
          "Failed to compile.",
          "",
          "./lib/game/controller.ts:118:46",
          "Type error: Argument of type 'HandEvaluation' is not assignable to parameter of type 'HandRank'.",
          "  116 |",
          "  117 |   const handDescriptions = playerEvaluations.map(",
          "> 118 |     (e) => `${e.player.name}: ${describeHand(e.hand)}`",
          "      |                                              ^",
        ].join("\n"),
        success: false,
      }),
      createProject(),
      {
        args: { command: "npm run build" },
        rationale: "Check build",
        tool: "run_command",
        type: "tool_call",
      },
      1,
      createAgentRunState(),
    );

    expect(result.observation.ok).toBe(false);
    expect(result.observation.content).toContain('"path": "lib/game/controller.ts"');
    expect(result.observation.content).toContain('"line": 118');
    expect(result.observation.content).toContain("describeHand(e.hand)");
  });

  it("returns exact read content separately from the numbered preview", async () => {
    const content = "const a = 1;\r\nconst b = 2;";
    fake.readFile.mockResolvedValue(content);

    const result = await executeAgentTool(
      createFakeStore(),
      createProject(),
      {
        args: { paths: ["app/page.tsx"] },
        rationale: "Read page",
        tool: "read_files",
        type: "tool_call",
      },
      1,
      createAgentRunState(),
    );
    const payload = JSON.parse(result.observation.content ?? "{}") as {
      files: Array<{
        content: string;
        numberedContent: string;
        totalLines: number;
      }>;
    };

    expect(payload.files[0]).toMatchObject({
      content,
      numberedContent: "1 | const a = 1;\n2 | const b = 2;",
      totalLines: 2,
    });
  });

  it("edits CRLF files when old_string uses LF line endings", async () => {
    const content = "const a = 1;\r\nconst b = 2;";
    const runState = createAgentRunState();
    fake.readFile.mockResolvedValue(content);
    mockWriteAgentFilesAsChangeRecord(content);

    await executeAgentTool(
      createFakeStore(),
      createProject(),
      {
        args: { paths: ["app/page.tsx"] },
        rationale: "Read page",
        tool: "read_files",
        type: "tool_call",
      },
      1,
      runState,
    );
    const result = await executeAgentTool(
      createFakeStore(),
      createProject(),
      {
        args: {
          new_string: "const a = 3;\nconst b = 4;",
          old_string: "const a = 1;\nconst b = 2;",
          path: "app/page.tsx",
          summary: "Update constants",
        },
        rationale: "Update page",
        tool: "edit_file",
        type: "tool_call",
      },
      2,
      runState,
    );
    const writtenFiles = fake.writeAgentFiles.mock.calls[0]?.[2] as Array<{
      content: string;
      path: string;
    }>;

    expect(result.observation.ok).toBe(true);
    expect(writtenFiles[0]).toEqual({
      content: "const a = 3;\r\nconst b = 4;",
      path: "app/page.tsx",
    });
  });

  it("strips read_files numbered prefixes before matching edit_file text", async () => {
    const content = "const a = 1;\nconst b = 2;";
    const runState = createAgentRunState();
    fake.readFile.mockResolvedValue(content);
    mockWriteAgentFilesAsChangeRecord(content);

    await executeAgentTool(
      createFakeStore(),
      createProject(),
      {
        args: { paths: ["app/page.tsx"] },
        rationale: "Read page",
        tool: "read_files",
        type: "tool_call",
      },
      1,
      runState,
    );
    const result = await executeAgentTool(
      createFakeStore(),
      createProject(),
      {
        args: {
          new_string: "1 | const a = 3;\n2 | const b = 4;",
          old_string: "1 | const a = 1;\n2 | const b = 2;",
          path: "app/page.tsx",
          summary: "Update constants",
        },
        rationale: "Update page",
        tool: "edit_file",
        type: "tool_call",
      },
      2,
      runState,
    );
    const writtenFiles = fake.writeAgentFiles.mock.calls[0]?.[2] as Array<{
      content: string;
      path: string;
    }>;

    expect(result.observation.ok).toBe(true);
    expect(writtenFiles[0]).toEqual({
      content: "const a = 3;\nconst b = 4;",
      path: "app/page.tsx",
    });
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

function mockWriteAgentFilesAsChangeRecord(beforeContent: string) {
  fake.writeAgentFiles.mockImplementation(
    async (
      _store: unknown,
      project: { id: string },
      files: Array<{ content: string; path: string }>,
      summary: string,
    ) => ({
      createdAt: "2026-01-01T00:00:00.000Z",
      files: files.map((file) => ({
        action: "modified",
        additions: 1,
        afterContent: file.content,
        beforeContent,
        deletions: 1,
        path: file.path,
        sampleAddedLines: [],
        sampleRemovedLines: [],
        unifiedDiff: `--- a/${file.path}\n+++ b/${file.path}`,
      })),
      id: "change-1",
      kind: "agent",
      projectId: project.id,
      summary,
    }),
  );
}

function createFakeStore(commandResult?: {
  command: string;
  exitCode: number | null;
  output: string;
  success: boolean;
}) {
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
    runProjectCommand: vi.fn(async () => commandResult ?? null),
  };

  return {
    get: () => state,
    set: (patch: Partial<typeof state>) => {
      state = { ...state, ...patch };
    },
  } as never;
}
