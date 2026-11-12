#!/usr/bin/env node
import { runRealLoopCli } from '../dist/real-loop.js';

const code = await runRealLoopCli();
process.exit(code);
