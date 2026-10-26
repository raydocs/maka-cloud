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

/** The system's Reduce Motion: the shimmer and the springs stop while it is on. */
export const ReduceMotion = createContext(false);
export const useReduceMotion = () => useContext(ReduceMotion);

const SETTINGS = {
  transparency: ['isReduceTransparencyEnabled', 'reduceTransparencyChanged'],
  motion: ['isReduceMotionEnabled', 'reduceMotionChanged'],
} as const;

function useSystemSetting(which: keyof typeof SETTINGS): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const [read, event] = SETTINGS[which];
    // Where AccessibilityInfo has no such setting (the web preview), it is simply off.
    if (typeof AccessibilityInfo[read] !== 'function') return;
    let current = true;
    void AccessibilityInfo[read]()
      .then((value) => current && setOn(value))
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener(event, setOn);
    return () => {
      current = false;
      subscription?.remove();
    };
  }, [which]);
  return on;
}

/** System is the default; light or dark is one tap in Settings. The choice stays on this device. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ModeChoice>('system');
  const scheme = useColorScheme();
  const reduceTransparency = useSystemSetting('transparency');
  const reduceMotion = useSystemSetting('motion');
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
        <ReduceMotion.Provider value={reduceMotion}>
          <ThemeContext.Provider value={mode === 'dark' ? DARK : LIGHT}>
            {children}
          </ThemeContext.Provider>
        </ReduceMotion.Provider>
      </ReduceTransparency.Provider>
    </Appearance.Provider>
  );
}
