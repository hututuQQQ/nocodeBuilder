
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { loadProjectEnvConfig, saveProjectSupabaseConfig, type ProjectSupabaseConfig } from "../../services/projectEnv";
import {
  SupabaseRestClient,
  type SupabaseAlterTableOperation,
  type SupabaseCreateTableColumn,
  type SupabaseColumn,
  type SupabaseRow,
  type SupabaseTable,
} from "../../services/supabaseRest";
import { useAppStore } from "../../store/appStore";

type Notice = { tone: "error" | "success"; message: string };
type RowFormState = {
  mode: "create" | "edit";
  originalRow?: SupabaseRow;
  values: Record<string, string>;
};
type TableColumnDraft = SupabaseCreateTableColumn & { id: string };
type TableFormState = {
  columns: TableColumnDraft[];
  enableRls: boolean;
  name: string;
};
type ColumnEditDraft = {
  dataType: string;
  defaultValue: string;
  dropped: boolean;
  id: string;
  isNew: boolean;
  isPrimaryKey: boolean;
  name: string;
  nullable: boolean;
  originalDataType: string;
  originalName: string;
  originalNullable: boolean;
  unique: boolean;
};
type ColumnEditorState = {
  columns: ColumnEditDraft[];
  tableName: string;
};

const PAGE_SIZE = 25;
const COLUMN_TYPES = [
  { label: "Text", value: "text" },
  { label: "Integer", value: "integer" },
  { label: "Bigint", value: "bigint" },
  { label: "Numeric", value: "numeric" },
  { label: "Boolean", value: "boolean" },
  { label: "UUID", value: "uuid" },
  { label: "Timestamp", value: "timestamptz" },
  { label: "Date", value: "date" },
  { label: "JSONB", value: "jsonb" },
];

