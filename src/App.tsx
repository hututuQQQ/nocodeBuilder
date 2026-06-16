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
import {
  DeepSeekConfig,
  DeepSeekConfigInput,
  DeepSeekModel,
  keyStore,
} from "./services/keyStore";

function App() {
  const [config, setConfig] = useState<DeepSeekConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSavingModel, setIsSavingModel] = useState(false);

  useEffect(() => {
    let isActive = true;

    async function loadConfig() {
      try {
        const storedConfig = await keyStore.getDeepSeekConfig();

        if (isActive) {
          setConfig(storedConfig);
        }
      } catch {
        if (isActive) {
          setConfig(null);
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

  const handleSaveConfig = useCallback(async (nextConfig: DeepSeekConfigInput) => {
    const savedConfig = await keyStore.saveDeepSeekConfig(nextConfig);
    setConfig(savedConfig);
    setIsSettingsOpen(false);
  }, []);

  const handleChangeModel = useCallback(
    async (model: DeepSeekModel) => {
      if (!config || config.model === model || isSavingModel) {
        return;
      }

      setIsSavingModel(true);

      try {
        const savedConfig = await keyStore.saveDeepSeekConfig({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model,
        });

        setConfig(savedConfig);
      } finally {
        setIsSavingModel(false);
      }
    },
    [config, isSavingModel],
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
          config={config}
          mode={config ? "settings" : "onboarding"}
          onCancel={config ? () => setIsSettingsOpen(false) : undefined}
          onSave={handleSaveConfig}
        />
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary>
      <AppShell
        activeModel={config.model}
        isSavingModel={isSavingModel}
        onChangeModel={handleChangeModel}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />
    </AppErrorBoundary>
  );
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
