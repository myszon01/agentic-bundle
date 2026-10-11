import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { install, markers, removeBlock, uninstall, upsertBlock } from '../lib/writer.js';

const opts = { bundle: 'demo', target: 't' };
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'agentic-bundle-'));
const read = (root, p) => readFile(path.join(root, p), 'utf8');

test('managed blocks are inserted, replaced and removed without touching user text', () => {
  const m = markers('demo').md;
  const once = upsertBlock('# Mine\n', 'v1', m);
  const twice = upsertBlock(once, 'v2', m);
  assert.match(twice, /# Mine\n\n<!-- BEGIN demo[^\n]*-->\nv2\n<!-- END demo -->\n$/);
  assert.equal(removeBlock(twice, m), '# Mine\n');
});

test('install → reinstall → uninstall round trip', async () => {
  const root = await tmp();
  await writeFile(path.join(root, 'AGENTS.md'), '# Mine\n');
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ servers: { keep: 1 } }));

  const v1 = [
    { type: 'file', path: 'skills/a/SKILL.md', content: 'a' },
    { type: 'file', path: 'skills/b/SKILL.md', content: 'b' },
    { type: 'block', path: 'AGENTS.md', content: 'shared', syntax: 'md' },
    { type: 'json', path: 'settings.json', value: { servers: { x: 1, y: 2 } }, owns: [['servers', 'x'], ['servers', 'y']] },
  ];
  await install(v1, root, opts);
  assert.equal(await read(root, 'skills/a/SKILL.md'), 'a');
  assert.deepEqual(JSON.parse(await read(root, 'settings.json')), { servers: { keep: 1, x: 1, y: 2 } });

  // v2 drops skill b and server y: both must be cleaned up.
  const v2 = [v1[0], v1[2], { ...v1[3], value: { servers: { x: 3 } }, owns: [['servers', 'x']] }];
  await install(v2, root, opts);
  assert.ok(!existsSync(path.join(root, 'skills/b')));
  assert.deepEqual(JSON.parse(await read(root, 'settings.json')), { servers: { keep: 1, x: 3 } });

  assert.equal(await uninstall(root, opts), true);
  assert.equal(await read(root, 'AGENTS.md'), '# Mine\n');
  assert.deepEqual(JSON.parse(await read(root, 'settings.json')), { servers: { keep: 1 } });
  assert.ok(!existsSync(path.join(root, 'skills')));
  assert.ok(!existsSync(path.join(root, '.agentic-bundle')));
});

test('does not overwrite foreign files unless forced', async () => {
  const root = await tmp();
  await mkdir(path.join(root, 'cmd'));
  await writeFile(path.join(root, 'cmd/x.md'), 'theirs');
  const warnings = [];
  await install([{ type: 'file', path: 'cmd/x.md', content: 'ours' }], root, { ...opts, warn: (w) => warnings.push(w) });
  assert.equal(await read(root, 'cmd/x.md'), 'theirs');
  assert.equal(warnings.length, 1);
  await install([{ type: 'file', path: 'cmd/x.md', content: 'ours' }], root, { ...opts, force: true });
  assert.equal(await read(root, 'cmd/x.md'), 'ours');
});

test('a block shared by two targets survives uninstalling one of them', async () => {
  const root = await tmp();
  const block = [{ type: 'block', path: 'AGENTS.md', content: 'shared', syntax: 'md' }];
  await install(block, root, { bundle: 'demo', target: 'a' });
  await install(block, root, { bundle: 'demo', target: 'b' });
  await uninstall(root, { bundle: 'demo', target: 'a' });
  assert.match(await read(root, 'AGENTS.md'), /shared/);
  await uninstall(root, { bundle: 'demo', target: 'b' });
  assert.ok(!existsSync(path.join(root, 'AGENTS.md')));
});

test('dry run writes nothing', async () => {
  const root = await tmp();
  await install([{ type: 'file', path: 'x.md', content: 'x' }], root, { ...opts, dryRun: true });
  assert.ok(!existsSync(path.join(root, 'x.md')));
  assert.ok(!existsSync(path.join(root, '.agentic-bundle')));
});

test('refuses paths that escape the root', async () => {
  const root = await tmp();
  await assert.rejects(install([{ type: 'file', path: '../evil', content: 'x' }], root, opts), /outside/);
});
