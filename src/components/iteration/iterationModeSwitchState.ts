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
    flags.isVerifyingSpec ||
    flags.isSwitchingIterationMode;
  const canOpenCancelSwitch =
    currentMode === "spec" && isCancellableSpecExecutionStatus(specStatus);
  const executionBusy = flags.isExecutingSpec;
  const verifyingLocked = specStatus === "verifying";

  return {
    anyBusy,
    chatButtonDisabled:
      currentMode === "chat" ||
      nonCancellableBusy ||
      verifyingLocked ||
      (executionBusy && !canOpenCancelSwitch),
    generateSpecDisabled: anyBusy,
    specButtonDisabled: currentMode === "spec" || anyBusy,
    switchToChatDisabled: nonCancellableBusy || verifyingLocked,
  };
}

export function isSpecExecutionStatus(status: string | null) {
  return status === "approved" || status === "building" || status === "verifying";
}

export function isCancellableSpecExecutionStatus(status: string | null) {
  return status === "approved" || status === "building";
}

export function getSwitchToChatDialogDescription(specStatus: string | null) {
  if (specStatus === "verifying") {
    return "Final verification is running. Wait for the result before switching modes.";
  }

  if (isSpecExecutionStatus(specStatus)) {
    return "The current AgentRun will be cancelled. Files already written will not be rolled back.";
  }

  if (isTerminalSpecStatus(specStatus)) {
    return "The current Spec result will stay unchanged and remain available in history.";
  }

  return "The current unexecuted Spec will be cancelled and kept in history.";
}

export function isTerminalSpecStatus(status: string | null) {
  return status === "completed" || status === "failed" || status === "cancelled";
}
