#!/usr/bin/env node
import { main } from '../lib/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`agentic-bundle: ${err.message}`);
  process.exitCode = 1;
});
