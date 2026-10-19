#!/usr/bin/env node
import { runWebSearch } from './run.js';

const outcome = await runWebSearch(process.argv.slice(2));
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
