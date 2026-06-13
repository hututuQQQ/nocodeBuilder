import { useCallback, useEffect, useState } from "react";
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
      <ApiKeySetupPage
        config={config}
        mode={config ? "settings" : "onboarding"}
        onCancel={config ? () => setIsSettingsOpen(false) : undefined}
        onSave={handleSaveConfig}
      />
    );
  }

  return (
    <AppShell
      activeModel={config.model}
      isSavingModel={isSavingModel}
      onChangeModel={handleChangeModel}
      onOpenSettings={() => setIsSettingsOpen(true)}
    />
  );
}

export default App;
