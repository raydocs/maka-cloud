#!/usr/bin/env node
import { BackupError, backupAll, listBackups, restoreBackup } from './backup.js';
import {
  backupDirProblem,
  backupLayoutOf,
  ConfigError,
  describeConfig,
  ENV_VARIABLES,
  pausePathOf,
  readModes,
  readStackConfig,
} from './config.js';
import { DEFAULT_MODES } from '@maka-cloud/modes';
import { createLogger, createScrubber } from './log.js';
import { PauseSwitch } from './pause.js';
import { runSetup, SETUP_VARIABLES } from './setup.js';
import { terminalIO } from './setup-terminal.js';
import { smokeCommand } from './smoke-live.js';
import { SMOKE_VARIABLES } from './smoke.js';
import { startStack } from './stack.js';

const USAGE = `Usage:
  maka-cloud setup [--from-env] [--no-verify] [--settings <path>] [--names <path>]
                     the first-run wizard: asks for the domain, the keys and your sandbox machine,
                     fills the rest with safe defaults, makes your invite and writes the settings
                     (default /etc/maka-cloud.env and /etc/maka-cloud.compose.env, mode 600); run
                     again to change them. Needs MAKA_CLOUD_DATA_DIR
  maka-cloud check   read the configuration from the environment and print it, without secrets
  maka-cloud modes   print the modes (quick, standard, deep) in force as JSON, to copy into MAKA_CLOUD_MODES
  maka-cloud start   start the stack and serve until SIGINT or SIGTERM
  maka-cloud pause   stop all spending: new model requests are refused and running work is
                     stopped within seconds (needs MAKA_CLOUD_DATA_DIR; works while the server runs)
  maka-cloud resume  allow spending again; work that was stopped is not restarted
  maka-cloud backups list the backups in MAKA_CLOUD_BACKUP_DIR, newest first
  maka-cloud backup  write a backup with the server stopped (a running server writes its own daily)
  maka-cloud restore <name>
                     put a backup back; the server must be stopped. What was there is moved to
                     <data dir>/pre-restore-*, nothing is deleted
  maka-cloud smoke   run the live smoke test against a running server; spends real money, so it
                     refuses unless MAKA_CLOUD_LIVE=1 and the MAKA_CLOUD_SMOKE_* settings are set
                     (see docs/fork/deploy.md)

Starting runs nothing by itself: tasks start only when a user posts a message.
Invites are made with: cloud-server invite create --invites <data dir>/invites.db --label <text>

Environment:
${ENV_VARIABLES.map(([name, what]) => `  ${name.padEnd(30)}${what}`).join('\n')}

Only for maka-cloud setup --from-env:
${SETUP_VARIABLES.map(([name, what]) => `  ${name.padEnd(30)}${what}`).join('\n')}

Only for maka-cloud smoke:
${SMOKE_VARIABLES.map(([name, what]) => `  ${name.padEnd(30)}${what}`).join('\n')}`;

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

/** The data and backup directories the backup commands work on, or the reason they cannot. */
function backupDirs(env: NodeJS.ProcessEnv): { dataDir: string; backupDir: string } | string {
  const dataDir = env.MAKA_CLOUD_DATA_DIR?.trim();
  const backupDir = env.MAKA_CLOUD_BACKUP_DIR?.trim();
  if (!dataDir) return 'MAKA_CLOUD_DATA_DIR is not set';
  if (!backupDir) return 'MAKA_CLOUD_BACKUP_DIR is not set';
  return backupDirProblem(dataDir, backupDir) ?? { dataDir, backupDir };
}

async function backupCommand(
  command: 'backups' | 'backup' | 'restore',
  rest: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const dirs = backupDirs(env);
  if (typeof dirs === 'string') {
    console.error(dirs);
    return 2;
  }
  const layout = backupLayoutOf(dirs.dataDir);
  try {
    if (command === 'backups') {
      const found = await listBackups(dirs.backupDir);
      for (const entry of found)
        console.log(`${entry.stamp}  ${new Date(entry.createdAt).toISOString()}`);
      if (found.length === 0) console.log('no backups');
    } else if (command === 'backup') {
      const done = await backupAll({ ...dirs, layout, env });
      console.log(`wrote ${done.stamp}: ${done.files} files, ${done.bytes} bytes`);
    } else {
      const done = await restoreBackup({ ...dirs, stamp: rest[0] ?? '', layout });
      console.log(`restored ${done.stamp}: ${done.files} files`);
      console.log(`what was there before is in ${done.previous}`);
      console.log('devices must turn notifications on again: a backup keeps no push subscriptions');
    }
    return 0;
  } catch (error) {
    if (!(error instanceof BackupError)) throw error;
    console.error(error.message);
    return 1;
  }
}

function modesCommand(env: NodeJS.ProcessEnv): number {
  const problems: string[] = [];
  // Prices are not needed to print the modes: only the JSON is checked.
  const parsed = readModes(env.MAKA_CLOUD_MODES?.trim() || undefined, [], problems);
  const unpriced = problems.filter((problem) => !problem.includes('has no price'));
  if (unpriced.length > 0) {
    console.error(unpriced.join('\n'));
    return 2;
  }
  console.log(JSON.stringify(parsed ?? DEFAULT_MODES, null, 2));
  return 0;
}

const SETUP_FLAGS = new Set(['--from-env', '--no-verify']);
const SETUP_PATHS = new Set(['--settings', '--names']);

async function setupCommand(rest: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const flags = new Set<string>();
  const paths = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (SETUP_FLAGS.has(arg)) flags.add(arg);
    else if (SETUP_PATHS.has(arg) && rest[index + 1] !== undefined) {
      paths.set(arg, rest[index + 1] as string);
      index += 1;
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  const dataDir = env.MAKA_CLOUD_DATA_DIR?.trim();
  if (!dataDir) {
    console.error('MAKA_CLOUD_DATA_DIR is not set');
    return 2;
  }
  const fromEnv = flags.has('--from-env');
  const io = terminalIO();
  try {
    return await runSetup({
      envFile: paths.get('--settings') ?? '/etc/maka-cloud.env',
      composeEnvFile: paths.get('--names') ?? '/etc/maka-cloud.compose.env',
      dataDir,
      env,
      fromEnv,
      verify: !flags.has('--no-verify'),
      io,
    });
  } finally {
    io.close();
  }
}

/** How long the process may take to exit after the stack has closed. */
const FORCED_EXIT_MS = 10_000;

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'setup') return setupCommand(rest, env);
  if (command === 'modes' && rest.length === 0) return modesCommand(env);
  if ((command === 'pause' || command === 'resume') && rest.length === 0) {
    return pauseCommand(command, env);
  }
  if ((command === 'backups' || command === 'backup') && rest.length === 0) {
    return backupCommand(command, rest, env);
  }
  if (command === 'restore' && rest.length === 1) return backupCommand(command, rest, env);
  if (command === 'smoke' && rest.length === 0) return smokeCommand(env);
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
  const stack = await startStack(config, env, {
    onWarning: log.warning,
    onInfo: (event, fields) => log.info(event, fields),
  });
  log.info('server.listening', { url: stack.cloud.server.url });
  if (stack.pause.isPaused()) {
    log.warn('spending.paused', { hint: 'run "maka-cloud resume" to allow it again' });
  }
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  log.info('server.closing');
  // Whatever is still alive after the stack has closed (a run's poll, a socket) must not hold the
  // process past the container's grace period: the next process recovers what was in flight.
  setTimeout(() => {
    log.warn('server.exit_forced', { afterMs: FORCED_EXIT_MS });
    process.exit(1);
  }, FORCED_EXIT_MS).unref();
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
