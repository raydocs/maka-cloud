#!/usr/bin/env node
import { runCiteCheck } from './run.js';

const outcome = await runCiteCheck(process.argv.slice(2));
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
