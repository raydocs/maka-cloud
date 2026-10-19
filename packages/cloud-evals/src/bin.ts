#!/usr/bin/env node
import { runCloudEvalsCli } from './cli.js';

process.exitCode = await runCloudEvalsCli(process.argv.slice(2));
