import { FormEvent, useState } from "react";
import { Loader2, SendHorizontal } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import type { ConfiguredModelOption } from "../../App";
import {
  getAiProviderDefinition,
  type AiProviderId,
} from "../../services/aiProviders";

type ChatPanelProps = {
  activeProvider: AiProviderId;
  activeModel: string;
  configuredModelOptions: ConfiguredModelOption[];
  isSavingModel: boolean;
  onChangeModel: (selection: ConfiguredModelOption) => Promise<void>;
};

export function ChatPanel({
  activeProvider,
  activeModel,
  configuredModelOptions,
  isSavingModel,
  onChangeModel,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);
  const chatMessages = useAppStore((state) => state.chatMessages);
  const isGeneratingProject = useAppStore((state) => state.isGeneratingProject);
  const isModifyingProject = useAppStore((state) => state.isModifyingProject);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const isBusy = isGeneratingProject || isModifyingProject;
  const provider = getAiProviderDefinition(activeProvider);
  const activeSelection = { provider: activeProvider, model: activeModel };
  const availableModelOptions =
    configuredModelOptions.length > 0
      ? configuredModelOptions
      : [activeSelection];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
    setDraft("");
  }

  async function handleChangeModel(selection: ConfiguredModelOption) {
    setModelError(null);

    try {
      await onChangeModel(selection);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save model.";
      setModelError(message);
    }
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-[#0d0d10]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-zinc-800 px-5 py-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Chat</h2>
          <p className="text-xs text-zinc-500">Frontend vibe coding workspace</p>
        </div>
        <div className="flex min-w-0 flex-col items-end gap-1">
          <label className="sr-only" htmlFor="chat-model-select">
            {provider.label} model
          </label>
          <div className="flex items-center gap-2">
            {isSavingModel ? (
              <Loader2
                size={14}
                className="animate-spin text-blue-200"
                aria-hidden="true"
              />
            ) : null}
            <select
              className="h-9 min-w-44 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-xs font-medium text-zinc-200 outline-none transition hover:border-zinc-700 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10 disabled:cursor-not-allowed disabled:text-zinc-600"
              disabled={isSavingModel || isBusy}
              id="chat-model-select"
              onChange={(event) => {
                const selection = decodeModelSelection(
                  event.currentTarget.value,
                );
                void handleChangeModel(selection);
              }}
              value={encodeModelSelection(activeSelection)}
            >
              {availableModelOptions.map((selection) => {
                const selectionProvider = getAiProviderDefinition(
                  selection.provider,
                );
                const option = selectionProvider.modelOptions.find(
                  (modelOption) => modelOption.value === selection.model,
                );

                return (
                  <option
                    key={encodeModelSelection(selection)}
                    value={encodeModelSelection(selection)}
                  >
                    {option
                      ? `${selectionProvider.label} / ${option.label} (${selection.model})`
                      : `${selectionProvider.label} / ${selection.model}`}
                  </option>
                );
              })}
            </select>
          </div>
          <span className="max-w-[260px] truncate text-[11px] text-zinc-600">
            {modelError ?? `${provider.label} / ${activeModel}`}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {chatMessages.map((message) => (
          <article
            className={`max-w-[86%] whitespace-pre-wrap rounded-md border px-4 py-3 text-sm leading-6 ${
              message.role === "user"
                ? "ml-auto border-teal-400/30 bg-teal-400/10 text-teal-50"
                : message.isStreaming
                  ? "border-blue-400/30 bg-blue-400/10 text-blue-100"
                  : "border-zinc-800 bg-zinc-900/70 text-zinc-300"
            }`}
            key={message.id}
          >
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              {message.role}
            </div>
            {message.content}
          </article>
        ))}
      </div>

      <form
        className="flex shrink-0 gap-3 border-t border-zinc-800 bg-zinc-950/80 p-4"
        onSubmit={handleSubmit}
      >
        <textarea
          className="h-20 min-h-20 flex-1 resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
          disabled={isBusy}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Tell the builder what to change..."
          value={draft}
        />
        <button
          className="flex h-20 w-24 shrink-0 items-center justify-center gap-2 rounded-md border border-teal-400/30 bg-teal-400/10 text-sm font-medium text-teal-100 transition hover:border-teal-300/60 hover:bg-teal-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          disabled={!draft.trim() || isBusy}
          type="submit"
        >
          {isBusy ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : (
            <SendHorizontal size={16} aria-hidden="true" />
          )}
          {isBusy ? "Writing" : "Send"}
        </button>
      </form>
    </main>
  );
}

function encodeModelSelection(selection: ConfiguredModelOption) {
  return `${selection.provider}:${selection.model}`;
}

function decodeModelSelection(value: string): ConfiguredModelOption {
  const [provider, ...modelParts] = value.split(":");

  return {
    provider: provider as AiProviderId,
    model: modelParts.join(":"),
  };
}
