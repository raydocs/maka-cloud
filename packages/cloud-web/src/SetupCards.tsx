import { useEffect, useState } from 'react';
import {
  type CloudClient,
  type Readiness,
  type SetupCard,
  type SetupStep,
  type ErrorText,
  errorText,
  Unsupported,
} from '@maka-cloud/client';
import { useT } from './i18n';
import type { Key } from './strings';
const titles: Record<SetupStep, Key> = {
  language: 'Choose your language',
  project: 'Connect a project',
  model: 'Ask the owner for model access',
  notifications: 'Enable notifications',
  conversation: 'Send your first message',
};
export function SetupCards({
  client,
  onAction,
  version,
}: {
  client: CloudClient;
  onAction: (action: SetupCard['action']) => void;
  version: number;
}) {
  const { t, shared } = useT();
  const pushAvailable =
    'Notification' in globalThis && 'PushManager' in globalThis && 'serviceWorker' in navigator;
  const [readiness, setReadiness] = useState<Readiness>();
  const [error, setError] = useState<ErrorText>('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (version < 0) return;
    let live = true;
    const refresh = () => {
      if (!live) return;
      void client.homeReadiness().then(
        (value) => {
          if (live) {
            setReadiness(value.readiness);
            setError('');
          }
        },
        (failure) => {
          if (live && !(failure instanceof Unsupported)) setError(errorText(failure));
        },
      );
    };
    // Permission comes from this client, never inferred from a push subscription.
    if (pushAvailable && Notification.permission === 'granted')
      void client.setup({ notificationsAllowed: true }).then(refresh, refresh);
    else refresh();
    window.addEventListener('focus', refresh);
    return () => {
      live = false;
      window.removeEventListener('focus', refresh);
    };
  }, [client, version, retry, pushAvailable]);
  return (
    <>
      {readiness?.cards
        .filter((card) => card.id !== 'notifications' || pushAvailable)
        .map((card) => (
          <section key={card.id} className="card section-card">
            <h2>{t(titles[card.id])}</h2>
            <button className="quiet-action" type="button" onClick={() => onAction(card.action)}>
              {t(titles[card.id])}
            </button>
            <button
              className="quiet-action"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void client
                  .setup({ dismiss: card.id })
                  .then(
                    (value) => setReadiness(value.readiness),
                    (failure) => setError(errorText(failure)),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {t('Later')}
            </button>
          </section>
        ))}
      {error && (
        <section className="card section-card">
          <p role="alert">{shared(error)}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            {t('Try again')}
          </button>
        </section>
      )}
    </>
  );
}
