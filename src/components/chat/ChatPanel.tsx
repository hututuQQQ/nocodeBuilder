import { FormEvent, useState } from "react";
import { Loader2, SendHorizontal } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import {
  DEEPSEEK_MODEL_OPTIONS,
  DeepSeekModel,
} from "../../services/keyStore";

type ChatPanelProps = {
  activeModel: DeepSeekModel;
  isSavingModel: boolean;
  onChangeModel: (model: DeepSeekModel) => Promise<void>;
};

export function ChatPanel({
  activeModel,
  isSavingModel,
  onChangeModel,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);
  const chatMessages = useAppStore((state) => state.chatMessages);
  const isModifyingProject = useAppStore((state) => state.isModifyingProject);
  const sendMessage = useAppStore((state) => state.sendMessage);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
    setDraft("");
  }

  async function handleChangeModel(model: DeepSeekModel) {
    setModelError(null);

    try {
      await onChangeModel(model);
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
          <div
            aria-label="DeepSeek model"
            className="grid grid-cols-2 rounded-md border border-zinc-800 bg-zinc-950 p-1"
            role="group"
          >
            {DEEPSEEK_MODEL_OPTIONS.map((option) => {
              const isSelected = activeModel === option.value;

              return (
                <button
                  aria-pressed={isSelected}
                  className={`h-8 min-w-20 rounded px-3 text-xs font-medium transition ${
                    isSelected
                      ? "bg-blue-500/15 text-blue-100 ring-1 ring-blue-400/35"
                      : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                  }`}
                  disabled={isSavingModel || isModifyingProject}
                  key={option.value}
                  onClick={() => void handleChangeModel(option.value)}
                  title={`${option.value}: ${option.description}`}
                  type="button"
                >
                  {isSavingModel && isSelected ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2
                        size={12}
                        className="animate-spin"
                        aria-hidden="true"
                      />
                      {option.label}
                    </span>
                  ) : (
                    option.label
                  )}
                </button>
              );
            })}
          </div>
          <span className="max-w-[260px] truncate text-[11px] text-zinc-600">
            {modelError ?? activeModel}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {chatMessages.map((message) => (
          <article
            className={`max-w-[86%] rounded-md border px-4 py-3 text-sm leading-6 ${
              message.role === "user"
                ? "ml-auto border-teal-400/30 bg-teal-400/10 text-teal-50"
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
          disabled={isModifyingProject}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Tell the builder what to change..."
          value={draft}
        />
        <button
          className="flex h-20 w-24 shrink-0 items-center justify-center gap-2 rounded-md border border-teal-400/30 bg-teal-400/10 text-sm font-medium text-teal-100 transition hover:border-teal-300/60 hover:bg-teal-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          disabled={!draft.trim() || isModifyingProject}
          type="submit"
        >
          {isModifyingProject ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : (
            <SendHorizontal size={16} aria-hidden="true" />
          )}
          {isModifyingProject ? "Writing" : "Send"}
        </button>
      </form>
    </main>
  );
}
