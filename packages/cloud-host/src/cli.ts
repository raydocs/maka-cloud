#!/usr/bin/env node
import {
  ConfigError,
  describeConfig,
  ENV_VARIABLES,
  pausePathOf,
  readStackConfig,
} from './config.js';
import { createLogger, createScrubber } from './log.js';
import { PauseSwitch } from './pause.js';
import { startStack } from './stack.js';

const USAGE = `Usage:
  maka-cloud check   read the configuration from the environment and print it, without secrets
  maka-cloud start   start the stack and serve until SIGINT or SIGTERM
  maka-cloud pause   stop all spending: new model requests are refused and running work is
                     stopped within seconds (needs MAKA_CLOUD_DATA_DIR; works while the server runs)
  maka-cloud resume  allow spending again; work that was stopped is not restarted

Starting runs nothing by itself: tasks start only when a user posts a message.
Invites are made with: cloud-server invite create --invites <data dir>/invites.db --label <text>

Environment:
${ENV_VARIABLES.map(([name, what]) => `  ${name.padEnd(30)}${what}`).join('\n')}`;

function pauseCommand(command: 'pause' | 'resume', env: NodeJS.ProcessEnv): number {
  const dataDir = env.MAKA_CLOUD_DATA_DIR?.trim();
  if (!dataDir) {
    console.error('MAKA_CLOUD_DATA_DIR is not set');
    return 2;
  }
  const spending = new PauseSwitch(pausePathOf(dataDir));
  if (command === 'pause') {
    console.log(
      spending.pause()
        ? 'paused: new model requests are refused and running work is stopped within seconds'
        : `already paused${spending.pausedAt() ? ` since ${spending.pausedAt()}` : ''}`,
    );
  } else {
    console.log(spending.resume() ? 'resumed: spending is allowed again' : 'was not paused');
  }
  return 0;
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...rest] = argv;
  if ((command === 'pause' || command === 'resume') && rest.length === 0) {
    return pauseCommand(command, env);
  }
  if ((command !== 'check' && command !== 'start') || rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  let config: ReturnType<typeof readStackConfig>;
  try {
    config = readStackConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    return 2;
  }
  for (const line of describeConfig(config)) console.log(line);
  if (command === 'check') return 0;

  const log = createLogger({ write: (line) => process.stdout.write(`${line}\n`), env });
  const stack = await startStack(config, env, { onWarning: log.warning });
  log.info('server.listening', { url: stack.cloud.server.url });
  if (stack.pause.isPaused()) {
    log.warn('spending.paused', { hint: 'run "maka-cloud resume" to allow it again' });
  }
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  log.info('server.closing');
  await stack.close();
  return 0;
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const scrub = createScrubber(process.env);
    console.error(
      scrub(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
    );
    process.exitCode = 1;
  },
);
