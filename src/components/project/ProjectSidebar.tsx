import { FormEvent, MouseEvent, useState } from "react";
import {
  FolderKanban,
  FolderOpen,
  Loader2,
  Plus,
  Settings,
  X,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";

type ProjectSidebarProps = {
  onOpenSettings: () => void;
};

export function ProjectSidebar({ onOpenSettings }: ProjectSidebarProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectPrompt, setProjectPrompt] = useState("");
  const currentProject = useAppStore((state) => state.currentProject);
  const createProject = useAppStore((state) => state.createProject);
  const isCreatingProject = useAppStore((state) => state.isCreatingProject);
  const isLoadingProjects = useAppStore((state) => state.isLoadingProjects);
  const openProjectFolder = useAppStore((state) => state.openProjectFolder);
  const projectError = useAppStore((state) => state.projectError);
  const projects = useAppStore((state) => state.projects);
  const selectProject = useAppStore((state) => state.selectProject);

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
            Project List
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

              return (
                <div
                  className={`group w-full cursor-pointer rounded-md border px-3 py-2 text-left text-sm transition ${
                    isCurrent
                      ? "border-teal-400/40 bg-teal-400/10 text-teal-50"
                      : "border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900"
                  }`}
                  key={project.id}
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
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{project.name}</div>
                      <div className="mt-1 truncate text-xs text-zinc-500">
                        {project.framework}
                      </div>
                    </div>
                    <button
                      aria-label={`Open ${project.name} folder`}
                      className="grid size-7 shrink-0 place-items-center rounded border border-zinc-800 text-zinc-500 opacity-0 transition hover:border-teal-400/40 hover:text-teal-200 group-hover:opacity-100"
                      onClick={(event) =>
                        handleOpenProjectFolder(event, project.id)
                      }
                      title="Open folder"
                      type="button"
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                    </button>
                  </div>
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
                  AI generated Next.js App Router project
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
                Create
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </aside>
  );
}
