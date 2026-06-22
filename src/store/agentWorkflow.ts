import {
  generateInitialProjectRuntime,
  modifyCurrentProjectRuntime,
} from "../agent-runtime/runController";
import type { ProjectInfo } from "../services/projects";
import type { StoreAccess } from "./storeAccess";

export function generateInitialProject(
  store: StoreAccess,
  project: ProjectInfo,
  projectPrompt: string,
) {
  return generateInitialProjectRuntime(store, project, projectPrompt);
}

export function modifyCurrentProject(
  store: StoreAccess,
  userRequest: string,
) {
  return modifyCurrentProjectRuntime(store, userRequest);
}
