import { FormEvent, useState } from "react";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  FileText,
  History,
  Loader2,
  RefreshCcw,
  SendHorizontal,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { ConfiguredModelOption } from "../../App";
import {
  getAiProviderDefinition,
  type AiProviderId,
} from "../../services/aiProviders";
import { useAppStore } from "../../store/appStore";
import type {
  DevelopmentSpec,
  SpecRevision,
  SpecTask,
} from "../../spec-core/types";
import { getCurrentSpecRevision } from "../../spec-core/validators";
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
  const [feedback, setFeedback] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);
  const currentProject = useAppStore((state) => state.currentProject);
  const currentConversation = useAppStore((state) => state.currentConversation);
  const currentSpec = useAppStore((state) => state.currentSpec);
  const historicalSpecs = useAppStore((state) => state.historicalSpecs);
  const isLoadingSpec = useAppStore((state) => state.isLoadingSpec);
  const isRevisingSpec = useAppStore((state) => state.isRevisingSpec);
  const isExecutingSpec = useAppStore((state) => state.isExecutingSpec);
  const isVerifyingSpec = useAppStore((state) => state.isVerifyingSpec);
  const reviseCurrentSpec = useAppStore((state) => state.reviseCurrentSpec);
  const approveAndExecuteCurrentSpec = useAppStore(
    (state) => state.approveAndExecuteCurrentSpec,
  );
  const retrySpecTask = useAppStore((state) => state.retrySpecTask);
  const retrySpecVerification = useAppStore(
    (state) => state.retrySpecVerification,
  );
  const provider = getAiProviderDefinition(activeProvider);
  const activeSelection = { provider: activeProvider, model: activeModel };
  const availableModelOptions =
    configuredModelOptions.length > 0
      ? configuredModelOptions
      : [activeSelection];
  const revision = currentSpec ? safeCurrentRevision(currentSpec) : null;
  const busy = isLoadingSpec || isRevisingSpec || isExecutingSpec || isVerifyingSpec;

  async function handleChangeModel(selection: ConfiguredModelOption) {
    setModelError(null);

    try {
      await onChangeModel(selection);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "Failed to save model.");
    }
  }

  async function submitRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!feedback.trim()) {
      return;
    }

    await reviseCurrentSpec(feedback);
    setFeedback("");
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-[#0d0d10]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-zinc-800 px-5 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-100">
            {currentConversation?.title ?? "Spec"}
          </h2>
          <p className="truncate text-xs text-zinc-500">
            {currentProject
              ? `${currentProject.name} / ${currentSpec?.status ?? "loading"}`
              : "No project selected"}
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
            Loading Spec
          </div>
        ) : !currentSpec || !revision ? (
          <EmptySpec />
        ) : (
          <div className="mx-auto max-w-5xl space-y-4">
            <SpecSummary spec={currentSpec} revision={revision} />
            <SpecStepper status={currentSpec.status} />
            <RequirementsView revision={revision} />
            <DesignView revision={revision} />
            <SpecTaskList
              disabled={busy}
              onRetry={(taskId) => void retrySpecTask(taskId)}
              tasks={revision.tasks}
            />
            <ReviewActions
              busy={busy}
              feedback={feedback}
              onApprove={() => void approveAndExecuteCurrentSpec()}
              onChangeFeedback={setFeedback}
              onSubmitRevision={submitRevision}
              spec={currentSpec}
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
  revision,
  spec,
}: {
  revision: SpecRevision;
  spec: DevelopmentSpec;
}) {
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
              Revision {revision.version}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">
            {revision.brief}
          </p>
          {spec.failureMessage ? (
            <p className="mt-2 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-200">
              {spec.failureMessage}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SpecStepper({ status }: { status: string }) {
  const steps = [
    { id: "requirements", label: "Requirements" },
    { id: "design", label: "Design" },
    { id: "tasks", label: "Tasks" },
    { id: "build", label: "Build" },
    { id: "verify", label: "Verify" },
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
  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<ShieldCheck size={15} aria-hidden="true" />} title="Requirements" />
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <ListBlock
          title="User stories"
          items={revision.requirements.userStories.map((story) => story.description)}
        />
        <ListBlock
          title="Acceptance criteria"
          items={revision.requirements.acceptanceCriteria.map(
            (criterion) =>
              `${criterion.required ? "Required" : "Optional"} · ${criterion.description}`,
          )}
        />
        <ListBlock title="Constraints" items={revision.requirements.constraints} />
        <ListBlock
          title="Out of scope"
          items={revision.requirements.outOfScope}
        />
      </div>
      {revision.requirements.unresolvedQuestions.length > 0 ? (
        <ListBlock
          className="mt-3"
          title="Unresolved questions"
          items={revision.requirements.unresolvedQuestions}
        />
      ) : null}
    </section>
  );
}

function DesignView({ revision }: { revision: SpecRevision }) {
  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<FileText size={15} aria-hidden="true" />} title="Design" />
      <p className="mt-3 text-sm leading-6 text-zinc-300">
        {revision.design.summary}
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <ListBlock
          title="Pages"
          items={revision.design.pages.map((page) => `${page.route} · ${page.purpose}`)}
        />
        <ListBlock
          title="Components"
          items={revision.design.components.map(
            (component) => `${component.name} · ${component.responsibility}`,
          )}
        />
        <ListBlock title="Data model" items={revision.design.dataModel} />
        <ListBlock title="Integrations" items={revision.design.integrations} />
        <ListBlock
          title="Technical decisions"
          items={revision.design.technicalDecisions}
        />
        <ListBlock
          title="Verification"
          items={revision.design.verificationStrategy}
        />
      </div>
    </section>
  );
}

