// Approve this release's staged npm packages (the CLI and one per tool), after the
// Release workflow has staged them. npm prompts for your 2FA code.
//
//   npm run approve                  approve the version in package.json
//   npm run approve -- 0.2.0         approve a specific version
//   npm run approve -- --dry-run     only list what would be approved
//
// Needs npm with staged publishing (npm 12: `npm install -g npm@12`) and `npm login`.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadBundle } from '../lib/bundle.js';
import { npmName } from '../lib/npm.js';
import { TARGETS } from '../lib/targets/index.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = args.find((a) => !a.startsWith('--')) ?? pkg.version;
const bundle = await loadBundle('harness');
const names = [pkg.name, ...Object.values(TARGETS).map((t) => npmName(bundle, t))];

const npm = (...a) => execFileSync('npm', a, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
try {
  npm('stage', '--help');
} catch {
  console.error('This npm has no `npm stage` command; run `npm install -g npm@12` first.');
  process.exit(1);
}

let pending = 0;
let failed = 0;
for (const name of names) {
  let items;
  try {
    items = JSON.parse(npm('stage', 'list', name, '--json'));
  } catch (err) {
    // With --json, npm reports errors as JSON on stdout.
    let reason = String(err.stderr || err.message).trim().split('\n').pop();
    try {
      reason = JSON.parse(err.stdout).error.summary;
    } catch {}
    if (/E401|Unauthorized/.test(reason)) reason += ' — run `npm login` first';
    console.error(`✗ ${name}: could not list staged versions: ${reason}`);
    failed++;
    continue;
  }
  const item = items.find((i) => i.version === version && !['rejected', 'approved', 'published'].includes(i.status));
  if (!item) {
    console.log(`- ${name}@${version}: nothing staged`);
    continue;
  }
  pending++;
  if (dryRun) {
    console.log(`• ${name}@${version}: staged as ${item.id} (${item.status ?? 'pending'})`);
    continue;
  }
  console.log(`→ approving ${name}@${version} (${item.id})`);
  const res = spawnSync('npm', ['stage', 'approve', item.id], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

console.log(dryRun ? `\n${pending} staged package(s) to approve.` : `\nDone: ${pending - failed} approved, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
