import { useT } from './i18n';
import { useEffect, useState } from 'react';
import {
  type CloudClient,
  displayText,
  type ErrorText,
  errorText,
  type Grant,
  grantFacts,
  Unsupported,
} from '@maka-cloud/client';

/**
 * The approvals the person kept ("for this task", "for this repository"), by repository: what each
 * lets the agent do again without asking, how it was used, when it ends, and a one-tap revoke. Hidden
 * on a server that keeps none.
 */
export function GrantsPanel({
  client,
  now = Date.now,
}: {
  client: CloudClient;
  now?: () => number;
}) {
  const { t, shared } = useT();
  const [grants, setGrants] = useState<Grant[] | undefined>();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorText>('');

  useEffect(() => {
    let current = true;
    client.listGrants().then(
      (list) => current && setGrants(list),
      (failure: unknown) => {
        if (!current) return;
        if (failure instanceof Unsupported) setHidden(true);
        else setError(errorText(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [client]);

  if (hidden) return null;

  async function act(work: () => Promise<unknown>, drop?: (grant: Grant) => boolean) {
    setBusy(true);
    setError('');
    try {
      await work();
      if (drop) setGrants((list) => list?.filter((grant) => !drop(grant)));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  const byRepository = new Map<string, Grant[]>();
  for (const grant of grants ?? []) {
    const list = byRepository.get(grant.repository) ?? [];
    list.push(grant);
    byRepository.set(grant.repository, list);
  }

  return (
    <section className="card section-card" aria-label={t('Kept approvals')}>
      <h2>{t('Kept approvals')}</h2>
      <p className="muted">
        {t(
          'What the agent may do again without asking. Revoke one and the next such step asks you.',
        )}
      </p>
      {grants && grants.length === 0 && (
        <p className="muted">
          {t(
            'Nothing kept. When you approve a step for a task or for a repository, it shows here.',
          )}
        </p>
      )}
      {[...byRepository].map(([repository, list]) => (
        <div key={repository} className="grant-group">
          <div className="grant-head">
            <h3 className="mono">{displayText(repository)}</h3>
            {list.length > 1 && (
              <button
                type="button"
                className="quiet-action"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    // The list shows scrubbed repository names, and the server matches the stored
                    // one, so a bulk revoke can miss: show what the server still keeps.
                    await client.revokeGrants({ repository });
                    setGrants(await client.listGrants());
                  })
                }
              >
                {t('Revoke all')}
              </button>
            )}
          </div>
          <ul className="grant-list">
            {list.map((grant) => {
              const facts = grantFacts(grant, now());
              return (
                <li key={grant.grantId} className="grant">
                  <div className="grant-text">
                    <span className="mono">{displayText(grant.tool)}</span>
                    <span className="muted">
                      {shared(facts.scope)} · {shared(facts.uses)} · {shared(facts.ends)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="quiet-action"
                    aria-label={t('Revoke {p0} in {p1}', {
                      p0: displayText(grant.tool),
                      p1: displayText(repository),
                    })}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => client.revokeGrant(grant.grantId),
                        (other) => other.grantId === grant.grantId,
                      )
                    }
                  >
                    {t('Revoke')}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {error && (
        <p role="alert" className="error">
          {shared(error)}
        </p>
      )}
    </section>
  );
}
