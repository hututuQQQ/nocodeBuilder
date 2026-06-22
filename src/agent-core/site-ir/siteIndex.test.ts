import { describe, expect, it } from "vitest";
import type { FileTree } from "../../services/projects";
import { buildSiteIndexFromFileTree, validateUniqueSiteNodeIds } from "./siteIndex";

describe("Site IR index", () => {
  it("creates page specs and source map entries from file tree", () => {
    const fileTree: FileTree = {
      name: "site",
      path: "",
      kind: "directory",
      children: [
        { name: "app", path: "app", kind: "directory", children: [
          { name: "page.tsx", path: "app/page.tsx", kind: "file" },
        ] },
      ],
    };
    const { siteSpec, sourceMap } = buildSiteIndexFromFileTree({
      fileTree,
      projectId: "project-1",
      projectName: "Site",
    });

    expect(siteSpec.pages[0]?.route).toBe("/");
    expect(sourceMap.entries[0]?.nodeId).toBe("home.root");
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      validateUniqueSiteNodeIds({
        version: 1,
        projectId: "project-1",
        product: { name: "Site", description: "", language: "en" },
        designSystem: { colors: {}, typography: {}, spacing: {}, radii: {} },
        reusableComponents: [],
        pages: [
          {
            id: "home",
            route: "/",
            title: "Home",
            nodes: [
              { id: "duplicate", type: "section" },
              { id: "duplicate", type: "button" },
            ],
          },
        ],
      }),
    ).toThrow(/Duplicate/);
  });
});
