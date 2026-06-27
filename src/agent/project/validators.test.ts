import { describe, expect, it } from "vitest";
import { NEXTJS_APP_ROUTER_PROJECT_POLICY } from "./projectPolicy";
import {
  validateAgentStepResponse,
  validateGeneratedProjectResponse,
} from "./validators";

describe("agent model action validation", () => {
  it("allows scoped initial generation files without app/page.tsx", () => {
    const requiredFiles = [
      "package.json",
      "next.config.js",
      "tsconfig.json",
      "tailwind.config.ts",
      "postcss.config.mjs",
      "app/layout.tsx",
      "app/globals.css",
    ];
    const policy = {
      ...NEXTJS_APP_ROUTER_PROJECT_POLICY,
      requiredFiles,
    };

    const result = validateGeneratedProjectResponse({
      type: "write_files",
      summary: "Generated foundation files",
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            dependencies: {
              next: "14.2.35",
              react: "18.3.1",
              "react-dom": "18.3.1",
            },
            devDependencies: {
              "@types/node": "20.14.11",
              "@types/react": "18.3.3",
              "@types/react-dom": "18.3.0",
              autoprefixer: "10.4.20",
              postcss: "8.4.49",
              tailwindcss: "3.4.17",
              typescript: "5.4.5",
            },
            scripts: {
              build: "next build",
              dev: "next dev",
              start: "next start",
            },
          }),
        },
        { path: "next.config.js", content: "module.exports = {};" },
        { path: "tsconfig.json", content: "{}" },
        { path: "tailwind.config.ts", content: "export default {};" },
        { path: "postcss.config.mjs", content: "export default {};" },
        { path: "app/layout.tsx", content: "export default function RootLayout() { return null; }" },
        { path: "app/globals.css", content: "@tailwind base;" },
      ],
    }, policy);

    expect(result.files.map((file) => file.path)).not.toContain("app/page.tsx");
  });

  it("normalizes legacy finish into finish_candidate", () => {
    const result = validateAgentStepResponse({
      type: "finish",
      summary: "Done",
    });

    expect(result.type).toBe("finish_candidate");
  });

  it("normalizes common Postgres aliases in Supabase schema tool calls", () => {
    const result = validateAgentStepResponse({
      args: {
        summary: "Create poker tables",
        tables: [
          {
            columns: [
              {
                dataType: "int2",
                defaultValue: "0",
                name: "seat_number",
                nullable: false,
                primaryKey: false,
                unique: false,
              },
              {
                dataType: "int8",
                name: "chip_count",
                nullable: false,
                primaryKey: false,
                unique: false,
              },
            ],
            enableRls: true,
            name: "room_players",
          },
        ],
      },
      rationale: "Create room player state.",
      tool: "apply_supabase_schema",
      type: "tool_call",
    });

    expect(result).toMatchObject({
      args: {
        tables: [
          {
            columns: [
              {
                dataType: "integer",
                name: "seat_number",
              },
              {
                dataType: "bigint",
                name: "chip_count",
              },
            ],
          },
        ],
      },
      tool: "apply_supabase_schema",
      type: "tool_call",
    });
  });

  it("accepts safe numeric Supabase default literals", () => {
    const result = validateAgentStepResponse({
      args: {
        summary: "Create poker table",
        tables: [
          {
            columns: [
              {
                dataType: "integer",
                defaultValue: "9",
                name: "max_players",
                nullable: false,
                primaryKey: false,
                unique: false,
              },
              {
                dataType: "numeric",
                defaultValue: "-1.5",
                name: "rake",
                nullable: false,
                primaryKey: false,
                unique: false,
              },
            ],
            enableRls: true,
            name: "rooms",
          },
        ],
      },
      rationale: "Create room settings.",
      tool: "apply_supabase_schema",
      type: "tool_call",
    });

    expect(result).toMatchObject({
      args: {
        tables: [
          {
            columns: [
              {
                dataType: "integer",
                defaultValue: "9",
                name: "max_players",
              },
              {
                dataType: "numeric",
                defaultValue: "-1.5",
                name: "rake",
              },
            ],
          },
        ],
      },
    });
  });

  it("keeps empty text defaults and drops empty defaults for non-text columns", () => {
    const result = validateAgentStepResponse({
      args: {
        summary: "Create profile defaults",
        tables: [
          {
            columns: [
              {
                dataType: "text",
                defaultValue: "''",
                name: "display_name",
                nullable: false,
                primaryKey: false,
                unique: false,
              },
              {
                dataType: "uuid",
                defaultValue: "''",
                name: "avatar_id",
                nullable: true,
                primaryKey: false,
                unique: false,
              },
            ],
            enableRls: true,
            name: "profiles",
          },
        ],
      },
      rationale: "Create profile defaults.",
      tool: "apply_supabase_schema",
      type: "tool_call",
    });

    expect(result).toMatchObject({
      args: {
        tables: [
          {
            columns: [
              {
                dataType: "text",
                defaultValue: "''",
                name: "display_name",
              },
              {
                dataType: "uuid",
                name: "avatar_id",
              },
            ],
          },
        ],
      },
    });
    if (result.type !== "tool_call" || result.tool !== "apply_supabase_schema") {
      throw new Error("Expected apply_supabase_schema tool call.");
    }
    expect(result.args.tables[0].columns[1].defaultValue).toBeUndefined();
  });

  it("rejects unsafe Supabase default expressions", () => {
    expect(() =>
      validateAgentStepResponse({
        args: {
          summary: "Create table",
          tables: [
            {
              columns: [
                {
                  dataType: "integer",
                  defaultValue: "9; drop table rooms",
                  name: "max_players",
                  nullable: false,
                  primaryKey: false,
                  unique: false,
                },
              ],
              enableRls: true,
              name: "rooms",
            },
          ],
        },
        rationale: "Create room settings.",
        tool: "apply_supabase_schema",
        type: "tool_call",
      }),
    ).toThrow('unsupported Supabase default value "9; drop table rooms"');
  });
});
