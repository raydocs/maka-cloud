import { readFile } from 'node:fs/promises';
import {
  AGENT_VENDORS,
  type AgentVendor,
  implementerFor,
  type ModesConfig,
  parseModeBrief,
} from '@maka-cloud/modes';
import type { Recovery, RunHandle, Runner, RunSpec } from '@maka-cloud/orchestrator';

/** The largest brief read to find its mode line; a bigger one is refused, not cut. */
const MAX_BRIEF_BYTES = 1_000_000;

function vendorOf(name: string): AgentVendor | undefined {
  return (AGENT_VENDORS as readonly string[]).includes(name) ? (name as AgentVendor) : undefined;
}

/**
 * A fleet runner (`claude-agent-sdk`, `codex`) that takes its model and effort from the mode the
 * brief names. The mode comes from the one `maka-mode:` line the conductor's code wrote, never
 * from other text in the brief, and the role is the implementer's: whichever vendor the task was
 * sent to works with that vendor's model and effort for the mode.
 *
 * Fails closed: a brief that cannot be read, or whose mode line is not a mode, refuses the run
 * instead of starting it with some other model. A brief without a mode line runs as before, with
 * the runner's own defaults, and so does a run that already names its model.
 */
export function withModes(runner: Runner, modes: ModesConfig): Runner {
  const vendor = vendorOf(runner.name);
  if (vendor === undefined) return runner;

  /** The spec with the implementer's model and effort for the mode its brief names. */
  const moded = async <S extends RunSpec>(spec: S): Promise<S> => {
    if (spec.model !== undefined || spec.effort !== undefined) return spec;
    let text: string;
    try {
      const bytes = await readFile(spec.briefPath);
      if (bytes.byteLength > MAX_BRIEF_BYTES) throw new Error('the brief is too large');
      text = bytes.toString('utf8');
    } catch (error) {
      const why = error instanceof Error ? error.message : 'unreadable';
      throw new Error(`the brief cannot be read to choose a mode (${why})`);
    }
    const parsed = parseModeBrief(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    if (parsed.mode === undefined) return spec;
    const agent = implementerFor(modes, parsed.mode, vendor);
    return {
      ...spec,
      ...(agent.model === undefined ? {} : { model: agent.model }),
      effort: agent.effort,
    };
  };

  // Every optional member of the inner runner is forwarded (`steerable` too), and only those it has: a runner
  // without `recover` must stay one the orchestrator ends as orphaned at restart, and one with it
  // must stay resumable, with the same model and effort it started with.
  const { recover, stopOrphaned } = runner;
  return {
    name: runner.name,
    // The orchestrator refuses messages to a runner that does not say it takes them, so the
    // wrapper says what the runner under it says, when it is asked.
    get steerable() {
      return runner.steerable;
    },
    start: async (spec: RunSpec): Promise<RunHandle> => runner.start(await moded(spec)),
    ...(stopOrphaned ? { stopOrphaned: stopOrphaned.bind(runner) } : {}),
    ...(recover
      ? {
          recover: async (spec: RunSpec & { recovery: Recovery }): Promise<RunHandle> =>
            recover.call(runner, await moded(spec)),
        }
      : {}),
  };
}
