import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Bot,
  CheckCircle2,
  FileText,
  History,
  Loader2,
  MessageSquareText,
  RefreshCcw,
  SendHorizontal,
  ShieldCheck,
  UserRound,
  XCircle,
} from "lucide-react";
import type { ConfiguredModelOption } from "../../App";
import { useI18n } from "../../i18n";
import {
  getAiProviderDefinition,
  type AiProviderId,
} from "../../services/aiProviders";
import type { AgentApproval, AgentRun } from "../../agent-core/types";
import { useAppStore } from "../../store/appStore";
import type { ChatMessage } from "../../store/chatMessages";
import type {
  DevelopmentSpec,
  SpecAcceptanceResult,
  SpecRevision,
  SpecTask,
} from "../../spec-core/types";
import {
  canRetrySpecVerification,
  computePersistedAcceptanceResults,
  getCurrentSpecRevision,
} from "../../spec-core/validators";
import { AgentRunPanel } from "../chat/AgentRunPanel";
import { IterationModeSwitch } from "../iteration/IterationModeSwitch";

type SpecPanelProps = {
  activeProvider: AiProviderId;
  activeModel: string;
  configuredModelOptions: ConfiguredModelOption[];
  isSavingModel: boolean;
  onChangeModel: (selection: ConfiguredModelOption) => Promise<void>;
};

