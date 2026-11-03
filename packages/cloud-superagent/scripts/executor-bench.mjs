#!/usr/bin/env node
import { runExecutorBenchCli } from '../dist/executor-bench.js';

const code = await runExecutorBenchCli();
process.exit(code);
