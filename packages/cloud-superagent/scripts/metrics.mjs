#!/usr/bin/env node
import { runMetricsCli } from '../dist/metrics.js';

const code = await runMetricsCli();
process.exit(code);
