import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BRAND,
  type CloudClient,
  AUTHORITY_WORDS,
  budgetWords,
  displayText,
  type DutyView,
  errorText,
  type ProjectView,
  type SuggestionKindView,
  triggerWords,
  Unsupported,
} from '@maka-cloud/client';

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

function SuggestionRow({
  kind,
  busy,
  onToggle,
}: {
  kind: SuggestionKindView;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const shown = kind.accepted + kind.dismissed + kind.ignored;
  return (
    <li className="duty">
      <div className="duty-text">
        <strong>{displayText(kind.label)}</strong>
        <span className="muted">
          {shown === 0
            ? 'Nothing suggested yet.'
            : `${kind.accepted} done · ${kind.dismissed} not now · ${kind.ignored} unanswered`}
        </span>
        {kind.enabled && kind.backedOff && (
          <span className="muted">Shown less often: the last few went unanswered.</span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={kind.enabled}
        aria-label={`${displayText(kind.label)} suggestions are ${kind.enabled ? 'on' : 'off'}`}
        className={`switch${kind.enabled ? ' on' : ''}`}
        disabled={busy}
        onClick={() => onToggle(!kind.enabled)}
      >
        <span aria-hidden="true" className="switch-knob" />
      </button>
    </li>
  );
}

/**
 * What the employee may suggest in a project, one switch for each kind. Hidden where the server has
 * no suggestions (cards off), so a server without them shows nothing new.
 */
function Suggestions({ client, projectId }: { client: CloudClient; projectId: string }) {
  const [kinds, setKinds] = useState<SuggestionKindView[] | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const load = useCallback(async () => {
    try {
      setKinds((await client.listSuggestions(projectId)).kinds);
    } catch (e) {
      if (!(e instanceof Unsupported)) setError(errorText(e));
    }
  }, [client, projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(kind: SuggestionKindView, enabled: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await client.setSuggestionKind(projectId, kind.kind, enabled);
    } catch (e) {
      setError(errorText(e));
    } finally {
      await load();
      pending.current = false;
      setBusy(false);
    }
  }

  if (kinds === undefined || kinds.length === 0) return null;
  return (
    <>
      <h3>Suggestions</h3>
      <p className="muted">
        Things it may notice and offer to do. Nothing starts until you tap its first word.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul className="duties" aria-label="Suggestions">
        {kinds.map((kind) => (
          <SuggestionRow
            key={kind.kind}
            kind={kind}
            busy={busy}
            onToggle={(enabled) => void toggle(kind, enabled)}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * The projects Maka works on and the standing duties of each: what wakes it, how far it may
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
          <p className="muted">Projects aren’t turned on for this workspace yet.</p>
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {projects === undefined && !unavailable && !error && (
        <section className="card section-card" aria-label="Loading" aria-busy="true">
          <span className="skeleton-line" style={{ width: '40%' }} />
          <span className="skeleton-line" />
          <span className="skeleton-line" style={{ width: '70%' }} />
        </section>
      )}
      {projects?.length === 0 && !unavailable && (
        <section className="card section-card">
          <h2>No projects yet</h2>
          <p className="muted">A project is a repository {BRAND.name} looks after.</p>
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
          <Suggestions client={client} projectId={project.projectId} />
        </section>
      ))}
    </div>
  );
}
