import { useEffect, useState } from 'react';
import {
  type ArtifactListing,
  captionOf,
  type CloudClient,
  displayText,
  firstSentence,
  publicLink,
  type SourceLabel,
  type SourceListing,
  type SourcePreview,
  type TaskView,
  Unsupported,
} from '@maka-cloud/client';
import { Viewer } from './Viewer';

/** A picture's bytes as a local object URL, revoked when it goes. */
function useObjectUrl(blob: Blob | undefined): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) return setUrl('');
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/** The pages a task opened (no page is fetched to answer); none when the server has no such route. */
export function useSources(
  client: CloudClient,
  taskId: string,
  /** Changes when the task did something that may have opened a page. */
  refresh: string,
): SourceListing[] {
  const [sources, setSources] = useState<SourceListing[]>([]);
  useEffect(() => {
    let current = true;
    client
      .listSources(taskId)
      .then((result) => current && setSources(Array.isArray(result.sources) ? result.sources : []))
      .catch((error: unknown) => {
        if (current && !(error instanceof Unsupported)) setSources([]);
      });
    return () => {
      current = false;
    };
  }, [client, taskId, refresh]);
  return sources;
}

const LABEL_WORDS: Record<SourceLabel, string> = {
  source: 'a source',
  docs: 'the docs',
  alternative: 'an alternative',
  pull_request: 'the pull request',
  preview: 'the preview',
  test_report: 'the test report',
};

/** Why a card is in the stack comes first: the change itself, then how to see it, then the reading. */
const LABEL_ORDER: SourceLabel[] = [
  'pull_request',
  'preview',
  'test_report',
  'docs',
  'source',
  'alternative',
];
const STACK_SIZE = 3;

export function stackOf(sources: readonly SourceListing[]): SourceListing[] {
  return [...sources]
    .sort(
      (a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label) || a.index - b.index,
    )
    .slice(0, STACK_SIZE);
}

/** Tilt for card `i` of `n`; the middle card is flat and on top. */
function tilt(i: number, n: number): number {
  if (n === 1) return 0;
  if (n === 2) return i === 0 ? -4 : 3;
  return [-5, 0, 4][i] ?? 0;
}

function SourceCard({
  client,
  taskId,
  source,
  tiltDegrees,
  onTop,
}: {
  client: CloudClient;
  taskId: string;
  source: SourceListing;
  tiltDegrees: number;
  onTop: boolean;
}) {
  const [preview, setPreview] = useState<SourcePreview | undefined>();
  const [picture, setPicture] = useState<Blob | undefined>();
  const src = useObjectUrl(picture);
  useEffect(() => {
    let current = true;
    client
      .sourcePreview(taskId, source.index)
      .then(async (result) => {
        if (!current) return;
        setPreview(result);
        if (!result.image) return;
        const blob = await client.sourceImage(taskId, source.index);
        if (current) setPicture(blob);
      })
      .catch(() => {
        // A page that cannot be previewed is still a card, with the site's initial.
      });
    return () => {
      current = false;
    };
  }, [client, taskId, source.index]);
  const site = displayText(source.site);
  const title = displayText(preview?.title ?? source.site);
  const href = publicLink(source.url);
  const card = (
    <>
      <div className="source-image" aria-hidden="true">
        {src ? <img src={src} alt="" /> : <span>{site.charAt(0).toUpperCase()}</span>}
      </div>
      <div className="source-text">
        <span className="source-title">{title}</span>
        <span className="source-meta">
          {site} · {LABEL_WORDS[source.label]}
        </span>
      </div>
    </>
  );
  const style = {
    '--tilt': `${tiltDegrees}deg`,
    zIndex: onTop ? 2 : 1,
  } as React.CSSProperties;
  return href ? (
    <a className="source-card" href={href} target="_blank" rel="noreferrer noopener" style={style}>
      {card}
    </a>
  ) : (
    <div className="source-card" style={style}>
      {card}
    </div>
  );
}

/** Up to three of the pages the task opened, as a fanned stack (a swipe on a phone). */
export function SourcesStack({
  client,
  taskId,
  sources,
}: {
  client: CloudClient;
  taskId: string;
  sources: readonly SourceListing[];
}) {
  const shown = stackOf(sources);
  if (shown.length === 0) return null;
  const middle = shown.length === 3 ? 1 : shown.length - 1;
  return (
    <section className="sources-stack" aria-label="Sources">
      {shown.map((source, i) => (
        <SourceCard
          key={source.index}
          client={client}
          taskId={taskId}
          source={source}
          tiltDegrees={tilt(i, shown.length)}
          onTop={i === middle}
        />
      ))}
    </section>
  );
}

