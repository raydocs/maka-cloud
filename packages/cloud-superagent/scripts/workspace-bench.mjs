#!/usr/bin/env node
import { runWorkspaceBenchCli } from '../dist/workspace-bench.js';

const code = await runWorkspaceBenchCli();
process.exit(code);
