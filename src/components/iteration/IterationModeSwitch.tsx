import { FormEvent, useState } from "react";
import { FileText, Loader2, MessageSquare, X } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import {
  getIterationModeSwitchControlState,
  getSwitchToChatDialogDescription,
  isCancellableSpecExecutionStatus,
} from "./iterationModeSwitchState";

export function IterationModeSwitch() {
  const [dialog, setDialog] = useState<"to-spec" | "to-chat" | null>(null);
  const [brief, setBrief] = useState("");
  const currentConversation = useAppStore((state) => state.currentConversation);
  const currentSpec = useAppStore((state) => state.currentSpec);
  const isExecutingSpecAction = useAppStore((state) => state.isExecutingSpec);
  const isGeneratingSpec = useAppStore((state) => state.isGeneratingSpec);
  const isRevisingSpec = useAppStore((state) => state.isRevisingSpec);
  const isSwitchingIterationMode = useAppStore(
    (state) => state.isSwitchingIterationMode,
  );
  const isVerifyingSpec = useAppStore((state) => state.isVerifyingSpec);
  const switchCurrentIterationToChat = useAppStore(
    (state) => state.switchCurrentIterationToChat,
  );
  const switchCurrentIterationToSpec = useAppStore(
    (state) => state.switchCurrentIterationToSpec,
  );
  const switchingExecutingSpec = isCancellableSpecExecutionStatus(
    currentSpec?.status ?? null,
  );
  const switchingVerifyingSpec = currentSpec?.status === "verifying";
  const switchToChatDescription = getSwitchToChatDialogDescription(
    currentSpec?.status ?? null,
  );

  if (!currentConversation) {
    return null;
  }

  if (currentConversation.kind === "initial_build") {
    return (
      <span className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-800 px-2.5 text-xs font-medium text-zinc-400">
        <FileText size={13} aria-hidden="true" />
        Spec · Locked
      </span>
    );
  }

  const controlState = getIterationModeSwitchControlState({
    currentMode: currentConversation.mode,
    flags: {
      isExecutingSpec: isExecutingSpecAction,
      isGeneratingSpec,
      isRevisingSpec,
      isSwitchingIterationMode,
      isVerifyingSpec,
    },
    specStatus: currentSpec?.status ?? null,
  });

  async function submitSwitchToSpec(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!brief.trim()) {
      return;
    }

    await switchCurrentIterationToSpec(brief);
    setBrief("");
    setDialog(null);
  }

  async function submitSwitchToChat(cancelActiveSpec: boolean) {
    await switchCurrentIterationToChat({ cancelActiveSpec });
    setDialog(null);
  }

  return (
    <>
      <div className="inline-flex h-8 shrink-0 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
        <button
          className={`flex items-center gap-1.5 px-2.5 text-xs font-medium transition disabled:cursor-not-allowed ${
            currentConversation.mode === "chat"
              ? "bg-teal-400/15 text-teal-100"
              : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
          disabled={controlState.chatButtonDisabled}
          onClick={() => setDialog("to-chat")}
          type="button"
        >
          <MessageSquare size={13} aria-hidden="true" />
          Chat
        </button>
        <button
          className={`flex items-center gap-1.5 border-l border-zinc-800 px-2.5 text-xs font-medium transition disabled:cursor-not-allowed ${
            currentConversation.mode === "spec"
              ? "bg-blue-400/15 text-blue-100"
              : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
          disabled={controlState.specButtonDisabled}
          onClick={() => setDialog("to-spec")}
          type="button"
        >
          {controlState.anyBusy && currentConversation.mode === "chat" ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <FileText size={13} aria-hidden="true" />
          )}
          Spec
        </button>
      </div>

      {dialog === "to-spec" ? (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/60 px-4">
          <form
            className="w-full max-w-[420px] rounded-md border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
            onSubmit={submitSwitchToSpec}
          >
            <DialogTitle onClose={() => setDialog(null)}>
              Switch to Spec Coding
            </DialogTitle>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              The builder will generate requirements, design, and tasks from the current project state. Project files will not change before approval.
            </p>
            <label className="mt-4 block text-xs font-medium text-zinc-400">
              Brief
              <textarea
                autoFocus
                className="mt-2 h-28 min-h-28 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-3 text-sm leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
                onChange={(event) => setBrief(event.currentTarget.value)}
                placeholder="Describe the next feature or change"
                value={brief}
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
                onClick={() => setDialog(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="flex h-9 items-center gap-2 rounded-md border border-blue-400/30 bg-blue-400/10 px-3 text-sm font-medium text-blue-100 transition hover:border-blue-300/60 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                disabled={!brief.trim() || controlState.generateSpecDisabled}
                type="submit"
              >
                {controlState.anyBusy ? (
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <FileText size={15} aria-hidden="true" />
                )}
                Generate Spec
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {dialog === "to-chat" ? (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/60 px-4">
          <div className="w-full max-w-[420px] rounded-md border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
            <DialogTitle onClose={() => setDialog(null)}>
              {switchingVerifyingSpec
                ? "Cancel verification and switch to Chat"
                : switchingExecutingSpec
                  ? "Cancel Spec and switch to Chat"
                  : "Switch to Chat"}
            </DialogTitle>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              {switchToChatDescription}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
                onClick={() => setDialog(null)}
                type="button"
              >
                Back
              </button>
              <button
                className="flex h-9 items-center gap-2 rounded-md border border-teal-400/30 bg-teal-400/10 px-3 text-sm font-medium text-teal-100 transition hover:border-teal-300/60 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                disabled={controlState.switchToChatDisabled}
                onClick={() => void submitSwitchToChat(switchingExecutingSpec)}
                type="button"
              >
                {controlState.switchToChatDisabled ? (
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <MessageSquare size={15} aria-hidden="true" />
                )}
                {switchingVerifyingSpec
                  ? "Cancel verification and switch"
                  : switchingExecutingSpec
                    ? "Cancel execution and switch"
                    : "Switch to Chat"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function DialogTitle({
  children,
  onClose,
}: {
  children: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-zinc-100">{children}</h2>
      <button
        aria-label="Close"
        className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
        onClick={onClose}
        type="button"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
