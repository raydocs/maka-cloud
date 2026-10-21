import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type CloudClient,
  displayText,
  dollars,
  type DutyView,
  errorText,
  type ProjectView,
  Unsupported,
} from '@maka-cloud/client';

const TRIGGER_WORDS: Record<string, string> = {
  ci_failed_default_branch: 'When CI fails on the default branch',
  ci_failed_own_pr: 'When CI fails on its own pull request',
  issue_opened: 'When an issue is opened',
  review_comment_own_pr: 'When someone comments on its pull request',
};

const AUTHORITY_WORDS: Record<DutyView['authority'], string> = {
  'read-only': 'Reads only',
  'open-pr': 'Opens pull requests',
  'merge-when-green': 'Merges when checks are green',
};

/** "Every 2 h", "Every 15 min", "When CI fails on the default branch": a trigger in a person's words. */
export function triggerWords(trigger: DutyView['trigger']): string {
  if (trigger.kind !== 'schedule') return TRIGGER_WORDS[trigger.kind] ?? 'When something happens';
  const minutes = trigger.everyMinutes ?? 0;
  if (minutes > 0 && minutes % 1440 === 0)
    return `Every ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes > 0 && minutes % 60 === 0) return `Every ${minutes / 60} h`;
  return `Every ${minutes} min`;
}

export function budgetWords(duty: DutyView): string {
  return `Up to ${dollars(duty.runBudgetUsd)} a run, ${dollars(duty.dailyCapUsd)} a day`;
}

function DutyRow({
  duty,
  busy,
  onToggle,
}: {
  duty: DutyView;
  busy: boolean;
  onToggle: (state: 'active' | 'off') => void;
}) {
  const on = duty.state === 'active';
  return (
    <li className="duty">
      <div className="duty-text">
        <strong>{displayText(duty.name)}</strong>
        <span className="muted">{triggerWords(duty.trigger)}</span>
        <span className="muted">
          {AUTHORITY_WORDS[duty.authority] ?? 'Limited'} · {budgetWords(duty)}
        </span>
        {duty.state === 'proposed' && (
          <span className="muted">
            Waiting for your approval. It shows on Home when it is ready.
          </span>
        )}
        {duty.state === 'off' && duty.offReason === 'failures' && (
          <span className="failure">
            Turned off after it failed {duty.consecutiveFailures} times in a row.
          </span>
        )}
      </div>
      {duty.state !== 'proposed' && (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${displayText(duty.name)} is ${on ? 'on' : 'off'}`}
          className={`switch${on ? ' on' : ''}`}
          disabled={busy}
          onClick={() => onToggle(on ? 'off' : 'active')}
        >
          <span aria-hidden="true" className="switch-knob" />
        </button>
      )}
    </li>
  );
}

/**
 * The projects the employee works on and the standing duties of each: what wakes it, how far it may
 * go, what it may spend, and an on/off switch. The server decides what a switch may do (an
 * unapproved duty and the limit on duties that are on are refused and said so).
 */
export function Projects({ client }: { client: CloudClient }) {
  const [projects, setProjects] = useState<ProjectView[] | undefined>();
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const pending = useRef(false);

  const load = useCallback(async () => {
    try {
      setProjects(await client.listProjects());
      setUnavailable(false);
    } catch (e) {
      if (e instanceof Unsupported) setUnavailable(true);
      else setError(errorText(e));
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(project: ProjectView, duty: DutyView, state: 'active' | 'off') {
    if (pending.current) return;
    pending.current = true;
    setBusy(duty.dutyId);
    setError('');
    try {
      await client.setDutyState(project.projectId, duty.dutyId, state);
    } catch (e) {
      setError(errorText(e));
    } finally {
      // Whatever the answer was, the page shows what the server holds now.
      await load();
      pending.current = false;
      setBusy('');
    }
  }

  return (
    <div className="page">
      <h1>Projects</h1>
      {unavailable && (
        <section className="card section-card">
          <p className="muted">Projects and duties are not available on this server.</p>
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {projects?.length === 0 && !unavailable && (
        <section className="card section-card">
          <h2>No projects yet</h2>
          <p className="muted">A project is a repository the employee looks after.</p>
        </section>
      )}
      {projects?.map((project) => (
        <section
          key={project.projectId}
          className="card section-card"
          aria-label={displayText(project.repo)}
        >
          <h2>{displayText(project.repo)}</h2>
          <p className="muted">Default branch: {displayText(project.defaultBranch)}</p>
          {project.duties.length === 0 ? (
            <p className="muted">No duties yet.</p>
          ) : (
            <ul className="duties">
              {project.duties.map((duty) => (
                <DutyRow
                  key={duty.dutyId}
                  duty={duty}
                  busy={busy !== ''}
                  onToggle={(state) => void toggle(project, duty, state)}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
