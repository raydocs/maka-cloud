import Constants from 'expo-constants';
import { getLocales } from 'expo-localization';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { readSecure, removeSecure, writeSecure } from './secure';
import { EN, type Key, PATTERNS_ZH, PHRASES_ZH, SERVER_CHOICES, ZH } from './strings';
import { PATTERNS_HANT, PHRASES_HANT, ZH_HANT } from './strings.hant';

/** Simplified Chinese is the app's main language and its fallback; Traditional and English follow. */
export type Language = 'zh-Hans' | 'zh-Hant' | 'en';

export const LANGUAGES: readonly Language[] = ['zh-Hans', 'zh-Hant', 'en'];

const isLanguage = (value: unknown): value is Language => LANGUAGES.includes(value as Language);

/**
 * The language for the phone's preferred languages, from the first one only: English for `en-*`;
 * Traditional Chinese for a `Hant` script or Taiwan, Hong Kong and Macau; Simplified Chinese for any
 * other Chinese and for everything else.
 */
export function languageFor(tags: readonly string[]): Language {
  const parts = (tags[0] ?? '').toLowerCase().replace(/_/gu, '-').split('-');
  if (parts[0] === 'en') return 'en';
  if (parts[0] !== 'zh') return 'zh-Hans';
  if (parts.includes('hant')) return 'zh-Hant';
  if (parts.includes('hans')) return 'zh-Hans';
  return parts.some((part) => part === 'tw' || part === 'hk' || part === 'mo')
    ? 'zh-Hant'
    : 'zh-Hans';
}

/**
 * The language this phone asks for. A build can fix it (`extra.language`, from `MAKA_LANG`; the
 * device-test builds fix Simplified Chinese so the Maestro flows always read the same words).
 */
export function deviceLanguage(): Language {
  const fixed = (Constants.expoConfig?.extra as { language?: string } | undefined)?.language;
  if (isLanguage(fixed)) return fixed;
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

type Patterns = ReadonlyArray<[RegExp, (m: RegExpMatchArray) => string]>;

/** English text from the shared logic in the given words when it is known; otherwise exactly as sent. */
function phrase(text: string, phrases: Record<string, string>, patterns: Patterns): string {
  // Own entries only: server text such as "constructor" is not a phrase.
  if (Object.prototype.hasOwnProperty.call(phrases, text)) return phrases[text] as string;
  for (const [pattern, render] of patterns) {
    const match = pattern.exec(text);
    if (match) return render(match);
  }
  return text;
}

const TABLES = {
  en: { strings: EN as Record<Key, string>, phrases: undefined, patterns: [] as Patterns },
  'zh-Hans': { strings: ZH, phrases: PHRASES_ZH, patterns: PATTERNS_ZH },
  'zh-Hant': { strings: ZH_HANT, phrases: PHRASES_HANT, patterns: PATTERNS_HANT },
} as const;

export interface Translator {
  lang: Language;
  /** One of the app's own strings, with its values filled in. */
  t(key: Key, params?: Params): string;
  /** Finished English from the shared client logic or the app's non-screen code, translated if known. */
  tx(text: string): string;
  /** A decision's choice: the app's words for one of the server's fixed choices, else its label as sent. */
  choice(id: string, label: string): string;
}

const CHOICE_KEYS = new Map(SERVER_CHOICES.map(([id, label, key]) => [`${id}\n${label}`, key]));

export function translator(lang: Language): Translator {
  const { strings, phrases, patterns } = TABLES[lang];
  return {
    lang,
    t: (key, params) => fill(strings[key], params),
    tx: (text) => (phrases ? phrase(text, phrases, patterns) : text),
    choice: (id, label) => {
      const key = lang === 'en' ? undefined : CHOICE_KEYS.get(`${id}\n${label}`);
      return key ? fill(strings[key]) : label;
    },
  };
}

interface LanguageApi extends Translator {
  /** The language picked in Settings, or undefined while the phone's own decides. */
  chosen: Language | undefined;
  /**
   * Picks a language for this app on this device, which then wins over the phone's setting; with
   * none, the saved choice is removed and the phone's language decides again.
   */
  choose(language: Language | undefined): void;
}

const KEY = 'maka.language';

const LanguageContext = createContext<LanguageApi>({
  ...translator(deviceLanguage()),
  chosen: undefined,
  choose: () => {},
});

export const useT = () => useContext(LanguageContext);

/**
 * The app's language: `language` when given (tests), else the one picked in Settings (kept on this
 * device), else the phone's.
 */
export function LanguageProvider({
  language,
  children,
}: {
  language?: Language;
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState<Language | undefined>();
  // A pick made before the saved one is read back wins over it.
  const picked = useRef(false);
  useEffect(() => {
    let current = true;
    void readSecure(KEY)
      .then((stored) => {
        if (current && !picked.current && isLanguage(stored)) setChosen(stored);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  const choose = useCallback((next: Language | undefined) => {
    picked.current = true;
    setChosen(next);
    void (next ? writeSecure(KEY, next) : removeSecure(KEY)).catch(() => {});
  }, []);
  const lang = language ?? chosen ?? deviceLanguage();
  const value = useMemo(() => ({ ...translator(lang), chosen, choose }), [lang, chosen, choose]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
