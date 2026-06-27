import { describe, expect, it } from "vitest";
import { validateAgentStepResponse } from "./validators";

describe("agent model action validation", () => {
  it("normalizes legacy finish into finish_candidate", () => {
    const result = validateAgentStepResponse({
      type: "finish",
      summary: "Done",
    });

    expect(result.type).toBe("finish_candidate");
  });

  it("normalizes finish_candidate evidence fields", () => {
    const result = validateAgentStepResponse({
      evidence: {
        acceptanceEvidence: [
          { criterionId: "criterion-1", evidence: "Verified in app/page.tsx." },
        ],
        changedFiles: ["app/page.tsx"],
        noOpReason: "Existing implementation already satisfies the request.",
        readFiles: ["app/page.tsx"],
      },
      summary: "Done",
      type: "finish_candidate",
    });

    expect(result).toMatchObject({
      evidence: {
        acceptanceEvidence: [
          { criterionId: "criterion-1", evidence: "Verified in app/page.tsx." },
        ],
        changedFiles: ["app/page.tsx"],
        noOpReason: "Existing implementation already satisfies the request.",
        readFiles: ["app/page.tsx"],
      },
      summary: "Done",
      type: "finish_candidate",
    });
  });

  it("rejects invalid finish_candidate evidence entries", () => {
    expect(() =>
      validateAgentStepResponse({
        evidence: {
          readFiles: ["app/page.tsx", false],
        },
        summary: "Done",
        type: "finish_candidate",
      }),
    ).toThrow("finish_candidate.evidence.readFiles entries must be non-empty strings");
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
