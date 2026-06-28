import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadProjectEnvConfig,
  saveProjectSupabaseConfig,
} from "./projectEnv";

const fake = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("./projects", () => ({
  getProjectErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  projectApi: {
    readFile: (...args: unknown[]) => fake.readFile(...args),
    writeFile: (...args: unknown[]) => fake.writeFile(...args),
  },
}));

describe("project env Supabase config", () => {
  beforeEach(() => {
    fake.readFile.mockReset();
    fake.writeFile.mockReset();
  });

  it("loads only the current publishable and secret key names", async () => {
    fake.readFile.mockResolvedValue(
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://project.supabase.co",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_current",
        "SUPABASE_SECRET_KEY=sb_secret_current",
        "SUPABASE_DB_URL=postgres://user:pass@host:5432/db",
      ].join("\n"),
    );

    const config = await loadProjectEnvConfig("project-1");

    expect(config.supabase).toMatchObject({
      publishableKey: "sb_publishable_current",
      secretKey: "sb_secret_current",
    });
  });

  it("does not load removed anon or service role fallback keys", async () => {
    fake.readFile.mockResolvedValue(
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://project.supabase.co",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=legacy-anon",
        "SUPABASE_SERVICE_ROLE_KEY=legacy-service-role",
      ].join("\n"),
    );

    const config = await loadProjectEnvConfig("project-1");

    expect(config.supabase).toBeNull();
  });

  it("saves the current publishable key name", async () => {
    fake.readFile.mockResolvedValue("");

    await saveProjectSupabaseConfig("project-1", {
      dbUrl: "postgres://user:pass@host:5432/db",
      publishableKey: "sb_publishable_current",
      schema: "public",
      secretKey: "sb_secret_current",
      url: "https://project.supabase.co",
    });

    expect(fake.writeFile).toHaveBeenCalledWith(
      "project-1",
      ".env",
      expect.stringContaining(
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_current",
      ),
    );
    expect(fake.writeFile.mock.calls[0][2]).not.toContain(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  });
});
