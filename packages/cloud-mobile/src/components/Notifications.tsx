import { BRAND } from '@maka-cloud/client';
import { useState } from 'react';
import { ButtonRow, Card, PillButton, T } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { turnOff, turnOn, usePushState } from '@/lib/push';
import { useWorkspace } from '@/lib/session';

/**
 * The opt-in. On Home it shows once, after signing in, until the person says yes or not now; in Me
 * it always shows, with the way to turn notifications on or off. Nothing is asked of the phone
 * before "Turn on notifications" is tapped.
 */
export function NotificationsCard({ place }: { place: 'home' | 'me' }) {
  const { client, server } = useWorkspace();
  const { t: say } = useT();
  const state = usePushState();
  const [busy, setBusy] = useState(false);
  if (state === 'loading') return null;
  if (place === 'home' && state !== 'ask') return null;
  const words = {
    gotIt: say('push.action.gotIt'),
    notNow: say('push.action.notNow'),
    open: say('push.action.open'),
  };
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  const line =
    state === 'on'
      ? say('push.on')
      : state === 'declined'
        ? say('push.declined')
        : state === 'denied'
          ? say('push.denied', { name: BRAND.name })
          : state === 'unavailable'
            ? say('push.unavailable')
            : state === 'failed'
              ? say('push.failed')
              : undefined;
  return (
    <Card label={say('push.title')}>
      <T kind="heading">{say('push.title')}</T>
      <T kind="muted">{say('push.body', { name: BRAND.name })}</T>
      {line ? (
        <T kind={state === 'failed' ? 'error' : 'body'} testID={`push-${state}`}>
          {line}
        </T>
      ) : null}
      <ButtonRow>
        {state === 'on' ? (
          <PillButton
            label={say('push.turnOff')}
            id="push-off"
            compact
            disabled={busy}
            onPress={() => act(() => turnOff(client, server))}
          />
        ) : (
          <PillButton
            label={say('push.turnOn')}
            id="push-on"
            primary
            disabled={busy}
            onPress={() => act(() => turnOn(client, server, words, true))}
          />
        )}
        {state === 'ask' ? (
          <PillButton
            label={say('push.notNow')}
            id="push-not-now"
            compact
            disabled={busy}
            onPress={() => act(() => turnOff(client, server))}
          />
        ) : null}
      </ButtonRow>
    </Card>
  );
}
