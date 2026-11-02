#!/usr/bin/env node
import { runStatusCli } from '../dist/status.js';

const code = await runStatusCli();
process.exit(code);
