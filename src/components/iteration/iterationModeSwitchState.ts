type IterationMode = "chat" | "spec";

type SwitchFlags = {
  isExecutingSpec: boolean;
  isGeneratingSpec: boolean;
  isRevisingSpec: boolean;
  isSwitchingIterationMode: boolean;
  isVerifyingSpec: boolean;
};

type SwitchStateInput = {
  currentMode: IterationMode;
  flags: SwitchFlags;
  specStatus: string | null;
};

export type IterationModeSwitchControlState = {
  anyBusy: boolean;
  chatButtonDisabled: boolean;
  generateSpecDisabled: boolean;
  specButtonDisabled: boolean;
  switchToChatDisabled: boolean;
};

export function getIterationModeSwitchControlState({
  currentMode,
  flags,
  specStatus,
}: SwitchStateInput): IterationModeSwitchControlState {
  const anyBusy =
    flags.isGeneratingSpec ||
    flags.isRevisingSpec ||
    flags.isExecutingSpec ||
    flags.isVerifyingSpec ||
    flags.isSwitchingIterationMode;
  const nonCancellableBusy =
    flags.isGeneratingSpec ||
    flags.isRevisingSpec ||
    flags.isSwitchingIterationMode;
  const canOpenCancelSwitch =
    currentMode === "spec" && isSpecExecutionStatus(specStatus);
  const executionBusy = flags.isExecutingSpec || flags.isVerifyingSpec;

  return {
    anyBusy,
    chatButtonDisabled:
      currentMode === "chat" ||
      nonCancellableBusy ||
      (executionBusy && !canOpenCancelSwitch),
    generateSpecDisabled: anyBusy,
    specButtonDisabled: currentMode === "spec" || anyBusy,
    switchToChatDisabled: nonCancellableBusy,
  };
}

export function isSpecExecutionStatus(status: string | null) {
  return status === "approved" || status === "building" || status === "verifying";
}
