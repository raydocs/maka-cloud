import type { CloudClient } from './client';
import type { ArtifactListing, SourceListing, TaskView } from './contract';
import { captionOf, displayText, firstSentence, hostOf, publicLink } from './presentation';

/** What a result is, said in a person's words; a name is only a name. */
export const isDiffListing = (listing: ArtifactListing): boolean =>
  listing.kind === 'file' && /\.(diff|patch)$/iu.test(listing.name);

const PULL_REQUEST = /\/pull\/\d+/u;

export interface DeliveryAction {
  label: string;
  url: string;
  /** Where it goes; the agent chose the link, so a phone shows this beside the label. */
  host: string;
}

/** A finished task as one result card: the outcome, one visual proof, a caption, at most two actions. */
export interface DeliveryModel {
  outcome: string;
  /** The picture to show; the diff is shown only when there is none. */
  shot?: ArtifactListing;
  diff?: ArtifactListing;
  caption: string;
  actions: DeliveryAction[];
}

/**
 * The result card of a task, or nothing while it has not finished with a summary. The two actions a
 * person would take next are the pull request, then the live preview; only public links are offered.
 */
export function deliveryModel(
  task: TaskView,
  listings: readonly ArtifactListing[],
  sources: readonly SourceListing[],
): DeliveryModel | undefined {
  const summary = task.manifest?.summary;
  if (task.state !== 'succeeded' || summary === undefined) return undefined;
  const shot = listings.find((listing) => listing.image);
  const diff = listings.find(isDiffListing);
  const pull = listings
    .filter((listing) => listing.kind === 'link')
    .map((listing) => publicLink(listing.url))
    .find((url) => url !== undefined && PULL_REQUEST.test(url));
  const preview = publicLink(sources.find((source) => source.label === 'preview')?.url);
  const actions: DeliveryAction[] = [];
  if (pull) actions.push({ label: 'Open pull request', url: pull, host: hostOf(pull) });
  if (preview) actions.push({ label: 'Open preview', url: preview, host: hostOf(preview) });
  return {
    outcome: displayText(firstSentence(summary)),
    ...(shot ? { shot } : {}),
    ...(diff ? { diff } : {}),
    caption: shot ? captionOf(displayText(shot.name)) : diff ? 'The changes' : '',
    actions: actions.slice(0, 2),
  };
}

/** One result of a task, read once. A picture keeps its bytes; a text result is shown inert. */
export type LoadedResult =
  | { kind: 'diff'; name: string; text: string }
  | { kind: 'report'; name: string; text: string }
  | { kind: 'image'; name: string; blob: Blob }
  | { kind: 'link'; name: string; url: string }
  | { kind: 'failed'; name: string };

/**
 * Everything a finished task left, in the server's order. A result that cannot be read is listed as
 * failed, not dropped; a link that is not public is left out. Rejects only if the listing itself fails.
 */
export async function loadTaskResults(
  client: CloudClient,
  taskId: string,
): Promise<LoadedResult[]> {
  const { artifacts } = await client.listArtifacts(taskId);
  const loaded: LoadedResult[] = [];
  for (const listing of artifacts) {
    if (listing.kind === 'link') {
      const url = publicLink(listing.url);
      if (url) loaded.push({ kind: 'link', name: listing.name, url });
      continue;
    }
    try {
      const content = await client.readArtifact(taskId, listing.index);
      if (content.kind === 'image')
        loaded.push({ kind: 'image', name: listing.name, blob: content.blob });
      else if (content.kind === 'text')
        loaded.push({
          kind: isDiffListing(listing) ? 'diff' : 'report',
          name: listing.name,
          text: content.text,
        });
    } catch {
      loaded.push({ kind: 'failed', name: listing.name });
    }
  }
  return loaded;
}

/** The pull request among a task's results, if it opened one. */
export function pullRequestOf(results: readonly LoadedResult[]): string | undefined {
  for (const result of results)
    if (result.kind === 'link' && PULL_REQUEST.test(result.url)) return result.url;
  return undefined;
}

/**
 * The pages a task opened (no page is fetched to answer); none when the server has no such route or
 * the read fails.
 */
export async function loadSources(client: CloudClient, taskId: string): Promise<SourceListing[]> {
  try {
    const result = await client.listSources(taskId);
    return Array.isArray(result.sources) ? result.sources : [];
  } catch {
    // A server without the route, or a failed read, simply has no pages to show.
    return [];
  }
}
