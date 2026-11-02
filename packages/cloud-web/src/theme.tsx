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
/**
 * The person's choice; "system" follows the device's light or dark setting, "sky" follows the sun:
 * light from sunrise to sunset where the person is, dark after.
 */
export type ModeChoice = 'system' | 'sky' | Mode;

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
    return stored === 'dark' || stored === 'light' || stored === 'sky' ? stored : 'system';
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

/**
 * Whether the sun is up, from the date and the clock alone (no location asked): the time zone puts
 * solar noon near 12:00 standard time, and the season sets the day's length at a mid latitude.
 * index.html repeats this rule before the first paint; keep the two the same.
 */
export function daylight(now: Date = new Date()): boolean {
  const year = now.getFullYear();
  const standard = Math.max(
    new Date(year, 0, 1).getTimezoneOffset(),
    new Date(year, 6, 1).getTimezoneOffset(),
  );
  const summerShift = (standard - now.getTimezoneOffset()) / 60;
  const day = Math.floor((now.getTime() - new Date(year, 0, 0).getTime()) / 86_400_000);
  const declination = ((23.44 * Math.PI) / 180) * Math.sin((2 * Math.PI * (284 + day)) / 365);
  const latitude = (35 * Math.PI) / 180;
  const halfDay = (Math.acos(-Math.tan(latitude) * Math.tan(declination)) * 180) / Math.PI / 15;
  const noon = 12 + summerShift;
  const hour = now.getHours() + now.getMinutes() / 60;
  return hour >= noon - halfDay && hour < noon + halfDay;
}

/** The scheme to draw now: the stored choice, or the device's when there is none. */
export function readMode(): Mode {
  const choice = readChoice();
  if (choice === 'sky') return daylight() ? 'light' : 'dark';
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
  // Following the sky, the scheme turns at sunrise and sunset; a minute is close enough.
  const [sun, setSun] = useState<Mode>(() => (daylight() ? 'light' : 'dark'));
  useEffect(() => {
    if (choice !== 'sky') return;
    const look = () => setSun(daylight() ? 'light' : 'dark');
    look();
    const timer = setInterval(look, 60_000);
    return () => clearInterval(timer);
  }, [choice]);
  const setMode = useCallback((next: ModeChoice) => {
    saveChoice(next);
    setChoice(next);
  }, []);
  const mode = choice === 'system' ? system : choice === 'sky' ? sun : choice;
  const value = useMemo(() => ({ mode, choice, setMode }), [mode, choice, setMode]);
  return (
    <ModeContext.Provider value={value}>
      <Theme theme={makaTheme} mode={mode}>
        {children}
      </Theme>
    </ModeContext.Provider>
  );
}
