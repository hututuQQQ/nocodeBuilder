import { invoke } from "@tauri-apps/api/core";
import type { DevelopmentSpec } from "../spec-core/types";
import { validateDevelopmentSpec } from "../spec-core/validators";

export const specApi = {
  async createSpec(projectId: string, spec: DevelopmentSpec) {
    const validated = validateDevelopmentSpec(spec);

    return validateDevelopmentSpec(
      await invoke<DevelopmentSpec>("create_development_spec", {
        projectId,
        spec: validated,
      }),
    );
  },

  async readSpec(projectId: string, specId: string) {
    return validateDevelopmentSpec(
      await invoke<DevelopmentSpec>("read_development_spec", {
        projectId,
        specId,
      }),
    );
  },

  async saveSpec(projectId: string, spec: DevelopmentSpec) {
    const validated = validateDevelopmentSpec(spec);

    return validateDevelopmentSpec(
      await invoke<DevelopmentSpec>("save_development_spec", {
        projectId,
        spec: validated,
      }),
    );
  },

  deleteUnattachedSpec(projectId: string, specId: string) {
    return invoke<void>("delete_development_spec", {
      projectId,
      specId,
    });
  },
};
