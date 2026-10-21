import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { defineTheme, Theme } from '@astryxdesign/core/theme';

export type Mode = 'light' | 'dark';

const STORAGE_KEY = 'maka.theme';

/** The same accent as tokens.css, so Astryx's own controls (buttons, focus rings) match the cards. */
const makaTheme = defineTheme({
  name: 'maka',
  tokens: {
    '--color-accent': ['#245bbb', '#8db8ff'],
    '--color-on-accent': ['#ffffff', '#0b1730'],
    '--color-text-accent': ['#245bbb', '#8db8ff'],
  },
  components: {
    button: { base: { borderRadius: '9999px', fontWeight: '600' } },
  },
});

/** Dark is the default; a stored choice wins. Storage can be missing or throw (private windows). */
export function readMode(): Mode {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
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
  mode: 'dark',
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
