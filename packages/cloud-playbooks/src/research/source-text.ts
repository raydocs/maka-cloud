const BLOCK_TAGS =
  /<\/?(?:p|div|br|li|ul|ol|tr|td|th|table|section|article|header|footer|nav|aside|main|blockquote|pre|h[1-6]|hr|figure|figcaption)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * The visible text of a fetched HTML page: no scripts, styles or comments, block
 * tags become line breaks, entities are decoded. This is a text extractor for
 * quote matching, not an HTML sanitiser; never render its output as HTML.
 */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const stripped = withoutBlocks.replace(BLOCK_TAGS, '\n').replace(/<[^>]*>/g, '');
  return decodeEntities(stripped);
}

/** Folds case, Unicode form, quote and dash styles and whitespace so a quote can be matched exactly. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Numbers in a text as plain digit strings: thousands separators dropped, a bracketed `[3]` ignored. */
export function numbersIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text
    .replace(/\[\d+\]/g, ' ')
    .matchAll(/(?<![\w.,])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)) {
    found.push(match[0].replace(/,/g, ''));
  }
  return found;
}
