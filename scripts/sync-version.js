// `npm version <x>` lifecycle hook: keep harness/bundle.json on the same version as package.json,
// so one tag releases the CLI and every per-tool package together.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const file = 'harness/bundle.json';
const bundle = JSON.parse(readFileSync(file, 'utf8'));
bundle.version = version;
writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`${file} → ${version}`);
