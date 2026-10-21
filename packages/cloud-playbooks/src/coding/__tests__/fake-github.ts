import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Commit {
  sha: string;
  tree: { sha: string };
  parents: { sha: string }[];
  message: string;
}

export interface RecordedCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: any;
}

const sha1 = (text: string | Buffer) => createHash('sha1').update(text).digest('hex');

/** An in-memory GitHub REST API: the git data, refs, branches and pull request endpoints the publisher uses. */
export class FakeGitHub {
  readonly calls: RecordedCall[] = [];
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, { base: string; entries: unknown[] }>();
  readonly commits = new Map<string, Commit>();
  readonly refs = new Map<string, string>();
  readonly pulls: {
    number: number;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
    html_url: string;
  }[] = [];
  branches = new Set(['main']);
  defaultBranch = 'main';
  /** Answer every call with this status and message. */
  failWith: { status: number; message: string } | undefined;
  url = '';
  private server: Server | undefined;
  private counter = 0;

  constructor(
    readonly repo: string,
    readonly baseSha: string,
  ) {
    this.commits.set(baseSha, {
      sha: baseSha,
      tree: { sha: 'f'.repeat(40) },
      parents: [],
      message: 'base',
    });
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }

  posts(suffix: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === 'POST' && call.path.endsWith(suffix));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    this.calls.push({
      method: req.method ?? '',
      path: `${path}${url.search}`,
      authorization: req.headers.authorization,
      body,
    });
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (this.failWith) return send(this.failWith.status, { message: this.failWith.message });
    const prefix = `/repos/${this.repo}`;
    if (!path.startsWith(prefix)) return send(404, { message: 'Not Found' });
    const rest = path.slice(prefix.length);

    if (req.method === 'GET' && rest === '')
      return send(200, { default_branch: this.defaultBranch });
    let m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (req.method === 'GET' && m) {
      const commit = this.commits.get(m[1] as string);
      return commit ? send(200, commit) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && rest === '/git/blobs') {
      const content = Buffer.from(body.content, 'base64');
      const sha = sha1(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
      this.blobs.set(sha, content);
      return send(201, { sha });
    }
    if (req.method === 'POST' && rest === '/git/trees') {
      const sha = sha1(JSON.stringify(body));
      this.trees.set(sha, { base: body.base_tree, entries: body.tree });
      return send(201, { sha });
    }
    if (req.method === 'POST' && rest === '/git/commits') {
      const sha = sha1(`${JSON.stringify(body)}${++this.counter}`);
      this.commits.set(sha, {
        sha,
        tree: { sha: body.tree },
        parents: body.parents.map((parent: string) => ({ sha: parent })),
        message: body.message,
      });
      return send(201, {
        sha,
        tree: { sha: body.tree },
        parents: body.parents.map((p: string) => ({ sha: p })),
      });
    }
    m = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (req.method === 'GET' && m) {
      const sha = this.refs.get(m[1] as string);
      return sha ? send(200, { object: { sha } }) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && rest === '/git/refs') {
      const name = String(body.ref).replace(/^refs\/heads\//, '');
      if (this.refs.has(name)) return send(422, { message: 'Reference already exists' });
      this.refs.set(name, body.sha);
      return send(201, { ref: body.ref, object: { sha: body.sha } });
    }
    m = /^\/branches\/(.+)$/.exec(rest);
    if (req.method === 'GET' && m) {
      return this.branches.has(decodeURIComponent(m[1] as string))
        ? send(200, { name: m[1] })
        : send(404, { message: 'Branch not found' });
    }
    if (req.method === 'GET' && rest === '/pulls') {
      const head = url.searchParams.get('head') ?? '';
      const owner = this.repo.split('/')[0];
      return send(
        200,
        this.pulls.filter((pull) => `${owner}:${pull.head}` === head),
      );
    }
    if (req.method === 'POST' && rest === '/pulls') {
      if (!this.refs.has(body.head)) return send(422, { message: 'head does not exist' });
      const number = this.pulls.length + 1;
      const pull = {
        number,
        head: body.head,
        base: body.base,
        title: body.title,
        body: body.body,
        draft: body.draft === true,
        html_url: `https://github.com/${this.repo}/pull/${number}`,
      };
      this.pulls.push(pull);
      return send(201, pull);
    }
    return send(404, { message: 'Not Found' });
  }
}
