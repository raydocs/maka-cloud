import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCitations } from '../check.js';
import { renderReport } from '../render.js';
import { claimsOf } from '../report-schema.js';
import { htmlToText } from '../source-text.js';
import { SOURCES, sampleReport } from './fixtures.js';

const sources = SOURCES.map((source) =>
  source.id === 'bridge' ? { ...source, text: htmlToText(source.text) } : source,
);

function reportWithBadClaim() {
  const report = sampleReport();
  report.sections[0]?.claims.push({
    id: 'bad',
    text: 'The bridge was closed for forty years.',
    citations: [{ sourceId: 'bridge', quote: 'The bridge was closed for forty years' }],
  });
  return report;
}

test('a dropped claim is absent from Markdown and HTML and listed as not verified', () => {
  const report = reportWithBadClaim();
  const result = checkCitations({ claims: claimsOf(report), sources });
  const rendered = renderReport(report, result, { dropFailed: true });
  assert.deepEqual(rendered.removed, ['bad']);
  for (const output of [rendered.markdown, rendered.html]) {
    const [body, rest] = output.split(/Not verified/);
    assert.doesNotMatch(body ?? '', /forty years/);
    assert.match(rest ?? '', /forty years/);
    assert.match(rest ?? '', /the quote is not in the source text/);
  }
  assert.match(rendered.markdown, /The Harbor Bridge opened to traffic in 1932\. \[1\]/);
  assert.match(rendered.markdown, /1\. Harbor Bridge: <https:\/\/example\.org\/bridge>/);
  assert.match(rendered.markdown, /2\. Harbor Tunnel/);
});

test('without dropping, a failed claim stays and is marked', () => {
  const report = reportWithBadClaim();
  const result = checkCitations({ claims: claimsOf(report), sources });
  const rendered = renderReport(report, result, { dropFailed: false });
  assert.deepEqual(rendered.removed, []);
  assert.match(
    rendered.markdown,
    /forty years\. \[1\] _\(not verified: the quote is not in the source text\)_/,
  );
  assert.match(rendered.html, /forty years\.[^<]*<span class="nv">\(not verified/);
  assert.doesNotMatch(rendered.markdown, /## Not verified/);
});

test('the report says how it was checked, including when nobody judged the quotes', () => {
  const report = sampleReport();
  const result = checkCitations({ claims: claimsOf(report), sources });
  const { markdown } = renderReport(report, result, { dropFailed: true });
  assert.match(markdown, /3 claims checked against the fetched source text/);
  assert.match(markdown, /3 with a quote found but no judgment on whether it supports the claim/);
});

test('a section whose claims are all dropped disappears', () => {
  const report = sampleReport();
  report.sections[1] = {
    heading: 'Empty after drop',
    claims: [{ id: 'z', text: 'Nothing.', citations: [] }],
  };
  const result = checkCitations({ claims: claimsOf(report), sources });
  const { markdown } = renderReport(report, result, { dropFailed: true });
  assert.doesNotMatch(markdown.split('## Not verified')[0] ?? '', /Empty after drop/);
});

test('report text is escaped in HTML and markup is neutralised in Markdown', () => {
  const report = sampleReport();
  report.title = '<img src=x onerror=alert(1)>';
  report.sections[0]!.claims[0]!.text =
    'The Harbor Bridge opened in 1932 <script>alert(1)</script> "x" & y.';
  report.sources[0]!.title = '<b>Harbor</b>';
  const result = checkCitations({ claims: claimsOf(report), sources });
  const { html, markdown } = renderReport(report, result, { dropFailed: false });
  assert.doesNotMatch(html, /<script>|<img|<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;x&quot; &amp; y\./);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(markdown, /<script>|<img|<b>/);
});

test('a source URL is rendered as a link only through the validated href', () => {
  const report = sampleReport();
  report.sources[0]!.url = 'https://example.org/a"b?x=<y>';
  const result = checkCitations({ claims: claimsOf(report), sources });
  const { html } = renderReport(report, result, { dropFailed: false });
  assert.match(
    html,
    /<a href="https:\/\/example\.org\/a%22b\?x=%3Cy%3E" rel="noopener noreferrer">/,
  );
});
