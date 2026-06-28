import { describe, expect, it } from "vitest";
import type { FileTree } from "../../services/projects";
import {
  buildSiteIndexFromFileTree,
  preserveSiteSpecMetadata,
  validateUniqueSiteNodeIds,
} from "./siteIndex";

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

  it("indexes real data-ncb-id attributes with source line numbers", () => {
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
      fileContents: {
        "app/page.tsx": [
          "export default function Page() {",
          "  return <main data-ncb-id=\"home.root\">",
          "    <section data-ncb-id=\"home.hero\">Hero</section>",
          "    <button data-ncb-id={'home.hero.cta'}>Start</button>",
          "  </main>;",
          "}",
        ].join("\n"),
      },
      fileTree,
      projectId: "project-1",
      projectName: "Site",
    });

    const root = siteSpec.pages[0]?.nodes[0];
    expect(root?.children?.map((node) => node.id)).toEqual([
      "home.hero",
      "home.hero.cta",
    ]);
    expect(sourceMap.entries.find((entry) => entry.nodeId === "home.root")).toMatchObject({
      path: "app/page.tsx",
      startLine: 2,
      endLine: 2,
    });
    expect(sourceMap.entries.find((entry) => entry.nodeId === "home.hero")).toMatchObject({
      path: "app/page.tsx",
      startLine: 3,
      endLine: 3,
    });
    expect(root?.children?.find((node) => node.id === "home.hero.cta")?.type).toBe("button");
  });

  it("keeps untagged pages without synthetic child nodes", () => {
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
      fileContents: {
        "app/page.tsx": "export default function Page() { return <main><h1>Old page</h1></main>; }",
      },
      fileTree,
      projectId: "project-1",
      projectName: "Site",
    });

    const root = siteSpec.pages[0]?.nodes[0];
    expect(root?.children).toEqual([]);
    expect(sourceMap.entries.find((entry) => entry.nodeId === "home.root")).toMatchObject({
      path: "app/page.tsx",
      startLine: 1,
    });
    expect(sourceMap.entries.some((entry) => entry.nodeId.includes("legacy"))).toBe(false);
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

  it("preserves product and design system metadata across refresh", () => {
    const refreshed = preserveSiteSpecMetadata(
      {
        version: 1,
        projectId: "project-1",
        product: { name: "Existing", description: "Keep me", language: "zh" },
        designSystem: {
          colors: { primary: "#0f766e" },
          radii: { card: "8px" },
          spacing: { section: "64px" },
          typography: { heading: "Inter" },
        },
        pages: [],
        reusableComponents: [],
      },
      {
        version: 1,
        projectId: "project-1",
        product: { name: "New", description: "", language: "unknown" },
        designSystem: { colors: {}, typography: {}, spacing: {}, radii: {} },
        pages: [
          {
            id: "home",
            route: "/",
            title: "Home",
            nodes: [{ id: "home.root", type: "page" }],
          },
        ],
        reusableComponents: [],
      },
    );

    expect(refreshed.product.name).toBe("Existing");
    expect(refreshed.designSystem.colors.primary).toBe("#0f766e");
    expect(refreshed.pages).toHaveLength(1);
  });
});
