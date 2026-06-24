import { describe, expect, it } from "vitest";
import { canUseNewIterationShortcut } from "./ProjectSidebar";

describe("ProjectSidebar", () => {
  it("enables New iteration only for the selected project after Initial Spec completion", () => {
    expect(
      canUseNewIterationShortcut({
        initialBuildCompleted: true,
        isCurrentProject: false,
        iterationBusy: false,
      }),
    ).toBe(false);

    expect(
      canUseNewIterationShortcut({
        initialBuildCompleted: false,
        isCurrentProject: true,
        iterationBusy: false,
      }),
    ).toBe(false);

    expect(
      canUseNewIterationShortcut({
        initialBuildCompleted: true,
        isCurrentProject: true,
        iterationBusy: true,
      }),
    ).toBe(false);

    expect(
      canUseNewIterationShortcut({
        initialBuildCompleted: true,
        isCurrentProject: true,
        iterationBusy: false,
      }),
    ).toBe(true);
  });
});
