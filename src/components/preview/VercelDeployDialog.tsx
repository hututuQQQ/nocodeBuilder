import { FormEvent } from "react";
import {
  CheckCircle2,
  Loader2,
  Rocket,
} from "lucide-react";
import { VercelDeployTarget } from "../../services/keyStore";
import { Notice } from "./previewPanelTypes";

type VercelDeployDialogProps = {
  isDeploying: boolean;
  isTestingToken: boolean;
  notice: Notice | null;
  onClose: () => void;
  onProjectNameChange: (value: string) => void;
  onScopeChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTargetChange: (value: VercelDeployTarget) => void;
  onTestToken: () => void;
  onTokenChange: (value: string) => void;
  projectName: string;
  scope: string;
  target: VercelDeployTarget;
  token: string;
};

export function VercelDeployDialog({
  isDeploying,
  isTestingToken,
  notice,
  onClose,
  onProjectNameChange,
  onScopeChange,
  onSubmit,
  onTargetChange,
  onTestToken,
  onTokenChange,
  projectName,
  scope,
  target,
  token,
}: VercelDeployDialogProps) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/70 px-4">
      <form
        className="w-full max-w-[440px] rounded-md border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
        onSubmit={onSubmit}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">
              Vercel Deploy
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              Token stays in builder settings and is never written to project files.
            </p>
          </div>
          <button
            className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <label className="mb-3 block">
          <span className="mb-2 block text-xs font-medium text-zinc-400">
            Vercel token
          </span>
          <input
            className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
            onChange={(event) => onTokenChange(event.currentTarget.value)}
            placeholder="vercel token"
            type="password"
            value={token}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-xs font-medium text-zinc-400">
              Scope
            </span>
            <input
              className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
              onChange={(event) => onScopeChange(event.currentTarget.value)}
              placeholder="team-slug"
              value={scope}
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-medium text-zinc-400">
              Existing Vercel project
            </span>
            <input
              className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
              onChange={(event) => onProjectNameChange(event.currentTarget.value)}
              placeholder="optional existing name or ID"
              value={projectName}
            />
            <span className="mt-2 block text-xs leading-5 text-zinc-500">
              Leave empty to let Vercel create or use the linked project.
            </span>
          </label>
        </div>

        <label className="mt-3 block">
          <span className="mb-2 block text-xs font-medium text-zinc-400">
            Default target
          </span>
          <select
            className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/10"
            onChange={(event) =>
              onTargetChange(event.currentTarget.value as VercelDeployTarget)
            }
            value={target}
          >
            <option value="preview">Preview</option>
            <option value="production">Production</option>
          </select>
        </label>

        <div
          aria-live="polite"
          className={`mt-3 min-h-10 rounded-md border px-3 py-2 text-xs ${
            notice?.tone === "error"
              ? "border-red-400/30 bg-red-400/10 text-red-100"
              : notice?.tone === "success"
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                : "border-zinc-800 bg-zinc-900 text-zinc-600"
          }`}
        >
          {notice?.message ?? "Token test result will appear here."}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="flex h-9 items-center gap-2 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!token.trim() || isTestingToken}
            onClick={onTestToken}
            type="button"
          >
            {isTestingToken ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 size={14} aria-hidden="true" />
            )}
            Test
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-md border border-blue-400/30 bg-blue-400/10 px-3 text-sm font-medium text-blue-100 transition hover:border-blue-300/60 hover:bg-blue-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
            disabled={!token.trim() || isDeploying}
            type="submit"
          >
            {isDeploying ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <Rocket size={14} aria-hidden="true" />
            )}
            Save and deploy
          </button>
        </div>
      </form>
    </div>
  );
}