function SpecTaskList({
  disabled,
  onRetry,
  tasks,
}: {
  disabled: boolean;
  onRetry: (taskId: string) => void;
  tasks: SpecTask[];
}) {
  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<CheckCircle2 size={15} aria-hidden="true" />} title="Tasks" />
      <div className="mt-3 space-y-2">
        {tasks.map((task) => (
          <div
            className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3"
            key={task.id}
          >
            <div className="flex min-w-0 items-start gap-3">
              <StatusDot status={task.status} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="truncate text-sm font-medium text-zinc-100">
                    {task.title}
                  </h4>
                  <span className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">
                    {task.status}
                  </span>
                  {task.runId ? (
                    <span className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">
                      {task.runId.slice(0, 16)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs leading-5 text-zinc-400">
                  {task.objective}
                </p>
                <p className="mt-2 truncate text-[11px] text-zinc-600">
                  Paths: {task.allowedPaths.join(", ")}
                </p>
                {task.dependencyIds.length > 0 ? (
                  <p className="mt-1 truncate text-[11px] text-zinc-600">
                    Dependencies: {task.dependencyIds.join(", ")}
                  </p>
                ) : null}
                {task.error ? (
                  <p className="mt-2 whitespace-pre-wrap rounded border border-red-400/30 bg-red-400/10 px-2 py-1.5 text-xs leading-5 text-red-200">
                    {task.error}
                  </p>
                ) : null}
              </div>
              {["failed", "cancelled", "blocked"].includes(task.status) ? (
                <button
                  aria-label={`Retry ${task.title}`}
                  className="grid size-8 shrink-0 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-blue-400/40 hover:text-blue-100 disabled:cursor-not-allowed disabled:text-zinc-700"
                  disabled={disabled}
                  onClick={() => onRetry(task.id)}
                  title="Retry"
                  type="button"
                >
                  <RefreshCcw size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
        ))}
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
  if (spec.status !== "review") {
    return null;
  }

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<SendHorizontal size={15} aria-hidden="true" />} title="Review" />
      <form className="mt-3 flex flex-col gap-3" onSubmit={onSubmitRevision}>
        <textarea
          className="h-24 min-h-24 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-3 text-sm leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
          onChange={(event) => onChangeFeedback(event.currentTarget.value)}
          placeholder="Revision feedback"
          value={feedback}
        />
        <div className="flex justify-end gap-2">
          <button
            className="flex h-9 items-center gap-2 rounded-md border border-zinc-800 px-3 text-sm text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={busy || !feedback.trim()}
            type="submit"
          >
            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
            Request revision
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
            Approve and start build
          </button>
        </div>
      </form>
    </section>
  );
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
  const passedTasks = tasks.filter((task) => task.status === "passed").length;

  if (!["approved", "building", "verifying", "completed", "failed", "cancelled"].includes(spec.status)) {
    return null;
  }

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<RefreshCcw size={15} aria-hidden="true" />} title="Build and verify" />
      <div className="mt-3 grid gap-3 lg:grid-cols-[220px_1fr]">
        <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-2xl font-semibold text-zinc-100">
            {passedTasks}/{tasks.length}
          </div>
          <p className="mt-1 text-xs text-zinc-500">Tasks passed</p>
          {spec.finalVerification ? (
            <p className="mt-3 rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-1.5 text-xs text-emerald-100">
              Final build passed
            </p>
          ) : null}
          {spec.status === "failed" ? (
            <button
              className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-blue-400/30 bg-blue-400/10 px-3 text-sm font-medium text-blue-100 transition hover:border-blue-300/60 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
              disabled={busy}
              onClick={onRetryVerification}
              type="button"
            >
              <RefreshCcw size={14} aria-hidden="true" />
              Reverify
            </button>
          ) : null}
        </div>
        <AgentRunPanel />
      </div>
    </section>
  );
}

function SpecHistory({
  activeSpecId,
  specs,
}: {
  activeSpecId: string;
  specs: DevelopmentSpec[];
}) {
  if (specs.length <= 1) {
    return null;
  }

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
      <SectionHeader icon={<History size={15} aria-hidden="true" />} title="Spec history" />
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
              <span className="shrink-0 text-blue-200">active</span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptySpec() {
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-[320px] rounded-md border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-sm leading-6 text-zinc-500">
        No Spec is active.
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
          None
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

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "passed"
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
      : status === "failed" || status === "cancelled" || status === "blocked"
        ? "border-red-400/40 bg-red-400/10 text-red-200"
        : status === "running"
          ? "border-blue-400/40 bg-blue-400/10 text-blue-200"
          : "border-zinc-800 text-zinc-500";

  return (
    <div className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border ${tone}`}>
      {status === "passed" ? (
        <CheckCircle2 size={15} aria-hidden="true" />
      ) : status === "failed" || status === "cancelled" || status === "blocked" ? (
        <XCircle size={15} aria-hidden="true" />
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

  if (["approved", "building"].includes(status)) {
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
