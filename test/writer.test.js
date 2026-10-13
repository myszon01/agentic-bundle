import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../lib/bundle.js';
import { TARGETS, installRoots } from '../lib/targets/index.js';
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

test('codex user skills installed in ~/.codex/skills by older versions are cleaned up', async () => {
  const bundle = await loadBundle(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'harness'));
  const saved = { home: process.env.AGENTIC_BUNDLE_HOME, codex: process.env.CODEX_HOME };
  const ctx = { bundle: bundle.name, target: 'codex' };
  try {
    for (const action of ['reinstall', 'uninstall']) {
      const home = await tmp();
      process.env.AGENTIC_BUNDLE_HOME = home;
      delete process.env.CODEX_HOME;
      const groups = installRoots(TARGETS.codex, bundle, { scope: 'user', warn: () => {} });
      const codexHome = path.join(home, '.codex');
      assert.deepEqual(groups.map((g) => g.root), [codexHome, home]);

      // What older versions installed: the same files, with skills under ~/.codex/skills.
      const skills = groups[1].entries.map((e) => ({ ...e, path: e.path.replace(/^\.agents\//, '') }));
      await install([...groups[0].entries, ...skills], codexHome, ctx);
      assert.ok(existsSync(path.join(codexHome, 'skills/code-review/SKILL.md')));

      if (action === 'reinstall') {
        for (const { root, entries } of groups) await install(entries, root, ctx);
        assert.ok(!existsSync(path.join(codexHome, 'skills')), 'old skills folder is removed');
        assert.ok(existsSync(path.join(home, '.agents/skills/code-review/SKILL.md')));
      }
      for (const { root } of groups) await uninstall(root, ctx);
      // Only the (now empty) ~/.codex root itself is left: roots are never deleted.
      assert.deepEqual(await readdir(home), ['.codex'], `${action}: nothing is left behind`);
      assert.deepEqual(await readdir(codexHome), [], `${action}: nothing is left in ~/.codex`);
    }
  } finally {
    for (const [k, v] of [['AGENTIC_BUNDLE_HOME', saved.home], ['CODEX_HOME', saved.codex]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('files the user already had are never taken over, even when identical', async () => {
  const root = await tmp();
  await mkdir(path.join(root, 'skills/a'), { recursive: true });
  await writeFile(path.join(root, 'skills/a/SKILL.md'), 'a');
  const logs = [];
  const next = await install([{ type: 'file', path: 'skills/a/SKILL.md', content: 'a' }], root, { ...opts, log: (l) => logs.push(l) });
  assert.deepEqual(next.files, []);
  assert.match(logs.join('\n'), /keep skills\/a\/SKILL\.md/);
  await uninstall(root, opts);
  assert.equal(await read(root, 'skills/a/SKILL.md'), 'a');
});

test('JSON keys the user already had are kept, not overwritten or removed', async () => {
  const root = await tmp();
  const mine = { mcpServers: { same: { command: 'x' }, theirs: { command: '/home/dev/bin/srv' }, other: { command: 'o' } } };
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify(mine));
  const value = { mcpServers: { same: { command: 'x' }, theirs: { command: 'srv' }, ours: { command: 'y' } } };
  const owns = [['mcpServers', 'same'], ['mcpServers', 'theirs'], ['mcpServers', 'ours']];
  const warnings = [];
  const next = await install([{ type: 'json', path: '.mcp.json', value, owns }], root, { ...opts, warn: (w) => warnings.push(w) });
  assert.deepEqual(next.json, [{ path: '.mcp.json', owns: [['mcpServers', 'ours']] }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /skipped mcpServers\.theirs in \.mcp\.json/);
  assert.deepEqual(JSON.parse(await read(root, '.mcp.json')).mcpServers.theirs, { command: '/home/dev/bin/srv' });

  await uninstall(root, opts);
  assert.deepEqual(JSON.parse(await read(root, '.mcp.json')), mine);

  await install([{ type: 'json', path: '.mcp.json', value, owns }], root, { ...opts, force: true });
  assert.deepEqual(JSON.parse(await read(root, '.mcp.json')).mcpServers.theirs, { command: 'srv' });
});

test('a TOML block is skipped when it would define a table twice', async () => {
  const root = await tmp();
  const config = 'model = "m"\n\n[mcp_servers."docs"]\ncommand = "mine"\n';
  await writeFile(path.join(root, 'config.toml'), config);
  const warnings = [];
  const block = { type: 'block', path: 'config.toml', content: '[mcp_servers.docs]\ncommand = "ours"\n\n[mcp_servers.new]\ncommand = "n"', syntax: 'toml' };
  const next = await install([block], root, { ...opts, warn: (w) => warnings.push(w) });
  assert.deepEqual(next.blocks, []);
  assert.match(warnings.join('\n'), /\[mcp_servers\.docs\] already defined outside the demo block/);
  assert.equal(await read(root, 'config.toml'), config);

  await writeFile(path.join(root, 'config.toml'), 'model = "m"\n\n[[profiles]]\nname = "a"\n');
  await install([{ ...block, content: '[mcp_servers.new]\ncommand = "n"' }], root, opts);
  assert.match(await read(root, 'config.toml'), /\[mcp_servers\.new\]/);
});

test('uninstall gives instruction files and untouched JSON back byte for byte', async () => {
  const root = await tmp();
  const mine = '# Mine\n\n\n\nkept as written';
  await writeFile(path.join(root, 'CLAUDE.md'), mine);
  const json = '{"mcpServers": {"theirs": {"command": "x"}}}';
  await writeFile(path.join(root, '.mcp.json'), json);
  const entries = [
    { type: 'block', path: 'CLAUDE.md', content: 'shared', syntax: 'md' },
    { type: 'json', path: '.mcp.json', value: { mcpServers: { theirs: { command: 'x' } } }, owns: [['mcpServers', 'theirs']] },
  ];
  await install(entries, root, { bundle: 'demo', target: 'a' });
  await install(entries.slice(0, 1), root, { bundle: 'demo', target: 'b' });
  assert.equal(await read(root, '.mcp.json'), json);
  await uninstall(root, { bundle: 'demo', target: 'a' });
  await uninstall(root, { bundle: 'demo', target: 'b' });
  assert.equal(await read(root, 'CLAUDE.md'), mine);
  assert.equal(await read(root, '.mcp.json'), json);
});
