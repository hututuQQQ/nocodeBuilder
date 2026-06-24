import { FormEvent, MouseEvent, useState } from "react";
import {
  Archive,
  FileText,
  FolderKanban,
  FolderOpen,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  Settings,
  SquarePen,
  X,
} from "lucide-react";
import type { ProjectConversation, ProjectConversationSummary } from "../../services/projects";
import type { DevelopmentSpec } from "../../spec-core/types";
import { useAppStore } from "../../store/appStore";
import { selectConversationList } from "../../store/conversationStoreActions";
import { hasCompletedInitialBuildEvidence } from "../../store/initialBuildGate";

type ProjectSidebarProps = {
  onOpenSettings: () => void;
};

export function ProjectSidebar({ onOpenSettings }: ProjectSidebarProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newIterationProjectId, setNewIterationProjectId] = useState<string | null>(null);
  const [newIterationMode, setNewIterationMode] = useState<"chat" | "spec">("chat");
  const [newIterationTitle, setNewIterationTitle] = useState("");
  const [newIterationBrief, setNewIterationBrief] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectPrompt, setProjectPrompt] = useState("");
  const archiveConversation = useAppStore((state) => state.archiveConversation);
  const conversationSummaries = useAppStore(
    (state) => state.conversationSummaries,
  );
  const createConversation = useAppStore((state) => state.createConversation);
  const currentProject = useAppStore((state) => state.currentProject);
  const currentConversation = useAppStore(
    (state) => state.currentConversation,
  );
  const currentSpec = useAppStore((state) => state.currentSpec);
  const initialBuildSpec = useAppStore((state) => state.initialBuildSpec);
  const historicalSpecs = useAppStore((state) => state.historicalSpecs);
  const createFeatureSpecIteration = useAppStore(
    (state) => state.createFeatureSpecIteration,
  );
  const createProject = useAppStore((state) => state.createProject);
  const isCreatingConversation = useAppStore(
    (state) => state.isCreatingConversation,
  );
  const isCreatingProject = useAppStore((state) => state.isCreatingProject);
  const isExecutingSpec = useAppStore((state) => state.isExecutingSpec);
  const isLoadingConversations = useAppStore(
    (state) => state.isLoadingConversations,
  );
  const isLoadingProjects = useAppStore((state) => state.isLoadingProjects);
  const isGeneratingSpec = useAppStore((state) => state.isGeneratingSpec);
  const isRevisingSpec = useAppStore((state) => state.isRevisingSpec);
  const isSwitchingIterationMode = useAppStore(
    (state) => state.isSwitchingIterationMode,
  );
  const isVerifyingSpec = useAppStore((state) => state.isVerifyingSpec);
  const openProjectFolder = useAppStore((state) => state.openProjectFolder);
  const projectError = useAppStore((state) => state.projectError);
  const projects = useAppStore((state) => state.projects);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const selectProject = useAppStore((state) => state.selectProject);
  const setShowArchivedConversations = useAppStore(
    (state) => state.setShowArchivedConversations,
  );
  const showArchivedConversations = useAppStore(
    (state) => state.showArchivedConversations,
  );
  const unarchiveConversation = useAppStore(
    (state) => state.unarchiveConversation,
  );
  const visibleConversations = selectConversationList(
    conversationSummaries,
    showArchivedConversations,
  );
  const iterationBusy =
    isCreatingConversation ||
    isGeneratingSpec ||
    isRevisingSpec ||
    isExecutingSpec ||
    isVerifyingSpec ||
    isSwitchingIterationMode;

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const createdProject = await createProject(projectName, projectPrompt);

    if (createdProject) {
      setProjectName("");
      setProjectPrompt("");
      setIsDialogOpen(false);
    }
  }

  function handleOpenProjectFolder(
    event: MouseEvent<HTMLButtonElement>,
    projectId: string,
  ) {
    event.stopPropagation();
    void openProjectFolder(projectId);
  }

  async function handleCreateConversation(
    event: MouseEvent<HTMLButtonElement>,
    projectId: string,
  ) {
    event.stopPropagation();
    setNewIterationProjectId(projectId);
    setNewIterationMode("chat");
    setNewIterationTitle("");
    setNewIterationBrief("");
  }

  async function handleCreateIteration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const projectId = newIterationProjectId;

    if (!projectId) {
      return;
    }

    if (currentProject?.id !== projectId) {
      await selectProject(projectId);
    }

    const title = newIterationTitle.trim();
    const conversation =
      newIterationMode === "spec"
        ? await createFeatureSpecIteration(projectId, title, newIterationBrief)
        : await createConversation(projectId, {
            kind: "iteration",
            mode: "chat",
            title,
          });

    if (!conversation) {
      return;
    }

    setNewIterationProjectId(null);
    setNewIterationTitle("");
    setNewIterationBrief("");
  }

  async function handleToggleArchivedConversations(
    event: MouseEvent<HTMLButtonElement>,
    projectId: string,
  ) {
    event.stopPropagation();
    const nextShowArchived =
      currentProject?.id === projectId ? !showArchivedConversations : true;

    if (currentProject?.id !== projectId) {
      await selectProject(projectId);
    }

    await setShowArchivedConversations(nextShowArchived);
  }

  function handleSelectConversation(
    event: MouseEvent<HTMLElement>,
    conversationId: string,
  ) {
    event.stopPropagation();
    void selectConversation(conversationId);
  }

  function handleArchiveConversation(
    event: MouseEvent<HTMLButtonElement>,
    conversationId: string,
  ) {
    event.stopPropagation();
    void archiveConversation(conversationId);
  }

  function handleRestoreConversation(
    event: MouseEvent<HTMLButtonElement>,
    conversationId: string,
  ) {
    event.stopPropagation();
    void unarchiveConversation(conversationId);
  }

  return (
    <aside className="relative flex min-h-0 min-w-0 flex-col bg-[#101012]">
      <div className="border-b border-zinc-800 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-md border border-teal-400/30 bg-teal-400/10 text-teal-200">
            <FolderKanban size={18} aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-zinc-50">
              AI Web Builder
            </h1>
            <p className="text-xs text-zinc-500">Desktop MVP</p>
          </div>
        </div>
      </div>

      <div className="border-b border-zinc-800 p-3">
        <button
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-teal-400/30 bg-teal-400/10 text-sm font-medium text-teal-100 transition hover:border-teal-300/60 hover:bg-teal-400/15"
          type="button"
          onClick={() => setIsDialogOpen(true)}
        >
          <Plus size={16} aria-hidden="true" />
          New Project
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
            Projects
          </h2>
          <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
            {projects.length}
          </span>
        </div>

        {isLoadingProjects ? (
          <div className="flex items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-6 text-sm text-zinc-500">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            Loading projects
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 px-3 py-6 text-center text-sm text-zinc-500">
            No projects yet
          </div>
        ) : (
          <div className="space-y-2">
            {projects.map((project) => {
              const isCurrent = currentProject?.id === project.id;
              const initialBuildCompleted =
                isCurrent &&
                hasCompletedInitialBuildForCurrentProject(
                  project.id,
                  conversationSummaries,
                  currentProject,
                  initialBuildSpec,
                  currentSpec,
                  historicalSpecs,
                );
              const canUseNewIteration = canUseNewIterationShortcut({
                initialBuildCompleted,
                isCurrentProject: isCurrent,
                iterationBusy,
              });

              return (
                <div key={project.id}>
                  <div
                    className={`group/project flex h-10 w-full cursor-pointer items-center gap-2 rounded-md border px-2 text-left text-sm transition ${
                      isCurrent
                        ? "border-teal-400/40 bg-teal-400/10 text-teal-50"
                        : "border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900"
                    }`}
                    onClick={() => void selectProject(project.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void selectProject(project.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <FolderKanban
                      size={15}
                      className="shrink-0 text-zinc-500"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1 truncate font-medium">
                      {project.name}
                    </div>
                    <div
                      className={`flex shrink-0 items-center gap-1 ${
                        isCurrent
                          ? "opacity-100"
                          : "opacity-0 transition group-hover/project:opacity-100"
                      }`}
                    >
                      <button
                        aria-label={`Open ${project.name} folder`}
                        className="grid size-7 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-teal-400/40 hover:text-teal-200"
                        onClick={(event) =>
                          handleOpenProjectFolder(event, project.id)
                        }
                        title="Open folder"
                        type="button"
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                      </button>
                      <button
                        aria-label={`Show archived iterations for ${project.name}`}
                        className={`grid size-7 place-items-center rounded border transition disabled:cursor-not-allowed disabled:text-zinc-700 ${
                          isCurrent && showArchivedConversations
                            ? "border-teal-400/40 bg-teal-400/10 text-teal-100"
                            : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-100"
                        }`}
                        disabled={isLoadingConversations}
                        onClick={(event) =>
                          void handleToggleArchivedConversations(
                            event,
                            project.id,
                          )
                        }
                        title={
                          isCurrent && showArchivedConversations
                            ? "Show active iterations"
                            : "Show archived iterations"
                        }
                        type="button"
                      >
                        <Archive size={14} aria-hidden="true" />
                      </button>
                      <button
                        aria-label={`New iteration in ${project.name}`}
                        className="grid size-7 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-teal-400/40 hover:text-teal-100 disabled:cursor-not-allowed disabled:text-zinc-700"
                        disabled={!canUseNewIteration}
                        onClick={(event) =>
                          void handleCreateConversation(event, project.id)
                        }
                        title={
                          !isCurrent
                            ? "Select project first"
                            : !initialBuildCompleted
                              ? "Complete Initial Spec first"
                              : "New iteration"
                        }
                        type="button"
                      >
                        <SquarePen size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {isCurrent ? (
                    <div className="mt-1 space-y-1 pl-4">
                      {!showArchivedConversations && !initialBuildCompleted ? (
                        <div className="px-2 py-1.5 text-xs text-zinc-500">
                          Complete Initial Spec first
                        </div>
                      ) : null}
                      {isLoadingConversations ? (
                        <div className="flex items-center gap-2 px-2 py-2 text-xs text-zinc-500">
                          <Loader2
                            size={13}
                            className="animate-spin"
                            aria-hidden="true"
                          />
                          Loading iterations
                        </div>
                      ) : visibleConversations.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-zinc-500">
                          {showArchivedConversations
                            ? "No archived iterations"
                            : "No active iterations"}
                        </div>
                      ) : (
                        visibleConversations.map((conversation) => {
                          const isSelected =
                            currentConversation?.id === conversation.id;
                          const archiveDisabled =
                            conversation.kind === "initial_build" &&
                            !isInitialBuildCompleted(
                              conversation,
                              currentConversation,
                              currentSpec,
                              historicalSpecs,
                            );

                          return (
                            <div
                              className={`group/chat flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs transition ${
                                isSelected
                                  ? "bg-zinc-800 text-zinc-50"
                                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                              }`}
                              key={conversation.id}
                              onClick={(event) =>
                                handleSelectConversation(event, conversation.id)
                              }
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Enter" ||
                                  event.key === " "
                                ) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void selectConversation(conversation.id);
                                }
                              }}
                              role="button"
                              tabIndex={0}
                            >
                              <MessageSquare
                                size={13}
                                className="shrink-0 text-zinc-500"
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {conversation.title}
                              </span>
                              <span className="shrink-0 rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                                {formatConversationMarker(conversation)}
                              </span>
                              <span className="shrink-0 text-[10px] text-zinc-600">
                                {formatRelativeTime(conversation.lastMessageAt)}
                              </span>
                              {conversation.archivedAt ? (
                                <button
                                  aria-label={`Restore ${conversation.title}`}
                                  className="grid size-6 shrink-0 place-items-center rounded text-zinc-500 transition hover:bg-zinc-800 hover:text-teal-100"
                                  onClick={(event) =>
                                    handleRestoreConversation(
                                      event,
                                      conversation.id,
                                    )
                                  }
                                  title="Restore chat"
                                  type="button"
                                >
                                  <RotateCcw size={12} aria-hidden="true" />
                                </button>
                              ) : archiveDisabled ? null : (
                                <button
                                  aria-label={`Archive ${conversation.title}`}
                                  className="grid size-6 shrink-0 place-items-center rounded text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100"
                                  onClick={(event) =>
                                    handleArchiveConversation(
                                      event,
                                      conversation.id,
                                    )
                                  }
                                  title="Archive chat"
                                  type="button"
                                >
                                  <Archive size={12} aria-hidden="true" />
                                </button>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800 p-3">
        <button
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 text-sm text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800"
          onClick={onOpenSettings}
          type="button"
        >
          <Settings size={16} aria-hidden="true" />
          Settings
        </button>
      </div>

      {isDialogOpen ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-black/60 px-4">
          <form
            className="w-full max-w-[360px] rounded-md border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
            onSubmit={handleCreateProject}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">
                  New Project
                </h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Development mode
                </p>
                <p className="mt-1 text-xs font-medium text-teal-100">
                  Spec Coding
                </p>
              </div>
              <button
                className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
                onClick={() => setIsDialogOpen(false)}
                type="button"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            <label
              className="mb-2 block text-xs font-medium text-zinc-400"
              htmlFor="project-name"
            >
              Project name
            </label>
            <input
              autoFocus
              className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
              id="project-name"
              onChange={(event) => setProjectName(event.currentTarget.value)}
              placeholder="pet-care-site"
              value={projectName}
            />

            <label
              className="mb-2 mt-4 block text-xs font-medium text-zinc-400"
              htmlFor="project-prompt"
            >
              Website brief
            </label>
            <textarea
              className="h-28 min-h-28 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-3 text-sm leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
              id="project-prompt"
              onChange={(event) => setProjectPrompt(event.currentTarget.value)}
              placeholder="Build a polished Chinese landing page for a boutique coffee brand with menu, story, and reservation sections."
              value={projectPrompt}
            />
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              New projects begin with requirements, design, and tasks. Code is generated only after approval.
            </p>

            {projectError ? (
              <p className="mt-3 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-200">
                {projectError}
              </p>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
                onClick={() => setIsDialogOpen(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="flex h-9 items-center gap-2 rounded-md border border-teal-400/30 bg-teal-400/10 px-3 text-sm font-medium text-teal-100 transition hover:border-teal-300/60 hover:bg-teal-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                disabled={
                  !projectName.trim() ||
                  !projectPrompt.trim() ||
                  isCreatingProject
                }
                type="submit"
              >
                {isCreatingProject ? (
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Plus size={15} aria-hidden="true" />
                )}
                Create specification
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {newIterationProjectId ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-black/60 px-4">
          <form
            className="w-full max-w-[360px] rounded-md border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
            onSubmit={handleCreateIteration}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">
                  New Iteration
                </h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Initial mode
                </p>
              </div>
              <button
                className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
                onClick={() => setNewIterationProjectId(null)}
                type="button"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            <div className="grid grid-cols-2 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
              <button
                className={`flex h-10 items-center justify-center gap-2 text-sm ${
                  newIterationMode === "chat"
                    ? "bg-teal-400/15 text-teal-100"
                    : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
                onClick={() => setNewIterationMode("chat")}
                type="button"
              >
                <MessageSquare size={15} aria-hidden="true" />
                Chat
              </button>
              <button
                className={`flex h-10 items-center justify-center gap-2 border-l border-zinc-800 text-sm ${
                  newIterationMode === "spec"
                    ? "bg-blue-400/15 text-blue-100"
                    : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
                onClick={() => setNewIterationMode("spec")}
                type="button"
              >
                <FileText size={15} aria-hidden="true" />
                Spec
              </button>
            </div>

            <label
              className="mb-2 mt-4 block text-xs font-medium text-zinc-400"
              htmlFor="iteration-title"
            >
              Iteration title
            </label>
            <input
              className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
              id="iteration-title"
              onChange={(event) => setNewIterationTitle(event.currentTarget.value)}
              placeholder={
                newIterationMode === "spec"
                  ? "Checkout refinement"
                  : "Follow-up changes"
              }
              value={newIterationTitle}
            />

            {newIterationMode === "spec" ? (
              <>
                <label
                  className="mb-2 mt-4 block text-xs font-medium text-zinc-400"
                  htmlFor="iteration-brief"
                >
                  Brief
                </label>
                <textarea
                  className="h-28 min-h-28 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-3 text-sm leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
                  id="iteration-brief"
                  onChange={(event) => setNewIterationBrief(event.currentTarget.value)}
                  placeholder="Describe the next feature or change"
                  value={newIterationBrief}
                />
              </>
            ) : null}

            {projectError ? (
              <p className="mt-3 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-200">
                {projectError}
              </p>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
                onClick={() => setNewIterationProjectId(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="flex h-9 items-center gap-2 rounded-md border border-teal-400/30 bg-teal-400/10 px-3 text-sm font-medium text-teal-100 transition hover:border-teal-300/60 hover:bg-teal-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                disabled={
                  isCreatingConversation ||
                  isGeneratingSpec ||
                  isRevisingSpec ||
                  isExecutingSpec ||
                  isVerifyingSpec ||
                  isSwitchingIterationMode ||
                  (newIterationMode === "spec" && !newIterationBrief.trim())
                }
                type="submit"
              >
                {iterationBusy ? (
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Plus size={15} aria-hidden="true" />
                )}
                Create iteration
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </aside>
  );
}

function hasCompletedInitialBuildForCurrentProject(
  projectId: string,
  summaries: ProjectConversationSummary[],
  currentProject: { id: string } | null,
  initialBuildSpec: DevelopmentSpec | null,
  currentSpec: DevelopmentSpec | null,
  historicalSpecs: DevelopmentSpec[],
) {
  return hasCompletedInitialBuildEvidence(
    {
      conversationSummaries: summaries,
      currentProject,
      initialBuildSpec,
      currentSpec,
      historicalSpecs,
    },
    projectId,
  );
}

export function canUseNewIterationShortcut({
  initialBuildCompleted,
  isCurrentProject,
  iterationBusy,
}: {
  initialBuildCompleted: boolean;
  isCurrentProject: boolean;
  iterationBusy: boolean;
}) {
  return isCurrentProject && initialBuildCompleted && !iterationBusy;
}

function formatConversationMarker(conversation: ProjectConversationSummary) {
  if (conversation.kind === "initial_build") {
    return "Spec · Locked";
  }

  return conversation.mode === "spec" ? "Spec" : "Chat";
}

function isInitialBuildCompleted(
  summary: ProjectConversationSummary,
  currentConversation: ProjectConversation | null,
  currentSpec: DevelopmentSpec | null,
  historicalSpecs: DevelopmentSpec[],
) {
  if (summary.kind !== "initial_build" || !summary.activeSpecId) {
    return false;
  }

  return Boolean(
    (
      currentConversation?.id === summary.id &&
      currentSpec?.id === summary.activeSpecId &&
      currentSpec.status === "completed"
    ) ||
      historicalSpecs.some(
        (spec) =>
          spec.id === summary.activeSpecId &&
          spec.conversationId === summary.id &&
          spec.projectId === summary.projectId &&
          spec.status === "completed",
      )
  );
}

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();

  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) {
    return "刚刚";
  }

  if (minutes < 60) {
    return `${minutes}分`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}时`;
  }

  const days = Math.floor(hours / 24);

  if (days < 14) {
    return `${days}天`;
  }

  return `${Math.floor(days / 7)}周`;
}
