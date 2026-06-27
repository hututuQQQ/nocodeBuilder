import { FormEvent, useEffect, useMemo, useState } from "react";
import { CheckCircle2, PlugZap, Save, X } from "lucide-react";
import {
  ChatCompletionClient,
  LlmClientError,
} from "../../agent/llm/ChatCompletionClient";
import appIcon from "../../assets/nocodebuilder-icon.png";
import { useI18n } from "../../i18n";
import {
  AI_PROVIDER_IDS,
  DEFAULT_AI_PROVIDER,
  getAiProviderDefinition,
  type AiProviderId,
} from "../../services/aiProviders";
import {
  AiProviderConfig,
  AiProviderConfigInput,
  AiProviderState,
} from "../../services/keyStore";
import { LocaleSelect } from "./LocaleSelect";

type ApiKeySetupPageProps = {
  aiState: AiProviderState | null;
  mode: "onboarding" | "settings";
  onCancel?: () => void;
  onSave: (
    configs: AiProviderConfigInput[],
    activeProvider: AiProviderId,
  ) => Promise<void>;
};

type Notice = {
  tone: "error" | "success";
  message: string;
};

type ProviderDraft = {
  apiKey: string;
  baseUrl: string;
  model: string;
  models: string[];
};

type TestedProviderSignatures = Partial<Record<AiProviderId, string>>;

