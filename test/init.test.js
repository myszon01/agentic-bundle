import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle, validateBundle } from '../lib/bundle.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = '@myszon01/agentic-bundle';

function templateCopy() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-bundle-init-'));
  for (const f of ['package.json', 'README.md', 'SETUP-SERVICE.md', 'LICENSE', 'harness', 'scripts', '.github', 'lib', 'bin', 'test']) {
    cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
  return dir;
}

const run = (dir, ...args) => execFileSync(process.execPath, ['scripts/init.js', ...args], { cwd: dir, encoding: 'utf8' });
// This checkout's CLI, standing in for the one a harness-only repository installs from npm.
const cli = (dir, ...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/agentic-bundle.js'), ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
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

  // Without --harness-only the copy keeps the tool and its release pipeline.
  for (const f of ['lib/cli.js', 'bin/agentic-bundle.js', 'test/init.test.js', 'scripts/pack.sh', '.github/workflows/release.yml']) {
    assert.ok(existsSync(path.join(dir, f)), `${f} is kept`);
  }
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('init removes the template\'s setup-service page and README section', () => {
  const dir = templateCopy();
  assert.ok(readFileSync(path.join(dir, 'README.md'), 'utf8').includes('<!-- setup-service -->'), 'the template README has the section');
  run(dir, '--repo', 'acme/tools');
  assert.ok(!existsSync(path.join(dir, 'SETUP-SERVICE.md')));
  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.ok(!readme.includes('setup-service') && !readme.includes('SETUP-SERVICE'));
  assert.match(readme, /## Development[\s\S]*## License/);
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

test('init --harness-only removes the copy of the tool and installs it from npm', () => {
  const dir = templateCopy();
  const { version } = json(ROOT, 'package.json');
  run(dir, '--repo', 'acme/team-harness', '--harness-only');

  const removed = ['lib', 'bin', 'test', 'scripts/pack.sh', 'scripts/approve.js', 'scripts/packages.js', 'scripts/sync-version.js', '.github/workflows/release.yml'];
  for (const f of removed) assert.ok(!existsSync(path.join(dir, f)), `${f} is removed`);
  assert.ok(existsSync(path.join(dir, 'scripts/init.js')), 'init stays, so it can be re-run');

  const pkg = json(dir, 'package.json');
  assert.equal(pkg.name, '@acme/team-harness');
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.devDependencies, { [TOOL]: `^${version}` });
  assert.equal(pkg.scripts.validate, 'agentic-bundle validate');
  assert.equal(pkg.scripts.test, undefined, 'no tests remain');
  for (const key of ['bin', 'files', 'publishConfig']) assert.equal(pkg[key], undefined, key);
  for (const cmd of Object.values(pkg.scripts)) assert.doesNotMatch(cmd, /bin\/|pack\.sh|approve|packages\.js|sync-version/);

  const ci = readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8');
  assert.deepEqual(ci.split('\njobs:\n')[1].match(/^  \S+:$/gm), ['  test:', '  ci-ok:']);
  assert.match(ci, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(ci, /macos|matrix\.os|bin\/agentic-bundle|scripts\//);
  assert.match(ci, /node: \[24, 26\]\n/);
  assert.ok(ci.includes('node-version: ${{ matrix.node }}'), 'GitHub expressions are written as-is');
  for (const step of ['npm ci', 'npx agentic-bundle validate', 'npx agentic-bundle build all', 'npx agentic-bundle install all', 'npx agentic-bundle uninstall all']) {
    assert.ok(ci.includes(step), step);
  }
  assert.match(ci, /\n  ci-ok:\n    name: ci-ok\n    if: always\(\)\n    needs: \[test\]\n/);

  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /^# team-harness\n/);
  assert.ok(readme.includes(`npm install -D ${TOOL}@latest`));
  assert.doesNotMatch(readme, /bin\/agentic-bundle|setup-service|Releasing/);

  // What the new CI runs, against the converted repository.
  assert.match(cli(dir, 'validate'), /team-harness@0\.1\.0 is valid/);
  const target = mkdtempSync(path.join(os.tmpdir(), 'agentic-bundle-target-'));
  cli(dir, 'install', 'all', '--dir', target);
  cli(dir, 'uninstall', 'all', '--dir', target);
  assert.deepEqual(readdirSync(target), []);
});

test('init --harness-only keeps your own tests and edits, and can be re-run', () => {
  const dir = templateCopy();
  const { version } = json(ROOT, 'package.json');
  writeFileSync(path.join(dir, 'test/harness.test.js'), "import { test } from 'node:test';\ntest('harness', () => {});\n");
  run(dir, '--repo', 'myszon01/team-harness', '--harness-only');
  assert.deepEqual(readdirSync(path.join(dir, 'test')), ['harness.test.js']);
  assert.equal(json(dir, 'package.json').scripts.test, 'node --test', 'tests of your own remain');

  // Changes made after converting survive re-runs, with or without the flag.
  appendFileSync(path.join(dir, '.github/workflows/ci.yml'), '# my step\n');
  appendFileSync(path.join(dir, 'README.md'), '\nMy notes.\n');
  mkdirSync(path.join(dir, 'lib'));
  writeFileSync(path.join(dir, 'lib/own.js'), '');
  run(dir, '--repo', 'myszon01/team-harness', '--scope', '@team', '--harness-only');
  const out = run(dir, '--repo', 'acme/renamed', '--scope', '@team');

  assert.match(out, /Initialised renamed \(harness-only\)/);
  assert.ok(readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8').endsWith('# my step\n'));
  assert.ok(existsSync(path.join(dir, 'lib/own.js')));
  assert.ok(existsSync(path.join(dir, 'test/harness.test.js')));
  const pkg = json(dir, 'package.json');
  assert.equal(pkg.name, '@team/renamed');
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.devDependencies, { [TOOL]: `^${version}` });
  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.ok(readme.includes('My notes.'));
  assert.ok(readme.includes(`npm install -D ${TOOL}@latest`), 'renaming the scope leaves the tool\'s name alone');
});
