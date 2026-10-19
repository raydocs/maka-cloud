import type { Report } from '../report-schema.js';

/** A fetched page, as HTML. */
export const PAGE_BRIDGE_HTML = `<!doctype html>
<html><head><title>Harbor Bridge</title><style>.x{color:red}</style>
<script>var secret = "The bridge was closed for forty years";</script></head>
<body><nav>Home &middot; About</nav>
<article><h1>Harbor Bridge</h1>
<p>The Harbor Bridge opened to traffic on 4&nbsp;March 1932 after eight years of construction.</p>
<p>It carries about 160,000 vehicles per day &mdash; far above the original design of 90,000.</p>
<p>The steel arch spans 503 metres, which was &ldquo;the longest of its kind&rdquo; at the time.</p>
</article><!-- The bridge never closed --></body></html>`;

/** A fetched page, already text. */
export const PAGE_TUNNEL_TXT = `Harbor Tunnel
The Harbor Tunnel opened in 1959 and is 2,300 metres long.
Tolls were removed in 2017 after a long public campaign.
`;

export const SOURCES = [
  { id: 'bridge', text: PAGE_BRIDGE_HTML },
  { id: 'tunnel', text: PAGE_TUNNEL_TXT },
];

export function sampleReport(): Report {
  return {
    title: 'Harbor crossings',
    sections: [
      {
        heading: 'The bridge',
        claims: [
          {
            id: 'c1',
            text: 'The Harbor Bridge opened to traffic in 1932.',
            citations: [
              { sourceId: 'bridge', quote: 'opened to traffic on 4 March 1932 after eight years' },
            ],
          },
          {
            id: 'c2',
            text: 'The bridge carries about 160,000 vehicles per day.',
            citations: [{ sourceId: 'bridge', quote: 'It carries about 160,000 vehicles per day' }],
          },
        ],
      },
      {
        heading: 'The tunnel',
        claims: [
          {
            id: 'c3',
            text: 'The Harbor Tunnel is 2,300 metres long.',
            citations: [{ sourceId: 'tunnel', quote: 'opened in 1959 and is 2,300 metres long' }],
          },
        ],
      },
    ],
    sources: [
      { id: 'bridge', url: 'https://example.org/bridge', title: 'Harbor Bridge' },
      { id: 'tunnel', url: 'https://example.org/tunnel', title: 'Harbor Tunnel' },
    ],
  };
}
