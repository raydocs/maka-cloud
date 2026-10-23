import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
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

/** The system's Reduce Transparency: glass and blur give way to solid fills while it is on. */
export const ReduceTransparency = createContext(false);
export const useReduceTransparency = () => useContext(ReduceTransparency);

function useSystemReduceTransparency(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    // The web preview's AccessibilityInfo has no such setting; there it is simply off.
    if (typeof AccessibilityInfo.isReduceTransparencyEnabled !== 'function') return;
    let current = true;
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => current && setOn(value))
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setOn);
    return () => {
      current = false;
      subscription?.remove();
    };
  }, []);
  return on;
}

/** System is the default; light or dark is one tap in Settings. The choice stays on this device. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ModeChoice>('system');
  const scheme = useColorScheme();
  const reduceTransparency = useSystemReduceTransparency();
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
      <ReduceTransparency.Provider value={reduceTransparency}>
        <ThemeContext.Provider value={mode === 'dark' ? DARK : LIGHT}>
          {children}
        </ThemeContext.Provider>
      </ReduceTransparency.Provider>
    </Appearance.Provider>
  );
}