export function SpecPanel({
  activeProvider,
  activeModel,
  configuredModelOptions,
  isSavingModel,
  onChangeModel,
}: SpecPanelProps) {
  const { t } = useI18n();
  const [feedback, setFeedback] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);
  const chatMessages = useAppStore((state) => state.chatMessages);
  const currentProject = useAppStore((state) => state.currentProject);
  const currentConversation = useAppStore((state) => state.currentConversation);
  const currentAgentApproval = useAppStore(
    (state) => state.currentAgentApproval,
  );
  const currentAgentRun = useAppStore((state) => state.currentAgentRun);
  const agentRuns = useAppStore((state) => state.agentRuns);
  const currentSpec = useAppStore((state) => state.currentSpec);
  const historicalSpecs = useAppStore((state) => state.historicalSpecs);
  const isLoadingSpec = useAppStore((state) => state.isLoadingSpec);
  const isGeneratingSpec = useAppStore((state) => state.isGeneratingSpec);
  const isRevisingSpec = useAppStore((state) => state.isRevisingSpec);
  const isExecutingSpec = useAppStore((state) => state.isExecutingSpec);
  const isSwitchingIterationMode = useAppStore(
    (state) => state.isSwitchingIterationMode,
  );
  const isVerifyingSpec = useAppStore((state) => state.isVerifyingSpec);
  const reviseCurrentSpec = useAppStore((state) => state.reviseCurrentSpec);
  const approveAndExecuteCurrentSpec = useAppStore(
    (state) => state.approveAndExecuteCurrentSpec,
  );
  const approveCurrentAgentApproval = useAppStore(
    (state) => state.approveCurrentAgentApproval,
  );
  const denyCurrentAgentApproval = useAppStore(
    (state) => state.denyCurrentAgentApproval,
  );
  const retrySpecTask = useAppStore((state) => state.retrySpecTask);
  const retrySpecVerification = useAppStore(
    (state) => state.retrySpecVerification,
  );
  const sendMessage = useAppStore((state) => state.sendMessage);
  const provider = getAiProviderDefinition(activeProvider);
  const activeSelection = { provider: activeProvider, model: activeModel };
  const availableModelOptions =
    configuredModelOptions.length > 0
      ? configuredModelOptions
      : [activeSelection];
  const revision = currentSpec ? safeCurrentRevision(currentSpec) : null;
  const busy =
    isLoadingSpec ||
    isGeneratingSpec ||
    isRevisingSpec ||
    isExecutingSpec ||
    isVerifyingSpec ||
    isSwitchingIterationMode;
  const canSteerActiveRun = Boolean(
    currentAgentRun && !isTerminalAgentRun(currentAgentRun.status),
  );
  const canUseChat = canUseSpecChat({
    canSteerActiveRun,
    hasConversation: Boolean(currentConversation),
    hasProject: Boolean(currentProject),
    isArchived: Boolean(currentConversation?.archivedAt),
    isBusy: busy,
  });
  const canSendChat = canSendSpecChatMessage({
    canSteerActiveRun,
    draft: chatDraft,
    hasConversation: Boolean(currentConversation),
    hasProject: Boolean(currentProject),
    isArchived: Boolean(currentConversation?.archivedAt),
    isBusy: busy,
  });
  const pendingSpecApproval = shouldShowSpecApprovalNotice({
    approval: currentAgentApproval,
    conversation: currentConversation,
    run: currentAgentRun,
    spec: currentSpec,
  })
    ? currentAgentApproval
    : null;

  async function handleChangeModel(selection: ConfiguredModelOption) {
    setModelError(null);

    try {
      await onChangeModel(selection);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : t("model.saveFailed"));
    }
  }

  async function submitRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!feedback.trim()) {
      return;
    }

    const revisionCreated = await reviseCurrentSpec(feedback);

    if (revisionCreated) {
      setFeedback("");
    }
  }

  function submitChat() {
    if (!canSendChat) {
      return;
    }

    void sendMessage(chatDraft);
    setChatDraft("");
  }

  function handleChatSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitChat();
  }

  function handleChatKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();
    submitChat();
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-[#0d0d10]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-zinc-800 px-5 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-100">
            {currentConversation?.title ?? t("sidebar.spec")}
          </h2>
          <p className="truncate text-xs text-zinc-500">
            {currentProject
              ? `${currentProject.name} / ${currentSpec?.status ?? t("spec.statusLoading")}`
              : t("chat.noProjectSelected")}
          </p>
        </div>
        <div className="flex min-w-0 flex-col items-end gap-1">
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
              disabled={isSavingModel || busy}
              onChange={(event) => {
                void handleChangeModel(decodeModelSelection(event.currentTarget.value));
              }}
              value={encodeModelSelection(activeSelection)}
            >
              {availableModelOptions.map((selection) => {
                const selectionProvider = getAiProviderDefinition(selection.provider);
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

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {isLoadingSpec && !currentSpec ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            {t("spec.loading")}
          </div>
        ) : !currentSpec || !revision ? (
          <EmptySpec />
        ) : (
          <div className="mx-auto w-full max-w-5xl min-w-0 space-y-4">
            <SpecSummary
              busy={busy}
              onRetryTask={(taskId) => void retrySpecTask(taskId)}
              revision={revision}
              spec={currentSpec}
            />
            <SpecStepper status={currentSpec.status} />
            <RequirementsView revision={revision} />
            <DesignView revision={revision} />
            <SpecTaskList
              agentRuns={currentAgentRun ? [currentAgentRun, ...agentRuns] : agentRuns}
              disabled={busy}
              onRetry={(taskId) => void retrySpecTask(taskId)}
              tasks={revision.tasks}
            />
            {pendingSpecApproval ? (
              <SpecApprovalNotice
                approval={pendingSpecApproval}
                onApprove={() => void approveCurrentAgentApproval()}
                onDeny={() => void denyCurrentAgentApproval()}
              />
            ) : null}
            <ReviewActions
              busy={busy}
              feedback={feedback}
              onApprove={() => void approveAndExecuteCurrentSpec()}
              onChangeFeedback={setFeedback}
              onSubmitRevision={submitRevision}
              spec={currentSpec}
            />
            <SpecChat
              canSend={canSendChat}
              canSteerActiveRun={canSteerActiveRun}
              canUse={canUseChat}
              draft={chatDraft}
              messages={chatMessages}
              onChangeDraft={setChatDraft}
              onKeyDown={handleChatKeyDown}
              onSubmit={handleChatSubmit}
              specStatus={currentSpec.status}
            />
            <BuildView
              busy={busy}
              onRetryVerification={() => void retrySpecVerification()}
              spec={currentSpec}
              tasks={revision.tasks}
            />
            <SpecHistory
              activeSpecId={currentSpec.id}
              specs={historicalSpecs}
            />
          </div>
        )}
      </div>
    </main>
  );
}

function SpecSummary({
  busy,
  onRetryTask,
  revision,
  spec,
}: {
  busy: boolean;
  onRetryTask: (taskId: string) => void;
  revision: SpecRevision;
  spec: DevelopmentSpec;
}) {
  const { t } = useI18n();
  const retryableTask =
    spec.status === "blocked" ? findFirstRetryableSpecTask(revision.tasks) : null;
  const retryLabel =
    spec.kind === "initial_build"
      ? t("spec.retryInitialBuild")
      : t("spec.retryTask");

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-md border border-blue-400/30 bg-blue-400/10 text-blue-100">
          <FileText size={17} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-100">
              {revision.requirements.goal}
            </h3>
            <StatusBadge status={spec.status} />
            <span className="rounded border border-zinc-800 px-2 py-0.5 text-xs text-zinc-500">
              {t("spec.revision", { version: revision.version })}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">
            {revision.brief}
          </p>
          {spec.failureMessage ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-red-400/30 bg-red-400/10 px-3 py-2">
              <p className="min-w-0 flex-1 text-xs leading-5 text-red-200">
                {spec.failureMessage}
              </p>
              {retryableTask ? (
                <button
                  aria-label={`${retryLabel}: ${retryableTask.title}`}
                  className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-blue-400/30 bg-blue-400/10 px-3 text-xs font-medium text-blue-100 transition hover:border-blue-300/60 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                  disabled={busy}
                  onClick={() => onRetryTask(retryableTask.id)}
                  title={`${retryLabel}: ${retryableTask.title}`}
                  type="button"
                >
                  {busy ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCcw size={13} aria-hidden="true" />
                  )}
                  {retryLabel}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SpecStepper({ status }: { status: string }) {
  const { t } = useI18n();
  const steps = [
    { id: "requirements", label: t("spec.step.requirements") },
    { id: "design", label: t("spec.step.design") },
    { id: "tasks", label: t("spec.step.tasks") },
    { id: "build", label: t("spec.step.build") },
    { id: "verify", label: t("spec.step.verify") },
  ];
  const activeIndex = stepIndexForStatus(status);

  return (
    <div className="grid grid-cols-5 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      {steps.map((step, index) => (
        <div
          className={`flex h-10 min-w-0 items-center justify-center gap-2 border-l border-zinc-800 px-2 text-xs first:border-l-0 ${
            index <= activeIndex ? "text-blue-100" : "text-zinc-600"
          }`}
          key={step.id}
        >
          <span
            className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] ${
              index <= activeIndex
                ? "border-blue-400/50 bg-blue-400/10"
                : "border-zinc-800"
            }`}
          >
            {index + 1}
          </span>
          <span className="truncate">{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function RequirementsView({ revision }: { revision: SpecRevision }) {
  const { t } = useI18n();

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<ShieldCheck size={15} aria-hidden="true" />} title={t("spec.requirements")} />
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <ListBlock
          title={t("spec.userStories")}
          items={revision.requirements.userStories.map((story) => story.description)}
        />
        <ListBlock
          title={t("spec.acceptanceCriteria")}
          items={revision.requirements.acceptanceCriteria.map(
            (criterion) =>
              `${criterion.required ? t("common.required") : t("common.optional")}: ${criterion.description}`,
          )}
        />
        <ListBlock title={t("spec.constraints")} items={revision.requirements.constraints} />
        <ListBlock
          title={t("spec.outOfScope")}
          items={revision.requirements.outOfScope}
        />
      </div>
      {revision.requirements.unresolvedQuestions.length > 0 ? (
        <ListBlock
          className="mt-3"
          title={t("spec.unresolvedQuestions")}
          items={revision.requirements.unresolvedQuestions}
        />
      ) : null}
    </section>
  );
}

function DesignView({ revision }: { revision: SpecRevision }) {
  const { t } = useI18n();

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<FileText size={15} aria-hidden="true" />} title={t("spec.design")} />
      <p className="mt-3 text-sm leading-6 text-zinc-300">
        {revision.design.summary}
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <ListBlock
          title={t("spec.pages")}
          items={revision.design.pages.map((page) => `${page.route}: ${page.purpose}`)}
        />
        <ListBlock
          title={t("spec.components")}
          items={revision.design.components.map(
            (component) => `${component.name}: ${component.responsibility}`,
          )}
        />
        <ListBlock title={t("spec.dataModel")} items={revision.design.dataModel} />
        <ListBlock title={t("spec.integrations")} items={revision.design.integrations} />
        <ListBlock
          title={t("spec.technicalDecisions")}
          items={revision.design.technicalDecisions}
        />
        <ListBlock
          title={t("spec.verification")}
          items={revision.design.verificationStrategy}
        />
      </div>
    </section>
  );
}

function SpecTaskList({
  agentRuns,
  disabled,
  onRetry,
  tasks,
}: {
  agentRuns: AgentRun[];
  disabled: boolean;
  onRetry: (taskId: string) => void;
  tasks: SpecTask[];
}) {
  const { t } = useI18n();

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<CheckCircle2 size={15} aria-hidden="true" />} title={t("spec.step.tasks")} />
      <div className="mt-3 space-y-2">
        {tasks.map((task) => {
          const displayStatus = getSpecTaskDisplayStatus(task, agentRuns);
          const runMessage = getSpecTaskRunStatusMessage(task, displayStatus);

          return (
            <div
              className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3"
              key={task.id}
            >
              <div className="flex min-w-0 items-start gap-3">
                <StatusDot status={displayStatus} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="truncate text-sm font-medium text-zinc-100">
                      {task.title}
                    </h4>
                    <span className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">
                      {displayStatus}
                    </span>
                    {task.runId ? (
                      <span className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">
                        {task.runId.slice(0, 16)}
                      </span>
                    ) : null}
                    {formatSpecTaskAutoRetryLabel(task, t) ? (
                      <span
                        className="inline-flex items-center gap-1 rounded border border-blue-400/30 bg-blue-400/10 px-2 py-0.5 text-[11px] text-blue-100"
                        title={formatSpecTaskAutoRetryLabel(task, t) ?? undefined}
                      >
                        <RefreshCcw size={11} aria-hidden="true" />
                        {formatSpecTaskAutoRetryLabel(task, t)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-zinc-400">
                    {task.objective}
                  </p>
                  <p className="mt-2 truncate text-[11px] text-zinc-600">
                    {t("spec.paths", { paths: task.allowedPaths.join(", ") })}
                  </p>
                  {task.dependencyIds.length > 0 ? (
                    <p className="mt-1 truncate text-[11px] text-zinc-600">
                      {t("spec.dependencies", {
                        dependencies: task.dependencyIds.join(", "),
                      })}
                    </p>
                  ) : null}
                  {task.error ? (
                    <p className="mt-2 whitespace-pre-wrap rounded border border-red-400/30 bg-red-400/10 px-2 py-1.5 text-xs leading-5 text-red-200">
                      {task.error}
                    </p>
                  ) : runMessage ? (
                    <p className="mt-2 whitespace-pre-wrap rounded border border-red-400/30 bg-red-400/10 px-2 py-1.5 text-xs leading-5 text-red-200">
                      {runMessage}
                    </p>
                  ) : null}
                </div>
                {canShowSpecTaskRetry(task, tasks) ? (
                  <button
                    aria-label={`${t("spec.retryTask")}: ${task.title}`}
                    className="grid size-8 shrink-0 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-blue-400/40 hover:text-blue-100 disabled:cursor-not-allowed disabled:text-zinc-700"
                    disabled={disabled}
                    onClick={() => onRetry(task.id)}
                    title={t("spec.retryTask")}
                    type="button"
                  >
                    <RefreshCcw size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ReviewActions({
  busy,
  feedback,
  onApprove,
  onChangeFeedback,
  onSubmitRevision,
  spec,
}: {
  busy: boolean;
  feedback: string;
  onApprove: () => void;
  onChangeFeedback: (value: string) => void;
  onSubmitRevision: (event: FormEvent<HTMLFormElement>) => void;
  spec: DevelopmentSpec;
}) {
  const { t } = useI18n();

  if (spec.status !== "review") {
    return null;
  }

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<SendHorizontal size={15} aria-hidden="true" />} title={t("spec.review")} />
      <form className="mt-3 flex flex-col gap-3" onSubmit={onSubmitRevision}>
        <textarea
          className="h-24 min-h-24 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-3 text-sm leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
          onChange={(event) => onChangeFeedback(event.currentTarget.value)}
          placeholder={t("spec.revisionFeedback")}
          value={feedback}
        />
        <div className="flex justify-end gap-2">
          <button
            className="flex h-9 items-center gap-2 rounded-md border border-zinc-800 px-3 text-sm text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={busy || !feedback.trim()}
            type="submit"
          >
            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
            {t("spec.requestRevision")}
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/60 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
            disabled={busy}
            onClick={onApprove}
            type="button"
          >
            {busy ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 size={15} aria-hidden="true" />
            )}
            {t("spec.approveStartBuild")}
          </button>
        </div>
      </form>
    </section>
  );
}

function SpecChat({
  canSend,
  canSteerActiveRun,
  canUse,
  draft,
  messages,
  onChangeDraft,
  onKeyDown,
  onSubmit,
  specStatus,
}: {
  canSend: boolean;
  canSteerActiveRun: boolean;
  canUse: boolean;
  draft: string;
  messages: ChatMessage[];
  onChangeDraft: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  specStatus: DevelopmentSpec["status"];
}) {
  const { t } = useI18n();
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollSpecChatContainerToBottom(messagesContainerRef.current);
  }, [messages]);

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader
        icon={<MessageSquareText size={15} aria-hidden="true" />}
        title={t("sidebar.chat")}
      />
      <div
        className="mt-3 max-h-72 space-y-3 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900/40 p-3"
        ref={messagesContainerRef}
      >
        {messages.length === 0 ? (
          <p className="py-6 text-center text-xs text-zinc-600">
            {t("spec.noMessages")}
          </p>
        ) : (
          messages.map((message) => (
            <SpecChatMessage key={message.id} message={message} />
          ))
        )}
      </div>
      <form className="mt-3 flex gap-3" onSubmit={onSubmit}>
        <textarea
          className="h-16 min-h-16 flex-1 resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10 disabled:cursor-not-allowed disabled:text-zinc-600"
          disabled={!canUse}
          onChange={(event) => onChangeDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={getSpecChatPlaceholder(specStatus, canSteerActiveRun, t)}
          value={draft}
        />
        <button
          className="flex h-16 w-24 shrink-0 items-center justify-center gap-2 rounded-md border border-teal-400/30 bg-teal-400/10 text-sm font-medium text-teal-100 transition hover:border-teal-300/60 hover:bg-teal-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          disabled={!canSend}
          type="submit"
        >
          {canUse ? (
            <SendHorizontal size={15} aria-hidden="true" />
          ) : (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          )}
          {canSteerActiveRun ? t("common.steer") : t("common.send")}
        </button>
      </form>
    </section>
  );
}

function scrollSpecChatContainerToBottom(container: HTMLDivElement | null) {
  if (!container) {
    return;
  }

  window.requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function SpecChatMessage({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const isUser = message.role === "user";

  return (
    <article
      className={`max-w-[92%] whitespace-pre-wrap rounded-md border px-3 py-2 text-sm leading-5 ${
        isUser
          ? "ml-auto border-teal-400/30 bg-teal-400/10 text-teal-50"
          : "border-zinc-800 bg-zinc-950/70 text-zinc-300"
      }`}
    >
      <div
        className={`mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] ${
          isUser ? "text-teal-200/70" : "text-zinc-500"
        }`}
      >
        {isUser ? (
          <UserRound size={12} aria-hidden="true" />
        ) : (
          <Bot size={12} aria-hidden="true" />
        )}
        {isUser ? t("chat.user") : t("chat.assistant")}
      </div>
      {message.content || (message.isStreaming ? t("chat.working") : "")}
    </article>
  );
}

export function canSendSpecChatMessage({
  canSteerActiveRun,
  draft,
  hasConversation,
  hasProject,
  isArchived,
  isBusy,
}: {
  canSteerActiveRun: boolean;
  draft: string;
  hasConversation: boolean;
  hasProject: boolean;
  isArchived: boolean;
  isBusy: boolean;
}) {
  return (
    Boolean(draft.trim()) &&
    canUseSpecChat({
      canSteerActiveRun,
      hasConversation,
      hasProject,
      isArchived,
      isBusy,
    })
  );
}

export function canUseSpecChat({
  canSteerActiveRun,
  hasConversation,
  hasProject,
  isArchived,
  isBusy,
}: {
  canSteerActiveRun: boolean;
  hasConversation: boolean;
  hasProject: boolean;
  isArchived: boolean;
  isBusy: boolean;
}) {
  return (
    hasProject &&
    hasConversation &&
    !isArchived &&
    (!isBusy || canSteerActiveRun)
  );
}

type SpecApprovalNoticeConversation = {
  activeSpecId: string | null;
  id: string;
  mode: string;
};

type SpecApprovalNoticeSpec = {
  currentRevisionId: string;
  id: string;
  revisions: Array<{
    id: string;
    tasks: Array<Pick<SpecTask, "id" | "runId" | "status">>;
  }>;
};

export function shouldShowSpecApprovalNotice({
  approval,
  conversation,
  now = Date.now(),
  run,
  spec,
}: {
  approval: Pick<
    AgentApproval,
    "consumedAt" | "decision" | "expiresAt" | "resolvedAt" | "runId"
  > | null;
  conversation: SpecApprovalNoticeConversation | null;
  now?: number;
  run: Pick<AgentRun, "contract" | "conversationId" | "id" | "status"> | null;
  spec: SpecApprovalNoticeSpec | null;
}) {
  if (
    !approval ||
    !conversation ||
    !run ||
    !spec ||
    !isApprovalPendingAt(approval, now) ||
    approval.runId !== run.id ||
    run.status !== "waiting_approval"
  ) {
    return false;
  }

  const source = run.contract.source;
  const revision = spec.revisions.find(
    (item) => item.id === spec.currentRevisionId,
  );
  const runningTask = revision?.tasks.find(
    (task) => task.status === "running",
  );

  return (
    conversation.mode === "spec" &&
    conversation.activeSpecId === spec.id &&
    run.conversationId === conversation.id &&
    source?.mode === "spec" &&
    source.specId === spec.id &&
    source.revisionId === revision?.id &&
    Boolean(runningTask) &&
    source.taskId === runningTask?.id &&
    runningTask?.runId === run.id
  );
}

export function formatApprovalExpiryLabel(
  _expiresAt: string,
  _now = Date.now(),
  t?: ReturnType<typeof useI18n>["t"],
) {
  return t ? t("spec.noTimeout") : "No timeout";
}

function isApprovalPendingAt(
  approval: Pick<
    AgentApproval,
    "consumedAt" | "decision" | "expiresAt" | "resolvedAt"
  >,
  _now: number,
) {
  const expiresMs = new Date(approval.expiresAt).getTime();

  return (
    !approval.decision &&
    !approval.resolvedAt &&
    !approval.consumedAt &&
    Number.isFinite(expiresMs)
  );
}

function getSpecChatPlaceholder(
  status: DevelopmentSpec["status"],
  canSteerActiveRun: boolean,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (canSteerActiveRun) {
    return t("spec.addSteering");
  }

  if (status === "blocked") {
    return t("spec.askBlocked");
  }

  if (status === "review") {
    return t("spec.askSpec");
  }

  return t("spec.messageSpec");
}

function BuildView({
  busy,
  onRetryVerification,
  spec,
  tasks,
}: {
  busy: boolean;
  onRetryVerification: () => void;
  spec: DevelopmentSpec;
  tasks: SpecTask[];
}) {
  const { t } = useI18n();
  const passedTasks = tasks.filter((task) => task.status === "passed").length;

  if (!["approved", "building", "verifying", "blocked", "completed", "failed", "cancelled"].includes(spec.status)) {
    return null;
  }

  const revision = getCurrentSpecRevision(spec);
  const criteriaById = new Map(
    revision.requirements.acceptanceCriteria.map((criterion) => [
      criterion.id,
      criterion,
    ]),
  );
  const acceptanceResults = computePersistedAcceptanceResults(spec);

  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<RefreshCcw size={15} aria-hidden="true" />} title={t("spec.buildAndVerify")} />
      <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="min-w-0 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-2xl font-semibold text-zinc-100">
            {passedTasks}/{tasks.length}
          </div>
          <p className="mt-1 text-xs text-zinc-500">{t("spec.tasksPassed")}</p>
          {spec.finalVerification ? (
            <div className={`mt-3 rounded border px-2 py-1.5 text-xs ${
              spec.finalVerification.success
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                : "border-red-400/30 bg-red-400/10 text-red-100"
            }`}>
              <p className="font-medium">
                {spec.finalVerification.success
                  ? t("spec.finalVerificationPassed")
                  : t("spec.finalVerificationFailed")}
              </p>
              <p className="mt-1 break-words text-[11px] opacity-80">
                {spec.finalVerification.command}
              </p>
              {!spec.finalVerification.success && spec.finalVerification.output ? (
                <p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded border border-current/20 px-2 py-1.5 text-[11px] leading-4 opacity-90">
                  {spec.finalVerification.output}
                </p>
              ) : null}
            </div>
          ) : null}
          {canRetrySpecVerification(spec) ? (
            <button
              className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-blue-400/30 bg-blue-400/10 px-3 text-sm font-medium text-blue-100 transition hover:border-blue-300/60 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
              disabled={busy}
              onClick={onRetryVerification}
              type="button"
            >
              <RefreshCcw size={14} aria-hidden="true" />
              {t("spec.reverify")}
            </button>
          ) : null}
        </div>
        <div className="min-w-0 space-y-3">
          <div className="min-w-0 overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
              {t("spec.acceptanceCriteria")}
            </h3>
            <div className="mt-3 space-y-2">
              {acceptanceResults.map((result) => (
                <div
                  className="min-w-0 overflow-hidden rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2"
                  key={result.criterionId}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <p className="flex min-w-0 items-start gap-2 text-xs leading-5 text-zinc-300">
                      <span className="shrink-0" aria-hidden="true">
                        {getAcceptanceStatusSymbol(result.status)}
                      </span>
                      <span className="min-w-0 break-words">
                        {criteriaById.get(result.criterionId)?.description ??
                          result.criterionId}
                      </span>
                    </p>
                    <StatusPill status={result.status} />
                  </div>
                  <p className="mt-1 break-all text-[11px] leading-4 text-zinc-500">
                    {formatAcceptanceEvidenceLabels(result, t).tasks}
                  </p>
                  <p className="mt-1 break-all text-[11px] leading-4 text-zinc-500">
                    {formatAcceptanceEvidenceLabels(result, t).runs}
                  </p>
                  {result.summary ? (
                    <p className="mt-2 whitespace-pre-wrap break-words rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-[11px] leading-4 text-zinc-400">
                      {result.summary}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <AgentRunPanel />
        </div>
      </div>
    </section>
  );
}

export function getAcceptanceStatusSymbol(
  status: "passed" | "failed" | "pending",
) {
  if (status === "passed") {
    return "+";
  }

  if (status === "failed") {
    return "x";
  }

  return "o";
}
export function formatAcceptanceEvidenceLabels(
  result: Pick<SpecAcceptanceResult, "runIds" | "taskIds">,
  t: ReturnType<typeof useI18n>["t"] = (key, params) => {
    if (key === "spec.runsEvidence" && params) {
      return `Runs: ${params.runs}`;
    }
    if (key === "spec.tasksEvidence" && params) {
      return `Tasks: ${params.tasks}`;
    }
    if (key === "spec.noneEvidence") {
      return "none";
    }
    return String(key);
  },
) {
  const runs = result.runIds.join(", ") || t("spec.noneEvidence");
  const tasks = result.taskIds.join(", ") || t("spec.noneEvidence");

  return {
    runs: t("spec.runsEvidence", { runs }),
    tasks: t("spec.tasksEvidence", { tasks }),
  };
}

export function formatSpecTaskAutoRetryLabel(
  task: Pick<SpecTask, "autoRetryCount">,
  t: ReturnType<typeof useI18n>["t"] = (key, params) =>
    key === "spec.autoRetry" && params
      ? `Auto retry ${params.count}`
      : String(key),
) {
  const count = task.autoRetryCount ?? 0;
  return count > 0 ? t("spec.autoRetry", { count }) : null;
}

export function canShowSpecTaskRetry(
  task: Pick<SpecTask, "dependencyIds" | "status">,
  tasks: Array<Pick<SpecTask, "id" | "status">>,
) {
  if (task.status === "failed" || task.status === "cancelled") {
    return true;
  }

  if (task.status !== "blocked") {
    return false;
  }

  return task.dependencyIds.every((dependencyId) =>
    tasks.some(
      (candidate) =>
        candidate.id === dependencyId && candidate.status === "passed",
    ),
  );
}

export function findFirstRetryableSpecTask<
  T extends Pick<SpecTask, "dependencyIds" | "id" | "status">,
>(
  tasks: T[],
): T | null {
  return tasks.find((task) => canShowSpecTaskRetry(task, tasks)) ?? null;
}

function SpecHistory({
  activeSpecId,
  specs,
}: {
  activeSpecId: string;
  specs: DevelopmentSpec[];
}) {
  const { t } = useI18n();

  if (specs.length <= 1) {
    return null;
  }

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<History size={15} aria-hidden="true" />} title={t("spec.history")} />
      <div className="mt-3 space-y-1">
        {specs.map((spec) => (
          <div
            className="flex min-w-0 items-center gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 text-xs"
            key={spec.id}
          >
            <span className="min-w-0 flex-1 truncate text-zinc-300">
              {spec.id}
            </span>
            <span className="shrink-0 rounded border border-zinc-800 px-2 py-0.5 text-zinc-500">
              {spec.status}
            </span>
            {spec.id === activeSpecId ? (
              <span className="shrink-0 text-blue-200">{t("spec.active")}</span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptySpec() {
  const { t } = useI18n();

  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-[320px] rounded-md border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-sm leading-6 text-zinc-500">
        {t("spec.empty")}
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
}: {
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
      {icon}
      {title}
    </div>
  );
}

function ListBlock({
  className = "",
  items,
  title,
}: {
  className?: string;
  items: string[];
  title: string;
}) {
  const { t } = useI18n();

  return (
    <div className={className}>
      <h4 className="mb-2 text-xs font-medium text-zinc-300">{title}</h4>
      {items.length > 0 ? (
        <ul className="space-y-1 text-xs leading-5 text-zinc-500">
          {items.map((item, index) => (
            <li className="rounded border border-zinc-900 bg-zinc-950 px-2 py-1.5" key={`${item}-${index}`}>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded border border-dashed border-zinc-900 px-2 py-2 text-xs text-zinc-600">
          {t("common.none")}
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="rounded border border-blue-400/30 bg-blue-400/10 px-2 py-0.5 text-xs text-blue-100">
      {status}
    </span>
  );
}

function StatusPill({ status }: { status: "passed" | "failed" | "pending" }) {
  const tone =
    status === "passed"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
      : status === "failed"
        ? "border-red-400/30 bg-red-400/10 text-red-100"
        : "border-zinc-800 bg-zinc-950 text-zinc-500";

  return (
    <span className={`shrink-0 rounded border px-2 py-0.5 text-[11px] ${tone}`}>
      {status}
    </span>
  );
}

function SpecApprovalNotice({
  approval,
  onApprove,
  onDeny,
}: {
  approval: AgentApproval;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { t } = useI18n();

  return (
    <section
      aria-live="assertive"
      className="rounded-md border border-amber-300/50 bg-amber-400/10 p-4 shadow-[0_0_0_1px_rgba(251,191,36,0.08)]"
    >
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-md border border-amber-300/40 bg-amber-300/10 text-amber-100">
            <ShieldCheck size={18} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-amber-50">
                {t("spec.approvalRequired")}
              </h3>
              <span className="rounded border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-100">
                {approval.toolName}
              </span>
              <span className="rounded border border-amber-300/20 px-2 py-0.5 text-[11px] text-amber-200/80">
                {formatApprovalExpiryLabel(approval.expiresAt, Date.now(), t)}
              </span>
            </div>
            <p className="mt-1 break-words text-xs leading-5 text-zinc-300">
              {approval.exactSideEffect}
            </p>
            {approval.targetResources.length > 0 ? (
              <p className="mt-1 truncate text-[11px] text-zinc-500">
                {approval.targetResources.join(", ")}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            aria-label={`${t("common.approve")} ${approval.toolName}`}
            className="flex h-9 min-w-28 items-center justify-center gap-2 rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/70 hover:bg-emerald-400/15"
            onClick={onApprove}
            type="button"
          >
            <CheckCircle2 size={15} aria-hidden="true" />
            {t("common.approve")}
          </button>
          <button
            aria-label={`${t("agent.deny")} ${approval.toolName}`}
            className="flex h-9 min-w-24 items-center justify-center gap-2 rounded-md border border-red-400/40 bg-red-400/10 px-3 text-sm font-medium text-red-100 transition hover:border-red-300/70 hover:bg-red-400/15"
            onClick={onDeny}
            type="button"
          >
            <XCircle size={15} aria-hidden="true" />
            {t("agent.deny")}
          </button>
        </div>
      </div>
    </section>
  );
}

export function getSpecTaskDisplayStatus(
  task: Pick<SpecTask, "runId" | "status">,
  agentRuns: Array<Pick<AgentRun, "id" | "status">>,
) {
  if (task.status !== "running" || !task.runId) {
    return task.status;
  }

  const run = agentRuns.find((item) => item.id === task.runId);

  if (run?.status === "waiting_approval") {
    return "waiting_approval";
  }

  if (!run || !isTerminalAgentRun(run.status)) {
    return task.status;
  }

  return run.status;
}

function getSpecTaskRunStatusMessage(
  task: Pick<SpecTask, "runId" | "status">,
  displayStatus: string,
) {
  if (
    task.status !== "running" ||
    displayStatus === "running" ||
    displayStatus === "waiting_approval" ||
    !task.runId
  ) {
    return null;
  }

  return `AgentRun ${task.runId} ended with status ${displayStatus}.`;
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "passed" || status === "completed"
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
      : status === "failed" || status === "cancelled" || status === "blocked" || status === "budget_exceeded"
        ? "border-red-400/40 bg-red-400/10 text-red-200"
        : status === "waiting_approval"
          ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
        : status === "running"
          ? "border-blue-400/40 bg-blue-400/10 text-blue-200"
          : "border-zinc-800 text-zinc-500";

  return (
    <div className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border ${tone}`}>
      {status === "passed" || status === "completed" ? (
        <CheckCircle2 size={15} aria-hidden="true" />
      ) : status === "failed" || status === "cancelled" || status === "blocked" || status === "budget_exceeded" ? (
        <XCircle size={15} aria-hidden="true" />
      ) : status === "waiting_approval" ? (
        <ShieldCheck size={15} aria-hidden="true" />
      ) : status === "running" ? (
        <Loader2 size={15} className="animate-spin" aria-hidden="true" />
      ) : (
        <FileText size={15} aria-hidden="true" />
      )}
    </div>
  );
}

function stepIndexForStatus(status: string) {
  if (["drafting", "review", "revising"].includes(status)) {
    return 2;
  }

  if (["approved", "building", "blocked"].includes(status)) {
    return 3;
  }

  return 4;
}

function safeCurrentRevision(spec: DevelopmentSpec) {
  try {
    return getCurrentSpecRevision(spec);
  } catch {
    return null;
  }
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
    model: modelParts.join(":"),
    provider: provider as AiProviderId,
  };
}
