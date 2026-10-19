import { type CheckResult, type ClaimResult, passed } from './check.js';
import { type Claim, type Report, type Source, claimsOf } from './report-schema.js';

export interface Rendered {
  markdown: string;
  html: string;
  /** Ids of the failed claims left out of the report. */
  removed: string[];
}

const STATUS_TEXT: Record<ClaimResult['status'], string> = {
  verified: 'quote found and judged to support the claim',
  quote_verified: 'quote found; whether it supports the claim was not judged',
  unsupported: 'a reviewer judged the quote does not support the claim',
  quote_not_found: 'the quote is not in the source text',
  number_mismatch: 'a number in the claim is not in the quote',
  source_missing: 'no fetched text for the source',
  quote_too_short: 'the quote is too short to prove anything',
  no_citation: 'no source cited',
};

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeMarkdown = (text: string) => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Renders the report as Markdown and HTML. With `dropFailed`, claims that failed
 * the check are left out of the body and listed under "Not verified"; without it
 * they stay, each marked. Text is escaped: report text is untrusted.
 */
export function renderReport(
  report: Report,
  result: CheckResult,
  options: { dropFailed: boolean },
): Rendered {
  const status = new Map(result.claims.map((claim) => [claim.id, claim]));
  const failed = (claim: Claim) => !passed(status.get(claim.id)?.status ?? 'no_citation');
  const dropped = options.dropFailed ? claimsOf(report).filter(failed) : [];
  const droppedIds = new Set(dropped.map((claim) => claim.id));

  const sourceById = new Map(report.sources.map((source) => [source.id, source]));
  const numbers = new Map<string, number>();
  const cited: Source[] = [];
  const marker = (claim: Claim): string =>
    claim.citations
      .map((citation) => {
        const source = sourceById.get(citation.sourceId);
        if (!source) return '[?]';
        if (!numbers.has(source.id)) {
          numbers.set(source.id, cited.length + 1);
          cited.push(source);
        }
        return `[${numbers.get(source.id)}]`;
      })
      .join('');
  const note = (claim: Claim): string => {
    const found = status.get(claim.id);
    return found && !passed(found.status) ? STATUS_TEXT[found.status] : '';
  };

  const body = report.sections
    .map((section) => ({
      heading: section.heading,
      claims: section.claims.filter((claim) => !droppedIds.has(claim.id)),
    }))
    .filter((section) => section.claims.length > 0)
    .map((section) => ({
      heading: section.heading,
      claims: section.claims.map((claim) => ({
        text: claim.text,
        marker: marker(claim),
        note: note(claim),
      })),
    }));

  const counts = result.counts;
  const checked = [
    `${counts.total} claims checked against the fetched source text:`,
    `${counts.verified} with a quote found and judged to support the claim,`,
    `${counts.quoteVerified} with a quote found but no judgment on whether it supports the claim,`,
    `${counts.failed} failed${options.dropFailed ? ` and ${dropped.length} left out of this report` : ''}.`,
  ].join(' ');
  const droppedItems = dropped.map((claim) => ({
    text: claim.text,
    why: STATUS_TEXT[status.get(claim.id)?.status ?? 'no_citation'],
  }));

  const md: string[] = [`# ${escapeMarkdown(report.title)}`, ''];
  for (const section of body) {
    md.push(`## ${escapeMarkdown(section.heading)}`, '');
    for (const claim of section.claims) {
      const flag = claim.note ? `_(not verified: ${claim.note})_` : '';
      md.push(`- ${[escapeMarkdown(claim.text), claim.marker, flag].filter(Boolean).join(' ')}`);
    }
    md.push('');
  }
  if (cited.length > 0) {
    md.push('## Sources', '');
    cited.forEach((source, index) => {
      const title = escapeMarkdown(source.title ?? source.url);
      md.push(`${index + 1}. ${title}: <${new URL(source.url).href}>`);
    });
    md.push('');
  }
  if (droppedItems.length > 0) {
    md.push(
      '## Not verified',
      '',
      'These claims were left out because they failed the citation check.',
      '',
    );
    for (const item of droppedItems) md.push(`- ${escapeMarkdown(item.text)} (${item.why})`);
    md.push('');
  }
  md.push('## How this was checked', '', checked, '');

  const html: string[] = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(report.title)}</title>`,
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1rem}.nv{color:#8a4b00}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.nv{color:#f0b060}a{color:#8ab4f8}}</style>',
    '</head><body>',
    `<h1>${escapeHtml(report.title)}</h1>`,
  ];
  for (const section of body) {
    html.push(`<h2>${escapeHtml(section.heading)}</h2>`, '<ul>');
    for (const claim of section.claims) {
      const flag = claim.note
        ? `<span class="nv">(not verified: ${escapeHtml(claim.note)})</span>`
        : '';
      const text = [escapeHtml(claim.text), escapeHtml(claim.marker), flag]
        .filter(Boolean)
        .join(' ');
      html.push(`<li>${text}</li>`);
    }
    html.push('</ul>');
  }
  if (cited.length > 0) {
    html.push('<h2>Sources</h2>', '<ol>');
    for (const source of cited) {
      const href = escapeHtml(new URL(source.url).href);
      html.push(
        `<li><a href="${href}" rel="noopener noreferrer">${escapeHtml(source.title ?? source.url)}</a></li>`,
      );
    }
    html.push('</ol>');
  }
  if (droppedItems.length > 0) {
    html.push(
      '<h2>Not verified</h2>',
      '<p>These claims were left out because they failed the citation check.</p>',
      '<ul>',
    );
    for (const item of droppedItems) {
      html.push(`<li>${escapeHtml(item.text)} (${escapeHtml(item.why)})</li>`);
    }
    html.push('</ul>');
  }
  html.push('<h2>How this was checked</h2>', `<p>${escapeHtml(checked)}</p>`, '</body></html>');

  return {
    markdown: `${md.join('\n').trimEnd()}\n`,
    html: `${html.join('\n')}\n`,
    removed: dropped.map((claim) => claim.id),
  };
}
