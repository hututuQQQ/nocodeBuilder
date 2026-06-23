import { describe, expect, it } from "vitest";
import { getIterationModeSwitchControlState } from "./iterationModeSwitchState";

describe("iteration mode switch state", () => {
  it("keeps the cancel-and-switch entrypoint enabled while a Spec task is executing", () => {
    const state = getIterationModeSwitchControlState({
      currentMode: "spec",
      flags: {
        isExecutingSpec: true,
        isGeneratingSpec: false,
        isRevisingSpec: false,
        isSwitchingIterationMode: false,
        isVerifyingSpec: false,
      },
      specStatus: "building",
    });

    expect(state.chatButtonDisabled).toBe(false);
    expect(state.switchToChatDisabled).toBe(false);
    expect(state.specButtonDisabled).toBe(true);
  });

  it("allows the same cancel-and-switch entrypoint while final verification is active", () => {
    const state = getIterationModeSwitchControlState({
      currentMode: "spec",
      flags: {
        isExecutingSpec: false,
        isGeneratingSpec: false,
        isRevisingSpec: false,
        isSwitchingIterationMode: false,
        isVerifyingSpec: true,
      },
      specStatus: "verifying",
    });

    expect(state.chatButtonDisabled).toBe(false);
    expect(state.switchToChatDisabled).toBe(false);
  });

  it("blocks mode changes during revision, generation, and an in-flight mode switch", () => {
    for (const busyFlag of [
      "isGeneratingSpec",
      "isRevisingSpec",
      "isSwitchingIterationMode",
    ] as const) {
      const state = getIterationModeSwitchControlState({
        currentMode: "spec",
        flags: {
          isExecutingSpec: false,
          isGeneratingSpec: false,
          isRevisingSpec: false,
          isSwitchingIterationMode: false,
          isVerifyingSpec: false,
          [busyFlag]: true,
        },
        specStatus: "review",
      });

      expect(state.chatButtonDisabled).toBe(true);
      expect(state.switchToChatDisabled).toBe(true);
    }
  });

  it("keeps chat to spec disabled while any Spec workflow is busy", () => {
    const state = getIterationModeSwitchControlState({
      currentMode: "chat",
      flags: {
        isExecutingSpec: false,
        isGeneratingSpec: true,
        isRevisingSpec: false,
        isSwitchingIterationMode: false,
        isVerifyingSpec: false,
      },
      specStatus: null,
    });

    expect(state.specButtonDisabled).toBe(true);
    expect(state.generateSpecDisabled).toBe(true);
  });
});
