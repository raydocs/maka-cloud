import type { ModelAccess, ModelAccessProvider } from '../index.js';

/**
 * Keys from the environment: `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` for the Claude runner and
 * `OPENAI_API_KEY` / `OPENAI_BASE_URL` for Codex. The shared vendor key goes into the sandbox, so
 * it lives here, beside the gated live smoke test, and the package does not export it.
 */
export function envModelAccess(env: NodeJS.ProcessEnv = process.env): ModelAccessProvider {
  return {
    async issue({ runner }): Promise<ModelAccess> {
      const codex = runner === 'codex';
      const apiKey = codex ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error(`${codex ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set.`);
      const baseUrl = codex ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL;
      return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
    },
  };
}
