import { useState } from "react";
import { Database, MonitorPlay } from "lucide-react";
import { DatabasePanel } from "../database/DatabasePanel";
import { PreviewPanel } from "../preview/PreviewPanel";

type WorkspaceTab = "preview" | "database";

export function WorkspacePanel() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("preview");

  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[40px_minmax(0,1fr)] border-b border-zinc-800 bg-[#0b0b0d]">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3">
        <button
          className={`flex h-7 items-center gap-2 rounded px-2 text-xs font-medium transition ${
            activeTab === "preview"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          }`}
          onClick={() => setActiveTab("preview")}
          type="button"
        >
          <MonitorPlay size={13} aria-hidden="true" />
          Preview
        </button>
        <button
          className={`flex h-7 items-center gap-2 rounded px-2 text-xs font-medium transition ${
            activeTab === "database"
              ? "bg-emerald-400/10 text-emerald-100 ring-1 ring-emerald-400/25"
              : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          }`}
          onClick={() => setActiveTab("database")}
          type="button"
        >
          <Database size={13} aria-hidden="true" />
          Database
        </button>
      </header>
      <div className="min-h-0 min-w-0 overflow-hidden">
        {activeTab === "preview" ? <PreviewPanel /> : <DatabasePanel />}
      </div>
    </section>
  );
}

