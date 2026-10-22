interface Live {
  start(): void;
  stop(): void;
}

interface AppStates {
  currentState: string | null | undefined;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

/**
 * Keeps a stream open only while its screen is in front and the app is in the foreground. Call it
 * when the screen gains focus; the function it returns is for when the screen loses it. Coming back
 * opens the stream again (it replays the conversation, so nothing is missed or doubled).
 */
export function keepLive(feed: Live, appState: AppStates): () => void {
  if (!appState.currentState || appState.currentState === 'active') feed.start();
  const subscription = appState.addEventListener('change', (next) => {
    if (next === 'active') feed.start();
    else feed.stop();
  });
  return () => {
    subscription.remove();
    feed.stop();
  };
}
