import { PointerEvent, useEffect, useRef, useState } from "react";
import { ChatPanel } from "../chat/ChatPanel";
import { LogsPanel } from "../logs/LogsPanel";
import { SpecPanel } from "../spec/SpecPanel";
import { WorkspacePanel } from "../workspace/WorkspacePanel";
import { ProjectSidebar } from "../project/ProjectSidebar";
import { initializeCommandEvents, useAppStore } from "../../store/appStore";
import type { ConfiguredModelOption } from "../../App";
import type { AiProviderId } from "../../services/aiProviders";
import { useI18n } from "../../i18n";

type AppShellProps = {
  activeProvider: AiProviderId;
  activeModel: string;
  configuredModelOptions: ConfiguredModelOption[];
  isSavingModel: boolean;
  onChangeModel: (selection: ConfiguredModelOption) => Promise<void>;
  onOpenSettings: () => void;
};

type DragMode = "sidebar" | "right" | "preview" | null;

type ShellLayout = {
  sidebarWidth: number;
  rightWidth: number;
  previewPercent: number;
};

const HORIZONTAL_HANDLE_TOTAL = 12;
const MIN_MIDDLE_WIDTH = 240;
const MIN_RIGHT_WIDTH = 300;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_RIGHT_WIDTH = 860;
const MAX_SIDEBAR_WIDTH = 360;

export function AppShell({
  activeProvider,
  activeModel,
  configuredModelOptions,
  isSavingModel,
  onChangeModel,
  onOpenSettings,
}: AppShellProps) {
  const { t } = useI18n();
  const loadProjects = useAppStore((state) => state.loadProjects);
  const currentConversation = useAppStore((state) => state.currentConversation);
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [layout, setLayout] = useState<ShellLayout>({
    sidebarWidth: 260,
    rightWidth: 520,
    previewPercent: 56,
  });
  const shellRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    initializeCommandEvents();
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    const shell = shellRef.current;

    if (!shell) {
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      setLayout((currentLayout) =>
        clampHorizontalLayout(entry.contentRect.width, currentLayout),
      );
    });

    resizeObserver.observe(shell);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!dragMode) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor =
      dragMode === "preview" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(event: globalThis.PointerEvent) {
      if (dragMode === "preview") {
        const panel = rightPanelRef.current;

        if (!panel) {
          return;
        }

        const rect = panel.getBoundingClientRect();
        const nextPercent = ((event.clientY - rect.top) / rect.height) * 100;

        setLayout((currentLayout) => ({
          ...currentLayout,
          previewPercent: clampPreviewPercent(rect.height, nextPercent),
        }));
        return;
      }

      const shell = shellRef.current;

      if (!shell) {
        return;
      }

      const rect = shell.getBoundingClientRect();

      setLayout((currentLayout) => {
        if (dragMode === "sidebar") {
          return clampHorizontalLayout(rect.width, {
            ...currentLayout,
            sidebarWidth: event.clientX - rect.left,
          });
        }

        return clampHorizontalLayout(rect.width, {
          ...currentLayout,
          rightWidth: rect.right - event.clientX,
        });
      });
    }

    function handlePointerUp() {
      setDragMode(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragMode]);

  function startDrag(mode: Exclude<DragMode, null>) {
    return (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragMode(mode);
    };
  }

  return (
    <div
      className="grid h-dvh w-dvw min-w-0 overflow-hidden bg-zinc-950 text-zinc-100"
      ref={shellRef}
      style={{
        gridTemplateColumns: `${layout.sidebarWidth}px 6px minmax(0, 1fr) 6px ${layout.rightWidth}px`,
      }}
    >
      <ProjectSidebar onOpenSettings={onOpenSettings} />
      <ResizeHandle
        ariaLabel={t("workspace.resizeProjectPanel")}
        dragging={dragMode === "sidebar"}
        onPointerDown={startDrag("sidebar")}
        orientation="vertical"
      />
      {currentConversation?.mode === "spec" ? (
        <SpecPanel
          activeProvider={activeProvider}
          activeModel={activeModel}
          configuredModelOptions={configuredModelOptions}
          isSavingModel={isSavingModel}
          onChangeModel={onChangeModel}
        />
      ) : (
        <ChatPanel
          activeProvider={activeProvider}
          activeModel={activeModel}
          configuredModelOptions={configuredModelOptions}
          isSavingModel={isSavingModel}
          onChangeModel={onChangeModel}
        />
      )}
      <ResizeHandle
        ariaLabel={t("workspace.resizePreviewWorkspace")}
        dragging={dragMode === "right"}
        onPointerDown={startDrag("right")}
        orientation="vertical"
      />
      <section
        className="grid min-h-0 min-w-0 bg-zinc-950"
        ref={rightPanelRef}
        style={{
          gridTemplateRows: `${layout.previewPercent}% 6px minmax(0, 1fr)`,
        }}
      >
        <WorkspacePanel />
        <ResizeHandle
          ariaLabel={t("workspace.resizePreviewFiles")}
          dragging={dragMode === "preview"}
          onPointerDown={startDrag("preview")}
          orientation="horizontal"
        />
        <LogsPanel />
      </section>
    </div>
  );
}

type ResizeHandleProps = {
  ariaLabel: string;
  dragging: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  orientation: "horizontal" | "vertical";
};

function ResizeHandle({
  ariaLabel,
  dragging,
  onPointerDown,
  orientation,
}: ResizeHandleProps) {
  const isVertical = orientation === "vertical";

  return (
    <div
      aria-label={ariaLabel}
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      className={`group grid shrink-0 place-items-center bg-zinc-950 outline-none transition hover:bg-teal-400/10 ${
        isVertical
          ? "cursor-col-resize border-x border-zinc-900"
          : "cursor-row-resize border-y border-zinc-900"
      } ${dragging ? "bg-teal-400/15" : ""}`}
      onPointerDown={onPointerDown}
      role="separator"
      tabIndex={0}
    >
      <div
        className={`rounded-full bg-zinc-700 transition group-hover:bg-teal-300 ${
          dragging ? "bg-teal-300" : ""
        } ${isVertical ? "h-10 w-0.5" : "h-0.5 w-10"}`}
      />
    </div>
  );
}

function clampHorizontalLayout(width: number, layout: ShellLayout): ShellLayout {
  const maxSidebar = Math.min(
    MAX_SIDEBAR_WIDTH,
    width - HORIZONTAL_HANDLE_TOTAL - MIN_MIDDLE_WIDTH - MIN_RIGHT_WIDTH,
  );
  const sidebarWidth = clamp(
    layout.sidebarWidth,
    MIN_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, maxSidebar),
  );
  const maxRight = Math.min(
    MAX_RIGHT_WIDTH,
    width - HORIZONTAL_HANDLE_TOTAL - MIN_MIDDLE_WIDTH - sidebarWidth,
  );
  const rightWidth = clamp(
    layout.rightWidth,
    MIN_RIGHT_WIDTH,
    Math.max(MIN_RIGHT_WIDTH, maxRight),
  );

  return {
    ...layout,
    rightWidth: Math.round(rightWidth),
    sidebarWidth: Math.round(sidebarWidth),
  };
}

function clampPreviewPercent(height: number, percent: number) {
  const minPreviewHeight = 160;
  const minFilesHeight = 180;
  const handleHeight = 6;
  const minPercent = (minPreviewHeight / height) * 100;
  const maxPercent = ((height - minFilesHeight - handleHeight) / height) * 100;

  return clamp(percent, minPercent, maxPercent);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

