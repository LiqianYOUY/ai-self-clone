"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Language = "zh" | "en";
const LANGUAGE_KEY = "self-language";
const LanguageContext = createContext<{
  language: Language;
  setLanguage: (language: Language) => void;
  t: (zh: string, en: string) => string;
}>({ language: "zh", setLanguage: () => undefined, t: (zh) => zh });

export function LanguageProvider({ children }: { children: ReactNode }) {
  // The first client render matches the server. Browser preferences apply only
  // after hydration; storage is optional in private or restricted browsers.
  const [language, updateLanguage] = useState<Language>("zh");
  const setLanguage = useCallback((next: Language) => {
    updateLanguage(next);
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    try {
      localStorage.setItem(LANGUAGE_KEY, next);
    } catch {
      /* Optional preference. */
    }
    const url = new URL(window.location.href);
    if (url.searchParams.has("lang")) {
      url.searchParams.set("lang", next);
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("lang");
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LANGUAGE_KEY);
    } catch {
      /* Optional preference. */
    }
    const preferred = query === "zh" || query === "en" ? query : stored;
    setLanguage(preferred === "en" ? "en" : "zh");
    const sync = (event: StorageEvent) => {
      if (
        event.key === LANGUAGE_KEY &&
        (event.newValue === "zh" || event.newValue === "en")
      ) {
        setLanguage(event.newValue);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [setLanguage]);
  const value = useMemo(
    () => ({
      language,
      setLanguage,
      t: (zh: string, en: string) => (language === "en" ? en : zh),
    }),
    [language, setLanguage],
  );
  return (
    <LanguageContext.Provider value={value}>
      <title>
        {language === "zh" ? "Self · 猜猜我是谁" : "Self · Human or AI?"}
      </title>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

export function LanguageSwitch() {
  const { language, setLanguage, t } = useLanguage();
  return (
    <div
      className="play-language-switch"
      role="group"
      aria-label={t("界面语言", "Interface language")}
    >
      <button
        type="button"
        lang="zh-CN"
        aria-pressed={language === "zh"}
        onClick={() => setLanguage("zh")}
      >
        中文
      </button>
      <button
        type="button"
        lang="en"
        aria-pressed={language === "en"}
        onClick={() => setLanguage("en")}
      >
        EN
      </button>
    </div>
  );
}

export { LanguageSwitch as LanguageSwitcher };
