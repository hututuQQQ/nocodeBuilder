import {
  Component,
  ErrorInfo,
  ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { AppShell } from "./components/layout/AppShell";
import { ApiKeySetupPage } from "./components/settings/ApiKeySetupPage";
import { AI_PROVIDER_IDS, type AiProviderId } from "./services/aiProviders";
import {
  AiProviderConfigInput,
  AiProviderState,
  getActiveAiProviderConfig,
  keyStore,
} from "./services/keyStore";

export type ConfiguredModelOption = {
  provider: AiProviderId;
  model: string;
};

function App() {
  const [aiState, setAiState] = useState<AiProviderState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSavingModel, setIsSavingModel] = useState(false);
  const config = getActiveAiProviderConfig(aiState);
  const configuredModelOptions = getConfiguredModelOptions(aiState);

  useEffect(() => {
    let isActive = true;

    async function loadConfig() {
      try {
        const storedState = await keyStore.getAiProviderState();

        if (isActive) {
          setAiState(storedState);
        }
      } catch {
        if (isActive) {
          setAiState(null);
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    loadConfig();

    return () => {
      isActive = false;
    };
  }, []);

  const handleSaveConfigs = useCallback(
    async (
      nextConfigs: AiProviderConfigInput[],
      activeProvider: AiProviderId,
    ) => {
      const savedState = await keyStore.saveAiProviderConfigs(
        nextConfigs,
        activeProvider,
      );
      setAiState(savedState);
      setIsSettingsOpen(false);
    },
    [],
  );

  const handleChangeModel = useCallback(
    async (selection: ConfiguredModelOption) => {
      const targetConfig = aiState?.configs[selection.provider];

      if (
        !targetConfig ||
        (config?.provider === selection.provider &&
          config.model === selection.model) ||
        !targetConfig.models.includes(selection.model) ||
        isSavingModel
      ) {
        return;
      }

      setIsSavingModel(true);

      try {
        const savedState = await keyStore.saveAiProviderConfig({
          provider: targetConfig.provider,
          apiKey: targetConfig.apiKey,
          baseUrl: targetConfig.baseUrl,
          model: selection.model,
          models: targetConfig.models,
        });

        setAiState(savedState);
      } finally {
        setIsSavingModel(false);
      }
    },
    [aiState, config?.model, config?.provider, isSavingModel],
  );

  if (isLoading) {
    return (
      <main className="grid h-dvh w-dvw place-items-center bg-[#0b0b0d] text-sm text-zinc-500">
        Loading configuration...
      </main>
    );
  }

  if (!config || isSettingsOpen) {
    return (
      <AppErrorBoundary>
        <ApiKeySetupPage
          aiState={aiState}
          mode={config ? "settings" : "onboarding"}
          onCancel={config ? () => setIsSettingsOpen(false) : undefined}
          onSave={handleSaveConfigs}
        />
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary>
      <AppShell
        activeProvider={config.provider}
        activeModel={config.model}
        configuredModelOptions={configuredModelOptions}
        isSavingModel={isSavingModel}
        onChangeModel={handleChangeModel}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />
    </AppErrorBoundary>
  );
}

function getConfiguredModelOptions(
  state: AiProviderState | null,
): ConfiguredModelOption[] {
  if (!state) {
    return [];
  }

  return AI_PROVIDER_IDS.flatMap((provider) => {
    const config = state.configs[provider];

    if (!config) {
      return [];
    }

    return config.models.map((model) => ({
      provider,
      model,
    }));
  });
}

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("App render failed", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="grid h-dvh w-dvw place-items-center bg-[#0b0b0d] p-8 text-zinc-200">
          <section className="max-w-2xl rounded-md border border-red-400/30 bg-red-950/30 p-5">
            <h1 className="text-base font-semibold text-red-100">
              App failed to render
            </h1>
            <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs leading-5 text-red-100/80">
              {this.state.error.message}
            </pre>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

export default App;
