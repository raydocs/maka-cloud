#!/usr/bin/env node
import { runDaemonBenchCli } from '../dist/daemon-bench.js';

const code = await runDaemonBenchCli();
process.exit(code);
