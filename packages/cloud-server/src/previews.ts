import type { DatabaseSync } from 'node:sqlite';
import { IMAGE_TYPES, type ImageType, sniffImage } from './image-type.js';
import { type PageMeta, readPageMeta } from './page-meta.js';
import { publicHttpsUrl, type createSafeFetch } from './safe-fetch.js';

export type SafeFetch = ReturnType<typeof createSafeFetch>;

/**
 * Why a page is on a card. Only these words ever reach the owner: the log takes one of them from
 * trusted code, never text a model wrote, so a source cannot caption itself.
 */
export const SOURCE_LABELS = [
  'source',
  'docs',
  'alternative',
  'pull_request',
  'preview',
  'test_report',
] as const;
export type SourceLabel = (typeof SOURCE_LABELS)[number];

/** Pages one task may have on record; the rest are not kept. */
export const MAX_OPENED_PAGES = 20;

export interface OpenedPage {
  index: number;
  url: string;
  label: SourceLabel;
}

/**
 * The pages a task actually opened, as seen by trusted code (a tool result in the transcript, a
 * pull request the employee opened), recorded per task. The preview proxy fetches nothing that is
 * not here: not a link in a manifest, not a URL in model text, not a markdown image.
 */
export class OpenedPages {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records the pages that are plain public https URLs and are new; returns how many were kept. */
  record(taskId: string, pages: readonly { url: string; label?: SourceLabel }[]): number {
    let kept = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          'SELECT COUNT(*) AS n, COALESCE(MAX(seq), -1) AS last FROM opened_pages WHERE task_id = ?',
        )
        .get(taskId) as { n: number; last: number };
      let count = row.n;
      let seq = row.last;
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO opened_pages (task_id, seq, url, label, opened_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const page of pages) {
        if (count >= MAX_OPENED_PAGES) break;
        const url = publicHttpsUrl(page.url);
        const label = page.label ?? 'source';
        if (!url || !SOURCE_LABELS.includes(label)) continue;
        url.hash = '';
        const result = insert.run(taskId, seq + 1, url.href, label, this.now());
        if (Number(result.changes) === 1) {
          seq += 1;
          count += 1;
          kept += 1;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return kept;
  }

  list(taskId: string): OpenedPage[] {
    const rows = this.db
      .prepare('SELECT url, label FROM opened_pages WHERE task_id = ? ORDER BY seq')
      .all(taskId) as { url: string; label: SourceLabel }[];
    return rows.map((row, index) => ({ index, url: row.url, label: row.label }));
  }
}

export interface Preview {
  /** The site's name as the owner sees it: the host of the page that was opened. */
  site: string;
  title?: string;
  image?: { type: ImageType; bytes: Buffer };
}

export class PreviewBusy extends Error {
  constructor() {
    super('previews_busy');
  }
}

export interface PreviewOptions {
  fetch: SafeFetch;
  now?: () => number;
  /** How long a preview is kept; 0 means not at all. */
  ttlMs?: number;
  /** How long a failed one is kept, so a dead site is not asked again at once. */
  failureTtlMs?: number;
  maxEntries?: number;
  /** The image bytes held in the cache, in all. */
  maxImageBytes?: number;
  /** Page fetches running at once, for every owner together. */
  maxInFlight?: number;
  pageBytes?: number;
  imageBytes?: number;
  timeoutMs?: number;
}

const DEFAULTS = {
  ttlMs: 60 * 60_000,
  failureTtlMs: 5 * 60_000,
  maxEntries: 256,
  maxImageBytes: 24 * 1024 * 1024,
  maxInFlight: 4,
  pageBytes: 512 * 1024,
  imageBytes: 1024 * 1024,
  timeoutMs: 6000,
};

export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/\.$/u, '').replace(/^www\./u, '');
  } catch {
    return '';
  }
}

/**
 * Previews of pages a task opened: the title and the page's own preview image, fetched here so
 * that the browser never contacts the site. One fetch per page at a time (a second asker waits
 * for the first), a bounded cache, a cap on fetches in flight, and a cache of failures too.
 * The caller decides which URLs may be asked; this only fetches what it is given, safely.
 */
export class PreviewService {
  private readonly options: Required<Omit<PreviewOptions, 'fetch' | 'now'>>;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; failed: boolean; preview: Preview }>();
  private readonly flights = new Map<string, Promise<Preview>>();
  private imageBytesHeld = 0;
  private running = 0;

  constructor(private readonly deps: PreviewOptions) {
    const { fetch: _fetch, now: _now, ...rest } = deps;
    this.options = { ...DEFAULTS, ...rest };
    this.now = deps.now ?? Date.now;
  }

  /** Fetches in flight: for tests and for the server's own gauge. */
  inFlight(): number {
    return this.running;
  }

  /** Bytes of preview images held. */
  held(): number {
    return this.imageBytesHeld;
  }

  async get(url: string): Promise<Preview> {
    const hit = this.cache.get(url);
    if (hit) {
      const age = this.now() - hit.at;
      if (age >= 0 && age < (hit.failed ? this.options.failureTtlMs : this.options.ttlMs)) {
        return hit.preview;
      }
      this.drop(url);
    }
    const flight = this.flights.get(url);
    if (flight) return flight;
    // No await between this check and the slot being taken.
    if (this.running >= this.options.maxInFlight) throw new PreviewBusy();
    this.running += 1;
    const started = this.load(url).finally(() => {
      this.running -= 1;
      this.flights.delete(url);
    });
    this.flights.set(url, started);
    return started;
  }

  private async load(url: string): Promise<Preview> {
    const site = siteOf(url);
    let preview: Preview = { site };
    let failed = true;
    try {
      const page = await this.deps.fetch(url, {
        accept: ['text/html', 'application/xhtml+xml'],
        maxBytes: this.options.pageBytes,
        startOnly: true,
        timeoutMs: this.options.timeoutMs,
      });
      if (page.ok) {
        failed = false;
        const meta: PageMeta = readPageMeta(page.body.toString('utf8'), new URL(page.url));
        preview = { site, ...(meta.title === undefined ? {} : { title: meta.title }) };
        if (meta.imageUrl !== undefined) {
          const image = await this.deps.fetch(meta.imageUrl, {
            accept: IMAGE_TYPES,
            maxBytes: this.options.imageBytes,
            timeoutMs: this.options.timeoutMs,
          });
          const type = image.ok ? sniffImage(image.body) : undefined;
          // The bytes decide, and the type the site declared must agree with them.
          if (image.ok && type !== undefined && type === image.contentType) {
            preview.image = { type, bytes: image.body };
          }
        }
      }
    } catch {
      // A page that cannot be read is a card without a preview, not an error.
    }
    this.store(url, { at: this.now(), failed, preview });
    return preview;
  }

  private store(url: string, entry: { at: number; failed: boolean; preview: Preview }): void {
    if (this.options.ttlMs === 0) return;
    const size = entry.preview.image?.bytes.length ?? 0;
    if (size > this.options.maxImageBytes) {
      delete entry.preview.image;
    }
    this.drop(url);
    this.cache.set(url, entry);
    this.imageBytesHeld += entry.preview.image?.bytes.length ?? 0;
    for (const oldest of this.cache.keys()) {
      if (
        this.cache.size <= this.options.maxEntries &&
        this.imageBytesHeld <= this.options.maxImageBytes
      )
        break;
      if (oldest !== url) this.drop(oldest);
    }
  }

  private drop(url: string): void {
    const entry = this.cache.get(url);
    if (!entry) return;
    this.imageBytesHeld -= entry.preview.image?.bytes.length ?? 0;
    this.cache.delete(url);
  }
}