export function DatabasePanel() {
  const currentProject = useAppStore((state) => state.currentProject);
  const [config, setConfig] = useState<ProjectSupabaseConfig | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [anonKeyDraft, setAnonKeyDraft] = useState("");
  const [secretKeyDraft, setSecretKeyDraft] = useState("");
  const [dbUrlDraft, setDbUrlDraft] = useState("");
  const [schemaDraft, setSchemaDraft] = useState("public");
  const [tables, setTables] = useState<SupabaseTable[]>([]);
  const [selectedTableName, setSelectedTableName] = useState("");
  const [rows, setRows] = useState<SupabaseRow[]>([]);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<string | undefined>();
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isLoadingTables, setIsLoadingTables] = useState(false);
  const [isLoadingRows, setIsLoadingRows] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isCreatingTable, setIsCreatingTable] = useState(false);
  const [isUpdatingColumns, setIsUpdatingColumns] = useState(false);
  const [isSavingRow, setIsSavingRow] = useState(false);
  const [rowForm, setRowForm] = useState<RowFormState | null>(null);
  const [tableForm, setTableForm] = useState<TableFormState | null>(null);
  const [columnEditor, setColumnEditor] = useState<ColumnEditorState | null>(null);

  const selectedTable = useMemo(
    () => tables.find((table) => table.name === selectedTableName) ?? null,
    [selectedTableName, tables],
  );
  const totalPages = rowCount === null ? null : Math.max(1, Math.ceil(rowCount / PAGE_SIZE));
  const canGoForward = totalPages === null ? rows.length === PAGE_SIZE : page + 1 < totalPages;

  useEffect(() => {
    let isActive = true;

    async function loadProjectConfig() {
      setConfig(null);
      setTables([]);
      setSelectedTableName("");
      setRows([]);
      setRowCount(null);
      setPage(0);
      setSearch("");
      setSearchDraft("");
      setNotice(null);

      if (!currentProject) return;
      setIsLoadingConfig(true);

      try {
        const projectEnv = await loadProjectEnvConfig(currentProject.id);
        const storedConfig = projectEnv.supabase;
        if (!isActive) return;
        setConfig(storedConfig);
        setUrlDraft(storedConfig?.url ?? "");
        setAnonKeyDraft(storedConfig?.anonKey ?? "");
        setSecretKeyDraft(storedConfig?.secretKey ?? "");
        setDbUrlDraft(storedConfig?.dbUrl ?? "");
        setSchemaDraft(storedConfig?.schema ?? "public");
        setIsConfigOpen(!storedConfig || !storedConfig.secretKey);
        if (storedConfig) await loadTables(storedConfig, isActive);
      } catch (error) {
        if (isActive) setNotice({ tone: "error", message: getReadableError(error) });
      } finally {
        if (isActive) setIsLoadingConfig(false);
      }
    }

    void loadProjectConfig();
    return () => { isActive = false; };
  }, [currentProject?.id]);

  useEffect(() => {
    if (config && selectedTable) void loadRows(config, selectedTable);
  }, [config, page, search, selectedTable, sortColumn, sortDirection]);

  async function loadTables(nextConfig: ProjectSupabaseConfig, isActive = true) {
    setIsLoadingTables(true);
    setNotice(null);
    try {
      const nextTables = await new SupabaseRestClient(nextConfig).listTables();
      if (!isActive) return;
      setTables(nextTables);
      setSelectedTableName((currentName) =>
        nextTables.some((table) => table.name === currentName)
          ? currentName
          : nextTables[0]?.name ?? "",
      );
      setNotice({
        tone: "success",
        message: nextTables.length > 0
          ? `Connected to ${nextTables.length} table(s) for ${currentProject?.name ?? "this project"}.`
          : "Connected, but no readable tables were found in this schema.",
      });
    } catch (error) {
      if (isActive) {
        setTables([]);
        setSelectedTableName("");
        setRows([]);
        setRowCount(null);
        setNotice({ tone: "error", message: getReadableError(error) });
      }
    } finally {
      if (isActive) setIsLoadingTables(false);
    }
  }

  async function loadRows(nextConfig: ProjectSupabaseConfig, table: SupabaseTable) {
    setIsLoadingRows(true);
    try {
      const result = await new SupabaseRestClient(nextConfig).listRows({
        page,
        pageSize: PAGE_SIZE,
        search,
        sortColumn,
        sortDirection,
        table,
      });
      setRows(result.rows);
      setRowCount(result.count);
    } catch (error) {
      setRows([]);
      setRowCount(null);
      setNotice({ tone: "error", message: getReadableError(error) });
    } finally {
      setIsLoadingRows(false);
    }
  }

  async function handleSaveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentProject) return;

    const validationError = validateConfigDraft(urlDraft, anonKeyDraft, secretKeyDraft);
    if (validationError) {
      setNotice({ tone: "error", message: validationError });
      return;
    }

    setIsTesting(true);
    setNotice(null);
    try {
      const draftConfig: ProjectSupabaseConfig = {
        provider: "supabase",
        url: urlDraft.trim().replace(/\/+$/, ""),
        anonKey: anonKeyDraft.trim(),
        secretKey: secretKeyDraft.trim(),
        dbUrl: dbUrlDraft.trim(),
        schema: schemaDraft.trim() || "public",
        updatedAt: "",
      };

      const client = new SupabaseRestClient(draftConfig);
      await Promise.all([
        client.testConnection(),
        client.testDatabaseConnection(),
      ]);
      const nextConfig = await saveProjectSupabaseConfig(currentProject.id, {
        anonKey: anonKeyDraft,
        dbUrl: dbUrlDraft,
        schema: schemaDraft,
        secretKey: secretKeyDraft,
        url: urlDraft,
      });
      setConfig(nextConfig);
      setIsConfigOpen(false);
      await loadTables(nextConfig);
    } catch (error) {
      setNotice({ tone: "error", message: getReadableError(error) });
    } finally {
      setIsTesting(false);
    }
  }

  async function handleRefresh() {
    if (!config) return;
    await loadTables(config);
    if (selectedTable) await loadRows(config, selectedTable);
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(0);
    setSearch(searchDraft.trim());
  }

  function handleSelectTable(tableName: string) {
    setSelectedTableName(tableName);
    setPage(0);
    setRows([]);
    setRowCount(null);
    setSortColumn(undefined);
    setSortDirection("asc");
  }

  function handleSort(columnName: string) {
    setPage(0);
    setSortColumn((currentColumn) => {
      if (currentColumn === columnName) {
        setSortDirection((currentDirection) =>
          currentDirection === "asc" ? "desc" : "asc",
        );
        return currentColumn;
      }
      setSortDirection("asc");
      return columnName;
    });
  }

  function openCreateForm() {
    if (!selectedTable) return;
    setRowForm({
      mode: "create",
      values: Object.fromEntries(selectedTable.columns.map((column) => [column.name, ""])),
    });
  }

  function openEditForm(row: SupabaseRow) {
    if (!selectedTable) return;
    setRowForm({
      mode: "edit",
      originalRow: row,
      values: Object.fromEntries(
        selectedTable.columns.map((column) => [column.name, formatFormValue(row[column.name])]),
      ),
    });
  }

  async function handleSaveRow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !selectedTable || !rowForm) return;

    setIsSavingRow(true);
    setNotice(null);
    try {
      const payload = parseRowPayload(selectedTable.columns, rowForm.values, rowForm.mode);
      const client = new SupabaseRestClient(config);
      if (rowForm.mode === "create") {
        await client.insertRow(selectedTable, payload);
      } else if (rowForm.originalRow) {
        await client.updateRow(selectedTable, rowForm.originalRow, payload);
      }
      setRowForm(null);
      await loadRows(config, selectedTable);
      setNotice({ tone: "success", message: rowForm.mode === "create" ? "Row inserted." : "Row updated." });
    } catch (error) {
      setNotice({ tone: "error", message: getReadableError(error) });
    } finally {
      setIsSavingRow(false);
    }
  }

  async function handleDeleteRow(row: SupabaseRow) {
    if (!config || !selectedTable) return;
    if (!window.confirm(`Delete this row from ${selectedTable.name}?`)) return;

    setNotice(null);
    try {
      await new SupabaseRestClient(config).deleteRow(selectedTable, row);
      await loadRows(config, selectedTable);
      setNotice({ tone: "success", message: "Row deleted." });
    } catch (error) {
      setNotice({ tone: "error", message: getReadableError(error) });
    }
  }

  function openCreateTableForm() {
    if (!config) return;
    if (!config.dbUrl.trim()) {
      setNotice({
        tone: "error",
        message: "Add SUPABASE_DB_URL in Supabase settings before creating tables.",
      });
      setIsConfigOpen(true);
      return;
    }

    setTableForm(createDefaultTableForm());
  }

  async function handleCreateTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !tableForm) return;

    const validationError = validateTableForm(tableForm);
    if (validationError) {
      setNotice({ tone: "error", message: validationError });
      return;
    }

    setIsCreatingTable(true);
    setNotice(null);
    try {
      const tableName = tableForm.name.trim();
      await new SupabaseRestClient(config).createTable({
        columns: tableForm.columns.map(({ id: _id, ...column }) => ({
          ...column,
          name: column.name.trim(),
        })),
        enableRls: tableForm.enableRls,
        tableName,
      });
      setTableForm(null);
      setRows([]);
      setRowCount(null);
      setPage(0);
      await delay(500);
      await loadTables(config);
      setSelectedTableName(tableName);
      setNotice({ tone: "success", message: `Table ${tableName} created.` });
    } catch (error) {
      setNotice({ tone: "error", message: getReadableError(error) });
    } finally {
      setIsCreatingTable(false);
    }
  }

  function openColumnEditor() {
    if (!config || !selectedTable) return;
    if (!config.dbUrl.trim()) {
      setNotice({
        tone: "error",
        message: "Add SUPABASE_DB_URL in Supabase settings before editing columns.",
      });
      setIsConfigOpen(true);
      return;
    }

    setColumnEditor(createColumnEditorState(selectedTable));
  }

  async function handleSaveColumns(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !columnEditor) return;

    const validationError = validateColumnEditor(columnEditor);
    if (validationError) {
      setNotice({ tone: "error", message: validationError });
      return;
    }

    const operations = createAlterTableOperations(columnEditor);
    if (operations.length === 0) {
      setColumnEditor(null);
      return;
    }

    setIsUpdatingColumns(true);
    setNotice(null);
    try {
      await new SupabaseRestClient(config).alterTable({
        operations,
        tableName: columnEditor.tableName,
      });
      setColumnEditor(null);
      setRows([]);
      setRowCount(null);
      setPage(0);
      await delay(500);
      await loadTables(config);
      setSelectedTableName(columnEditor.tableName);
      setNotice({ tone: "success", message: "Columns updated." });
    } catch (error) {
      setNotice({ tone: "error", message: getReadableError(error) });
    } finally {
      setIsUpdatingColumns(false);
    }
  }

  async function handleDeleteTable() {
    if (!config || !selectedTable) return;
    if (!config.dbUrl.trim()) {
      setNotice({
        tone: "error",
        message: "Add SUPABASE_DB_URL in Supabase settings before deleting tables.",
      });
      setIsConfigOpen(true);
      return;
    }
    if (!window.confirm(`Delete table ${selectedTable.name}? This cannot be undone.`)) return;

    setIsLoadingTables(true);
    setNotice(null);
    try {
      await new SupabaseRestClient(config).dropTable(selectedTable.name);
      setRows([]);
      setRowCount(null);
      setSelectedTableName("");
      await delay(500);
      await loadTables(config);
      setNotice({ tone: "success", message: `Table ${selectedTable.name} deleted.` });
    } catch (error) {
      setNotice({ tone: "error", message: getReadableError(error) });
    } finally {
      setIsLoadingTables(false);
    }
  }

  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-col border-b border-zinc-800 bg-[#0b0b0d]">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-zinc-800 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Database size={16} className="shrink-0 text-emerald-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-100">Database</h2>
            <p className="truncate text-[11px] text-zinc-600">
              {currentProject ? `${currentProject.name} / ${config?.schema ?? "not connected"}` : "No project selected"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            aria-label="Refresh database"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!config || isLoadingTables || isLoadingRows}
            onClick={() => void handleRefresh()}
            title="Refresh"
            type="button"
          >
            {isLoadingTables || isLoadingRows ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCcw size={14} aria-hidden="true" />}
          </button>
          <button
            aria-label="Configure Supabase"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!currentProject}
            onClick={() => setIsConfigOpen(true)}
            title="Supabase settings"
            type="button"
          >
            <KeyRound size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      {!currentProject ? (
        <EmptyDatabaseState title="No project selected" message="Select a generated project to manage its Supabase database." />
      ) : isLoadingConfig ? (
        <EmptyDatabaseState title="Loading database" message="Reading this project's Supabase connection." loading />
      ) : !config ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SupabaseConfigForm
            anonKeyDraft={anonKeyDraft}
            dbUrlDraft={dbUrlDraft}
            isTesting={isTesting}
            notice={notice}
            onAnonKeyChange={setAnonKeyDraft}
            onDbUrlChange={setDbUrlDraft}
            onSchemaChange={setSchemaDraft}
            onSecretKeyChange={setSecretKeyDraft}
            onSubmit={handleSaveConfig}
            onUrlChange={setUrlDraft}
            projectName={currentProject.name}
            schemaDraft={schemaDraft}
            secretKeyDraft={secretKeyDraft}
            urlDraft={urlDraft}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[150px_minmax(0,1fr)] overflow-hidden">
          <aside className="flex min-h-0 flex-col border-r border-zinc-800 bg-zinc-950/50">
            <div className="flex h-10 items-center justify-between gap-2 border-b border-zinc-800 px-3 text-xs font-semibold text-zinc-400">
              <div className="flex min-w-0 items-center gap-2">
                <Table2 size={13} aria-hidden="true" />
                <span className="truncate">Tables</span>
              </div>
              <button
                aria-label="Create table"
                className="grid size-6 shrink-0 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                disabled={!config}
                onClick={openCreateTableForm}
                title="New table"
                type="button"
              >
                <Plus size={12} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {tables.length === 0 ? (
                <p className="px-2 py-4 text-xs leading-5 text-zinc-600">No readable tables.</p>
              ) : tables.map((table) => (
                <button
                  className={`mb-1 flex h-8 w-full items-center justify-between rounded px-2 text-left text-xs transition ${selectedTableName === table.name ? "bg-emerald-400/10 text-emerald-100 ring-1 ring-emerald-400/25" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"}`}
                  key={table.name}
                  onClick={() => handleSelectTable(table.name)}
                  title={table.name}
                  type="button"
                >
                  <span className="truncate">{table.name}</span>
                  <span className="text-[10px] text-zinc-600">{table.columns.length}</span>
                </button>
              ))}
            </div>
          </aside>

          <main className="flex min-h-0 min-w-0 flex-col">
            <div className="flex h-10 shrink-0 items-center justify-between gap-2 overflow-x-auto border-b border-zinc-800 px-3">
              <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={handleSearchSubmit}>
                <Search size={14} className="shrink-0 text-zinc-600" aria-hidden="true" />
                <input
                  className="h-7 min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/10"
                  onChange={(event) => setSearchDraft(event.currentTarget.value)}
                  placeholder="Search text columns"
                  value={searchDraft}
                />
              </form>
              <button
                className="flex h-7 shrink-0 items-center gap-1.5 rounded border border-zinc-800 px-2 text-xs font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                disabled={!selectedTable}
                onClick={openColumnEditor}
                type="button"
              >
                <Pencil size={13} aria-hidden="true" />
                Columns
              </button>
              <button
                aria-label="Delete table"
                className="grid size-7 shrink-0 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                disabled={!selectedTable || isLoadingTables}
                onClick={() => void handleDeleteTable()}
                title="Delete table"
                type="button"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
              <button
                className="flex h-7 shrink-0 items-center gap-1.5 rounded border border-emerald-400/30 bg-emerald-400/10 px-2 text-xs font-medium text-emerald-100 transition hover:border-emerald-300/60 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                disabled={!selectedTable}
                onClick={openCreateForm}
                type="button"
              >
                <Plus size={13} aria-hidden="true" />
                New
              </button>
            </div>

            {notice ? <NoticeBar notice={notice} /> : null}

            {!selectedTable ? (
              <EmptyDatabaseState title="Select a table" message="Choose a Supabase table to inspect rows." />
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-zinc-950 text-zinc-500">
                    <tr>
                      <th className="w-20 border-b border-zinc-800 px-3 py-2 font-medium">Actions</th>
                      {selectedTable.columns.map((column) => (
                        <th className="border-b border-zinc-800 px-3 py-2 font-medium" key={column.name}>
                          <button className="flex max-w-[180px] items-center gap-1 truncate text-left transition hover:text-zinc-200" onClick={() => handleSort(column.name)} type="button">
                            <span className="truncate">{column.name}</span>
                            {sortColumn === column.name ? <span className="text-[10px] text-emerald-300">{sortDirection}</span> : null}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {isLoadingRows ? (
                      <tr><td className="px-3 py-8 text-center text-zinc-500" colSpan={selectedTable.columns.length + 1}><Loader2 size={16} className="mx-auto mb-2 animate-spin" aria-hidden="true" />Loading rows</td></tr>
                    ) : rows.length === 0 ? (
                      <tr><td className="px-3 py-8 text-center text-zinc-600" colSpan={selectedTable.columns.length + 1}>No rows found.</td></tr>
                    ) : rows.map((row, rowIndex) => (
                      <tr className="group hover:bg-zinc-900/60" key={createRowKey(row, rowIndex)}>
                        <td className="border-b border-zinc-900 px-3 py-2">
                          <div className="flex items-center gap-1">
                            <button aria-label="Edit row" className="grid size-7 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200" onClick={() => openEditForm(row)} title="Edit" type="button"><Pencil size={12} aria-hidden="true" /></button>
                            <button aria-label="Delete row" className="grid size-7 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-red-400/40 hover:text-red-200" onClick={() => void handleDeleteRow(row)} title="Delete" type="button"><Trash2 size={12} aria-hidden="true" /></button>
                          </div>
                        </td>
                        {selectedTable.columns.map((column) => (
                          <td className="max-w-[240px] border-b border-zinc-900 px-3 py-2 text-zinc-300" key={column.name}>
                            <span className="block truncate" title={formatCellValue(row[column.name])}>{formatCellValue(row[column.name])}</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <footer className="flex h-10 shrink-0 items-center justify-between border-t border-zinc-800 px-3 text-xs text-zinc-500">
              <span>{selectedTable ? `${selectedTable.name}${rowCount === null ? "" : ` / ${rowCount} rows`}` : "No table"}</span>
              <div className="flex items-center gap-2">
                <button aria-label="Previous page" className="grid size-7 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700" disabled={page === 0} onClick={() => setPage((currentPage) => Math.max(0, currentPage - 1))} type="button"><ChevronLeft size={13} aria-hidden="true" /></button>
                <span>Page {page + 1}{totalPages ? ` / ${totalPages}` : ""}</span>
                <button aria-label="Next page" className="grid size-7 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700" disabled={!canGoForward} onClick={() => setPage((currentPage) => currentPage + 1)} type="button"><ChevronRight size={13} aria-hidden="true" /></button>
              </div>
            </footer>
          </main>
        </div>
      )}

      {isConfigOpen && currentProject && config ? (
        <div className="absolute inset-0 z-20 overflow-y-auto bg-black/70 p-4">
          <div className="mx-auto w-full max-w-[460px] rounded-md border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Supabase Settings</h3>
                <p className="mt-1 text-xs text-zinc-500">Saved to {currentProject.name}/.env.</p>
              </div>
              <button aria-label="Close Supabase settings" className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200" onClick={() => setIsConfigOpen(false)} type="button"><X size={14} aria-hidden="true" /></button>
            </div>
            <SupabaseConfigForm anonKeyDraft={anonKeyDraft} compact dbUrlDraft={dbUrlDraft} isTesting={isTesting} notice={notice} onAnonKeyChange={setAnonKeyDraft} onDbUrlChange={setDbUrlDraft} onSchemaChange={setSchemaDraft} onSecretKeyChange={setSecretKeyDraft} onSubmit={handleSaveConfig} onUrlChange={setUrlDraft} projectName={currentProject.name} schemaDraft={schemaDraft} secretKeyDraft={secretKeyDraft} urlDraft={urlDraft} />
          </div>
        </div>
      ) : null}

      {tableForm ? (
        <TableFormDialog
          form={tableForm}
          isSaving={isCreatingTable}
          onAddColumn={() => setTableForm((currentForm) => currentForm ? { ...currentForm, columns: [...currentForm.columns, createBlankColumnDraft()] } : currentForm)}
          onChange={(nextForm) => setTableForm(nextForm)}
          onClose={() => setTableForm(null)}
          onRemoveColumn={(columnId) => setTableForm((currentForm) => currentForm ? { ...currentForm, columns: currentForm.columns.filter((column) => column.id !== columnId) } : currentForm)}
          onSubmit={handleCreateTable}
        />
      ) : null}

      {columnEditor ? (
        <ColumnEditorDialog
          editor={columnEditor}
          isSaving={isUpdatingColumns}
          onAddColumn={() => setColumnEditor((currentEditor) => currentEditor ? { ...currentEditor, columns: [...currentEditor.columns, createNewColumnEditDraft()] } : currentEditor)}
          onChange={setColumnEditor}
          onClose={() => setColumnEditor(null)}
          onSubmit={handleSaveColumns}
        />
      ) : null}

      {rowForm && selectedTable ? (
        <RowFormDialog
          columns={selectedTable.columns}
          form={rowForm}
          isSaving={isSavingRow}
          onChange={(columnName, value) => setRowForm((currentForm) => currentForm ? { ...currentForm, values: { ...currentForm.values, [columnName]: value } } : currentForm)}
          onClose={() => setRowForm(null)}
          onSubmit={handleSaveRow}
          tableName={selectedTable.name}
        />
      ) : null}
    </section>
  );
}

function SupabaseConfigForm({ anonKeyDraft, compact = false, dbUrlDraft, isTesting, notice, onAnonKeyChange, onDbUrlChange, onSchemaChange, onSecretKeyChange, onSubmit, onUrlChange, projectName, schemaDraft, secretKeyDraft, urlDraft }: {
  anonKeyDraft: string;
  compact?: boolean;
  dbUrlDraft: string;
  isTesting: boolean;
  notice: Notice | null;
  onAnonKeyChange: (value: string) => void;
  onDbUrlChange: (value: string) => void;
  onSchemaChange: (value: string) => void;
  onSecretKeyChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUrlChange: (value: string) => void;
  projectName: string;
  schemaDraft: string;
  secretKeyDraft: string;
  urlDraft: string;
}) {
  return (
    <form className={compact ? "" : "mx-auto w-full max-w-[520px] p-5"} onSubmit={onSubmit}>
      {!compact ? <div className="mb-5"><h3 className="text-sm font-semibold text-zinc-100">Connect Supabase</h3><p className="mt-1 text-xs leading-5 text-zinc-500">This connection is read from and saved to {projectName}/.env. The public key is for generated apps, the secret key is used for row data, and the database URL is used for schema changes.</p></div> : null}
      <label className="mb-3 block"><span className="mb-2 block text-xs font-medium text-zinc-400">Project URL</span><input className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" onChange={(event) => onUrlChange(event.currentTarget.value)} placeholder="https://your-project.supabase.co" value={urlDraft} /></label>
      <label className="mb-3 block"><span className="mb-2 block text-xs font-medium text-zinc-400">Public / anon key</span><input className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" onChange={(event) => onAnonKeyChange(event.currentTarget.value)} placeholder="sb_publishable_... or legacy anon key" type="password" value={anonKeyDraft} /></label>
      <label className="mb-3 block"><span className="mb-2 block text-xs font-medium text-zinc-400">Secret key</span><input className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" onChange={(event) => onSecretKeyChange(event.currentTarget.value)} placeholder="sb_secret_... or service_role key" type="password" value={secretKeyDraft} /></label>
      <label className="mb-3 block"><span className="mb-2 block text-xs font-medium text-zinc-400">Database URL</span><input className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" onChange={(event) => onDbUrlChange(event.currentTarget.value)} placeholder="postgresql://postgres.project-ref:...@...pooler.supabase.com:5432/postgres?sslmode=require" type="password" value={dbUrlDraft} /><span className="mt-2 block text-[11px] leading-5 text-zinc-500">For schema changes, use Supabase Connect &gt; Connection Pooler &gt; Session mode. Direct db.* URLs can be IPv6-only and may fail on IPv4 networks. Pooler usernames usually look like postgres.project-ref.</span></label>
      <label className="mb-3 block"><span className="mb-2 block text-xs font-medium text-zinc-400">Schema</span><input className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" onChange={(event) => onSchemaChange(event.currentTarget.value)} placeholder="public" value={schemaDraft} /></label>
      {notice ? <NoticeBar notice={notice} /> : null}
      <div className="mt-4 flex justify-end"><button className="flex h-9 items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/60 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600" disabled={isTesting} type="submit">{isTesting ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}Save and connect</button></div>
    </form>
  );
}

function TableFormDialog({ form, isSaving, onAddColumn, onChange, onClose, onRemoveColumn, onSubmit }: {
  form: TableFormState;
  isSaving: boolean;
  onAddColumn: () => void;
  onChange: (form: TableFormState) => void;
  onClose: () => void;
  onRemoveColumn: (columnId: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  function updateColumn(columnId: string, updates: Partial<TableColumnDraft>) {
    onChange({
      ...form,
      columns: form.columns.map((column) =>
        column.id === columnId ? { ...column, ...updates } : column,
      ),
    });
  }

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto bg-black/70 p-4">
      <form className="mx-auto flex max-h-full w-full max-w-[780px] flex-col rounded-md border border-zinc-800 bg-zinc-950 shadow-2xl" onSubmit={onSubmit}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800 p-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">New table</h3>
            <p className="mt-1 text-xs text-zinc-500">Create a table in the configured Supabase schema.</p>
          </div>
          <button aria-label="Close table editor" className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200" onClick={onClose} type="button"><X size={14} aria-hidden="true" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
            <label className="block">
              <span className="mb-2 block text-xs font-medium text-zinc-400">Table name</span>
              <input className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" onChange={(event) => onChange({ ...form, name: event.currentTarget.value })} placeholder="customers" value={form.name} />
            </label>
            <label className="flex h-10 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-300">
              <input checked={form.enableRls} className="accent-emerald-400" onChange={(event) => onChange({ ...form, enableRls: event.currentTarget.checked })} type="checkbox" />
              Enable RLS
            </label>
          </div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-zinc-400">Columns</h4>
            <button className="flex h-8 items-center gap-1.5 rounded border border-zinc-800 px-2 text-xs text-zinc-400 transition hover:border-emerald-400/40 hover:text-emerald-100" onClick={onAddColumn} type="button"><Plus size={13} aria-hidden="true" />Column</button>
          </div>
          <div className="min-w-[700px] space-y-2">
            {form.columns.map((column) => (
              <div className="grid grid-cols-[minmax(120px,1.2fr)_minmax(110px,0.9fr)_minmax(110px,0.9fr)_repeat(3,auto)_32px] items-end gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 p-2" key={column.id}>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-zinc-500">Name</span>
                  <input className="h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/50" onChange={(event) => updateColumn(column.id, { name: event.currentTarget.value })} placeholder="column_name" value={column.name} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-zinc-500">Type</span>
                  <select className="h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none transition focus:border-emerald-400/50" onChange={(event) => updateColumn(column.id, { dataType: event.currentTarget.value, defaultValue: defaultForType(event.currentTarget.value) })} value={column.dataType}>
                    {COLUMN_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-zinc-500">Default</span>
                  <select className="h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none transition focus:border-emerald-400/50" onChange={(event) => updateColumn(column.id, { defaultValue: event.currentTarget.value })} value={column.defaultValue ?? "none"}>
                    {defaultOptionsForType(column.dataType).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="flex h-9 items-center gap-1.5 rounded border border-zinc-800 px-2 text-[11px] text-zinc-400"><input checked={column.nullable} className="accent-emerald-400" disabled={column.primaryKey} onChange={(event) => updateColumn(column.id, { nullable: event.currentTarget.checked })} type="checkbox" />Null</label>
                <label className="flex h-9 items-center gap-1.5 rounded border border-zinc-800 px-2 text-[11px] text-zinc-400"><input checked={column.primaryKey} className="accent-emerald-400" onChange={(event) => updateColumn(column.id, { nullable: event.currentTarget.checked ? false : column.nullable, primaryKey: event.currentTarget.checked, unique: event.currentTarget.checked ? false : column.unique })} type="checkbox" />PK</label>
                <label className="flex h-9 items-center gap-1.5 rounded border border-zinc-800 px-2 text-[11px] text-zinc-400"><input checked={column.unique} className="accent-emerald-400" disabled={column.primaryKey} onChange={(event) => updateColumn(column.id, { unique: event.currentTarget.checked })} type="checkbox" />Unique</label>
                <button aria-label="Remove column" className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:text-zinc-700" disabled={form.columns.length <= 1} onClick={() => onRemoveColumn(column.id)} title="Remove column" type="button"><Trash2 size={13} aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-800 p-4">
          <button className="h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200" onClick={onClose} type="button">Cancel</button>
          <button className="flex h-9 items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/60 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600" disabled={isSaving} type="submit">{isSaving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}Create table</button>
        </div>
      </form>
    </div>
  );
}

function ColumnEditorDialog({ editor, isSaving, onAddColumn, onChange, onClose, onSubmit }: {
  editor: ColumnEditorState;
  isSaving: boolean;
  onAddColumn: () => void;
  onChange: (editor: ColumnEditorState) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  function updateColumn(columnId: string, updates: Partial<ColumnEditDraft>) {
    onChange({
      ...editor,
      columns: editor.columns.map((column) =>
        column.id === columnId ? { ...column, ...updates } : column,
      ),
    });
  }

  function removeColumn(column: ColumnEditDraft) {
    if (column.isNew) {
      onChange({
        ...editor,
        columns: editor.columns.filter((item) => item.id !== column.id),
      });
      return;
    }

    updateColumn(column.id, { dropped: !column.dropped });
  }

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto bg-black/70 p-4">
      <form className="mx-auto flex max-h-full w-full max-w-[860px] flex-col rounded-md border border-zinc-800 bg-zinc-950 shadow-2xl" onSubmit={onSubmit}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800 p-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Edit columns</h3>
            <p className="mt-1 text-xs text-zinc-500">{editor.tableName}</p>
          </div>
          <button aria-label="Close column editor" className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200" onClick={onClose} type="button"><X size={14} aria-hidden="true" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-zinc-400">Columns</h4>
            <button className="flex h-8 items-center gap-1.5 rounded border border-zinc-800 px-2 text-xs text-zinc-400 transition hover:border-emerald-400/40 hover:text-emerald-100" onClick={onAddColumn} type="button"><Plus size={13} aria-hidden="true" />Column</button>
          </div>
          <div className="min-w-[760px] space-y-2">
            {editor.columns.map((column) => (
              <div className={`grid grid-cols-[minmax(120px,1.2fr)_minmax(110px,0.9fr)_minmax(120px,0.9fr)_repeat(3,auto)_32px] items-end gap-2 rounded-md border p-2 ${column.dropped ? "border-red-400/20 bg-red-400/5 opacity-70" : "border-zinc-800 bg-zinc-900/50"}`} key={column.id}>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-zinc-500">Name</span>
                  <input className="h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/50 disabled:text-zinc-600" disabled={column.dropped} onChange={(event) => updateColumn(column.id, { name: event.currentTarget.value })} placeholder="column_name" value={column.name} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-zinc-500">Type</span>
                  <select className="h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none transition focus:border-emerald-400/50 disabled:text-zinc-600" disabled={column.dropped} onChange={(event) => updateColumn(column.id, { dataType: event.currentTarget.value, defaultValue: column.defaultValue === "unchanged" ? "unchanged" : defaultForType(event.currentTarget.value) })} value={column.dataType}>
                    {COLUMN_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-zinc-500">Default</span>
                  <select className="h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none transition focus:border-emerald-400/50 disabled:text-zinc-600" disabled={column.dropped} onChange={(event) => updateColumn(column.id, { defaultValue: event.currentTarget.value })} value={column.defaultValue}>
                    {defaultOptionsForType(column.dataType, !column.isNew).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="flex h-9 items-center gap-1.5 rounded border border-zinc-800 px-2 text-[11px] text-zinc-400"><input checked={column.nullable} className="accent-emerald-400" disabled={column.dropped || column.isPrimaryKey} onChange={(event) => updateColumn(column.id, { nullable: event.currentTarget.checked })} type="checkbox" />Null</label>
                <label className="flex h-9 items-center gap-1.5 rounded border border-zinc-800 px-2 text-[11px] text-zinc-400"><input checked={column.unique} className="accent-emerald-400" disabled={column.dropped || !column.isNew} onChange={(event) => updateColumn(column.id, { unique: event.currentTarget.checked })} type="checkbox" />Unique</label>
                <span className="flex h-9 items-center rounded border border-zinc-800 px-2 text-[11px] text-zinc-500">{column.isNew ? "New" : column.isPrimaryKey ? "PK" : "Existing"}</span>
                <button aria-label={column.dropped ? "Restore column" : "Remove column"} className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:text-zinc-700" disabled={column.isPrimaryKey && !column.isNew} onClick={() => removeColumn(column)} title={column.dropped ? "Restore column" : "Remove column"} type="button">{column.dropped ? <RefreshCcw size={13} aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}</button>
              </div>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-800 p-4">
          <button className="h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200" onClick={onClose} type="button">Cancel</button>
          <button className="flex h-9 items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/60 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600" disabled={isSaving} type="submit">{isSaving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}Save columns</button>
        </div>
      </form>
    </div>
  );
}

function RowFormDialog({ columns, form, isSaving, onChange, onClose, onSubmit, tableName }: {
  columns: SupabaseColumn[];
  form: RowFormState;
  isSaving: boolean;
  onChange: (columnName: string, value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  tableName: string;
}) {
  return (
    <div className="absolute inset-0 z-30 overflow-y-auto bg-black/70 p-4">
      <form className="mx-auto flex max-h-full w-full max-w-[560px] flex-col rounded-md border border-zinc-800 bg-zinc-950 shadow-2xl" onSubmit={onSubmit}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800 p-4"><div><h3 className="text-sm font-semibold text-zinc-100">{form.mode === "create" ? "New row" : "Edit row"}</h3><p className="mt-1 text-xs text-zinc-500">{tableName}</p></div><button aria-label="Close row editor" className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200" onClick={onClose} type="button"><X size={14} aria-hidden="true" /></button></div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {columns.map((column) => <FieldEditor column={column} key={column.name} onChange={onChange} value={form.values[column.name] ?? ""} />)}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-800 p-4"><button className="h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200" onClick={onClose} type="button">Cancel</button><button className="flex h-9 items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/60 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600" disabled={isSaving} type="submit">{isSaving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}Save</button></div>
      </form>
    </div>
  );
}

function FieldEditor({ column, onChange, value }: { column: SupabaseColumn; onChange: (columnName: string, value: string) => void; value: string }) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-400"><span>{column.name}</span><span className="text-[10px] font-normal text-zinc-600">{column.type}{column.format ? ` / ${column.format}` : ""}</span></span>
      {column.type === "boolean" ? (
        <select className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" onChange={(event) => onChange(column.name, event.currentTarget.value)} value={value}><option value="">{column.nullable ? "null" : "false"}</option><option value="true">true</option><option value="false">false</option></select>
      ) : column.type === "object" || column.type === "array" ? (
        <textarea className="min-h-24 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" onChange={(event) => onChange(column.name, event.currentTarget.value)} placeholder={column.nullable ? "null" : "{}"} value={value} />
      ) : (
        <input className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" onChange={(event) => onChange(column.name, event.currentTarget.value)} placeholder={column.nullable ? "null" : column.type} type={getInputType(column)} value={value} />
      )}
    </label>
  );
}

function NoticeBar({ notice }: { notice: Notice }) {
  return (
    <div aria-live="polite" className={`shrink-0 border-b px-3 py-2 text-xs ${notice.tone === "error" ? "border-red-400/20 bg-red-400/10 text-red-100" : "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"}`}>{notice.message}</div>
  );
}

function EmptyDatabaseState({ loading = false, message, title }: { loading?: boolean; message: string; title: string }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-5">
      <div className="max-w-[320px] rounded-md border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center">
        {loading ? <Loader2 size={18} className="mx-auto mb-3 animate-spin text-zinc-500" aria-hidden="true" /> : null}
        <h3 className="text-sm font-semibold text-zinc-300">{title}</h3>
        <p className="mt-2 text-xs leading-5 text-zinc-500">{message}</p>
      </div>
    </div>
  );
}

function validateConfigDraft(url: string, anonKey: string, secretKey: string) {
  if (!url.trim()) return "Enter a Supabase project URL.";
  if (!anonKey.trim()) return "Enter a Supabase public / anon key for generated apps.";
  if (!secretKey.trim()) return "Enter SUPABASE_SECRET_KEY for the database dashboard.";
  try {
    const parsedUrl = new URL(url.trim());
    if (!parsedUrl.protocol.startsWith("http")) return "Supabase URL must start with http or https.";
  } catch {
    return "Supabase URL must be a valid URL.";
  }
  return null;
}

function validateTableForm(form: TableFormState) {
  if (!isValidIdentifier(form.name)) return "Table name must start with a letter or underscore and only contain letters, numbers, and underscores.";
  if (form.columns.length === 0) return "Add at least one column.";

  const names = new Set<string>();
  for (const column of form.columns) {
    if (!isValidIdentifier(column.name)) return "Column names must start with a letter or underscore and only contain letters, numbers, and underscores.";
    if (names.has(column.name.trim())) return `Duplicate column name: ${column.name.trim()}.`;
    names.add(column.name.trim());
  }

  return null;
}

function validateColumnEditor(editor: ColumnEditorState) {
  const activeColumns = editor.columns.filter((column) => !column.dropped);
  if (activeColumns.length === 0) return "A table must keep at least one column.";

  const names = new Set<string>();
  for (const column of activeColumns) {
    if (!isValidIdentifier(column.name)) return "Column names must start with a letter or underscore and only contain letters, numbers, and underscores.";
    const normalizedName = column.name.trim();
    if (names.has(normalizedName)) return `Duplicate column name: ${normalizedName}.`;
    names.add(normalizedName);
  }

  return null;
}

function createAlterTableOperations(editor: ColumnEditorState): SupabaseAlterTableOperation[] {
  const operations: SupabaseAlterTableOperation[] = [];

  for (const column of editor.columns) {
    if (!column.isNew && column.dropped) {
      operations.push({ kind: "dropColumn", name: column.originalName });
    }
  }

  for (const column of editor.columns) {
    if (column.isNew || column.dropped) continue;

    const nextName = column.name.trim();
    if (nextName !== column.originalName) {
      operations.push({
        kind: "renameColumn",
        newName: nextName,
        oldName: column.originalName,
      });
    }

    if (column.dataType !== column.originalDataType) {
      operations.push({
        dataType: column.dataType,
        kind: "setColumnType",
        name: nextName,
      });
    }

    if (column.nullable !== column.originalNullable && !column.isPrimaryKey) {
      operations.push({
        kind: "setColumnNullable",
        name: nextName,
        nullable: column.nullable,
      });
    }

    if (column.defaultValue !== "unchanged") {
      operations.push({
        dataType: column.dataType,
        defaultValue: column.defaultValue === "none" ? null : column.defaultValue,
        kind: "setColumnDefault",
        name: nextName,
      });
    }
  }

  for (const column of editor.columns) {
    if (!column.isNew || column.dropped) continue;
    operations.push({
      column: {
        dataType: column.dataType,
        defaultValue: column.defaultValue === "none" ? undefined : column.defaultValue,
        name: column.name.trim(),
        nullable: column.nullable,
        unique: column.unique,
      },
      kind: "addColumn",
    });
  }

  return operations;
}

function isValidIdentifier(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim());
}

function createColumnEditorState(table: SupabaseTable): ColumnEditorState {
  return {
    columns: table.columns.map((column) => {
      const dataType = dataTypeFromColumn(column);
      const isPrimaryKey = table.primaryKeys.includes(column.name);
      return {
        dataType,
        defaultValue: "unchanged",
        dropped: false,
        id: createDraftId(),
        isNew: false,
        isPrimaryKey,
        name: column.name,
        nullable: isPrimaryKey ? false : column.nullable,
        originalDataType: dataType,
        originalName: column.name,
        originalNullable: isPrimaryKey ? false : column.nullable,
        unique: false,
      };
    }),
    tableName: table.name,
  };
}

function createNewColumnEditDraft(): ColumnEditDraft {
  const dataType = "text";
  return {
    dataType,
    defaultValue: defaultForType(dataType),
    dropped: false,
    id: createDraftId(),
    isNew: true,
    isPrimaryKey: false,
    name: "",
    nullable: true,
    originalDataType: dataType,
    originalName: "",
    originalNullable: true,
    unique: false,
  };
}

function dataTypeFromColumn(column: SupabaseColumn) {
  if (column.format === "uuid") return "uuid";
  if (column.format === "date") return "date";
  if (column.format === "date-time" || column.format === "timestamp") return "timestamptz";
  if (column.type === "integer") return "integer";
  if (column.type === "number") return "numeric";
  if (column.type === "boolean") return "boolean";
  if (column.type === "object" || column.type === "array") return "jsonb";
  return "text";
}

function createDefaultTableForm(): TableFormState {
  return {
    columns: [
      {
        dataType: "uuid",
        defaultValue: "gen_random_uuid()",
        id: createDraftId(),
        name: "id",
        nullable: false,
        primaryKey: true,
        unique: false,
      },
      {
        dataType: "timestamptz",
        defaultValue: "now()",
        id: createDraftId(),
        name: "created_at",
        nullable: false,
        primaryKey: false,
        unique: false,
      },
    ],
    enableRls: true,
    name: "",
  };
}

function createBlankColumnDraft(): TableColumnDraft {
  return {
    dataType: "text",
    defaultValue: "none",
    id: createDraftId(),
    name: "",
    nullable: true,
    primaryKey: false,
    unique: false,
  };
}

function createDraftId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultForType(dataType: string) {
  if (dataType === "uuid") return "gen_random_uuid()";
  if (dataType === "timestamptz") return "now()";
  return "none";
}

function defaultOptionsForType(dataType: string, includeKeep = false) {
  const baseOptions = [
    ...(includeKeep ? [{ label: "Keep", value: "unchanged" }] : []),
    { label: "None", value: "none" },
  ];

  if (dataType === "uuid") return [...baseOptions, { label: "UUID", value: "gen_random_uuid()" }];
  if (dataType === "timestamptz") return [...baseOptions, { label: "Now", value: "now()" }];
  if (dataType === "date") return [...baseOptions, { label: "Today", value: "CURRENT_DATE" }];
  if (dataType === "boolean") return [...baseOptions, { label: "True", value: "true" }, { label: "False", value: "false" }];
  if (dataType === "integer" || dataType === "bigint" || dataType === "numeric") return [...baseOptions, { label: "Zero", value: "0" }];
  if (dataType === "text") return [...baseOptions, { label: "Empty string", value: "''" }];
  if (dataType === "jsonb") return [...baseOptions, { label: "Object", value: "'{}'::jsonb" }, { label: "Array", value: "'[]'::jsonb" }];

  return baseOptions;
}

function formatCellValue(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "undefined") return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatFormValue(value: unknown) {
  if (value === null || typeof value === "undefined") return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function parseRowPayload(columns: SupabaseColumn[], values: Record<string, string>, mode: RowFormState["mode"]) {
  const payload: SupabaseRow = {};
  for (const column of columns) {
    const parsedValue = parseColumnValue(column, values[column.name] ?? "", mode);
    if (typeof parsedValue !== "undefined") payload[column.name] = parsedValue;
  }
  return payload;
}

function parseColumnValue(column: SupabaseColumn, rawValue: string, mode: RowFormState["mode"]): unknown {
  if (!rawValue.trim()) {
    if (column.nullable) return null;
    return mode === "create" && !column.required ? undefined : "";
  }
  if (column.type === "integer" || column.type === "number") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`${column.name} must be a number.`);
    return value;
  }
  if (column.type === "boolean") return rawValue === "true";
  if (column.type === "object" || column.type === "array") return JSON.parse(rawValue);
  return rawValue;
}

function getInputType(column: SupabaseColumn) {
  if (column.type === "integer" || column.type === "number") return "number";
  if (column.format === "date") return "date";
  if (column.format === "timestamp" || column.format === "date-time") return "datetime-local";
  return "text";
}

function createRowKey(row: SupabaseRow, index: number) {
  const id = row.id ?? row.uuid;
  return typeof id === "string" || typeof id === "number" ? String(id) : String(index);
}

function getReadableError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Supabase request failed.";
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}




