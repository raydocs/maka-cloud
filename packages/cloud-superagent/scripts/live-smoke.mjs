#!/usr/bin/env node
import { runLiveSmokeCli } from '../dist/live-smoke.js';

const code = await runLiveSmokeCli();
process.exit(code);
