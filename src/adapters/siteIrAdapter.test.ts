import { describe, expect, it } from "vitest";
import { addStableNodeIdsToGeneratedFiles } from "./siteIrAdapter";

describe("siteIrAdapter preview bridge", () => {
  it("adds stable page ids and a controlled preview bridge component", () => {
    const files = addStableNodeIdsToGeneratedFiles([
      {
        path: "app/page.tsx",
        content: [
          "export default function Page() {",
          "  return <main><h1>Hello</h1></main>;",
          "}",
        ].join("\n"),
      },
    ]);
    const page = files.find((file) => file.path === "app/page.tsx");
    const bridge = files.find(
      (file) => file.path === "components/NocodeBuilderPreviewBridge.tsx",
    );

    expect(page?.content).toContain('data-ncb-id="home.root"');
    expect(page?.content).toContain(
      'import NocodeBuilderPreviewBridge from "../components/NocodeBuilderPreviewBridge";',
    );
    expect(page?.content).toContain("<NocodeBuilderPreviewBridge />");
    expect(page?.content).not.toContain("dangerouslySetInnerHTML");
    expect(bridge?.content).toContain('if (process.env.NODE_ENV !== "development") return;');
    expect(bridge?.content).toContain(
      'window.parent.postMessage({ source: "nocode-builder-preview", type, ...payload }, targetOrigin);',
    );
    expect(bridge?.content).not.toContain('postMessage({ source: "nocode-builder-preview", type, ...payload }, "*")');
  });

  it("uses the correct relative bridge import for nested app routes", () => {
    const files = addStableNodeIdsToGeneratedFiles([
      {
        path: "app/pricing/page.tsx",
        content: "export default function Page() { return <main>Pricing</main>; }",
      },
    ]);
    const page = files.find((file) => file.path === "app/pricing/page.tsx");

    expect(page?.content).toContain(
      'import NocodeBuilderPreviewBridge from "../../components/NocodeBuilderPreviewBridge";',
    );
    expect(page?.content).toContain('data-ncb-id="pricing.root"');
  });

  it("does not create duplicate bridge files when the model already returned one", () => {
    const files = addStableNodeIdsToGeneratedFiles([
      {
        path: "app/page.tsx",
        content: "export default function Page() { return <main>Home</main>; }",
      },
      {
        path: "components/NocodeBuilderPreviewBridge.tsx",
        content: "export default function OldBridge() { return null; }",
      },
    ]);
    const bridgeFiles = files.filter(
      (file) => file.path === "components/NocodeBuilderPreviewBridge.tsx",
    );

    expect(bridgeFiles).toHaveLength(1);
    expect(bridgeFiles[0]?.content).toContain("export default function NocodeBuilderPreviewBridge");
  });

  it("does not add an unused bridge import when no main element exists", () => {
    const files = addStableNodeIdsToGeneratedFiles([
      {
        path: "app/page.tsx",
        content: "export default function Page() { return <section>Home</section>; }",
      },
    ]);
    const page = files.find((file) => file.path === "app/page.tsx");

    expect(page?.content).not.toContain("NocodeBuilderPreviewBridge");
  });
});
