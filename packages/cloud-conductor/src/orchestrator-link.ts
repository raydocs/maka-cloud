import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** What the cloud server gives the conductor for one conversation (T4's `ConductorAccess`). */
export interface ConductorAccess {
  /** The orchestrator MCP endpoint. */
  mcpUrl: string;
  /** Issues a new bearer token for the conversation's orchestrator session; the previous one stops working. */
  rotateToken(): string;
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
}

/** Longer than the orchestrator's 10-minute wait cap, so a blocking wait is never cut short here. */
const CALL_TIMEOUT_MS = 11 * 60 * 1000;

/**
 * The conductor's client of the T2 orchestrator MCP server, for one run.
 * Tokens live only in memory: `tokens` holds one per conversation for this
 * process, rotated the first time a conversation needs one.
 */
export class OrchestratorLink {
  private client: Promise<Client> | undefined;
  private closed = false;

  constructor(
    private readonly conversationId: string,
    private readonly access: ConductorAccess,
    private readonly tokens: Map<string, string>,
    private readonly counters: { openClients: number },
  ) {}

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallResult> {
    const client = await this.connect();
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    return {
      isError: result.isError === true,
      text: content.map((block) => block.text ?? '').join('\n'),
      ...(result.structuredContent
        ? { structured: result.structuredContent as Record<string, unknown> }
        : {}),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.client;
    this.client = undefined;
    if (!pending) return;
    const client = await pending.catch(() => undefined);
    if (!client) return;
    try {
      await client.close();
    } finally {
      this.counters.openClients -= 1;
    }
  }

  private connect(): Promise<Client> {
    if (this.closed) return Promise.reject(new Error('The run has ended'));
    this.client ??= this.open().catch((error: unknown) => {
      this.client = undefined;
      throw error;
    });
    return this.client;
  }

  private async open(): Promise<Client> {
    let token = this.tokens.get(this.conversationId);
    let rotated = false;
    if (token === undefined) {
      token = this.access.rotateToken();
      this.tokens.set(this.conversationId, token);
      rotated = true;
    }
    try {
      return await this.openWith(token);
    } catch (error) {
      // A token from before a rotation elsewhere is refused; one fresh token is the only retry.
      if (rotated) throw error;
      token = this.access.rotateToken();
      this.tokens.set(this.conversationId, token);
      return this.openWith(token);
    }
  }

  private async openWith(token: string): Promise<Client> {
    const client = new Client(
      { name: 'maka-cloud-conductor', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(this.access.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    this.counters.openClients += 1;
    if (this.closed) {
      // The run ended while connecting: do not leave the connection behind.
      this.counters.openClients -= 1;
      await client.close().catch(() => undefined);
      throw new Error('The run has ended');
    }
    return client;
  }
}
