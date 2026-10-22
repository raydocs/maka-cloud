import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { defineTheme, Theme } from '@astryxdesign/core/theme';

export type Mode = 'light' | 'dark';
/** The person's choice; "system" follows the device's light or dark setting. */
export type ModeChoice = 'system' | Mode;

const STORAGE_KEY = 'maka.theme';

/**
 * Astryx's own controls (buttons, focus rings) are ink, like the selected navigation pill: actions
 * stay calm, and the blue accent in tokens.css is kept for what needs the person.
 */
const makaTheme = defineTheme({
  name: 'maka',
  tokens: {
    '--color-accent': ['#111318', '#f2f4f8'],
    '--color-on-accent': ['#ffffff', '#0d1322'],
    '--color-text-accent': ['#111318', '#f2f4f8'],
  },
  components: {
    button: { base: { borderRadius: '9999px', fontWeight: '500' } },
  },
});

/**
 * System is the default; a stored choice wins. Storage can be missing or throw (private windows).
 * index.html reads the same key before the first paint, so the page never flashes the other scheme.
 */
export function readChoice(): ModeChoice {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : 'system';
  } catch {
    return 'system';
  }
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemMode(): Mode {
  try {
    return globalThis.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The scheme to draw now: the stored choice, or the device's when there is none. */
export function readMode(): Mode {
  const choice = readChoice();
  return choice === 'system' ? systemMode() : choice;
}

function saveChoice(choice: ModeChoice) {
  try {
    if (choice === 'system') globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, choice);
  } catch {
    // The choice then lasts until the page closes.
  }
}

const ModeContext = createContext<{
  mode: Mode;
  choice: ModeChoice;
  setMode: (choice: ModeChoice) => void;
}>({
  mode: 'light',
  choice: 'system',
  setMode: () => {},
});

export const useMode = () => useContext(ModeContext);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ModeChoice>(readChoice);
  const [system, setSystem] = useState<Mode>(systemMode);
  // While the choice is "system", a change of the device's setting is followed at once.
  useEffect(() => {
    if (choice !== 'system') return;
    let query: MediaQueryList | undefined;
    try {
      query = globalThis.matchMedia?.(DARK_QUERY);
    } catch {
      return;
    }
    if (!query) return;
    const watched = query;
    const follow = () => setSystem(watched.matches ? 'dark' : 'light');
    follow();
    watched.addEventListener?.('change', follow);
    return () => watched.removeEventListener?.('change', follow);
  }, [choice]);
  const setMode = useCallback((next: ModeChoice) => {
    saveChoice(next);
    setChoice(next);
  }, []);
  const mode = choice === 'system' ? system : choice;
  const value = useMemo(() => ({ mode, choice, setMode }), [mode, choice, setMode]);
  return (
    <ModeContext.Provider value={value}>
      <Theme theme={makaTheme} mode={mode}>
        {children}
      </Theme>
    </ModeContext.Provider>
  );
}
