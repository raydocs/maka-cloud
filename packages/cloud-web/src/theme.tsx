import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { defineTheme, Theme } from '@astryxdesign/core/theme';

export type Mode = 'light' | 'dark';

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

/** Light is the default; a stored choice wins. Storage can be missing or throw (private windows). */
export function readMode(): Mode {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function saveMode(mode: Mode) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    // The choice then lasts until the page closes.
  }
}

const ModeContext = createContext<{ mode: Mode; setMode: (mode: Mode) => void }>({
  mode: 'light',
  setMode: () => {},
});

export const useMode = () => useContext(ModeContext);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setState] = useState<Mode>(readMode);
  const setMode = useCallback((next: Mode) => {
    saveMode(next);
    setState(next);
  }, []);
  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return (
    <ModeContext.Provider value={value}>
      <Theme theme={makaTheme} mode={mode}>
        {children}
      </Theme>
    </ModeContext.Provider>
  );
}
