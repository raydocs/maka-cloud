import { ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  type CloudClient,
  displayText,
  dollars,
  errorText,
  type InboxItem,
  type LoadedResult,
  loadTaskResults,
  pullRequestOf,
  stepsOf,
  taskLabel,
  verdictOf,
  type TaskView,
  Unsupported,
} from '@maka-cloud/client';
import { DiffLines, SourcesStack, useSources } from './Delivery';

function ImageResult({ name, blob }: { name: string; blob: Blob }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return src ? <img className="picture" alt={displayText(name)} src={src} /> : null;
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul className="plain-list">
        {items.map((item, i) => (
          // The list never reorders, so the position is its identity.
          <li key={i}>{displayText(item)}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * One task in full, on a dense opaque page: what it did and did not do, how sure it is, the review,
 * the steps, the changes, the reports and pictures it left, the pages it opened, and what it cost.
 * Results are read once when the page opens (a finished task no longer changes).
 */
export function TaskPage({
  client,
  task,
  onBack,
}: {
  client: CloudClient;
  task: TaskView;
  onBack: () => void;
}) {
  const [results, setResults] = useState<LoadedResult[] | undefined>();
  const [verdict, setVerdict] = useState<InboxItem | undefined>();
  const [error, setError] = useState('');
  const sources = useSources(client, task.taskId, task.state);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const loaded = await loadTaskResults(client, task.taskId);
        if (current) setResults(loaded);
      } catch (e) {
        if (current) {
          setError(errorText(e));
          setResults([]);
        }
      }
    })();
    client
      .listInbox('all')
      .then((items) => current && setVerdict(verdictOf(items, task.taskId)))
      .catch((e: unknown) => {
        // A server with no inbox simply has no review to show.
        if (current && !(e instanceof Unsupported)) setVerdict(undefined);
      });
    return () => {
      current = false;
    };
  }, [client, task.taskId]);

  const manifest = task.manifest;
  // The runner's own `review:` line says whether a second agent reviewed the change; it is shown
  // on its own, in the runner's words, and left out of the plain list of what was done.
  const reviewLine = manifest?.done.find((line) => line.startsWith('review: '));
  const done = manifest?.done.filter((line) => line !== reviewLine) ?? [];
  const { steps } = stepsOf(task.progress);
  const pull = results ? pullRequestOf(results) : undefined;
  return (
    <article
      className="page task-page solid"
      aria-label={`Task: ${displayText(task.title ?? 'Task')}`}
    >
      <button type="button" className="back-link" onClick={onBack}>
        ← Back
      </button>
      <h1>{displayText(task.title ?? 'Task')}</h1>
      <p className="task-meta">
        <span className={`status-mark ${task.state}`} /> {taskLabel(task)} · Cost{' '}
        {dollars(task.costUsd)}
        {task.budgetUsd !== undefined && ` of ${dollars(task.budgetUsd)}`}
        {pull && (
          <>
            {' · '}
            <a href={pull} target="_blank" rel="noreferrer noopener">
              Pull request <ArrowUpRight aria-hidden="true" size={14} className="icon-inline" />
            </a>
          </>
        )}
      </p>
      {task.failureReason && <p className="failure">{displayText(task.failureReason)}</p>}
      {manifest && (
        <section aria-label="Outcome">
          <h2>Outcome</h2>
          <p>{displayText(manifest.summary)}</p>
          <p className="muted">Confidence the agent reported: {manifest.confidence}</p>
          <List title="Done" items={done} />
          <List title="Not done" items={manifest.notDone} />
          <List title="Known issues" items={manifest.knownIssues} />
        </section>
      )}
      {reviewLine !== undefined && (
        <section aria-label="Independent review">
          <h2>Independent review</h2>
          <p>{displayText(reviewLine.slice('review: '.length))}</p>
        </section>
      )}
      {verdict && (
        <section aria-label="Review">
          <h2>Review</h2>
          <p>{displayText(verdict.ask)}</p>
        </section>
      )}
      {steps.length > 0 && (
        <section aria-label="Steps">
          <h2>Steps</h2>
          <ol className="plain-list">
            {steps.map((step, i) => (
              <li key={i}>{displayText(step)}</li>
            ))}
          </ol>
        </section>
      )}
      <section aria-label="Results">
        <h2>Results</h2>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {results === undefined && <p className="muted">Loading the results…</p>}
        {results?.length === 0 && !error && <p className="muted">This task left no results.</p>}
        {results?.map((result, i) => (
          <div key={i} className="task-result">
            <h3>{displayText(result.name)}</h3>
            {result.kind === 'diff' && <DiffLines text={result.text} />}
            {result.kind === 'report' && <pre className="solid">{displayText(result.text)}</pre>}
            {result.kind === 'image' && <ImageResult name={result.name} blob={result.blob} />}
            {result.kind === 'link' && (
              <a href={result.url} target="_blank" rel="noreferrer noopener">
                {result.url} <ArrowUpRight aria-hidden="true" size={14} className="icon-inline" />
              </a>
            )}
            {result.kind === 'failed' && <p className="muted">This result could not be loaded.</p>}
          </div>
        ))}
      </section>
      <SourcesStack client={client} taskId={task.taskId} sources={sources} />
    </article>
  );
}
