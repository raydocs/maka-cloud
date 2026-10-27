import { useEffect } from 'react';
import { loadPush } from './push';
import { useWorkspace } from './session';

/**
 * The browser preview (`expo start --web`, for reviewing screens) has no phone notifications to
 * route; it only reads the choice, so the screens show the opt-in as a phone would.
 */
export function usePushRouting() {
  const { server } = useWorkspace();
  useEffect(() => {
    void loadPush(server);
  }, [server]);
}