export function DiffLines({ text }: { text: string }) {
  return (
    <pre className="diff-content viewer-diff solid">
      {text.split('\n').map((line, i) => (
        <span
          // The text never reorders, so the line number is its identity.
          key={i}
          className={`diff-line${line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : ''}`}
        >
          {displayText(line)}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

interface Opened {
  kind: 'image' | 'diff';
  title: string;
  blob?: Blob;
  text?: string;
}

const isDiff = (listing: ArtifactListing) =>
  listing.kind === 'file' && /\.(diff|patch)$/iu.test(listing.name);

/**
 * A finished task as one result card: the outcome in one sentence, one visual proof from the box,
 * a caption, and at most two one-tap actions. The visual opens large over a blurred page.
 */
export function DeliveryCard({
  client,
  task,
  listings,
  sources,
  onOpenTask,
}: {
  client: CloudClient;
  task: TaskView;
  listings: readonly ArtifactListing[];
  sources: readonly SourceListing[];
  /** Opens the task's own page (plan, steps, changes, review, cost). */
  onOpenTask?: (task: TaskView) => void;
}) {
  const shot = listings.find((listing) => listing.image);
  const diff = listings.find(isDiff);
  const [proof, setProof] = useState<Blob | undefined>();
  const proofUrl = useObjectUrl(proof);
  const [opened, setOpened] = useState<Opened | undefined>();
  const [failed, setFailed] = useState(false);
  const shotIndex = shot?.index;

  useEffect(() => {
    if (shotIndex === undefined) return;
    let current = true;
    client
      .readArtifact(task.taskId, shotIndex)
      .then((content) => current && content.kind === 'image' && setProof(content.blob))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [client, task.taskId, shotIndex]);

  const summary = task.manifest?.summary;
  if (task.state !== 'succeeded' || summary === undefined) return null;
  const outcome = displayText(firstSentence(summary));
  const caption = shot ? captionOf(displayText(shot.name)) : diff ? 'The changes' : '';

  // The first two things a person would do next: the pull request, then the live preview.
  const pull = listings
    .filter((listing) => listing.kind === 'link')
    .map((listing) => publicLink(listing.url))
    .find((url) => url !== undefined && /\/pull\/\d+/u.test(url));
  const preview = publicLink(sources.find((source) => source.label === 'preview')?.url);
  const actions = [
    pull ? { label: 'Open pull request', href: pull } : undefined,
    preview ? { label: 'Open preview', href: preview } : undefined,
  ].filter((action) => action !== undefined);

  async function openDiff() {
    if (!diff) return;
    try {
      const content = await client.readArtifact(task.taskId, diff.index);
      if (content.kind === 'text')
        setOpened({
          kind: 'diff',
          title: caption || 'The changes',
          text: content.text,
        });
    } catch {
      setFailed(true);
    }
  }

  return (
    <article className="card delivery" aria-label={`Result: ${displayText(task.title ?? 'Task')}`}>
      <div className="section-heading">
        <span className="status-mark succeeded" />
        Finished
        {onOpenTask && (
          <button type="button" className="text-link" onClick={() => onOpenTask(task)}>
            Details
          </button>
        )}
      </div>
      <p className="delivery-outcome">{outcome}</p>
      {shot && proofUrl && (
        <button
          type="button"
          className="delivery-visual"
          aria-label={`Open large: ${caption || 'picture'}`}
          onClick={() =>
            setOpened({
              kind: 'image',
              title: caption || 'Picture',
              blob: proof,
            })
          }
        >
          <img className="picture" src={proofUrl} alt={displayText(shot.name)} />
        </button>
      )}
      {!(shot && proofUrl) && diff && (
        <button
          type="button"
          className="delivery-visual delivery-diff-tile"
          aria-label="Open large: the changes"
          onClick={() => void openDiff()}
        >
          <span aria-hidden="true">±</span> View the changes
        </button>
      )}
      {caption && <p className="delivery-caption muted">{caption}</p>}
      {failed && <p className="muted">The picture could not be loaded.</p>}
      {actions.length > 0 && (
        <div className="delivery-actions">
          {actions.slice(0, 2).map((action) => (
            <a
              key={action.label}
              className="action-pill"
              href={action.href}
              target="_blank"
              rel="noreferrer noopener"
            >
              {action.label} ↗
            </a>
          ))}
        </div>
      )}
      {opened && (
        <Viewer
          label={opened.title}
          status={
            <>
              <span className="status-mark succeeded" /> Finished · {opened.title}
            </>
          }
          onClose={() => setOpened(undefined)}
        >
          {opened.kind === 'image' && opened.blob && (
            <ViewerPicture blob={opened.blob} title={opened.title} />
          )}
          {opened.kind === 'diff' && <DiffLines text={opened.text ?? ''} />}
        </Viewer>
      )}
    </article>
  );
}

function ViewerPicture({ blob, title }: { blob: Blob; title: string }) {
  const src = useObjectUrl(blob);
  return src ? <img className="viewer-picture" src={src} alt={title} /> : null;
}

/** One top-level task's place in the chat: its result card when it finished, and the pages it opened. */
export function TaskDelivery({
  client,
  task,
  listings,
  onOpenTask,
}: {
  client: CloudClient;
  task: TaskView;
  listings: readonly ArtifactListing[];
  onOpenTask?: (task: TaskView) => void;
}) {
  const sources = useSources(client, task.taskId, `${task.state}:${task.progress.length}`);
  return (
    <>
      <DeliveryCard
        client={client}
        task={task}
        listings={listings}
        sources={sources}
        onOpenTask={onOpenTask}
      />
      <SourcesStack client={client} taskId={task.taskId} sources={sources} />
    </>
  );
}
