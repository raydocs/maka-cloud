import { useT } from './i18n';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  type CloudClient,
  confidenceWords,
  finishedParts,
  displayText,
  dollars,
  errorText,
  type InboxItem,
  type LoadedResult,
  loadTaskResults,
  pullRequestOf,
  reviewLineOf,
  reviewWords,
  stepsOf,
  taskLabel,
  verdictOf,
  type TaskView,
  type TimelineStep,
  Unsupported,
  TERMINAL,
} from '@maka-cloud/client';
import { DiffLines, SourcesStack, useSources } from './Delivery';
import { FailureNote } from './Failure';

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
  const { t, shared, duration } = useT();
  const [results, setResults] = useState<LoadedResult[] | undefined>();
  const [verdict, setVerdict] = useState<InboxItem | undefined>();
  const [error, setError] = useState('');
  const [timeline, setTimeline] = useState<TimelineStep[]>([]);
  const [next, setNext] = useState<number>();
  const [timelineError, setTimelineError] = useState(false);
  const [loadingSteps, setLoadingSteps] = useState(false);
  const loadedCount = useRef(0);
  const generation = useRef(0);
  const terminal = TERMINAL.has(task.state);
  useEffect(() => {
    loadedCount.current = 0;
    setTimeline([]);
    setNext(undefined);
    setTimelineError(false);
    setLoadingSteps(false);
  }, [client, task.taskId]);
  useEffect(() => {
    const version = ++generation.current;
    setLoadingSteps(false);
    let request = 0;
    const refresh = async () => {
      const ticket = ++request;
      try {
        const steps = new Map<string, TimelineStep>();
        let after: number | undefined;
        do {
          const { timeline } = await client.timeline(task.taskId, { after });
          for (const step of timeline.steps) steps.set(step.stepId, step);
          after = timeline.stepsNext;
        } while (after !== undefined && steps.size < loadedCount.current);
        if (generation.current !== version || ticket !== request) return;
        setTimeline([...steps.values()]);
        loadedCount.current = steps.size;
        setNext(after);
        setTimelineError(false);
      } catch {
        if (generation.current === version) setTimelineError(true);
      }
    };
    void refresh();
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      generation.current++;
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client, task.taskId, terminal]);
  const moreSteps = async () => {
    const version = generation.current;
    setLoadingSteps(true);
    try {
      const page = await client.timeline(task.taskId, { after: next });
      if (generation.current !== version) return;
      setTimeline((steps) => {
        const merged = new Map(steps.map((step) => [step.stepId, step]));
        for (const step of page.timeline.steps) merged.set(step.stepId, step);
        loadedCount.current = merged.size;
        return [...merged.values()];
      });
      setNext(page.timeline.stepsNext);
      setTimelineError(false);
    } catch {
      if (generation.current === version) setTimelineError(true);
    } finally {
      if (generation.current === version) setLoadingSteps(false);
    }
  };
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
  // once, under Review, and left out of the plain list of what was done.
  const reviewLine = reviewLineOf(manifest?.done);
  const done = manifest?.done.filter((line) => line !== reviewLine) ?? [];
  const review = reviewWords(manifest?.done, verdict);
  const { steps } = stepsOf(task.progress);
  const pull = results ? pullRequestOf(results) : undefined;
  return (
    <article
      className="page task-page solid"
      aria-label={t('Task: {p0}', { p0: displayText(task.title ?? t('Task')) })}
    >
      <button type="button" className="back-link" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={16} className="icon-inline" /> {t('Back')}
      </button>
      <h1>{displayText(task.title ?? t('Task'))}</h1>
      <p className="task-page-meta muted">
        <span className={`status-mark ${task.state}`} /> {shared(taskLabel(task))}{' '}
        {task.costUsd !== undefined ? t('· Cost') : task.budgetUsd !== undefined && t('Budget:')}{' '}
        {(task.costUsd !== undefined || task.budgetUsd !== undefined) && (
          <span className="mono">
            {task.costUsd !== undefined && shared(dollars(task.costUsd))}
            {task.budgetUsd !== undefined &&
              (task.costUsd === undefined
                ? shared(dollars(task.budgetUsd))
                : t(' of {p0}', { p0: dollars(task.budgetUsd) }))}
          </span>
        )}
        {pull && (
          <>
            {' · '}
            <a href={pull} target="_blank" rel="noreferrer noopener">
              {t('Pull request')}
              <ArrowUpRight aria-hidden="true" size={14} className="icon-inline" />
            </a>
          </>
        )}
      </p>
      {task.failureReason && <FailureNote reason={task.failureReason} />}
      {manifest && (
        <section aria-label={t('Outcome')}>
          <h2>{t('Outcome')}</h2>
          <p>{displayText(manifest.summary)}</p>
          <p className="muted">{shared(confidenceWords(manifest.confidence))}</p>
          <List title={t('Done')} items={done} />
          <List title={t('Not done')} items={manifest.notDone} />
          <List title={t('Known issues')} items={manifest.knownIssues} />
        </section>
      )}
      {review.length > 0 && (
        <section aria-label={t('Review')}>
          <h2>{t('Review')}</h2>
          {review.map((line) => (
            <p key={line}>
              {reviewLine === undefined && verdict?.kind === 'finished' && finishedParts(verdict)
                ? shared(line)
                : line}
            </p>
          ))}
        </section>
      )}
      {(timeline.length > 0 || steps.length > 0 || timelineError) && (
        <section aria-label={t('Steps')}>
          <h2>{t('Steps')}</h2>
          {timelineError && <p role="alert">{t('Timeline could not be loaded.')}</p>}
          <ol className="plain-list">
            {timeline.map((step) => (
              <li key={step.stepId} data-state={step.state}>
                <strong>{displayText(step.kind)}</strong>
                {' · '}
                {t(
                  (
                    {
                      running: 'Running',
                      done: 'Done',
                      failed: 'Failed',
                      interrupted: 'Interrupted',
                    } as const
                  )[step.state],
                )}
                {step.label && <p>{displayText(step.label)}</p>}
                {step.durationMs !== undefined && (
                  <span>
                    {' '}
                    · {t('Duration: {duration}', { duration: duration(step.durationMs) })}
                  </span>
                )}
                {step.state === 'interrupted' && (
                  <p>{t('May or may not have happened — check before redoing it')}</p>
                )}
              </li>
            ))}
            {timeline.length === 0 && steps.map((step, i) => <li key={i}>{displayText(step)}</li>)}
          </ol>
          {next !== undefined && (
            <button type="button" disabled={loadingSteps} onClick={() => void moreSteps()}>
              {t('Load more steps')}
            </button>
          )}
        </section>
      )}
      <section aria-label={t('Results')}>
        <h2>{t('Results')}</h2>
        {error && (
          <p role="alert" className="error">
            {shared(error)}
          </p>
        )}
        {results === undefined && <p className="muted">{t('Loading the results…')}</p>}
        {results?.length === 0 && !error && (
          <p className="muted">{t('This task left no results.')}</p>
        )}
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
            {result.kind === 'failed' && (
              <p className="muted">{t('This result could not be loaded.')}</p>
            )}
          </div>
        ))}
      </section>
      <SourcesStack client={client} taskId={task.taskId} sources={sources} />
    </article>
  );
}
