// Prints the JSON list of distributables (the CLI plus one package per tool) for CI matrices.
import { TARGETS } from '../lib/targets/index.js';

console.log(JSON.stringify(['cli', ...Object.keys(TARGETS)]));
