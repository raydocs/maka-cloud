import { publicHttpsUrl } from './safe-fetch.js';
import { scrubErrorText } from './public-view.js';

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
  const line = scrubErrorText(decodeEntities(text))
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

/** The title and preview image the page names for itself, read from the start of its HTML. */
export function readPageMeta(html: string, base: URL): PageMeta {
  const head = html
    .slice(0, MAX_HEAD_CHARS)
    .replace(/<!--[\s\S]{0,20000}?-->/gu, '')
    .replace(/<(script|style|template|noscript)\b[\s\S]{0,50000}?<\/\1\s*>/giu, '');
  const end = head.search(/<\/head\s*>|<body\b/iu);
  const scope = end === -1 ? head : head.slice(0, end);

  const meta = new Map<string, string>();
  for (const tag of scope.matchAll(/<meta\b[^<>]{0,6000}>/giu)) {
    const attrs = attributes(tag[0]);
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (key !== '' && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title\b[^>]{0,200}>([\s\S]{0,600}?)<\/title\s*>/iu.exec(scope)?.[1];
  const title = [meta.get('og:title'), meta.get('twitter:title'), titleTag]
    .map((text) => plainLine(text ?? ''))
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
