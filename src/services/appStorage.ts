import { invoke } from "@tauri-apps/api/core";
import type { AiProviderId } from "./aiProviders";

export type AppStorageKey =
  | "ai-provider-config"
  | "project-memory"
  | "ui-locale";

export function readAppStorageValue<T>(key: AppStorageKey) {
  return invoke<T | null>("read_app_storage", { key });
}

export function writeAppStorageValue<T>(key: AppStorageKey, value: T) {
  return invoke<void>("write_app_storage", { key, value });
}

export function hasAiProviderSecret(provider: AiProviderId) {
  return invoke<boolean>("has_ai_provider_secret", { provider });
}

export function saveAiProviderSecret(provider: AiProviderId, apiKey: string) {
  return invoke<void>("save_ai_provider_secret", { provider, apiKey });
}
