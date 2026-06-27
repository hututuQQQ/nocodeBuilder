import { Languages } from "lucide-react";
import { useI18n, type LocalePreference } from "../../i18n";

type LocaleSelectProps = {
  compact?: boolean;
};

const LOCALE_OPTIONS: LocalePreference[] = ["system", "en", "zh-CN"];

export function LocaleSelect({ compact = false }: LocaleSelectProps) {
  const { locale, preference, setPreference, t } = useI18n();

  return (
    <label
      className={`flex min-w-0 items-center gap-2 ${
        compact ? "w-full" : "w-full sm:w-auto"
      }`}
    >
      <span className="sr-only">{t("locale.label")}</span>
      <Languages
        size={compact ? 14 : 15}
        className="shrink-0 text-zinc-500"
        aria-hidden="true"
      />
      <select
        aria-label={t("locale.label")}
        className={`min-w-0 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-300 outline-none transition hover:border-zinc-700 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10 ${
          compact ? "h-8 flex-1 px-2" : "h-9 px-3"
        }`}
        onChange={(event) =>
          void setPreference(event.currentTarget.value as LocalePreference)
        }
        value={preference}
      >
        {LOCALE_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {formatLocaleOption(option, locale, t)}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatLocaleOption(
  option: LocalePreference,
  locale: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (option === "system") {
    return t("locale.systemResolved", {
      locale: locale === "zh-CN" ? "简体中文" : "English",
    });
  }

  return option === "zh-CN" ? t("locale.chinese") : t("locale.english");
}
