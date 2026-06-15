import { ReactNode } from "react";

type EmptyStateProps = {
  icon: ReactNode;
  title: string;
  detail: string;
};

export function EmptyState({ icon, title, detail }: EmptyStateProps) {
  return (
    <div className="grid h-full min-h-[180px] place-items-center rounded-md border border-dashed border-zinc-800 bg-zinc-900/30 px-6 text-center">
      <div>
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-500">
          {icon}
        </div>
        <p className="text-sm font-medium text-zinc-300">{title}</p>
        <p className="mt-1 max-w-xs text-xs leading-5 text-zinc-600">
          {detail}
        </p>
      </div>
    </div>
  );
}
