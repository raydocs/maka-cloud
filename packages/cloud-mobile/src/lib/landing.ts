import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { useWorkspace } from './session';

/**
 * Right after signing in, someone with conversations lands in the latest one; a first visit stays on
 * Home. Called by the tab layout, which mounts exactly when a session starts.
 */
export function useLanding() {
  const { landing } = useWorkspace();
  const router = useRouter();
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per session, when the tabs mount.
  useEffect(() => {
    if (landing === 'chat') router.replace('/chat');
  }, []);
}
