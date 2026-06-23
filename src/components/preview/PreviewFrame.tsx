import { useEffect, useMemo, useRef } from "react";
import { MonitorPlay } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { PreviewTab } from "./previewPanelTypes";

type PreviewFrameProps = {
  activePreviewTab: PreviewTab;
  activePreviewUrl: string | null;
  deploymentRefreshKey: number;
  previewRefreshKey: number;
};

export function PreviewFrame({
  activePreviewTab,
  activePreviewUrl,
  deploymentRefreshKey,
  previewRefreshKey,
}: PreviewFrameProps) {
  const setSelectedSiteNode = useAppStore((state) => state.setSelectedSiteNode);
  const recordPreviewDiagnostic = useAppStore((state) => state.recordPreviewDiagnostic);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const expectedPreviewOrigin = useMemo(
    () => getPreviewOrigin(activePreviewUrl),
    [activePreviewUrl],
  );

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      if (!expectedPreviewOrigin || event.origin !== expectedPreviewOrigin) {
        return;
      }

      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      if (!isPreviewBridgeMessage(event.data)) {
        return;
      }

      if (event.data.type === "node-selected") {
        setSelectedSiteNode(event.data.nodeId);
        recordPreviewDiagnostic({
          kind: "node-selected",
          level: "info",
          message: `Selected preview node ${event.data.nodeId}.`,
          nodeId: event.data.nodeId,
          sessionId: activePreviewUrl,
          url: activePreviewUrl ?? undefined,
        });
        return;
      }

      if (event.data.type === "diagnostic") {
        recordPreviewDiagnostic({
          kind: event.data.kind,
          level: event.data.level,
          message: event.data.message,
          sessionId: activePreviewUrl,
          url: event.data.url,
        });
      }
    }

    window.addEventListener("message", handlePreviewMessage);
    return () => window.removeEventListener("message", handlePreviewMessage);
  }, [activePreviewUrl, expectedPreviewOrigin, recordPreviewDiagnostic, setSelectedSiteNode]);

  return (
    <div className="grid min-h-0 flex-1 place-items-center p-5">
      {activePreviewUrl ? (
        <iframe
          key={`${activePreviewUrl}-${previewRefreshKey}-${deploymentRefreshKey}`}
          className="h-full w-full rounded-md border border-zinc-800 bg-white"
          ref={iframeRef}
          src={activePreviewUrl}
          title={
            activePreviewTab === "deployment"
              ? "Vercel deployment"
              : "Local preview"
          }
        />
      ) : (
        <div className="flex w-full max-w-sm flex-col items-center rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center">
          <div className="mb-3 grid size-10 place-items-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-500">
            <MonitorPlay size={18} aria-hidden="true" />
          </div>
          <p className="text-sm font-medium text-zinc-300">
            No preview running
          </p>
          <p className="mt-1 text-xs text-zinc-600">
            Start preview when you want to load the generated app.
          </p>
        </div>
      )}
    </div>
  );
}

function isPreviewBridgeMessage(
  value: unknown,
): value is PreviewBridgeMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (record.source !== "nocode-builder-preview") {
    return false;
  }

  if (record.type === "node-selected") {
    return typeof record.nodeId === "string" && record.nodeId.length > 0;
  }

  return (
    record.type === "diagnostic" &&
    isPreviewDiagnosticKind(record.kind) &&
    isPreviewDiagnosticLevel(record.level) &&
    typeof record.message === "string" &&
    record.message.length > 0
  );
}

type PreviewBridgeMessage =
  | {
      nodeId: string;
      source: "nocode-builder-preview";
      type: "node-selected";
    }
  | {
      kind:
        | "window-error"
        | "unhandled-rejection"
        | "console-error"
        | "failed-image"
        | "failed-resource"
        | "horizontal-overflow";
      level: "error" | "warning" | "info";
      message: string;
      source: "nocode-builder-preview";
      type: "diagnostic";
      url?: string;
    };

function getPreviewOrigin(url: string | null) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isPreviewDiagnosticKind(
  value: unknown,
): value is Extract<PreviewBridgeMessage, { type: "diagnostic" }>["kind"] {
  return [
    "window-error",
    "unhandled-rejection",
    "console-error",
    "failed-image",
    "failed-resource",
    "horizontal-overflow",
  ].includes(String(value));
}

function isPreviewDiagnosticLevel(value: unknown): value is "error" | "warning" | "info" {
  return ["error", "warning", "info"].includes(String(value));
}
