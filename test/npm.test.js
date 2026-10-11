import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle, validateBundle } from '../lib/bundle.js';
import { npmEntries, npmName, npmRepository } from '../lib/npm.js';
import { TARGETS } from '../lib/targets/index.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'harness');
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
  assert.equal(npmName(bundle, TARGETS.gemini), `${bundle.manifest.npm.scope}/${bundle.name}-gemini`);
  assert.equal(npmName(bundle, TARGETS.gemini, ''), `${bundle.name}-gemini`);
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
