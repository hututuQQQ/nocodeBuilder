import { MonitorPlay } from "lucide-react";
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
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-5">
      {activePreviewUrl ? (
        <iframe
          key={`${activePreviewUrl}-${previewRefreshKey}-${deploymentRefreshKey}`}
          className="h-full w-full rounded-md border border-zinc-800 bg-white"
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
