import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CitationInputError, checkCitations } from '../check.js';
import { type Claim, claimsOf } from '../report-schema.js';
import { htmlToText, normalizeText, numbersIn } from '../source-text.js';
import { SOURCES, sampleReport } from './fixtures.js';

const sources = SOURCES.map((source) =>
  source.id === 'bridge' ? { ...source, text: htmlToText(source.text) } : source,
);

function claim(text: string, sourceId: string, quote: string, id = 'x'): Claim {
  return { id, text, citations: [{ sourceId, quote }] };
}

const statusOf = (claims: Claim[], judgments?: Parameters<typeof checkCitations>[0]['judgments']) =>
  checkCitations({ claims, sources, ...(judgments ? { judgments } : {}) }).claims.map(
    (result) => result.status,
  );

describe('checkCitations', () => {
  test('a claim whose quote is on the page is quote_verified, and nobody has judged it', () => {
    const result = checkCitations({ claims: claimsOf(sampleReport()), sources });
    assert.deepEqual(
      result.claims.map((entry) => entry.status),
      ['quote_verified', 'quote_verified', 'quote_verified'],
    );
    assert.deepEqual(result.counts, {
      total: 3,
      verified: 0,
      quoteVerified: 3,
      failed: 0,
      judged: 0,
    });
  });

  test('a quote that is not on the page fails', () => {
    assert.deepEqual(
      statusOf([claim('It never closed.', 'bridge', 'The bridge was closed for forty years')]),
      ['quote_not_found'],
    );
  });

  test('text only inside a script or a comment is not on the page', () => {
    assert.deepEqual(statusOf([claim('c', 'bridge', 'The bridge was closed for forty years')]), [
      'quote_not_found',
    ]);
    assert.deepEqual(statusOf([claim('c', 'bridge', 'The bridge never closed')]), [
      'quote_not_found',
    ]);
  });

  test('a claim number the quote does not contain fails, even when the quote is real', () => {
    assert.deepEqual(
      statusOf([
        claim(
          'The bridge carries about 190,000 vehicles per day.',
          'bridge',
          'It carries about 160,000 vehicles per day',
        ),
      ]),
      ['number_mismatch'],
    );
    assert.deepEqual(
      statusOf([
        claim('Tolls ended in 2018.', 'tunnel', 'Tolls were removed in 2017 after a long'),
      ]),
      ['number_mismatch'],
    );
  });

  test('a claim the quote does not support passes the mechanical check, and fails on a reviewer judgment', () => {
    const unsupported = claim(
      'The bridge was built to reduce traffic.',
      'bridge',
      'far above the original design of 90,000',
    );
    assert.deepEqual(statusOf([unsupported]), ['quote_verified']);
    const judged = checkCitations({
      claims: [unsupported],
      sources,
      judgments: [{ claimId: 'x', entailed: false, reason: 'the quote says nothing about why' }],
    });
    assert.equal(judged.claims[0]?.status, 'unsupported');
    assert.deepEqual(judged.claims[0]?.reasons, ['the quote says nothing about why']);
    assert.equal(judged.counts.failed, 1);
    assert.equal(judged.counts.judged, 1);
  });

  test('a supportive judgment makes a claim verified', () => {
    const result = checkCitations({
      claims: claimsOf(sampleReport()),
      sources,
      judgments: [{ claimId: 'c1', entailed: true, reason: 'the quote gives the opening date' }],
    });
    assert.deepEqual(
      result.claims.map((entry) => entry.status),
      ['verified', 'quote_verified', 'quote_verified'],
    );
    assert.equal(result.counts.verified, 1);
    assert.equal(result.counts.judged, 1);
  });

  test('a judgment never upgrades a claim that failed the mechanical checks', () => {
    const result = checkCitations({
      claims: [claim('c', 'bridge', 'The bridge was closed for forty years')],
      sources,
      judgments: [{ claimId: 'x', entailed: true, reason: 'looks right' }],
    });
    assert.equal(result.claims[0]?.status, 'quote_not_found');
  });

  test('one rejecting judgment among several wins, and a judgment for an unknown claim is reported', () => {
    const result = checkCitations({
      claims: [claim('c', 'tunnel', 'The Harbor Tunnel opened in 1959 and is')],
      sources,
      judgments: [
        { claimId: 'x', entailed: true, reason: 'a' },
        { claimId: 'x', entailed: false, reason: 'b' },
        { claimId: 'nope', entailed: true, reason: 'c' },
      ],
    });
    assert.equal(result.claims[0]?.status, 'unsupported');
    assert.deepEqual(result.unknownJudgments, ['nope']);
  });

  test('missing source, no citation and a too-short quote fail', () => {
    const none: Claim = { id: 'n', text: 'Something.', citations: [] };
    assert.deepEqual(
      statusOf([
        claim('c', 'ghost', 'some words that are long enough here', 'a'),
        none,
        claim('c', 'tunnel', 'Harbor Tunnel', 'b'),
        claim('c', 'tunnel', 'in 2017', 'd'),
      ]),
      ['source_missing', 'no_citation', 'quote_too_short', 'quote_too_short'],
    );
  });

  test('every quote of a multi-source claim must be found', () => {
    const both: Claim = {
      id: 'm',
      text: 'The bridge opened in 1932 and the tunnel in 1959.',
      citations: [
        { sourceId: 'bridge', quote: 'opened to traffic on 4 March 1932' },
        { sourceId: 'tunnel', quote: 'The Harbor Tunnel opened in 1959' },
      ],
    };
    assert.deepEqual(statusOf([both]), ['quote_verified']);
    const fabricated: Claim = {
      ...both,
      citations: [
        ...both.citations.slice(0, 1),
        { sourceId: 'tunnel', quote: 'opened in 1961 to great fanfare' },
      ],
    };
    assert.deepEqual(statusOf([fabricated]), ['quote_not_found']);
  });

  test('a number may come from any of the claim quotes', () => {
    const both: Claim = {
      id: 'm',
      text: 'The bridge opened in 1932; the tunnel is 2,300 metres long.',
      citations: [
        { sourceId: 'bridge', quote: 'opened to traffic on 4 March 1932' },
        { sourceId: 'tunnel', quote: 'opened in 1959 and is 2,300 metres long' },
      ],
    };
    assert.deepEqual(statusOf([both]), ['quote_verified']);
  });

  test('case, whitespace, curly quotes, dashes and entities do not matter', () => {
    assert.deepEqual(
      statusOf([
        claim('The arch was long.', 'bridge', 'WAS  “the longest of its kind”\nat the time'),
        claim('d', 'bridge', 'about 160,000 vehicles per day — far above the original', 'd'),
        claim('e', 'bridge', 'opened to traffic on 4\u00a0March 1932 after eight', 'e'),
      ]),
      ['quote_verified', 'quote_verified', 'quote_verified'],
    );
  });

  test('duplicate claim ids and duplicate source ids are rejected', () => {
    const twice = [
      claim('a', 'tunnel', 'The Harbor Tunnel opened in 1959'),
      claim('b', 'tunnel', 'The Harbor Tunnel opened in 1959'),
    ];
    assert.throws(() => checkCitations({ claims: twice, sources }), CitationInputError);
    assert.throws(
      () => checkCitations({ claims: [], sources: [...sources, ...sources] }),
      CitationInputError,
    );
  });

  test('the check does not touch its inputs', () => {
    const claims = claimsOf(sampleReport());
    const before = JSON.stringify({ claims, sources });
    checkCitations({ claims, sources });
    assert.equal(JSON.stringify({ claims, sources }), before);
  });
});

describe('source-text', () => {
  test('htmlToText keeps visible text only', () => {
    const text = htmlToText(SOURCES[0]?.text ?? '');
    assert.match(text, /opened to traffic on 4 March 1932/);
    assert.doesNotMatch(text, /secret|color:red|never closed|<|>/);
    assert.match(text, /“the longest of its kind”/);
  });

  test('htmlToText does not read header as head', () => {
    assert.match(htmlToText('<header>Top</header><p>Body</p>'), /Top[\s\S]*Body/);
  });

  test('normalizeText folds the usual differences', () => {
    assert.equal(normalizeText(' A’s “B” – C\n\n D '), 'a\'s "b" - c d');
  });

  test('numbersIn drops separators and bracketed markers', () => {
    assert.deepEqual(numbersIn('In 2020, 1,200 people paid 3.5 each [4]; v2.1 is out'), [
      '2020',
      '1200',
      '3.5',
    ]);
  });
});
