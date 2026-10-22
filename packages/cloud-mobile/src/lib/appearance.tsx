import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { readSecure, writeSecure } from './secure';
import { DARK, LIGHT, ThemeContext } from './theme';

type Mode = 'dark' | 'light';
const KEY = 'maka.appearance';

const Appearance = createContext<{ mode: Mode; setMode(mode: Mode): void }>({
  mode: 'light',
  setMode: () => {},
});
export const useAppearance = () => useContext(Appearance);

/** Light is the default; dark is one tap in Settings. The choice stays on this device. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('light');
  useEffect(() => {
    void readSecure(KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark') setMode(stored);
    });
  }, []);
  const value = useMemo(
    () => ({
      mode,
      setMode(next: Mode) {
        setMode(next);
        void writeSecure(KEY, next).catch(() => {});
      },
    }),
    [mode],
  );
  return (
    <Appearance.Provider value={value}>
      <ThemeContext.Provider value={mode === 'dark' ? DARK : LIGHT}>
        {children}
      </ThemeContext.Provider>
    </Appearance.Provider>
  );
}
