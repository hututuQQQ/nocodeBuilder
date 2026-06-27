import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  readAppStorageValue,
  writeAppStorageValue,
} from "../services/appStorage";
import { translations, type TranslationKey } from "./translations";

export type Locale = "en" | "zh-CN";
export type LocalePreference = "system" | Locale;

type I18nContextValue = {
  locale: Locale;
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => Promise<void>;
  t: (key: TranslationKey, params?: TranslationParams) => string;
};

export type TranslationParams = Record<string, string | number>;
export type TranslateFunction = I18nContextValue["t"];

const DEFAULT_LOCALE_PREFERENCE: LocalePreference = "system";
const UI_LOCALE_STORAGE_KEY = "ui-locale";
const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>(
    DEFAULT_LOCALE_PREFERENCE,
  );
  const [systemLocale, setSystemLocale] = useState<Locale>(() =>
    resolveSystemLocale(readNavigatorLanguages()),
  );
  const locale = resolveLocalePreference(preference, [systemLocale]);

  useEffect(() => {
    let isActive = true;

    async function loadPreference() {
      try {
        const storedPreference =
          await readAppStorageValue<LocalePreference>(UI_LOCALE_STORAGE_KEY);

        if (isActive && isLocalePreference(storedPreference)) {
          setPreferenceState(storedPreference);
        }
      } catch {
        // Falling back to system language is fine when storage is unavailable.
      }
    }

    loadPreference();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    const handleLanguageChange = () => {
      setSystemLocale(resolveSystemLocale(readNavigatorLanguages()));
    };

    window.addEventListener("languagechange", handleLanguageChange);

    return () => {
      window.removeEventListener("languagechange", handleLanguageChange);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setPreference = useCallback(async (nextPreference: LocalePreference) => {
    setPreferenceState(nextPreference);
    await writeAppStorageValue(UI_LOCALE_STORAGE_KEY, nextPreference);
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) =>
      translate(locale, key, params),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      preference,
      setPreference,
      t,
    }),
    [locale, preference, setPreference, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);

  if (!value) {
    throw new Error("useI18n must be used within I18nProvider.");
  }

  return value;
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  params: TranslationParams = {},
) {
  const template = translations[locale][key] ?? translations.en[key] ?? key;

  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => {
    const value = params[name];
    return typeof value === "undefined" ? match : String(value);
  });
}

export function resolveLocalePreference(
  preference: LocalePreference,
  systemLanguages: readonly string[] = readNavigatorLanguages(),
): Locale {
  if (preference !== "system") {
    return preference;
  }

  return resolveSystemLocale(systemLanguages);
}

export function resolveSystemLocale(systemLanguages: readonly string[]) {
  return systemLanguages.some((language) =>
    language.toLocaleLowerCase().startsWith("zh"),
  )
    ? "zh-CN"
    : "en";
}

export function isLocalePreference(
  value: unknown,
): value is LocalePreference {
  return value === "system" || value === "en" || value === "zh-CN";
}

function readNavigatorLanguages() {
  if (typeof navigator === "undefined") {
    return ["en"];
  }

  return navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];
}
