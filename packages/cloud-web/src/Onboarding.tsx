import { translator, type Translator, useT } from './i18n';
import { useState } from 'react';

const SKIPPED_KEY = 'maka.onboarding.skipped';

/** Whether this browser skipped the first-run card. Storage can be missing or throw. */
export function onboardingSkipped(): boolean {
  try {
    return globalThis.localStorage?.getItem(SKIPPED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberSkipped() {
  try {
    globalThis.localStorage?.setItem(SKIPPED_KEY, '1');
  } catch {
    // The card then comes back next visit, which is harmless.
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** The three starters: verb-first, like the cards the employee proposes later. */
export function starters(repo: string, { t }: Pick<Translator, 't'> = translator('en')) {
  return [
    {
      verb: t('Fix'),
      rest: t('the failing test in {repo}', { repo }),
      sentence: t('Fix the failing test in {repo} and open a pull request.', { repo }),
    },
    {
      verb: t('Add'),
      rest: t('a test for the least-tested module in {repo}', { repo }),
      sentence: t('Add a test for the least-tested module in {repo} and open a pull request.', {
        repo,
      }),
    },
    {
      verb: t('starter.update'),
      rest: t('a vulnerable dependency in {repo}', { repo }),
      sentence: t(
        'Update a vulnerable dependency in {repo}, keep the tests green, and open a pull request.',
        { repo },
      ),
    },
  ];
}

/**
 * The first visit: name a repository, pick a first task (it fills the start sentence, nothing starts
 * on its own), and know what you will see. Shown until the first conversation, or until skipped.
 */
export function Onboarding({
  onPick,
  onSkip,
}: {
  onPick: (sentence: string) => void;
  onSkip: () => void;
}) {
  const { t } = useT();
  const [repo, setRepo] = useState('');
  const name = repo
    .trim()
    .replace(/^https:\/\/github\.com\//u, '')
    .replace(/\.git$/u, '');
  const valid = REPO.test(name);
  return (
    <section className="card onboarding" aria-label={t('Get started')}>
      <div className="onboarding-head">
        <h2>{t('Hand off your first task')}</h2>
        <button
          type="button"
          className="quiet-action"
          onClick={() => {
            rememberSkipped();
            onSkip();
          }}
        >
          {t('Skip')}
        </button>
      </div>
      <ol className="onboarding-steps">
        <li>
          <span className="step-number" aria-hidden="true">
            1
          </span>
          <div>
            <h3>{t('Name a repository')}</h3>
            <p className="muted">
              {t(
                'A public GitHub repository, as owner/name. Private ones come with the GitHub App.',
              )}
            </p>
            <input
              aria-label={t('Repository')}
              placeholder={t('owner/repo')}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {repo.trim() !== '' && !valid && (
              <p className="muted">{t('Write it as owner/name, for example acme/widgets.')}</p>
            )}
          </div>
        </li>
        <li>
          <span className="step-number" aria-hidden="true">
            2
          </span>
          <div>
            <h3>{t('Pick a first task')}</h3>
            <p className="muted">
              {t('It fills the sentence below. Change anything before you start.')}
            </p>
            <div className="starter-list">
              {starters(valid ? name : 'owner/repo', { t }).map((starter) => (
                <button
                  key={starter.verb}
                  type="button"
                  className="starter"
                  disabled={!valid}
                  onClick={() => onPick(starter.sentence)}
                >
                  <span className="verb-chip">{starter.verb}</span> {starter.rest}
                </button>
              ))}
            </div>
          </div>
        </li>
        <li>
          <span className="step-number" aria-hidden="true">
            3
          </span>
          <div>
            <h3>{t('Watch it work')}</h3>
            <p className="muted">
              {t(
                'You see each step, the test that proves the change, a second agent’s review and the cost. Nothing reaches your repository until you approve it.',
              )}
            </p>
          </div>
        </li>
      </ol>
    </section>
  );
}
