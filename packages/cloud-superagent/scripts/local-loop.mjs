#!/usr/bin/env node
import { runLocalLoopCli } from '../dist/local-loop.js';

const code = await runLocalLoopCli(process.argv.slice(2));
process.exit(code);
