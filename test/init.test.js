import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  for (const f of ['package.json', 'README.md', 'SETUP-SERVICE.md', 'CLAUDE.md', 'LICENSE', '.gitignore', '.nvmrc', 'harness', 'scripts', '.github', 'lib', 'bin', 'docs', 'test']) {
    // A repository made from the template has already run init, which removes some of these.
    if (existsSync(path.join(ROOT, f))) cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
  return dir;
}

const run = (dir, ...args) => execFileSync(process.execPath, ['scripts/init.js', ...args], { cwd: dir, encoding: 'utf8' });
// Exit status, stdout and stderr, for runs that warn or fail.
const runAll = (dir, ...args) => spawnSync(process.execPath, ['scripts/init.js', ...args], { cwd: dir, encoding: 'utf8' });
// This checkout's CLI, standing in for the one a harness-only repository installs from npm.
const cli = (dir, ...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/agentic-bundle.js'), ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
const json = (dir, f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
// init only makes sense on the template itself; in a repository made from it, init has already run.
const initTest = (name, fn) => test(name, { skip: json(ROOT, 'package.json').name !== TOOL && 'template only: init already ran here' }, fn);
const writeJson = (dir, f, v) => writeFileSync(path.join(dir, f), `${JSON.stringify(v, null, 2)}\n`);
// The tool, run by its scoped name: the unscoped "agentic-bundle" on npm is not this tool.
const NPX = `npx ${TOOL}`;
const UNSCOPED_NPX = /npx (-y )?agentic-bundle/;
// Everything a harness-only repository keeps at its root: nothing else of the tool's survives.
const HARNESS_REPO_FILES = ['.github', '.gitignore', '.nvmrc', 'LICENSE', 'README.md', 'harness', 'package.json', 'scripts'];

initTest('init renames the CLI, bundle, owner and README references', () => {
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
  for (const f of ['lib/cli.js', 'bin/agentic-bundle.js', 'test/init.test.js', 'scripts/pack.sh', '.github/workflows/release.yml', 'CLAUDE.md', 'docs/distribution.md']) {
    assert.ok(existsSync(path.join(dir, f)), `${f} is kept`);
  }
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

initTest('init removes the template\'s setup-service page and README section', () => {
  const dir = templateCopy();
  assert.ok(readFileSync(path.join(dir, 'README.md'), 'utf8').includes('<!-- setup-service -->'), 'the template README has the section');
  run(dir, '--repo', 'acme/tools');
  assert.ok(!existsSync(path.join(dir, 'SETUP-SERVICE.md')));
  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.ok(!readme.includes('setup-service') && !readme.includes('SETUP-SERVICE'));
  assert.match(readme, /## Development[\s\S]*## License/);
});

initTest('init --clean leaves an empty but valid harness, and can be re-run', async () => {
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

initTest('init rejects names that are not kebab-case', () => {
  assert.throws(() => run(templateCopy(), '--repo', 'acme/x', '--name', 'Not_Kebab'), /kebab-case/);
});

initTest('init --harness-only removes the copy of the tool and installs it from npm', () => {
  const dir = templateCopy();
  const { version } = json(ROOT, 'package.json');
  const { stdout, stderr } = runAll(dir, '--repo', 'acme/team-harness', '--harness-only');
  assert.ok(stdout.includes(`${NPX} validate`));
  assert.doesNotMatch(stdout, UNSCOPED_NPX);
  assert.equal(stderr, '', 'the README is replaced, so there is nothing to warn about');

  const removed = ['lib', 'bin', 'test', 'docs', 'CLAUDE.md', 'scripts/pack.sh', 'scripts/approve.js', 'scripts/packages.js', 'scripts/sync-version.js', '.github/workflows/release.yml'];
  for (const f of removed) assert.ok(!existsSync(path.join(dir, f)), `${f} is removed`);
  assert.ok(existsSync(path.join(dir, 'scripts/init.js')), 'init stays, so it can be re-run');
  assert.deepEqual(readdirSync(dir).sort(), HARNESS_REPO_FILES);
  assert.deepEqual(readdirSync(path.join(dir, 'scripts')), ['init.js']);

  const pkg = json(dir, 'package.json');
  assert.equal(pkg.name, '@acme/team-harness');
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.devDependencies, { [TOOL]: `^${version}` });
  assert.equal(pkg.scripts.validate, 'agentic-bundle validate');
  assert.equal(pkg.scripts.test, undefined, 'no tests remain');
  for (const key of ['bin', 'files', 'publishConfig']) assert.equal(pkg[key], undefined, key);
  assert.equal(pkg.scripts['build:npm'], undefined, 'a harness-only repository publishes nothing');
  for (const cmd of Object.values(pkg.scripts)) assert.doesNotMatch(cmd, /bin\/|pack\.sh|approve|packages\.js|sync-version|--npm/);

  const ci = readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8');
  assert.deepEqual(ci.split('\njobs:\n')[1].match(/^  \S+:$/gm), ['  test:', '  ci-ok:']);
  assert.match(ci, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(ci, /macos|matrix\.os|bin\/agentic-bundle|scripts\//);
  assert.match(ci, /node: \[24, 26\]\n/);
  assert.ok(ci.includes('node-version: ${{ matrix.node }}'), 'GitHub expressions are written as-is');
  for (const step of ['npm ci', `${NPX} validate`, `${NPX} build all`, `${NPX} install all`, `${NPX} uninstall all`]) {
    assert.ok(ci.includes(step), step);
  }
  assert.doesNotMatch(ci, UNSCOPED_NPX);
  assert.match(ci, /\n  ci-ok:\n    name: ci-ok\n    if: always\(\)\n    needs: \[test\]\n/);

  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /^# team-harness\n/);
  assert.ok(readme.includes(`npm install -D ${TOOL}@latest`));
  assert.ok(readme.includes(`${NPX} install all`));
  assert.ok(readme.includes(`node_modules/${TOOL}/docs/distribution.md`));
  assert.doesNotMatch(readme, UNSCOPED_NPX);
  assert.doesNotMatch(readme, /bin\/agentic-bundle|setup-service|Releasing/);

  // What the new CI runs, against the converted repository.
  assert.match(cli(dir, 'validate'), /team-harness@0\.1\.0 is valid/);
  const target = mkdtempSync(path.join(os.tmpdir(), 'agentic-bundle-target-'));
  cli(dir, 'install', 'all', '--dir', target);
  cli(dir, 'uninstall', 'all', '--dir', target);
  assert.deepEqual(readdirSync(target), []);
});

initTest('init --harness-only keeps your own tests and edits, and can be re-run', () => {
  const dir = templateCopy();
  const { version } = json(ROOT, 'package.json');
  writeFileSync(path.join(dir, 'test/harness.test.js'), "import { test } from 'node:test';\ntest('harness', () => {});\n");
  writeFileSync(path.join(dir, 'CLAUDE.md'), '# Team notes\n\nRun `npm run validate` before committing.\n');
  writeFileSync(path.join(dir, 'docs/onboarding.md'), '# Onboarding\n');
  const template = json(dir, 'package.json');
  writeJson(dir, 'package.json', { ...template, scripts: { ...template.scripts, lint: 'echo lint', 'pack:pi': 'node bin/agentic-bundle.js build pi --npm --out dist' } });
  run(dir, '--repo', 'myszon01/team-harness', '--harness-only');
  assert.deepEqual(readdirSync(path.join(dir, 'test')), ['harness.test.js']);
  assert.equal(json(dir, 'package.json').scripts.test, 'node --test', 'tests of your own remain');
  assert.equal(json(dir, 'package.json').scripts.lint, 'echo lint');
  assert.equal(json(dir, 'package.json').scripts['pack:pi'], undefined, 'scripts that build npm packages go');
  assert.ok(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').startsWith('# Team notes'), 'a CLAUDE.md of your own stays');
  assert.deepEqual(readdirSync(path.join(dir, 'docs')), ['onboarding.md'], 'only the tool\'s docs go');

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

initTest('init --harness-only converts an initialised copy only without --clean, and keeps its README', () => {
  const dir = templateCopy();
  run(dir, '--repo', 'acme/tools');
  const files = () => ['package.json', 'README.md', 'harness/bundle.json'].map((f) => readFileSync(path.join(dir, f), 'utf8'));
  const before = files();

  // --clean would empty a harness/ the team may have filled: refused, and nothing is touched.
  const refused = runAll(dir, '--repo', 'acme/tools', '--clean', '--harness-only');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already initialised.*run init --harness-only without --clean/);
  assert.deepEqual(files(), before);
  assert.ok(existsSync(path.join(dir, 'bin/agentic-bundle.js')), 'not converted');
  assert.ok(existsSync(path.join(dir, 'harness/skills/code-review/SKILL.md')), 'harness kept');

  const { status, stderr } = runAll(dir, '--repo', 'acme/tools', '--harness-only');
  assert.equal(status, 0, stderr);
  assert.ok(existsSync(path.join(dir, 'harness/skills/code-review/SKILL.md')), 'harness kept');
  assert.deepEqual(readdirSync(dir).sort(), HARNESS_REPO_FILES, 'bin/, lib/, docs/ and CLAUDE.md are removed');
  assert.deepEqual(json(dir, 'package.json').devDependencies, { [TOOL]: 'latest' });
  // The README may have been edited, so it is kept, with a warning that it documents the removed CLI.
  assert.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), before[1]);
  assert.match(stderr, /Warning: README\.md still documents the CLI and release flow/);
  assert.ok(stderr.includes(`${NPX} validate`));
  assert.doesNotMatch(stderr, UNSCOPED_NPX);
});

initTest('init --clean --harness-only starts a fresh copy with an empty harness', () => {
  const dir = templateCopy();
  run(dir, '--repo', 'acme/tools', '--clean', '--harness-only');
  assert.deepEqual(readdirSync(path.join(dir, 'harness/skills')), ['.gitkeep']);
  assert.deepEqual(readdirSync(dir).sort(), HARNESS_REPO_FILES);
  assert.equal(json(dir, 'package.json').private, true);
});

test('pack.sh refuses to pack a public CLI package around a restricted harness', () => {
  const dir = templateCopy();
  const out = path.join(dir, 'artifacts');
  // npm next to this node; nothing is published, `npm pack` only writes a tarball.
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, npm_config_update_notifier: 'false' };
  const pack = () => spawnSync('sh', ['scripts/pack.sh', 'cli', out], { cwd: dir, encoding: 'utf8', env });

  const bundle = json(dir, 'harness/bundle.json');
  writeJson(dir, 'harness/bundle.json', { ...bundle, npm: { ...bundle.npm, access: 'restricted' } });
  const refused = pack();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /npm\.access "restricted", but publishConfig\.access in package\.json is "public"/);
  assert.deepEqual(readdirSync(out), []);

  const pkg = json(dir, 'package.json');
  writeJson(dir, 'package.json', { ...pkg, publishConfig: { access: 'restricted' } });
  const packed = pack();
  assert.equal(packed.status, 0, packed.stderr);
  assert.deepEqual(readdirSync(out), [`${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`]);

  // Publishing leaves access to each package's publishConfig, which a command-line --access would override.
  for (const f of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) {
    assert.doesNotMatch(readFileSync(path.join(ROOT, f), 'utf8'), /--access[\s=]/, f);
  }
});
