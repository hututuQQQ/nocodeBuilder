import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Database,
  FileText,
  Loader2,
  MonitorPlay,
  SendHorizontal,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";
import type { ChatActivity, ChatMessage } from "../../store/chatMessages";
import { formatElapsedTime } from "../../store/commandLogs";
import type { ConfiguredModelOption } from "../../App";
import {
  getAiProviderDefinition,
  type AiProviderId,
} from "../../services/aiProviders";
import { IterationModeSwitch } from "../iteration/IterationModeSwitch";
import { AgentRunPanel } from "./AgentRunPanel";

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
  const [now, setNow] = useState(Date.now());
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const chatMessages = useAppStore((state) => state.chatMessages);
  const currentConversation = useAppStore(
    (state) => state.currentConversation,
  );
  const currentProject = useAppStore((state) => state.currentProject);
  const historicalSpecs = useAppStore((state) => state.historicalSpecs);
  const isCreatingConversation = useAppStore(
    (state) => state.isCreatingConversation,
  );
  const isGeneratingProject = useAppStore((state) => state.isGeneratingProject);
  const isGeneratingSpec = useAppStore((state) => state.isGeneratingSpec);
  const isExecutingSpec = useAppStore((state) => state.isExecutingSpec);
  const isLoadingConversations = useAppStore(
    (state) => state.isLoadingConversations,
  );
  const isModifyingProject = useAppStore((state) => state.isModifyingProject);
  const isRevisingSpec = useAppStore((state) => state.isRevisingSpec);
  const isSwitchingIterationMode = useAppStore(
    (state) => state.isSwitchingIterationMode,
  );
  const isVerifyingSpec = useAppStore((state) => state.isVerifyingSpec);
  const currentAgentRun = useAppStore((state) => state.currentAgentRun);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const isBusy =
    isGeneratingProject ||
    isModifyingProject ||
    isCreatingConversation ||
    isGeneratingSpec ||
    isRevisingSpec ||
    isExecutingSpec ||
    isVerifyingSpec ||
    isLoadingConversations ||
    isSwitchingIterationMode;
  const canSteerActiveRun = Boolean(
    currentAgentRun && !isTerminalAgentRun(currentAgentRun.status),
  );
  const isArchived = Boolean(currentConversation?.archivedAt);
  const canChat = Boolean(currentProject && currentConversation && !isArchived);
  const canSend =
    canChat && Boolean(draft.trim()) && (!isBusy || canSteerActiveRun);
  const provider = getAiProviderDefinition(activeProvider);
  const activeSelection = { provider: activeProvider, model: activeModel };
  const availableModelOptions =
    configuredModelOptions.length > 0
      ? configuredModelOptions
      : [activeSelection];

  const hasRunningActivity = chatMessages.some((message) =>
    message.activities?.some((activity) => activity.status === "running"),
  );

  useEffect(() => {
    if (!hasRunningActivity) {
      return;
    }

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(intervalId);
  }, [hasRunningActivity]);

  useEffect(() => {
    if (shouldStickToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [chatMessages]);

  function handleMessageScroll() {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 80;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitDraft();
  }

  function submitDraft() {
    if (!canSend) {
      return;
    }

    void sendMessage(draft);
    setDraft("");
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();
    submitDraft();
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
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-100">
            {currentProject
              ? currentConversation?.title ?? "Chat"
              : "No project selected"}
          </h2>
          <p className="truncate text-xs text-zinc-500">
            {currentProject
              ? `${currentProject.name}${isArchived ? " / archived" : ""}`
              : "Create or select a project to start a chat"}
          </p>
        </div>
        <div className="flex min-w-0 flex-col items-end gap-1">
          <label className="sr-only" htmlFor="chat-model-select">
            {provider.label} model
          </label>
          <div className="flex items-center gap-2">
            <IterationModeSwitch />
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

      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
        onScroll={handleMessageScroll}
        ref={scrollContainerRef}
      >
        <AgentRunPanel />
        {currentConversation?.mode === "chat" && historicalSpecs.length > 0 ? (
          <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
              <FileText size={14} aria-hidden="true" />
              Spec History
            </div>
            <div className="mt-2 space-y-1">
              {historicalSpecs.map((spec) => (
                <div
                  className="flex min-w-0 items-center gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 text-xs"
                  key={spec.id}
                >
                  <span className="min-w-0 flex-1 truncate text-zinc-300">
                    {spec.revisions.find((revision) => revision.id === spec.currentRevisionId)?.brief ?? spec.id}
                  </span>
                  <span className="shrink-0 rounded border border-zinc-800 px-2 py-0.5 text-zinc-500">
                    {spec.status}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {!currentProject ? (
          <div className="grid h-full place-items-center">
            <div className="max-w-[320px] rounded-md border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-sm leading-6 text-zinc-500">
              Create or select a project to start a project-scoped chat.
            </div>
          </div>
        ) : isLoadingConversations && !currentConversation ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            Loading chats
          </div>
        ) : chatMessages.length === 0 ? (
          <div className="grid h-full place-items-center">
            <div className="max-w-[320px] rounded-md border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-sm leading-6 text-zinc-500">
              This chat is empty.
            </div>
          </div>
        ) : (
          chatMessages.map((message) =>
            message.role === "user" ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage key={message.id} message={message} now={now} />
            ),
          )
        )}
        <div ref={messagesEndRef} />
      </div>

      <form
        className="flex shrink-0 gap-3 border-t border-zinc-800 bg-zinc-950/80 p-4"
        onSubmit={handleSubmit}
      >
        <textarea
          className="h-20 min-h-20 flex-1 resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
          disabled={!canChat || (isBusy && !canSteerActiveRun)}
          onKeyDown={handleDraftKeyDown}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={
            !currentProject
              ? "Select a project first"
              : isArchived
                ? "Restore this chat to continue"
                : canSteerActiveRun
                  ? "Add steering for the current run..."
                  : "Tell the builder what to change..."
          }
          value={draft}
        />
        <button
          className="flex h-20 w-24 shrink-0 items-center justify-center gap-2 rounded-md border border-teal-400/30 bg-teal-400/10 text-sm font-medium text-teal-100 transition hover:border-teal-300/60 hover:bg-teal-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          disabled={!canSend}
          type="submit"
        >
          {isBusy ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : (
            <SendHorizontal size={16} aria-hidden="true" />
          )}
          {isBusy && canSteerActiveRun ? "Steer" : isBusy ? "Writing" : "Send"}
        </button>
      </form>
    </main>
  );
}

function isTerminalAgentRun(status: string) {
  return ["completed", "failed", "cancelled", "budget_exceeded"].includes(status);
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

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <article className="ml-auto max-w-[86%] whitespace-pre-wrap rounded-md border border-teal-400/30 bg-teal-400/10 px-4 py-3 text-sm leading-6 text-teal-50">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-teal-200/70">
        user
      </div>
      {message.content}
    </article>
  );
}

function AssistantMessage({
  message,
  now,
}: {
  message: ChatMessage;
  now: number;
}) {
  const hasContent = message.content.trim().length > 0;
  const [isExpanded, setIsExpanded] = useState(!message.activitiesCollapsed);
  const shouldCollapseContent = shouldCollapseAssistantContent(message);
  const [isContentExpanded, setIsContentExpanded] = useState(
    !shouldCollapseContent,
  );
  const isContentCollapsed = shouldCollapseContent && !isContentExpanded;
  const displayedContent = isContentCollapsed
    ? formatCollapsedAssistantContent(message.content, Boolean(message.isStreaming))
    : message.content;
  const activities = message.activities ?? [];
  const shouldShowActivitySummary =
    activities.length > 0 && message.activitiesCollapsed;
  const visibleActivities =
    message.activitiesCollapsed && !isExpanded ? [] : activities;

  useEffect(() => {
    if (message.activitiesCollapsed) {
      setIsExpanded(false);
    }
  }, [message.activitiesCollapsed, message.id]);

  useEffect(() => {
    setIsContentExpanded(!shouldCollapseContent);
  }, [message.id, shouldCollapseContent]);

  return (
    <article className="max-w-[92%] text-sm leading-6 text-zinc-300">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
        <Bot size={14} aria-hidden="true" />
        assistant
      </div>
      {shouldShowActivitySummary ? (
        <button
          className="mb-2 flex w-full max-w-full items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-left text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
          onClick={() => setIsExpanded((current) => !current)}
          type="button"
        >
          {isExpanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className="truncate">
            Process: {message.activitySummary ?? summarizeChatActivities(activities)}
          </span>
        </button>
      ) : null}
      {visibleActivities.length > 0 ? (
        <div className="space-y-2">
          {visibleActivities.map((activity) => (
            <ActivityRow activity={activity} key={activity.id} now={now} />
          ))}
        </div>
      ) : null}
      {hasContent ? (
        <div
          className={`relative mt-3 whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-900/70 px-4 py-3 ${
            isContentCollapsed ? "max-h-44 overflow-hidden" : ""
          }`}
        >
          <TypewriterText
            active={Boolean(message.animateContent)}
            text={displayedContent}
          />
          {isContentCollapsed ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-zinc-900 to-transparent" />
          ) : null}
        </div>
      ) : message.isStreaming && !message.activities?.length ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-blue-400/30 bg-blue-400/10 px-4 py-3 text-blue-100">
          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          Working
        </div>
      ) : null}
      {hasContent && shouldCollapseContent ? (
        <button
          className="mt-2 flex w-full max-w-full items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-left text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
          onClick={() => setIsContentExpanded((current) => !current)}
          type="button"
        >
          {message.isStreaming ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : isContentExpanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className="truncate">
            {isContentExpanded
              ? "Collapse generated output"
              : summarizeAssistantContent(message.content)}
          </span>
        </button>
      ) : null}
    </article>
  );
}

function shouldCollapseAssistantContent(message: ChatMessage) {
  if (!message.content.trim()) {
    return false;
  }

  const lineCount = countContentLines(message.content);

  return (
    message.isStreaming ||
    message.content.length > 1200 ||
    lineCount > 18 ||
    message.content.includes("Changed files:") ||
    message.content.includes("Diff preview:") ||
    /^[-+]{3} [ab]\//m.test(message.content) ||
    /```/.test(message.content)
  );
}

function summarizeAssistantContent(content: string) {
  const lineCount = countContentLines(content);
  const charCount = content.length.toLocaleString();

  return `Generated output: ${lineCount.toLocaleString()} line${
    lineCount === 1 ? "" : "s"
  }, ${charCount} chars`;
}

function formatCollapsedAssistantContent(content: string, isStreaming: boolean) {
  if (!isStreaming) {
    return trimCollapsedContentHead(content);
  }

  const latest = trimCollapsedContentTail(content);

  if (latest === content) {
    return latest;
  }

  return [
    "[Streaming latest output]",
    latest,
  ].join("\n");
}

function trimCollapsedContentHead(content: string) {
  const maxChars = 2_400;

  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n\n[Output continues. Expand to view all.]`;
}

function trimCollapsedContentTail(content: string) {
  const maxChars = 2_800;

  if (content.length <= maxChars) {
    return content;
  }

  return content.slice(-maxChars);
}

function countContentLines(content: string) {
  return Math.max(1, content.split(/\r?\n/).length);
}

function summarizeChatActivities(activities: ChatActivity[]) {
  const visibleActivities = activities.filter(
    (activity) => activity.kind !== "thinking",
  );
  const failedCount = visibleActivities.filter(
    (activity) => activity.status === "failed",
  ).length;
  const parts = [`${visibleActivities.length} step(s)`];

  if (failedCount > 0) {
    parts.push(`${failedCount} failed`);
  }

  return parts.join(", ");
}

function ActivityRow({
  activity,
  now,
}: {
  activity: ChatActivity;
  now: number;
}) {
  const elapsedMs = getActivityElapsedMs(activity, now);
  const elapsedText = formatElapsedTime(elapsedMs);
  const preview = activity.outputPreview ?? [];
  const statusTone =
    activity.status === "failed"
      ? "text-red-300"
      : activity.status === "succeeded"
        ? "text-emerald-300"
        : "text-blue-300";

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400">
          <ActivityKindIcon activity={activity} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-zinc-100">
              {activity.title}
            </span>
            <span className={`ml-auto flex shrink-0 items-center gap-1 text-xs ${statusTone}`}>
              <ActivityStatusIcon status={activity.status} />
              {formatActivityStatus(activity.status)}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
            {activity.command ? (
              <code className="max-w-full truncate rounded bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-300">
                {activity.command}
              </code>
            ) : null}
            {elapsedText ? <span>{elapsedText}</span> : null}
          </div>
          {activity.detail ? (
            <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-400">
              {activity.detail}
            </p>
          ) : null}
          {activity.error ? (
            <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-red-300">
              {activity.error}
            </p>
          ) : null}
          {preview.length > 0 ? (
            <details className="mt-2 text-xs text-zinc-500">
              <summary className="cursor-pointer select-none text-zinc-400 outline-none">
                Output preview
                {activity.outputLineCount
                  ? ` (${activity.outputLineCount.toLocaleString()} line${
                      activity.outputLineCount === 1 ? "" : "s"
                    })`
                  : ""}
              </summary>
              <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-zinc-800 bg-[#08080a] p-2 font-mono text-[11px] leading-5 text-zinc-400">
                {preview.join("\n")}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActivityKindIcon({ activity }: { activity: ChatActivity }) {
  if (activity.kind === "thinking") {
    return <Brain size={15} aria-hidden="true" />;
  }

  if (activity.kind === "command") {
    return <TerminalSquare size={15} aria-hidden="true" />;
  }

  if (activity.kind === "file") {
    return <FileText size={15} aria-hidden="true" />;
  }

  if (activity.kind === "database") {
    return <Database size={15} aria-hidden="true" />;
  }

  if (activity.kind === "preview") {
    return <MonitorPlay size={15} aria-hidden="true" />;
  }

  if (activity.kind === "verification") {
    return <CheckCircle2 size={15} aria-hidden="true" />;
  }

  return <Wrench size={15} aria-hidden="true" />;
}

function ActivityStatusIcon({
  status,
}: {
  status: ChatActivity["status"];
}) {
  if (status === "failed") {
    return <XCircle size={13} aria-hidden="true" />;
  }

  if (status === "succeeded") {
    return <CheckCircle2 size={13} aria-hidden="true" />;
  }

  return <CircleDashed size={13} className="animate-spin" aria-hidden="true" />;
}

function formatActivityStatus(status: ChatActivity["status"]) {
  if (status === "failed") {
    return "Failed";
  }

  if (status === "succeeded") {
    return "Done";
  }

  if (status === "pending") {
    return "Queued";
  }

  return "Running";
}

function getActivityElapsedMs(activity: ChatActivity, now: number) {
  if (typeof activity.elapsedMs === "number") {
    return activity.elapsedMs;
  }

  if (activity.status !== "running" || !activity.startedAt) {
    return undefined;
  }

  const startedAt = new Date(activity.startedAt).getTime();

  if (!Number.isFinite(startedAt)) {
    return undefined;
  }

  return Math.max(0, now - startedAt);
}

function TypewriterText({
  active,
  text,
}: {
  active: boolean;
  text: string;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [visibleText, setVisibleText] = useState(
    active && !prefersReducedMotion ? "" : text,
  );

  useEffect(() => {
    if (!active || prefersReducedMotion) {
      setVisibleText(text);
      return;
    }

    const characters = Array.from(text);
    const step = Math.max(1, Math.ceil(characters.length / 90));
    let index = 0;
    setVisibleText("");

    const intervalId = window.setInterval(() => {
      index = Math.min(characters.length, index + step);
      setVisibleText(characters.slice(0, index).join(""));

      if (index >= characters.length) {
        window.clearInterval(intervalId);
      }
    }, 16);

    return () => window.clearInterval(intervalId);
  }, [active, prefersReducedMotion, text]);

  return <>{visibleText}</>;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    function handleChange(event: MediaQueryListEvent) {
      setPrefersReducedMotion(event.matches);
    }

    mediaQuery.addEventListener("change", handleChange);

    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return prefersReducedMotion;
}
