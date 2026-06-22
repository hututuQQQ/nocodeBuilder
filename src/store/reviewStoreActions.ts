import {
  getProjectErrorMessage,
  projectApi,
  type ProjectFileInput,
} from "../services/projects";
import type { AppState } from "./appStore";
import {
  getPendingReviewFiles,
  MAX_CHANGE_HISTORY_RECORDS,
  type ChangeRecord,
  type PendingReviewFile,
} from "./changeHistory";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

type ReviewActions = Pick<
  AppState,
  | "acceptAllChanges"
  | "acceptChangedFile"
  | "loadProjectChangeHistory"
  | "persistProjectChangeHistory"
  | "recordProjectChange"
  | "revertAllChanges"
  | "revertChangedFile"
  | "selectReviewFile"
>;

export function createReviewActions({
  get,
  set,
}: StoreAccess): ReviewActions {
  const store = { get, set };

  return {
    acceptAllChanges: async () => {
      const project = get().currentProject;

      if (!project || get().changeHistory.length === 0) {
        return;
      }

      set({
        changeHistory: [],
        selectedChangeFilePath: null,
      });
      await get().persistProjectChangeHistory(project.id, []);
    },

    acceptChangedFile: async (path) => {
      const project = get().currentProject;

      if (!project) {
        return;
      }

      const nextHistory = removePendingPaths(get().changeHistory, [path]);
      const nextSelectedPath = nextSelectedReviewPath(
        nextHistory,
        get().selectedChangeFilePath,
      );

      set({
        changeHistory: nextHistory,
        selectedChangeFilePath: nextSelectedPath,
      });
      await get().persistProjectChangeHistory(project.id, nextHistory);
    },

    loadProjectChangeHistory: async (projectId) => {
      try {
        const records = await projectApi.listProjectChangeHistory(projectId);
        const normalizedRecords = normalizeChangeHistory(records);
        const pendingFiles = getPendingReviewFiles(normalizedRecords);

        if (get().currentProject?.id === projectId) {
          set({
            changeHistory: normalizedRecords,
            selectedChangeFilePath: pendingFiles[0]?.path ?? null,
          });
        }

        if (normalizedRecords.length !== records.length) {
          await projectApi.saveProjectChangeHistory(projectId, normalizedRecords);
        }
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[review:error] ${message}`,
          ]),
        }));
      }
    },

    persistProjectChangeHistory: async (projectId, records) => {
      try {
        await projectApi.saveProjectChangeHistory(
          projectId,
          normalizeChangeHistory(records),
        );
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[review:error] ${message}`,
          ]),
        }));
      }
    },

    recordProjectChange: async (record) => {
      const records = normalizeChangeHistory([record, ...get().changeHistory]);
      const selectedPath =
        get().selectedChangeFilePath ??
        getPendingReviewFiles(records)[0]?.path ??
        null;

      set({
        changeHistory: records,
        selectedChangeFilePath: selectedPath,
      });
      await get().persistProjectChangeHistory(record.projectId, records);
    },

    revertAllChanges: async () => {
      const files = getPendingReviewFiles(get().changeHistory);

      if (files.length === 0) {
        return;
      }

      await revertPendingFiles(store, files);
    },

    revertChangedFile: async (path) => {
      const file = getPendingReviewFiles(get().changeHistory).find(
        (item) => item.path === path,
      );

      if (!file) {
        return;
      }

      await revertPendingFiles(store, [file]);
    },

    selectReviewFile: (path) => {
      set({
        selectedChangeFilePath: path,
      });
    },
  };
}

async function revertPendingFiles(
  store: StoreAccess,
  files: PendingReviewFile[],
) {
  const { get, set } = store;
  const project = get().currentProject;

  if (!project) {
    return;
  }

  set({ isRevertingChange: true, projectError: null });

  try {
    const restoreWrites: ProjectFileInput[] = [];
    const restoreDeletes: string[] = [];

    for (const file of files) {
      const currentContent = await readOptionalProjectFile(project.id, file.path);
      assertCanRevertFile(file, currentContent);

      if (file.beforeContent === null) {
        restoreDeletes.push(file.path);
      } else {
        restoreWrites.push({
          content: file.beforeContent,
          path: file.path,
        });
      }
    }

    if (restoreWrites.length > 0) {
      await projectApi.writeFiles(project.id, restoreWrites);
    }

    if (restoreDeletes.length > 0) {
      await projectApi.deleteFiles(project.id, restoreDeletes);
    }

    const revertedPaths = files.map((file) => file.path);
    const nextHistory = removePendingPaths(get().changeHistory, revertedPaths);
    const fileTree = await projectApi.listFiles(project.id);
    const selectedFilePath = get().selectedFilePath;
    const selectedFileWasDeleted =
      selectedFilePath !== null && restoreDeletes.includes(selectedFilePath);
    const selectedFileWasWritten =
      selectedFilePath !== null &&
      restoreWrites.some((file) => file.path === selectedFilePath);
    const selectedFileContent =
      selectedFilePath && selectedFileWasWritten
        ? await projectApi.readFile(project.id, selectedFilePath)
        : selectedFileWasDeleted
          ? ""
          : get().selectedFileContent;

    set((state) => ({
      changeHistory: nextHistory,
      fileTree,
      previewRefreshKey: state.previewRefreshKey + 1,
      selectedChangeFilePath: nextSelectedReviewPath(
        nextHistory,
        state.selectedChangeFilePath,
      ),
      selectedFileContent,
      selectedFilePath: selectedFileWasDeleted ? null : state.selectedFilePath,
      terminalLogs: appendLogs(state.terminalLogs, [
        `[review] Reverted ${files.length} pending file(s)`,
      ]),
    }));
    await get().persistProjectChangeHistory(project.id, nextHistory);
  } catch (error) {
    const message = getProjectErrorMessage(error);

    set((state) => ({
      projectError: message,
      terminalLogs: appendLogs(state.terminalLogs, [`[review:error] ${message}`]),
    }));
  } finally {
    set({ isRevertingChange: false });
  }
}

async function readOptionalProjectFile(projectId: string, path: string) {
  try {
    return await projectApi.readFile(projectId, path);
  } catch (error) {
    const message = getProjectErrorMessage(error);

    if (message.toLowerCase().includes("not found")) {
      return null;
    }

    throw error;
  }
}

function assertCanRevertFile(
  file: PendingReviewFile,
  currentContent: string | null,
) {
  if (currentContent !== file.afterContent) {
    throw new Error(
      `${file.path} changed after this review item was created. Review the latest file before reverting.`,
    );
  }
}

function removePendingPaths(records: ChangeRecord[], paths: string[]) {
  const pathSet = new Set(paths);

  return normalizeChangeHistory(
    records
      .map((record) => ({
        ...record,
        files: record.files.filter((file) => !pathSet.has(file.path)),
      }))
      .filter((record) => record.files.length > 0),
  );
}

function nextSelectedReviewPath(
  records: ChangeRecord[],
  currentPath: string | null,
) {
  const pendingFiles = getPendingReviewFiles(records);

  if (currentPath && pendingFiles.some((file) => file.path === currentPath)) {
    return currentPath;
  }

  return pendingFiles[0]?.path ?? null;
}

function normalizeChangeHistory(records: ChangeRecord[]) {
  return records
    .filter((record) => record.kind !== "revert")
    .map((record) => ({
      ...record,
      files: record.files.filter((file) => !file.revertedAt),
      kind: "agent" as const,
      revertedAt: undefined,
      revertedByChangeId: undefined,
    }))
    .filter((record) => record.files.length > 0)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_CHANGE_HISTORY_RECORDS);
}