export function ApiKeySetupPage({
  aiState,
  mode,
  onCancel,
  onSave,
}: ApiKeySetupPageProps) {
  const { t } = useI18n();
  const [providerId, setProviderId] = useState<AiProviderId>(
    aiState?.activeProvider ?? DEFAULT_AI_PROVIDER,
  );
  const [drafts, setDrafts] = useState<Record<AiProviderId, ProviderDraft>>(
    () => createDrafts(aiState),
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testedConfigSignatures, setTestedConfigSignatures] =
    useState<TestedProviderSignatures>({});
  const provider = getAiProviderDefinition(providerId);
  const draft = drafts[providerId];
  const hasStoredApiKey =
    aiState?.configs[providerId]?.apiKeyConfigured ?? false;

  useEffect(() => {
    setProviderId(aiState?.activeProvider ?? DEFAULT_AI_PROVIDER);
    setDrafts(createDrafts(aiState));
    setNotice(null);
    setTestedConfigSignatures({});
  }, [aiState]);

  const configSignature = useMemo(
    () => getDraftSignature(providerId, draft),
    [draft, providerId],
  );
  const hasRequiredFields = useMemo(
    () =>
      (hasStoredApiKey || draft.apiKey.trim().length > 0) &&
      draft.baseUrl.trim().length > 0 &&
      draft.models.length > 0,
    [draft.apiKey, draft.baseUrl, draft.models.length, hasStoredApiKey],
  );
  const providerIdsToSave = useMemo(
    () => getProviderIdsToSave(drafts, testedConfigSignatures),
    [drafts, testedConfigSignatures],
  );
  const canTest = hasRequiredFields && !isSaving && !isTesting;
  const canSave = useMemo(
    () => providerIdsToSave.length > 0 && !isSaving && !isTesting,
    [isSaving, isTesting, providerIdsToSave.length],
  );

  function markConfigDirty() {
    setTestedConfigSignatures((currentSignatures) => {
      const nextSignatures = { ...currentSignatures };
      delete nextSignatures[providerId];
      return nextSignatures;
    });
    setNotice((currentNotice) =>
      currentNotice?.tone === "success" ? null : currentNotice,
    );
  }

  function updateDraft(updater: (draft: ProviderDraft) => ProviderDraft) {
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [providerId]: updater(currentDrafts[providerId]),
    }));
    markConfigDirty();
  }

  function handleProviderChange(nextProviderId: AiProviderId) {
    if (nextProviderId === providerId) {
      return;
    }

    setProviderId(nextProviderId);
    setNotice(null);
  }

  function handleToggleModel(model: string) {
    updateDraft((currentDraft) => {
      const isSelected = currentDraft.models.includes(model);
      const selectedModels = isSelected
        ? currentDraft.models.filter((selectedModel) => selectedModel !== model)
        : [...currentDraft.models, model];

      if (selectedModels.length === 0) {
        return currentDraft;
      }

      const orderedModels = provider.modelOptions
        .map((option) => option.value)
        .filter((optionModel) => selectedModels.includes(optionModel));

      return {
        ...currentDraft,
        model: orderedModels.includes(currentDraft.model)
          ? currentDraft.model
          : orderedModels[0],
        models: orderedModels,
      };
    });
  }

  function validateConfig() {
    if (!hasStoredApiKey && !draft.apiKey.trim()) {
      return t("settings.enterApiKey", { provider: provider.label });
    }

    if (!draft.baseUrl.trim()) {
      return t("settings.enterBaseUrl", { provider: provider.label });
    }

    if (draft.models.length === 0) {
      return t("settings.chooseModel", { provider: provider.label });
    }

    try {
      new URL(draft.baseUrl.trim());
    } catch {
      return t("settings.invalidBaseUrl");
    }

    return null;
  }

  async function handleTestConnection() {
    const error = validateConfig();

    if (error) {
      setNotice({ tone: "error", message: error });
      return;
    }

    setIsTesting(true);
    setNotice(null);
    setTestedConfigSignatures((currentSignatures) => {
      const nextSignatures = { ...currentSignatures };
      delete nextSignatures[providerId];
      return nextSignatures;
    });

    try {
      const results = await Promise.all(
        draft.models.map((model) =>
          testModelConnection({
            apiKey: draft.apiKey.trim() || undefined,
            baseUrl: draft.baseUrl.trim(),
            model,
            provider: providerId,
            t,
          }),
        ),
      );
      const failedResult = results.find((result) => !result.ok);

      if (failedResult) {
        setNotice({
          tone: "error",
          message: failedResult.message,
        });
        return;
      }

      setTestedConfigSignatures((currentSignatures) => ({
        ...currentSignatures,
        [providerId]: configSignature,
      }));
      setNotice({
        tone: "success",
        message: t("settings.connectionPassed", {
          models: draft.models.join(", "),
          provider: provider.label,
        }),
      });
    } catch (testError) {
      setNotice({
        tone: "error",
        message: getConnectionErrorMessage(testError, t),
      });
    } finally {
      setIsTesting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saveProviderIds = getProviderIdsToSave(
      drafts,
      testedConfigSignatures,
    );

    if (saveProviderIds.length === 0) {
      setNotice({
        tone: "error",
        message: t("settings.saveRequiresTest"),
      });
      return;
    }

    const activeProviderToSave = saveProviderIds.includes(providerId)
      ? providerId
      : saveProviderIds[0];
    const configsToSave = saveProviderIds.map((saveProviderId) => {
      const saveDraft = drafts[saveProviderId];

      return {
        provider: saveProviderId,
        apiKey: saveDraft.apiKey.trim() || undefined,
        model: saveDraft.model,
        models: saveDraft.models,
        baseUrl: saveDraft.baseUrl.trim(),
      };
    });

    setIsSaving(true);
    setNotice(null);

    try {
      await onSave(configsToSave, activeProviderToSave);
    } catch {
      setNotice({
        tone: "error",
        message: t("settings.saveFailed"),
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="grid min-h-dvh w-dvw place-items-center overflow-y-auto bg-[#0b0b0d] px-4 py-6 text-zinc-100 sm:px-6">
      <form
        className="w-full max-w-[660px] rounded-lg border border-zinc-800 bg-[#101012] shadow-2xl shadow-black/30"
        onSubmit={handleSubmit}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-6 py-5">
          <div className="flex items-center gap-3">
            <img
              alt=""
              className="size-11 rounded-lg border border-teal-400/20 bg-zinc-950 object-cover shadow-lg shadow-black/30"
              src={appIcon}
            />
            <div>
              <h1 className="text-lg font-semibold text-zinc-50">
                {t("app.name")}
              </h1>
              <p className="mt-1 text-sm text-zinc-500">
                {t("settings.configureProvider")}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <LocaleSelect />
            {mode === "settings" && onCancel ? (
              <button
                aria-label={t("settings.close")}
                className="grid size-9 shrink-0 place-items-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400 transition hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200"
                onClick={onCancel}
                type="button"
              >
                <X size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="space-y-5 px-6 py-6">
          <fieldset>
            <legend className="mb-2 block text-sm font-medium text-zinc-300">
              {t("settings.provider")}
            </legend>
            <div className="grid grid-cols-2 gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-1">
              {AI_PROVIDER_IDS.map((optionProviderId) => {
                const optionProvider =
                  getAiProviderDefinition(optionProviderId);
                const isSelected = providerId === optionProviderId;
                const isConfigured = Boolean(aiState?.configs[optionProviderId]);

                return (
                  <button
                    aria-pressed={isSelected}
                    className={`flex min-h-12 flex-col items-center justify-center rounded text-sm font-medium transition ${
                      isSelected
                        ? "bg-teal-400/15 text-teal-100 ring-1 ring-teal-400/30"
                        : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                    }`}
                    key={optionProviderId}
                    onClick={() => handleProviderChange(optionProviderId)}
                    type="button"
                  >
                    <span>{optionProvider.label}</span>
                    <span className="mt-0.5 text-[11px] font-normal text-zinc-600">
                      {isConfigured
                        ? t("common.configured")
                        : optionProvider.defaultModel}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-zinc-300">
              {t("settings.apiKey")}
            </span>
            <input
              className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
              onChange={(event) => {
                const apiKey = event.currentTarget.value;

                updateDraft((currentDraft) => ({
                  ...currentDraft,
                  apiKey,
                }));
              }}
              placeholder={
                hasStoredApiKey
                  ? t("settings.storedCredential")
                  : provider.apiKeyPlaceholder
              }
              type="password"
              value={draft.apiKey}
            />
          </label>

          <fieldset>
            <legend className="mb-2 block text-sm font-medium text-zinc-300">
              {t("settings.models")}
            </legend>
            <div
              className="grid gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-1"
              style={{
                gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))",
              }}
            >
              {provider.modelOptions.map((option) => {
                const isSelected = draft.models.includes(option.value);

                return (
                  <button
                    aria-pressed={isSelected}
                    className={`flex min-h-12 flex-col items-center justify-center rounded px-2 text-sm font-medium transition ${
                      isSelected
                        ? "bg-teal-400/15 text-teal-100 ring-1 ring-teal-400/30"
                        : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                    }`}
                    key={option.value}
                    onClick={() => handleToggleModel(option.value)}
                    title={option.description}
                    type="button"
                  >
                    <span className="flex items-center gap-1.5">
                      {isSelected ? (
                        <CheckCircle2 size={13} aria-hidden="true" />
                      ) : null}
                      {option.label}
                    </span>
                    <span className="mt-0.5 max-w-full truncate text-[11px] font-normal text-zinc-600">
                      {option.value}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-zinc-300">
              {t("settings.baseUrl")}
            </span>
            <input
              className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
              onChange={(event) => {
                const baseUrl = event.currentTarget.value;

                updateDraft((currentDraft) => ({
                  ...currentDraft,
                  baseUrl,
                }));
              }}
              placeholder={provider.defaultBaseUrl}
              value={draft.baseUrl}
            />
          </label>

          <div
            aria-live="polite"
            className={`min-h-11 rounded-md border px-3 py-2 text-sm ${
              notice?.tone === "error"
                ? "border-red-400/30 bg-red-400/10 text-red-100"
                : notice?.tone === "success"
                  ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                  : "border-zinc-800 bg-zinc-950 text-zinc-600"
            }`}
          >
            {notice
              ? notice.message
              : t("settings.noticePlaceholder")}
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-zinc-800 bg-zinc-950/50 px-6 py-4">
          <button
            className="flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 text-sm font-medium text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={!canTest}
            onClick={handleTestConnection}
            type="button"
          >
            <PlugZap size={16} aria-hidden="true" />
            {isTesting ? t("settings.testing") : t("settings.testConnection")}
          </button>
          <button
            className="flex h-10 items-center justify-center gap-2 rounded-md border border-teal-400/30 bg-teal-400/10 px-4 text-sm font-medium text-teal-100 transition hover:border-teal-300/60 hover:bg-teal-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
            disabled={!canSave}
            type="submit"
          >
            {isSaving ? (
              <CheckCircle2 size={16} aria-hidden="true" />
            ) : (
              <Save size={16} aria-hidden="true" />
            )}
            {t("settings.saveContinue")}
          </button>
        </div>
      </form>
    </main>
  );
}

function createDrafts(
  aiState: AiProviderState | null,
): Record<AiProviderId, ProviderDraft> {
  const drafts = {} as Record<AiProviderId, ProviderDraft>;

  for (const providerId of AI_PROVIDER_IDS) {
    drafts[providerId] = createProviderDraft(
      providerId,
      aiState?.configs[providerId],
    );
  }

  return drafts;
}

async function testModelConnection({
  apiKey,
  baseUrl,
  model,
  provider,
  t,
}: {
  apiKey?: string;
  baseUrl: string;
  model: string;
  provider: AiProviderId;
  t: ReturnType<typeof useI18n>["t"];
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const providerDefinition = getAiProviderDefinition(provider);

  try {
    const client = new ChatCompletionClient({
      provider,
      apiKey,
      baseUrl,
      model,
    });
    const isConnected = await client.testConnection();

    if (!isConnected) {
      return {
        ok: false,
        message: t("settings.connectionUnexpected", {
          model,
          provider: providerDefinition.label,
        }),
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: t("settings.connectionFailed", {
        message: getConnectionErrorMessage(error, t),
        model,
        provider: providerDefinition.label,
      }),
    };
  }
}

function getProviderIdsToSave(
  drafts: Record<AiProviderId, ProviderDraft>,
  testedSignatures: TestedProviderSignatures,
) {
  return AI_PROVIDER_IDS.filter(
    (candidateProviderId) =>
      testedSignatures[candidateProviderId] ===
      getDraftSignature(candidateProviderId, drafts[candidateProviderId]),
  );
}

function getDraftSignature(providerId: AiProviderId, draft: ProviderDraft) {
  return JSON.stringify({
    provider: providerId,
    apiKey: draft.apiKey.trim(),
    baseUrl: draft.baseUrl.trim(),
    model: draft.model,
    models: draft.models,
  });
}

function createProviderDraft(
  providerId: AiProviderId,
  config?: AiProviderConfig,
): ProviderDraft {
  const provider = getAiProviderDefinition(providerId);
  const optionValues = provider.modelOptions.map((option) => option.value);
  const models =
    config?.models.filter((model) => optionValues.includes(model)) ?? [];
  const selectedModels = models.length > 0 ? models : [provider.defaultModel];
  const activeModel =
    config?.model && selectedModels.includes(config.model)
      ? config.model
      : selectedModels[0];

  return {
    apiKey: "",
    baseUrl: config?.baseUrl ?? provider.defaultBaseUrl,
    model: activeModel,
    models: selectedModels,
  };
}

function getConnectionErrorMessage(
  error: unknown,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (error instanceof LlmClientError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return t("settings.connectionGenericFailed");
}
