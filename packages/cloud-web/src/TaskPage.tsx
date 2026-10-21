import { useEffect, useState } from 'react';
import { type CloudClient, Unsupported } from './client';
import type { ArtifactListing, InboxItem, TaskView } from './contract';
import { DiffLines, SourcesStack, useSources } from './Delivery';
import { errorText } from './errors';
import { displayText, dollars, publicLink, stepsOf, taskLabel } from './presentation';

/** What a result is, said in a person's words; a name is only a name. */
const isDiff = (listing: ArtifactListing) =>
  listing.kind === 'file' && /\.(diff|patch)$/iu.test(listing.name);

type Loaded =
  | { kind: 'diff'; name: string; text: string }
  | { kind: 'report'; name: string; text: string }
  | { kind: 'image'; name: string; blob: Blob }
  | { kind: 'link'; name: string; url: string }
  | { kind: 'failed'; name: string };

/** The reviewer's sentence for a task: the supervisor's own text, label included, never worked out here. */
export function verdictOf(items: readonly InboxItem[], taskId: string): InboxItem | undefined {
  return items
    .filter(
      (item) =>
        item.taskId === taskId && (item.kind === 'finished' || item.kind === 'verification_failed'),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

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
  const [results, setResults] = useState<Loaded[] | undefined>();
  const [verdict, setVerdict] = useState<InboxItem | undefined>();
  const [error, setError] = useState('');
  const sources = useSources(client, task.taskId, task.state);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const { artifacts } = await client.listArtifacts(task.taskId);
        const loaded: Loaded[] = [];
        for (const listing of artifacts) {
          if (listing.kind === 'link') {
            const url = publicLink(listing.url);
            if (url) loaded.push({ kind: 'link', name: listing.name, url });
            continue;
          }
          try {
            const content = await client.readArtifact(task.taskId, listing.index);
            if (content.kind === 'image')
              loaded.push({
                kind: 'image',
                name: listing.name,
                blob: content.blob,
              });
            else if (content.kind === 'text')
              loaded.push({
                kind: isDiff(listing) ? 'diff' : 'report',
                name: listing.name,
                text: content.text,
              });
          } catch {
            loaded.push({ kind: 'failed', name: listing.name });
          }
        }
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
  const { steps } = stepsOf(task.progress);
  const pull = results?.find(
    (result): result is Extract<Loaded, { kind: 'link' }> =>
      result.kind === 'link' && /\/pull\/\d+/u.test(result.url),
  );
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
            <a href={pull.url} target="_blank" rel="noreferrer noopener">
              Pull request ↗
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
          <List title="Done" items={manifest.done} />
          <List title="Not done" items={manifest.notDone} />
          <List title="Known issues" items={manifest.knownIssues} />
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
                {result.url} ↗
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
