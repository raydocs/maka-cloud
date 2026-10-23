import { useT } from './i18n';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, FileDiff } from 'lucide-react';
import {
  type ArtifactListing,
  type CloudClient,
  type DeliveryModel,
  type DeliveryView,
  deliveryModel,
  displayText,
  LABEL_WORDS,
  loadSources,
  publicLink,
  type SourceListing,
  stackOf,
  type SourcePreview,
  type TaskView,
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
    void loadSources(client, taskId).then((loaded) => current && setSources(loaded));
    return () => {
      current = false;
    };
  }, [client, taskId, refresh]);
  return sources;
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
  const { shared } = useT();
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
          {site} · {shared(LABEL_WORDS[source.label])}
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
  const { t } = useT();
  const shown = stackOf(sources);
  if (shown.length === 0) return null;
  const middle = shown.length === 3 ? 1 : shown.length - 1;
  return (
    <section className="sources-stack" aria-label={t('Sources')}>
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

/**
 * One screenshot of the result at one viewport, framed like that device: it loads its own bytes,
 * shows its viewport's name under it, and opens large when tapped.
 */
function ViewShot({
  client,
  taskId,
  view,
  onOpen,
  onFailed,
}: {
  client: CloudClient;
  taskId: string;
  view: DeliveryView;
  onOpen: (blob: Blob) => void;
  onFailed: () => void;
}) {
  const { t, shared } = useT();
  const [blob, setBlob] = useState<Blob | undefined>();
  const url = useObjectUrl(blob);
  const index = view.listing.index;
  useEffect(() => {
    let current = true;
    client
      .readArtifact(taskId, index)
      .then((content) => current && content.kind === 'image' && setBlob(content.blob))
      .catch(() => current && onFailed());
    return () => {
      current = false;
    };
  }, [client, taskId, index, onFailed]);
  return (
    <figure className={`view-shot view-${view.viewport.toLowerCase()}`}>
      <button
        type="button"
        className="view-frame"
        aria-label={t('Open large: {p0}', { p0: shared(view.viewport) })}
        disabled={!blob}
        onClick={() => blob && onOpen(blob)}
      >
        {url ? (
          <img
            src={url}
            alt={t('{viewport}: {name}', {
              viewport: shared(view.viewport),
              name: displayText(view.listing.name),
            })}
          />
        ) : null}
      </button>
      <figcaption>{shared(view.viewport)}</figcaption>
    </figure>
  );
}

interface Opened {
  kind: 'image' | 'diff';
  title: string;
  blob?: Blob;
  text?: string;
}

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
  const { t, shared } = useT();
  const model = deliveryModel(task, listings, sources);
  const views = model?.views;
  // With views each screenshot loads itself; the single picture is not loaded a second time.
  const shot = views ? undefined : model?.shot;
  const diff = model?.diff;
  const [proof, setProof] = useState<Blob | undefined>();
  const proofUrl = useObjectUrl(proof);
  const [opened, setOpened] = useState<Opened | undefined>();
  const [failed, setFailed] = useState(false);
  const markFailed = useCallback(() => setFailed(true), []);
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

  if (!model) return null;
  const { outcome, actions } = model;
  const caption = views || (!shot && diff) ? shared(model.caption) : model.caption;

  async function openDiff() {
    if (!diff) return;
    try {
      const content = await client.readArtifact(task.taskId, diff.index);
      if (content.kind === 'text')
        setOpened({
          kind: 'diff',
          title: caption || t('The changes'),
          text: content.text,
        });
    } catch {
      setFailed(true);
    }
  }

  return (
    <article
      className="card delivery"
      aria-label={t('Result: {p0}', { p0: displayText(task.title ?? t('Task')) })}
    >
      <div className="section-heading">
        <span className="status-mark succeeded" />
        {t('Finished')}
        {onOpenTask && (
          <button type="button" className="text-link" onClick={() => onOpenTask(task)}>
            {t('Details')}
          </button>
        )}
      </div>
      <p className="delivery-outcome">{outcome}</p>
      {views && (
        <div className="delivery-views" role="group" aria-label={caption}>
          {views.map((view) => (
            <ViewShot
              key={view.viewport}
              client={client}
              taskId={task.taskId}
              view={view}
              onOpen={(blob) => setOpened({ kind: 'image', title: shared(view.viewport), blob })}
              onFailed={markFailed}
            />
          ))}
        </div>
      )}
      {shot && proofUrl && (
        <button
          type="button"
          className="delivery-visual"
          aria-label={t('Open large: {p0}', { p0: caption || t('Picture') })}
          onClick={() =>
            setOpened({
              kind: 'image',
              title: caption || t('Picture'),
              blob: proof,
            })
          }
        >
          <img className="picture" src={proofUrl} alt={displayText(shot.name)} />
        </button>
      )}
      {!views && !(shot && proofUrl) && diff && (
        <button
          type="button"
          className="delivery-visual delivery-diff-tile"
          aria-label={t('Open large: the changes')}
          onClick={() => void openDiff()}
        >
          <FileDiff aria-hidden="true" size={16} className="icon-inline" /> {t('View the changes')}
        </button>
      )}
      {/* The caption names a single picture: the changes tile already says what it is, and with
          views each frame is labelled while the caption names the group instead. */}
      {shot && caption && <p className="delivery-caption muted">{caption}</p>}
      {failed && <p className="muted">{t('The picture could not be loaded.')}</p>}
      {actions.length > 0 && (
        <div className="delivery-actions">
          {actions.map((action) => (
            <a
              key={action.label}
              className="action-pill"
              href={action.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {shared(action.label)}{' '}
              <ArrowUpRight aria-hidden="true" size={14} className="icon-inline" />
            </a>
          ))}
        </div>
      )}
      {opened && (
        <Viewer
          label={opened.title}
          status={
            <>
              <span className="status-mark succeeded" /> {t('Finished ·')} {opened.title}
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
