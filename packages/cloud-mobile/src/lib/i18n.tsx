import Constants from 'expo-constants';
import { getLocales } from 'expo-localization';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { EN, type Key, PATTERNS_ZH, PHRASES_ZH, ZH } from './strings';

/** Simplified Chinese is the app's main language and its fallback; English is the one alternative. */
export type Language = 'zh-Hans' | 'en';

/** English only when the phone's first preferred language is English; Chinese otherwise. */
export function languageFor(tags: readonly string[]): Language {
  const first = tags[0]?.toLowerCase() ?? '';
  return first === 'en' || first.startsWith('en-') ? 'en' : 'zh-Hans';
}

/**
 * The language this phone asks for. A build can fix it (`extra.language`, from `MAKA_LANG`; the
 * device-test builds fix Chinese so the Maestro flows always read the same words).
 */
export function deviceLanguage(): Language {
  const fixed = (Constants.expoConfig?.extra as { language?: string } | undefined)?.language;
  if (fixed === 'en' || fixed === 'zh-Hans') return fixed;
  try {
    return languageFor(getLocales().map((locale) => locale.languageTag));
  } catch {
    return 'zh-Hans';
  }
}

type Params = Record<string, string | number>;

const fill = (text: string, params?: Params) =>
  text.replace(/\{(\w+)\}/gu, (all, name: string) =>
    params?.[name] === undefined ? all : String(params[name]),
  );

/** English text from the shared logic, in Chinese when it is known; otherwise exactly as sent. */
function phraseZh(text: string): string {
  const known = PHRASES_ZH[text];
  if (known !== undefined) return known;
  for (const [pattern, render] of PATTERNS_ZH) {
    const match = pattern.exec(text);
    if (match) return render(match);
  }
  return text;
}

export interface Translator {
  lang: Language;
  /** One of the app's own strings, with its values filled in. */
  t(key: Key, params?: Params): string;
  /** Finished English from the shared client logic or the app's non-screen code, translated if known. */
  tx(text: string): string;
}

export function translator(lang: Language): Translator {
  const table = lang === 'en' ? EN : ZH;
  return {
    lang,
    t: (key, params) => fill(table[key], params),
    tx: (text) => (lang === 'en' ? text : phraseZh(text)),
  };
}

const LanguageContext = createContext<Translator>(translator(deviceLanguage()));

export const useT = () => useContext(LanguageContext);

export function LanguageProvider({
  language,
  children,
}: {
  language?: Language;
  children: ReactNode;
}) {
  const value = useMemo(() => translator(language ?? deviceLanguage()), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
