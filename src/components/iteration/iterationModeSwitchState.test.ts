import { describe, expect, it } from "vitest";
import {
  getIterationModeSwitchControlState,
  getSwitchToChatDialogDescription,
} from "./iterationModeSwitchState";

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

  it("keeps the safe-boundary cancel entrypoint enabled during final verification", () => {
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

  it("allows a persisted verifying Spec to request safe-boundary cancellation", () => {
    const state = getIterationModeSwitchControlState({
      currentMode: "spec",
      flags: {
        isExecutingSpec: false,
        isGeneratingSpec: false,
        isRevisingSpec: false,
        isSwitchingIterationMode: false,
        isVerifyingSpec: false,
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

  it("describes terminal Spec switches without implying cancellation", () => {
    expect(getSwitchToChatDialogDescription("completed")).toBe(
      "The current Spec result will stay unchanged and remain available in history.",
    );
    expect(getSwitchToChatDialogDescription("failed")).toBe(
      "The current Spec result will stay unchanged and remain available in history.",
    );
  });

  it("describes execution and review Spec switches distinctly", () => {
    expect(getSwitchToChatDialogDescription("building")).toBe(
      "The current AgentRun will be cancelled. Files already written will not be rolled back.",
    );
    expect(getSwitchToChatDialogDescription("verifying")).toBe(
      "The current verification command may finish before switching. No further verification step will start.",
    );
    expect(getSwitchToChatDialogDescription("review")).toBe(
      "The current unexecuted Spec will be cancelled and kept in history.",
    );
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
