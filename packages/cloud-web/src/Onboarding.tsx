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
export function starters(repo: string) {
  return [
    {
      verb: 'Fix',
      rest: `the failing test in ${repo}`,
      sentence: `Fix the failing test in ${repo} and open a pull request.`,
    },
    {
      verb: 'Add',
      rest: `a test for the least-tested module in ${repo}`,
      sentence: `Add a test for the least-tested module in ${repo} and open a pull request.`,
    },
    {
      verb: 'Update',
      rest: `a vulnerable dependency in ${repo}`,
      sentence: `Update a vulnerable dependency in ${repo}, keep the tests green, and open a pull request.`,
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
  const [repo, setRepo] = useState('');
  const name = repo
    .trim()
    .replace(/^https:\/\/github\.com\//u, '')
    .replace(/\.git$/u, '');
  const valid = REPO.test(name);
  return (
    <section className="card onboarding" aria-label="Get started">
      <div className="onboarding-head">
        <h2>Hand off your first task</h2>
        <button
          type="button"
          className="quiet-action"
          onClick={() => {
            rememberSkipped();
            onSkip();
          }}
        >
          Skip
        </button>
      </div>
      <ol className="onboarding-steps">
        <li>
          <span className="step-number" aria-hidden="true">
            1
          </span>
          <div>
            <h3>Name a repository</h3>
            <p className="muted">
              A public GitHub repository, as owner/name. Private ones come with the GitHub App.
            </p>
            <input
              aria-label="Repository"
              placeholder="owner/repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {repo.trim() !== '' && !valid && (
              <p className="muted">Write it as owner/name, for example acme/widgets.</p>
            )}
          </div>
        </li>
        <li>
          <span className="step-number" aria-hidden="true">
            2
          </span>
          <div>
            <h3>Pick a first task</h3>
            <p className="muted">It fills the sentence below. Change anything before you start.</p>
            <div className="starter-list">
              {starters(valid ? name : 'owner/repo').map((starter) => (
                <button
                  key={starter.verb}
                  type="button"
                  className="starter"
                  disabled={!valid}
                  onClick={() => onPick(starter.sentence)}
                >
                  <span className="verb-chip">{starter.verb}</span>{' '}
                  {starter.rest}
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
            <h3>Watch it work</h3>
            <p className="muted">
              You see each step, the test that proves the change, a second agent’s review and the
              cost. Nothing reaches your repository until you approve it.
            </p>
          </div>
        </li>
      </ol>
    </section>
  );
}
