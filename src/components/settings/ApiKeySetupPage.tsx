import { FormEvent, useEffect, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, PlugZap, Save, X } from "lucide-react";
import {
  DeepSeekClient,
  DeepSeekClientError,
} from "../../agent/llm/DeepSeekClient";
import {
  DEEPSEEK_MODEL_OPTIONS,
  DEFAULT_DEEPSEEK_BASE_URL,
  DeepSeekConfig,
  DeepSeekConfigInput,
  DeepSeekModel,
} from "../../services/keyStore";

type ApiKeySetupPageProps = {
  config: DeepSeekConfig | null;
  mode: "onboarding" | "settings";
  onCancel?: () => void;
  onSave: (config: DeepSeekConfigInput) => Promise<void>;
};

type Notice = {
  tone: "error" | "success";
  message: string;
};

const DEFAULT_DEEPSEEK_MODEL = DEEPSEEK_MODEL_OPTIONS[0].value;

export function ApiKeySetupPage({
  config,
  mode,
  onCancel,
  onSave,
}: ApiKeySetupPageProps) {
  const [apiKey, setApiKey] = useState(config?.apiKey ?? "");
  const [model, setModel] = useState<DeepSeekModel>(
    config?.model ?? DEFAULT_DEEPSEEK_MODEL,
  );
  const [baseUrl, setBaseUrl] = useState(
    config?.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testedConfigSignature, setTestedConfigSignature] = useState<
    string | null
  >(null);

  useEffect(() => {
    setApiKey(config?.apiKey ?? "");
    setModel(config?.model ?? DEFAULT_DEEPSEEK_MODEL);
    setBaseUrl(config?.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL);
    setNotice(null);
    setTestedConfigSignature(null);
  }, [config]);

  const configSignature = useMemo(
    () =>
      JSON.stringify({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model,
      }),
    [apiKey, baseUrl, model],
  );
  const hasRequiredFields = useMemo(
    () => apiKey.trim().length > 0 && baseUrl.trim().length > 0,
    [apiKey, baseUrl],
  );
  const hasPassedConnectionTest = testedConfigSignature === configSignature;
  const canTest = hasRequiredFields && !isSaving && !isTesting;
  const canSave = useMemo(
    () =>
      hasRequiredFields && hasPassedConnectionTest && !isSaving && !isTesting,
    [hasPassedConnectionTest, hasRequiredFields, isSaving, isTesting],
  );

  function markConfigDirty() {
    setTestedConfigSignature(null);
    setNotice((currentNotice) =>
      currentNotice?.tone === "success" ? null : currentNotice,
    );
  }

  function validateConfig() {
    if (!apiKey.trim()) {
      return "请输入 DeepSeek API Key。";
    }

    if (!baseUrl.trim()) {
      return "请输入 DeepSeek Base URL。";
    }

    try {
      new URL(baseUrl.trim());
    } catch {
      return "Base URL 必须是有效的 URL。";
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
    setTestedConfigSignature(null);

    try {
      const client = new DeepSeekClient({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model,
      });
      const isConnected = await client.testConnection();

      if (!isConnected) {
        setNotice({
          tone: "error",
          message: "DeepSeek API 已响应，但连接测试返回值异常，请稍后重试。",
        });
        return;
      }

      setTestedConfigSignature(configSignature);
      setNotice({
        tone: "success",
        message: "DeepSeek 真实连接测试成功，可以保存配置。",
      });
    } catch (testError) {
      setNotice({
        tone: "error",
        message: getConnectionErrorMessage(testError),
      });
    } finally {
      setIsTesting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const error = validateConfig();

    if (error) {
      setNotice({ tone: "error", message: error });
      return;
    }

    if (!hasPassedConnectionTest) {
      setNotice({
        tone: "error",
        message: "请先通过 Test Connection 真实连接测试后再保存配置。",
      });
      return;
    }

    setIsSaving(true);
    setNotice(null);

    try {
      await onSave({
        apiKey: apiKey.trim(),
        model,
        baseUrl: baseUrl.trim(),
      });
    } catch {
      setNotice({ tone: "error", message: "保存配置失败，请稍后重试。" });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="grid min-h-dvh w-dvw place-items-center overflow-y-auto bg-[#0b0b0d] px-4 py-6 text-zinc-100 sm:px-6">
      <form
        className="w-full max-w-[560px] rounded-md border border-zinc-800 bg-[#101012] shadow-2xl shadow-black/30"
        onSubmit={handleSubmit}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-md border border-teal-400/30 bg-teal-400/10 text-teal-200">
              <KeyRound size={19} aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-zinc-50">
                AI Web Builder
              </h1>
              <p className="mt-1 text-sm text-zinc-500">
                使用前请配置 DeepSeek API Key
              </p>
            </div>
          </div>

          {mode === "settings" && onCancel ? (
            <button
              aria-label="Close settings"
              className="grid size-9 shrink-0 place-items-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400 transition hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200"
              onClick={onCancel}
              type="button"
            >
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div className="space-y-5 px-6 py-6">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-zinc-300">
              API Key
            </span>
            <input
              className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
              onChange={(event) => {
                setApiKey(event.currentTarget.value);
                markConfigDirty();
              }}
              placeholder="sk-..."
              type="password"
              value={apiKey}
            />
          </label>

          <fieldset>
            <legend className="mb-2 block text-sm font-medium text-zinc-300">
              Model
            </legend>
            <div className="grid grid-cols-2 gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-1">
              {DEEPSEEK_MODEL_OPTIONS.map((option) => {
                const isSelected = model === option.value;

                return (
                  <button
                    className={`flex min-h-12 flex-col items-center justify-center rounded text-sm font-medium transition ${
                      isSelected
                        ? "bg-teal-400/15 text-teal-100 ring-1 ring-teal-400/30"
                        : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                    }`}
                    key={option.value}
                    onClick={() => {
                      setModel(option.value);
                      markConfigDirty();
                    }}
                    type="button"
                  >
                    <span>{option.label}</span>
                    <span className="mt-0.5 text-[11px] font-normal text-zinc-600">
                      {option.value}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-zinc-300">
              Base URL
            </span>
            <input
              className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
              onChange={(event) => {
                setBaseUrl(event.currentTarget.value);
                markConfigDirty();
              }}
              value={baseUrl}
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
            {notice ? notice.message : "测试结果和错误提示会显示在这里。"}
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
            {isTesting ? "Testing..." : "Test Connection"}
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
            Save and Continue
          </button>
        </div>
      </form>
    </main>
  );
}

function getConnectionErrorMessage(error: unknown) {
  if (error instanceof DeepSeekClientError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "连接测试失败，请稍后重试。";
}
