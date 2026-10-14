import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import vi from "./locales/vi.json";
import zh from "./locales/zh.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import it from "./locales/it.json";
import pt from "./locales/pt.json";
import ru from "./locales/ru.json";
import id from "./locales/id.json";

/** Add a language: drop a JSON file in ./locales, import it here and list it below. */
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "zh", name: "简体中文" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português (Brasil)" },
  { code: "ru", name: "Русский" },
  { code: "id", name: "Bahasa Indonesia" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];

const STORAGE_KEY = "language";

function initialLanguage(): Language {
  const saved = localStorage.getItem(STORAGE_KEY);
  const wanted = [saved, ...navigator.languages].filter(Boolean) as string[];
  for (const tag of wanted) {
    const base = tag.toLowerCase().split("-")[0];
    const hit = LANGUAGES.find((l) => l.code === base);
    if (hit) return hit.code;
  }
  return "en";
}

i18n.use(initReactI18next).init({
  resources: Object.fromEntries(
    Object.entries({ en, vi, zh, ja, ko, es, fr, de, it, pt, ru, id }).map(([code, translation]) => [code, { translation }]),
  ),
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

const syncHtmlLang = (lng: string) => document.documentElement.setAttribute("lang", lng);
syncHtmlLang(i18n.language);
i18n.on("languageChanged", syncHtmlLang);

export function setLanguage(code: Language) {
  localStorage.setItem(STORAGE_KEY, code);
  i18n.changeLanguage(code);
}

export default i18n;
