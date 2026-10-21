import { publicHttpsUrl } from './safe-fetch.js';
import { scrubErrorText } from './public-view.js';
import { withoutHidden } from './secret-shapes.js';

/**
 * What a card needs from a page it was given: a title and the address of its preview image.
 * The page is a stranger's text, so this reads only the start of it, with patterns that cannot run
 * away, and everything it hands back is one short printable line or a public https URL.
 */
export interface PageMeta {
  title?: string;
  imageUrl?: string;
}

const MAX_TITLE_CHARS = 140;
const MAX_HEAD_CHARS = 200_000;

// Characters that would let a title look like something else once shown: controls, direction and
// zero-width marks, private-use and unassigned code points, line and paragraph separators.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}͏ᅟᅠ឴឵᠋-᠏⠀ㅤ︀-️ﾠ\u{E0100}-\u{E01EF}]/gu;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/giu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** One short printable line, with no model or vendor names (the rule every outside string follows). */
export function plainLine(text: string, max = MAX_TITLE_CHARS): string | undefined {
  const line = scrubErrorText(withoutHidden(decodeEntities(text)))
    .replace(UNPRINTABLE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (line === '') return undefined;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(
    /([a-z][a-z0-9:_-]{0,40})\s*=\s*(?:"([^"]{0,2100})"|'([^']{0,2100})'|([^\s"'<>=`]{1,2100}))/giu,
  )) {
    const name = (match[1] ?? '').toLowerCase();
    if (!found.has(name)) found.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return found;
}

const SKIPPED = new Set(['script', 'style', 'template', 'noscript']);
const MAX_TAG_CHARS = 6000;
const MAX_TITLE_SOURCE_CHARS = 600;

/**
 * The title and preview image the page names for itself, read from the start of its HTML. One
 * pass over the text, each position visited once and every search for a closing mark remembered,
 * so hostile input (thousands of unclosed comments, tags or titles) costs time in proportion to
 * its size and no more. Comments and the contents of script, style, template and noscript are
 * not the page's own tags; reading stops at the end of `<head>`.
 */
export function readPageMeta(html: string, base: URL): PageMeta {
  const text = html.slice(0, MAX_HEAD_CHARS);
  const lower = text.toLowerCase();
  // `indexOf` from `from`, remembered: a mark that was not found is never searched for again, and
  // one that was found is searched for again only once the scan has gone past it.
  const memo = new Map<string, number>();
  const find = (needle: string, from: number): number => {
    const known = memo.get(needle);
    if (known === -1 || (known !== undefined && known >= from)) return known;
    const found = lower.indexOf(needle, from);
    memo.set(needle, found);
    return found;
  };

  const meta = new Map<string, string>();
  let titleTag: string | undefined;
  for (let at = 0; at < lower.length; ) {
    const open = find('<', at);
    if (open === -1) break;
    if (lower.startsWith('<!--', open)) {
      const close = find('-->', open + 4);
      if (close === -1) break;
      at = close + 3;
      continue;
    }
    const name = /^<(\/?)([a-z][a-z0-9]{0,15})/u.exec(lower.slice(open, open + 20));
    if (!name) {
      at = open + 1;
      continue;
    }
    const tag = name[2] ?? '';
    const closing = name[1] === '/';
    if ((closing && tag === 'head') || (!closing && tag === 'body')) break;
    const end = find('>', open);
    if (end === -1) break;
    if (end - open > MAX_TAG_CHARS) {
      at = open + 1;
      continue;
    }
    at = end + 1;
    if (closing) continue;
    if (SKIPPED.has(tag)) {
      const close = find(`</${tag}`, at);
      if (close === -1) break;
      const closeEnd = find('>', close);
      if (closeEnd === -1) break;
      at = closeEnd + 1;
    } else if (tag === 'meta') {
      const attrs = attributes(text.slice(open, end + 1));
      const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
      const content = attrs.get('content');
      if (key !== '' && content !== undefined && !meta.has(key)) meta.set(key, content);
    } else if (tag === 'title' && titleTag === undefined) {
      const close = find('</title', at);
      if (close !== -1 && close - at <= MAX_TITLE_SOURCE_CHARS) {
        titleTag = text.slice(at, close);
        const closeEnd = find('>', close);
        if (closeEnd === -1) break;
        at = closeEnd + 1;
      }
    }
  }

  const title = [meta.get('og:title'), meta.get('twitter:title'), titleTag]
    .map((value) => plainLine(value ?? ''))
    .find((line) => line !== undefined);
  const image = meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image');
  const imageUrl =
    image === undefined || image.trim() === ''
      ? undefined
      : publicHttpsUrl(decodeEntities(image).trim(), base)?.href;
  return {
    ...(title === undefined ? {} : { title }),
    ...(imageUrl === undefined ? {} : { imageUrl }),
  };
}
