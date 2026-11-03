#!/usr/bin/env node
import { runDeviceDaemonCli } from '@maka-cloud/superagent';

const result = await runDeviceDaemonCli(process.argv.slice(2));
if (!result.ok) {
  console.error(result.reason ?? 'device daemon failed');
  process.exit(1);
}
