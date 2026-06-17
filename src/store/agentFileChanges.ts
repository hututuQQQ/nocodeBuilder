import type { ProjectInfo } from "../services/projects";
import { projectApi } from "../services/projects";
import { createChangeRecord } from "./changeHistory";
import { appendTerminalLog } from "./agentUi";
import type { StoreAccess } from "./storeAccess";

export async function writeAgentFiles(
  store: StoreAccess,
  project: ProjectInfo,
  files: Array<{ path: string; content: string }>,
  summary: string,
) {
  appendTerminalLog(store, `[agent] Writing ${files.length} project files`);
  const beforeContents = new Map<string, string | null>();

  for (const file of files) {
    try {
      beforeContents.set(file.path, await projectApi.readFile(project.id, file.path));
    } catch {
      beforeContents.set(file.path, null);
    }
  }

  await projectApi.writeFiles(project.id, files);

  const refreshedFileTree = await projectApi.listFiles(project.id);
  const selectedFilePath = store.get().selectedFilePath;
  const selectedFileWasModified = files.some(
    (file) => file.path === selectedFilePath,
  );
  const selectedFileContent =
    selectedFilePath && selectedFileWasModified
      ? await projectApi.readFile(project.id, selectedFilePath)
      : store.get().selectedFileContent;

  if (store.get().currentProject?.id !== project.id) {
    return createChangeRecord(project.id, summary, files, beforeContents);
  }

  const changeRecord = createChangeRecord(
    project.id,
    summary,
    files,
    beforeContents,
  );

  store.set((state) => ({
    changeHistory: [changeRecord, ...state.changeHistory].slice(0, 20),
    fileTree: refreshedFileTree,
    selectedFileContent,
  }));

  return changeRecord;
}

export async function deleteAgentFiles(
  store: StoreAccess,
  project: ProjectInfo,
  paths: string[],
  summary: string,
) {
  appendTerminalLog(store, `[agent] Deleting ${paths.length} project files`);
  const beforeContents = new Map<string, string | null>();

  for (const path of paths) {
    beforeContents.set(path, await projectApi.readFile(project.id, path));
  }

  await projectApi.deleteFiles(project.id, paths);

  const refreshedFileTree = await projectApi.listFiles(project.id);
  const selectedFilePath = store.get().selectedFilePath;
  const selectedFileWasDeleted = selectedFilePath
    ? paths.includes(selectedFilePath)
    : false;
  const selectedFileContent = selectedFileWasDeleted
    ? ""
    : store.get().selectedFileContent;
  const selectedFilePathAfterDelete = selectedFileWasDeleted
    ? null
    : selectedFilePath;

  const deletedFiles = paths.map((path) => ({ path, content: null }));

  if (store.get().currentProject?.id !== project.id) {
    return createChangeRecord(project.id, summary, deletedFiles, beforeContents);
  }

  const changeRecord = createChangeRecord(
    project.id,
    summary,
    deletedFiles,
    beforeContents,
  );

  store.set((state) => ({
    changeHistory: [changeRecord, ...state.changeHistory].slice(0, 20),
    fileTree: refreshedFileTree,
    selectedFileContent,
    selectedFilePath: selectedFilePathAfterDelete,
  }));

  return changeRecord;
}
