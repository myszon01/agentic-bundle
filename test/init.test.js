import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle, validateBundle } from '../lib/bundle.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function templateCopy() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-bundle-init-'));
  for (const f of ['package.json', 'README.md', 'LICENSE', 'harness', 'scripts', '.github']) {
    cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
  return dir;
}

const run = (dir, ...args) => execFileSync(process.execPath, ['scripts/init.js', ...args], { cwd: dir, encoding: 'utf8' });
const json = (dir, f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));

test('init renames the CLI, bundle, owner and README references', () => {
  const dir = templateCopy();
  const before = json(ROOT, 'package.json').name;
  run(dir, '--repo', 'Acme/My-Plugin', '--description', 'Acme tools');

  const pkg = json(dir, 'package.json');
  assert.equal(pkg.name, '@acme/my-plugin');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.repository.url, 'git+https://github.com/Acme/My-Plugin.git');

  const bundle = json(dir, 'harness/bundle.json');
  assert.equal(bundle.name, 'my-plugin');
  assert.equal(bundle.description, 'Acme tools');
  assert.deepEqual(bundle.npm, { scope: '@acme' });

  assert.equal(readFileSync(path.join(dir, '.github/CODEOWNERS'), 'utf8').trim().split('\n').pop(), '* @Acme');
  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.ok(readme.includes('npx -y @acme/my-plugin install'));
  assert.ok(!readme.includes(before), 'old CLI name is gone from the README');
  assert.match(readFileSync(path.join(dir, 'LICENSE'), 'utf8'), /Copyright \(c\) \d{4} Acme/);
});

test('init --clean leaves an empty but valid harness, and can be re-run', async () => {
  const dir = templateCopy();
  run(dir, '--repo', 'acme/first', '--clean');
  run(dir, '--repo', 'acme/second', '--scope', '@acme-tools');

  const bundle = await loadBundle(path.join(dir, 'harness'));
  assert.deepEqual(validateBundle(bundle).errors, []);
  assert.equal(bundle.name, 'second');
  assert.equal(bundle.skills.length + bundle.commands.length + bundle.agents.length + bundle.mcp.length, 0);
  assert.deepEqual(readdirSync(path.join(dir, 'harness/skills')), ['.gitkeep']);
  assert.equal(json(dir, 'package.json').name, '@acme-tools/second');
  assert.ok(readFileSync(path.join(dir, 'README.md'), 'utf8').includes('@acme-tools/second'));
  assert.ok(existsSync(path.join(dir, 'harness/AGENTS.md')));
});

test('init rejects names that are not kebab-case', () => {
  assert.throws(() => run(templateCopy(), '--repo', 'acme/x', '--name', 'Not_Kebab'), /kebab-case/);
});
