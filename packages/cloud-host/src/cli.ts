#!/usr/bin/env node
import { ConfigError, describeConfig, ENV_VARIABLES, readStackConfig } from './config.js';
import { startStack } from './stack.js';

const USAGE = `Usage:
  maka-cloud check   read the configuration from the environment and print it, without secrets
  maka-cloud start   start the stack and serve until SIGINT or SIGTERM

Starting runs nothing by itself: tasks start only when a user posts a message.
Invites are made with: cloud-server invite create --invites <data dir>/invites.db --label <text>

Environment:
${ENV_VARIABLES.map(([name, what]) => `  ${name.padEnd(30)}${what}`).join('\n')}`;

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...rest] = argv;
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

  const stack = await startStack(config, env, {
    onWarning: (message, detail) => console.warn(`warning: ${message}`, detail ?? ''),
  });
  console.log(`listening:           ${stack.cloud.server.url}`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  console.log('shutting down');
  await stack.close();
  return 0;
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
