import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle, validateBundle } from '../lib/bundle.js';
import { npmEntries, npmName, npmRepository } from '../lib/npm.js';
import { TARGETS } from '../lib/targets/index.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'harness');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentic-bundle.js');
const bundle = await loadBundle(HARNESS);
const noop = () => {};
const file = (entries, p) => entries.find((e) => e.path === p);

function build(id) {
  const target = TARGETS[id];
  const name = npmName(bundle, target);
  const { entries } = target.package(bundle, { warn: noop, npm: { name } });
  return { name, entries: npmEntries(bundle, target, entries, { name, cli: '@acme/cli' }) };
}

test('package names are scoped per target', () => {
  assert.equal(npmName(bundle, TARGETS.opencode), `${bundle.manifest.npm.scope}/${bundle.name}-opencode`);
  assert.equal(npmName(bundle, TARGETS.opencode, ''), `${bundle.name}-opencode`);
  assert.equal(npmName(bundle, TARGETS.pi, '@other'), `@other/${bundle.name}-pi`);
});

test('every target produces a publishable package with install instructions', () => {
  for (const id of Object.keys(TARGETS)) {
    const { name, entries } = build(id);
    const pkg = JSON.parse(file(entries, 'package.json').content);
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, bundle.version);
    assert.deepEqual(pkg.publishConfig, { access: 'public' });
    assert.equal(entries.filter((e) => e.path === 'package.json').length, 1, `${id}: one package.json`);
    assert.match(file(entries, 'README.md').content, /## Install\n\n\S/, `${id}: README has install steps`);
  }
});

test('pi keeps its pi manifest and installs natively from npm', () => {
  const { name, entries } = build('pi');
  const pkg = JSON.parse(file(entries, 'package.json').content);
  assert.deepEqual(pkg.pi, { skills: ['./skills'], prompts: ['./prompts'] });
  assert.ok(pkg.keywords.includes('pi-package'));
  assert.ok(file(entries, 'README.md').content.includes(`pi install npm:${name}`));
});

test('claude marketplace points at the npm package when published', () => {
  const { name, entries } = build('claude');
  const marketplace = JSON.parse(file(entries, '.claude-plugin/marketplace.json').content);
  assert.deepEqual(marketplace.plugins[0].source, { source: 'npm', package: name, version: bundle.version });
  const local = TARGETS.claude.package(bundle, { warn: noop }).entries;
  assert.equal(JSON.parse(file(local, '.claude-plugin/marketplace.json').content).plugins[0].source, './');
});

test('repository URLs are normalised for npm', () => {
  assert.deepEqual(npmRepository('https://github.com/a/b'), { type: 'git', url: 'git+https://github.com/a/b.git' });
  assert.deepEqual(npmRepository({ type: 'git', url: 'x' }), { type: 'git', url: 'x' });
});

test('an invalid npm scope fails validation', () => {
  const { errors } = validateBundle({ ...bundle, manifest: { ...bundle.manifest, npm: { scope: 'nope' } } });
  assert.ok(errors.some((e) => e.includes('npm.scope')));
});

test('npm.access defaults to public and "restricted" makes every package private', () => {
  const restricted = { ...bundle, manifest: { ...bundle.manifest, npm: { ...bundle.manifest.npm, access: 'restricted' } } };
  for (const id of Object.keys(TARGETS)) {
    const target = TARGETS[id];
    const name = npmName(restricted, target);
    const { entries } = target.package(restricted, { warn: noop, npm: { name } });
    const out = npmEntries(restricted, target, entries, { name, cli: '@acme/cli' });
    assert.deepEqual(JSON.parse(file(out, 'package.json').content).publishConfig, { access: 'restricted' }, id);
    assert.match(file(out, 'README.md').content, /## Install\n\nThis package is private: .*npm login/, `${id}: README says to log in`);
  }
  assert.doesNotMatch(file(build('claude').entries, 'README.md').content, /npm login/);
});

test('a restricted package must be scoped', () => {
  const restricted = { ...bundle, manifest: { ...bundle.manifest, npm: { access: 'restricted' } } };
  const target = TARGETS.claude;
  const name = npmName(restricted, target);
  const { entries } = target.package(restricted, { warn: noop, npm: { name } });
  assert.throws(() => npmEntries(restricted, target, entries, { name, cli: '@acme/cli' }), /needs a scoped package name/);
});

test('npm.access is validated', () => {
  const errorsFor = (npm) => validateBundle({ ...bundle, manifest: { ...bundle.manifest, npm } }).errors.filter((e) => e.includes('npm.'));
  assert.deepEqual(errorsFor({ scope: '@fixture' }), []);
  assert.deepEqual(errorsFor({ scope: '@fixture', access: 'public' }), []);
  assert.deepEqual(errorsFor({ scope: '@fixture', access: 'restricted' }), []);
  assert.deepEqual(errorsFor({ access: 'public' }), []);
  assert.match(errorsFor({ scope: '@fixture', access: 'private' }).join(), /"npm\.access" must be "public" or "restricted", got "private"/);
  assert.match(errorsFor({ scope: '@fixture', access: true }).join(), /"npm\.access" must be .* got true/);
  // The scope may come from `build --npm --npm-scope`; npmEntries checks the effective name at build time.
  assert.deepEqual(errorsFor({ access: 'restricted' }), []);
});

test('build --npm-scope supplies the scope that a restricted package needs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-bundle-restricted-'));
  const source = path.join(dir, 'harness');
  mkdirSync(path.join(source, 'commands'), { recursive: true });
  writeFileSync(path.join(source, 'bundle.json'), JSON.stringify({ name: 'made-up-bundle', npm: { access: 'restricted' } }));
  writeFileSync(path.join(source, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\nSay hello.\n');
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args, '--source', source], { cwd: dir, encoding: 'utf8' });

  assert.equal(cli('validate').status, 0);
  const scoped = cli('build', 'claude', '--npm', '--npm-scope', '@acme', '--out', path.join(dir, 'scoped'));
  assert.equal(scoped.status, 0, scoped.stderr);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'scoped', 'claude', 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@acme/made-up-bundle-claude');
  assert.deepEqual(pkg.publishConfig, { access: 'restricted' });

  const unscoped = cli('build', 'claude', '--npm', '--out', path.join(dir, 'unscoped'));
  assert.notEqual(unscoped.status, 0);
  assert.match(unscoped.stderr, /npm\.access "restricted" needs a scoped package name, got "made-up-bundle-claude" \(set npm\.scope or --npm-scope\)/);
});
