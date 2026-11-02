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
/** One line under the title, and the button's own short verb. */
const lines: Record<SetupStep, { what: Key; verb: Key }> = {
  language: { what: 'Pick the language Maka writes in.', verb: 'Choose' },
  project: {
    what: 'Give Maka a GitHub repository to work in.',
    verb: 'Connect',
  },
  model: {
    what: 'The owner turns on model access for your account.',
    verb: 'Ask',
  },
  notifications: {
    what: 'Hear when work finishes or needs you, even with the tab closed.',
    verb: 'Turn on',
  },
  conversation: {
    what: 'Say what you want done. Maka plans it, does it and shows proof.',
    verb: 'Write it',
  },
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
  const cards = (readiness?.cards ?? []).filter(
    (card) => card.id !== 'notifications' || pushAvailable,
  );
  return (
    <>
      {/* The steps left share one card, a row each, so setup never pushes the work off a phone. */}
      {cards.length > 0 && (
        <section className="card section-card setup-card" aria-label={t('Finish setting up')}>
          <h2>{t('Finish setting up')}</h2>
          <ul className="setup-rows">
            {cards.map((card) => (
              <li key={card.id} className="setup-row">
                <div className="setup-card-text">
                  <h3>{t(titles[card.id])}</h3>
                  <p className="muted">{t(lines[card.id].what)}</p>
                </div>
                <div className="card-actions">
                  <button
                    className="pill-action"
                    type="button"
                    aria-label={t(titles[card.id])}
                    onClick={() => onAction(card.action)}
                  >
                    {t(lines[card.id].verb)}
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
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
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
