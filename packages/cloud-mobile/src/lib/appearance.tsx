import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { readSecure, writeSecure } from './secure';
import { DARK, LIGHT, ThemeContext } from './theme';

type Mode = 'dark' | 'light';
/** The person's choice; "system" follows the phone's own light or dark setting. */
export type ModeChoice = 'system' | Mode;
const KEY = 'maka.appearance';

const Appearance = createContext<{
  mode: Mode;
  choice: ModeChoice;
  setMode(choice: ModeChoice): void;
}>({
  mode: 'light',
  choice: 'system',
  setMode: () => {},
});
export const useAppearance = () => useContext(Appearance);

/** System is the default; light or dark is one tap in Settings. The choice stays on this device. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ModeChoice>('system');
  const scheme = useColorScheme();
  useEffect(() => {
    void readSecure(KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark' || stored === 'system') setChoice(stored);
    });
  }, []);
  const mode: Mode = choice === 'system' ? (scheme === 'dark' ? 'dark' : 'light') : choice;
  const value = useMemo(
    () => ({
      mode,
      choice,
      setMode(next: ModeChoice) {
        setChoice(next);
        void writeSecure(KEY, next).catch(() => {});
      },
    }),
    [mode, choice],
  );
  return (
    <Appearance.Provider value={value}>
      <ThemeContext.Provider value={mode === 'dark' ? DARK : LIGHT}>
        {children}
      </ThemeContext.Provider>
    </Appearance.Provider>
  );
}
