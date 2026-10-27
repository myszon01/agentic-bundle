import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, chown, mkdtemp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../lib/bundle.js';
import { TARGETS, installRoots } from '../lib/targets/index.js';
import { install, markers, removeBlock, uninstall, upsertBlock } from '../lib/writer.js';

const opts = { bundle: 'demo', target: 't' };
const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'harness');

/**
 * A manifest shaped like 0.2.0's: named <bundle>.<target>.json in both scopes, without a scope field. Unlike 0.2.0,
 * install() here leaves files and keys that were already there unmanaged, so tests that need 0.2.0's records of
 * those write them explicitly.
 */
async function legacyInstall(entries, root, ctx) {
  const { scope, ...manifest } = await install(entries, root, ctx);
  await writeFile(path.join(root, '.agentic-bundle', `${ctx.bundle}.${ctx.target}.json`), JSON.stringify(manifest));
}

/** Install or uninstall like the CLI: every root of the scope, with what the other scope writes there. */
async function cli(command, bundle, target, scope, dir, logs = [], extra = {}) {
  for (const { root, entries, layouts } of installRoots(TARGETS[target], bundle, { scope, dir, warn: () => {} })) {
    const ctx = { bundle: bundle.name, target, scope, layouts, log: (l) => logs.push(l), ...extra };
    if (command === 'install') await install(entries, root, ctx);
    else await uninstall(root, ctx);
  }
  return logs;
}

/** Run fn with a fresh temporary home directory (AGENTIC_BUNDLE_HOME) and no CODEX_HOME. */
async function withHome(fn) {
  const saved = { home: process.env.AGENTIC_BUNDLE_HOME, codex: process.env.CODEX_HOME };
  process.env.AGENTIC_BUNDLE_HOME = await tmp();
  delete process.env.CODEX_HOME;
  try {
    return await fn(process.env.AGENTIC_BUNDLE_HOME);
  } finally {
    for (const [k, v] of [['AGENTIC_BUNDLE_HOME', saved.home], ['CODEX_HOME', saved.codex]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
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

test('codex user skills installed in ~/.codex/skills by 0.2.0 are cleaned up', async () => {
  const bundle = await loadBundle(HARNESS);
  for (const action of ['reinstall', 'uninstall']) {
    await withHome(async (home) => {
      const groups = installRoots(TARGETS.codex, bundle, { scope: 'user', warn: () => {} });
      const codexHome = path.join(home, '.codex');
      assert.deepEqual(groups.map((g) => g.root), [codexHome, path.join(home, '.agents')]);

      // What 0.2.0 installed: the same files, skills under ~/.codex/skills, in an unmarked <bundle>.codex.json.
      await legacyInstall([...groups[0].entries, ...groups[1].entries], codexHome, { bundle: bundle.name, target: 'codex' });
      assert.ok(existsSync(path.join(codexHome, 'skills/code-review/SKILL.md')));

      if (action === 'reinstall') {
        await cli('install', bundle, 'codex', 'user');
        assert.ok(!existsSync(path.join(codexHome, 'skills')), 'old skills folder is removed');
        assert.ok(existsSync(path.join(home, '.agents/skills/code-review/SKILL.md')));
        assert.deepEqual(await readdir(path.join(codexHome, '.agentic-bundle')), [`${bundle.name}.codex.user.json`]);
      }
      await cli('uninstall', bundle, 'codex', 'user');
      // Only the (now empty) roots themselves are left: roots are never deleted.
      const left = (await readdir(home)).sort();
      assert.deepEqual(left, action === 'reinstall' ? ['.agents', '.codex'] : ['.codex'], `${action}: nothing else is left behind`);
      for (const dir of left) assert.deepEqual(await readdir(path.join(home, dir)), [], `${action}: nothing is left in ~/${dir}`);
    });
  }
});

test('codex: a project install in ~ and the user install share the files both write, across roots', async () => {
  const bundle = await loadBundle(HARNESS);
  for (const order of [['project', 'user'], ['user', 'project']]) {
    await withHome(async (home) => {
      await mkdir(path.join(home, '.codex'));
      await writeFile(path.join(home, '.codex/config.toml'), 'model = "mine"'); // no final newline
      const logs = [];
      for (const scope of order) await cli('install', bundle, 'codex', scope, home, logs);
      assert.doesNotMatch(logs.join('\n'), /keep |remove /, `${order}: the second install neither keeps files unmanaged nor removes any`);
      assert.ok(existsSync(path.join(home, '.agentic-bundle', `${bundle.name}.codex.json`)));
      assert.ok(existsSync(path.join(home, '.codex/.agentic-bundle', `${bundle.name}.codex.user.json`)));

      // Uninstalling either one leaves what the other still records: agents, skills and the config.toml block.
      await cli('uninstall', bundle, 'codex', order[0], home);
      assert.ok(existsSync(path.join(home, '.codex/agents/researcher.toml')), `${order}: agent stays`);
      assert.ok(existsSync(path.join(home, '.agents/skills/code-review/SKILL.md')), `${order}: skills stay`);
      assert.match(await read(home, '.codex/config.toml'), /\[mcp_servers\.fetch\]/, `${order}: MCP block stays`);
      await cli('uninstall', bundle, 'codex', order[1], home);
      assert.equal(await read(home, '.codex/config.toml'), 'model = "mine"', `${order}: config.toml back byte for byte`);
      assert.deepEqual(await readdir(path.join(home, '.codex')), ['config.toml']);
      assert.deepEqual((await readdir(home)).filter((n) => n !== '.agents'), ['.codex']);
    });
  }
});

test('codex: the user install never shares a manifest with a project install run in ~', async () => {
  const bundle = await loadBundle(HARNESS);
  await withHome(async (home) => {
    // `install codex --scope user`, then `uninstall codex` in ~: there is no project install to remove.
    await cli('install', bundle, 'codex', 'user');
    assert.ok(existsSync(path.join(home, '.agents/.agentic-bundle', `${bundle.name}.codex.user.json`)), 'user skills have their own manifest in ~/.agents');
    for (const { root } of installRoots(TARGETS.codex, bundle, { scope: 'project', dir: home, warn: () => {} })) {
      assert.equal(await uninstall(root, { bundle: bundle.name, target: 'codex' }), false);
    }
    assert.ok(existsSync(path.join(home, '.agents/skills/code-review/SKILL.md')));
  });
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

test('a file another install of the bundle records is shared, and removed only by the last one', async () => {
  const root = await tmp();
  const file = [{ type: 'file', path: 'cmd/x.md', content: 'x' }];
  await install(file, root, { bundle: 'demo', target: 'a' });
  const logs = [];
  const next = await install(file, root, { bundle: 'demo', target: 'b', log: (l) => logs.push(l) });
  assert.deepEqual(next.files, ['cmd/x.md'], 'recorded, not kept as the user\'s');
  assert.deepEqual(logs, []);
  // b drops it from its harness: a still records it, so it stays.
  logs.length = 0;
  await install([], root, { bundle: 'demo', target: 'b', log: (l) => logs.push(l) });
  assert.match(logs.join('\n'), /keep cmd\/x\.md \(still installed by \.agentic-bundle\/demo\.a\.json\)/);
  await install(file, root, { bundle: 'demo', target: 'b' });
  await uninstall(root, { bundle: 'demo', target: 'a' });
  assert.equal(await read(root, 'cmd/x.md'), 'x');
  await uninstall(root, { bundle: 'demo', target: 'b' });
  assert.deepEqual(await readdir(root), []);
});

test('files and blocks are shared with an install rooted in a folder above', async () => {
  const outer = await tmp();
  const inner = path.join(outer, 'sub');
  await mkdir(inner);
  await writeFile(path.join(inner, 'config.toml'), 'model = "m"');
  const entries = (base) => [
    { type: 'file', path: `${base}agents/a.toml`, content: 'a' },
    { type: 'block', path: `${base}config.toml`, content: '[mcp_servers.x]\ncommand = "x"', syntax: 'toml' },
  ];
  for (const order of [['outer', 'inner'], ['inner', 'outer']]) {
    const run = (fn, which) => (which === 'outer' ? fn(entries('sub/'), outer, 'o') : fn(entries(''), inner, 'i'));
    for (const which of order) await run((e, root, target) => install(e, root, { bundle: 'demo', target }), which);
    await run((e, root, target) => uninstall(root, { bundle: 'demo', target }), order[0]);
    assert.equal(await read(inner, 'agents/a.toml'), 'a', `${order}: file stays`);
    assert.match(await read(inner, 'config.toml'), /\[mcp_servers\.x\]/, `${order}: block stays`);
    await run((e, root, target) => uninstall(root, { bundle: 'demo', target }), order[1]);
    assert.equal(await read(inner, 'config.toml'), 'model = "m"', `${order}: byte for byte`);
    assert.deepEqual((await readdir(inner)).sort(), ['config.toml']);
  }
});

test('claude: a project install in ~ and the user install keep their own manifests and share .claude files', async () => {
  const bundle = await loadBundle(HARNESS);
  for (const order of [['project', 'user'], ['user', 'project']]) {
    await withHome(async (home) => {
      await writeFile(path.join(home, 'CLAUDE.md'), '# Mine\n');
      const logs = await cli('install', bundle, 'claude', order[0], home);
      logs.length = 0;
      await cli('install', bundle, 'claude', order[1], home, logs);
      assert.doesNotMatch(logs.join('\n'), /remove|keep/, `${order}: ${logs}`);
      assert.deepEqual(await readdir(path.join(home, '.agentic-bundle')), [`${bundle.name}.claude.json`, `${bundle.name}.claude.user.json`]);
      assert.match(await read(home, 'CLAUDE.md'), /BEGIN fixture-bundle/);
      assert.match(await read(home, '.claude/CLAUDE.md'), /BEGIN fixture-bundle/);
      assert.ok(JSON.parse(await read(home, '.mcp.json')).mcpServers.fetch && JSON.parse(await read(home, '.claude.json')).mcpServers.fetch);

      // Uninstalling the first leaves the other complete, shared skills, commands and agents included.
      await cli('uninstall', bundle, 'claude', order[0], home);
      assert.ok(existsSync(path.join(home, '.claude/skills/code-review/SKILL.md')), `${order}: shared files stay`);
      assert.ok(existsSync(path.join(home, order[0] === 'user' ? '.mcp.json' : '.claude.json')));
      assert.match(await read(home, order[0] === 'user' ? 'CLAUDE.md' : '.claude/CLAUDE.md'), /BEGIN fixture-bundle/);
      await cli('uninstall', bundle, 'claude', order[1], home);
      assert.deepEqual(await readdir(home), ['CLAUDE.md']);
      assert.equal(await read(home, 'CLAUDE.md'), '# Mine\n');
    });
  }
});

test('claude: a 0.2.0 manifest in ~ belongs to the scope that wrote it', async () => {
  const bundle = await loadBundle(HARNESS);
  for (const [made, then] of [['user', 'project'], ['project', 'user'], ['user', 'user'], ['project', 'project']]) {
    for (const command of ['install', 'uninstall']) {
      await withHome(async (home) => {
        for (const { root, entries } of installRoots(TARGETS.claude, bundle, { scope: made, dir: home, warn: () => {} })) {
          await legacyInstall(entries, root, { bundle: bundle.name, target: 'claude' });
        }
        await cli(command, bundle, 'claude', then, home);
        const names = await readdir(path.join(home, '.agentic-bundle')).catch(() => []);
        const owner = `${bundle.name}.claude${made === 'user' ? '.user' : ''}.json`;
        if (command === 'install' || made !== then) assert.ok(names.includes(owner), `${made} → ${command} ${then}: ${names}`);
        if (made !== then) assert.match(await read(home, made === 'user' ? '.claude/CLAUDE.md' : 'CLAUDE.md'), /BEGIN fixture-bundle/, 'the other install is intact');
        for (const scope of ['project', 'user']) await cli('uninstall', bundle, 'claude', scope, home);
        assert.deepEqual(await readdir(home), [], `${made} → ${command} ${then}: nothing is left`);
      });
    }
  }
});

test('claude: a 0.2.0 user manifest written after an upgrade is merged into the user manifest', async () => {
  const bundle = await loadBundle(HARNESS);
  // Each record holds something the other lacks: a skill, an MCP server, and (one side or the other) the block.
  for (const blockIn of ['new', '0.2.0']) {
    await withHome(async (home) => {
      await cli('install', blockIn === 'new' ? bundle : { ...bundle, instructions: null }, 'claude', 'user');
      const [user] = installRoots(TARGETS.claude, bundle, { scope: 'user', warn: () => {} });
      const legacy = user.entries
        .filter((e) => !e.path.startsWith('.claude/skills/conventional-commits/') && !(blockIn === 'new' && e.type === 'block'))
        .map((e) => (e.type === 'json' ? { ...e, value: { mcpServers: { old: { command: 'old' } } }, owns: [['mcpServers', 'old']] } : e));
      legacy.push({ type: 'file', path: '.claude/skills/old/SKILL.md', content: 'old' });
      await legacyInstall(legacy, user.root, { bundle: bundle.name, target: 'claude' }); // a pinned 0.2.0 run again
      await cli('install', bundle, 'claude', 'project', home);
      assert.deepEqual(await readdir(path.join(home, '.agentic-bundle')), [`${bundle.name}.claude.json`, `${bundle.name}.claude.user.json`]);
      const merged = JSON.parse(await read(home, `.agentic-bundle/${bundle.name}.claude.user.json`));
      for (const f of ['.claude/skills/conventional-commits/SKILL.md', '.claude/skills/old/SKILL.md']) assert.ok(merged.files.includes(f), `${blockIn}: ${f}`);
      assert.deepEqual(merged.blocks.map((b) => b.path), ['.claude/CLAUDE.md'], blockIn);
      assert.deepEqual(merged.json[0].owns.map((k) => k[1]).sort(), ['fetch', 'old'], blockIn);
      await cli('uninstall', bundle, 'claude', 'user');
      await cli('uninstall', bundle, 'claude', 'project', home);
      assert.deepEqual(await readdir(home), [], `${blockIn}: nothing is left`);
    });
  }
});

test('claude: a dry run moves no 0.2.0 manifest and plans as if it had', async () => {
  const bundle = await loadBundle(HARNESS);
  await withHome(async (home) => {
    const [user] = installRoots(TARGETS.claude, bundle, { scope: 'user', warn: () => {} });
    await legacyInstall(user.entries, user.root, { bundle: bundle.name, target: 'claude' });
    const before = await read(home, `.agentic-bundle/${bundle.name}.claude.json`);
    for (const [command, scope] of [['install', 'project'], ['uninstall', 'project'], ['install', 'user'], ['uninstall', 'user']]) {
      const logs = await cli(command, bundle, 'claude', scope, home, [], { dryRun: true });
      assert.match(logs[0], /^move \.agentic-bundle\/fixture-bundle\.claude\.json to fixture-bundle\.claude\.user\.json/);
      assert.equal(logs[0].includes('uninstall it with --scope user'), scope === 'project', `${command} ${scope}: hint only from the project scope`);
      if (scope === 'project') assert.doesNotMatch(logs.join('\n'), /keep|remove/, `${command} ${scope}: ${logs}`);
      if (command === 'uninstall' && scope === 'user') assert.match(logs.join('\n'), /remove \.claude\/skills\/code-review\/SKILL\.md/);
    }
    assert.deepEqual(await readdir(path.join(home, '.agentic-bundle')), [`${bundle.name}.claude.json`]);
    assert.equal(await read(home, `.agentic-bundle/${bundle.name}.claude.json`), before);
  });
});

test('a corrupt manifest is reported with its path', async () => {
  const root = await tmp();
  await mkdir(path.join(root, '.agentic-bundle'));
  await writeFile(path.join(root, '.agentic-bundle/demo.t.json'), '{');
  await assert.rejects(install([{ type: 'file', path: 'x.md', content: 'x' }], root, opts), /demo\.t\.json/);
});

test('claude: files the user already had in ~/.claude stay theirs for both scopes', async () => {
  const bundle = await loadBundle(HARNESS);
  await withHome(async (home) => {
    const [user] = installRoots(TARGETS.claude, bundle, { scope: 'user', warn: () => {} });
    const commit = user.entries.find((e) => e.path === '.claude/commands/commit.md');
    await mkdir(path.join(home, '.claude/commands'), { recursive: true });
    await writeFile(path.join(home, '.claude/commands/commit.md'), commit.content); // identical
    await writeFile(path.join(home, '.claude/commands/review.md'), 'mine'); // different
    const warnings = [];
    for (const scope of ['user', 'project']) {
      const logs = await cli('install', bundle, 'claude', scope, home, [], { warn: (w) => warnings.push(w) });
      assert.match(logs.join('\n'), /keep \.claude\/commands\/commit\.md \(identical/, scope);
    }
    assert.equal(warnings.filter((w) => /skipped \.claude\/commands\/review\.md/.test(w)).length, 2);
    for (const scope of ['project', 'user']) await cli('uninstall', bundle, 'claude', scope, home);
    assert.deepEqual((await readdir(path.join(home, '.claude/commands'))).sort(), ['commit.md', 'review.md']);
    assert.equal(await read(home, '.claude/commands/review.md'), 'mine');
  });
});

test('claude: a symlinked home directory still keeps a 0.2.0 user install apart from a project install in ~', async () => {
  const bundle = await loadBundle(HARNESS);
  await withHome(async (home) => {
    const link = `${home}-link`;
    await symlink(home, link);
    process.env.AGENTIC_BUNDLE_HOME = link; // withHome restores it
    const [user] = installRoots(TARGETS.claude, bundle, { scope: 'user', warn: () => {} });
    await legacyInstall(user.entries, user.root, { bundle: bundle.name, target: 'claude' });
    // `cd ~` and the working directory is the real path, while the home directory keeps the symlink.
    const logs = await cli('uninstall', bundle, 'claude', 'project', await realpath(link));
    assert.match(logs[0] ?? '', /^move .*; if it was a project install here, uninstall it with --scope user\)$/);
    assert.doesNotMatch(logs.join('\n'), /remove/);
    assert.match(await read(home, '.claude/CLAUDE.md'), /BEGIN fixture-bundle/, 'the user install is intact');
    await cli('uninstall', bundle, 'claude', 'user');
    assert.deepEqual(await readdir(home), []);
  });
});

test('claude: with a harness of files only, a project install in ~ and the user install each keep their record', async () => {
  const bundle = { ...(await loadBundle(HARNESS)), instructions: null, mcp: [] };
  await withHome(async (home) => {
    await cli('install', bundle, 'claude', 'project', home);
    await cli('install', bundle, 'claude', 'user');
    assert.deepEqual(await readdir(path.join(home, '.agentic-bundle')), [`${bundle.name}.claude.json`, `${bundle.name}.claude.user.json`]);
    for (const scope of ['project', 'user']) {
      const [{ root, layouts }] = installRoots(TARGETS.claude, bundle, { scope, dir: home, warn: () => {} });
      assert.equal(await uninstall(root, { bundle: bundle.name, target: 'claude', scope, layouts }), true, scope);
    }
    assert.deepEqual(await readdir(home), []);
  });
});

test('claude: a 0.2.0 project install in ~ is recognised after the harness drops its instructions and MCP servers', async () => {
  const full = await loadBundle(HARNESS);
  const bare = { ...full, instructions: null, mcp: [] };
  await withHome(async (home) => {
    await writeFile(path.join(home, 'CLAUDE.md'), '# Mine\n');
    const [project] = installRoots(TARGETS.claude, full, { scope: 'project', dir: home, warn: () => {} });
    await legacyInstall(project.entries, project.root, { bundle: full.name, target: 'claude' });
    const logs = await cli('install', bare, 'claude', 'user');
    assert.doesNotMatch(logs.join('\n'), /move|remove|\.mcp\.json/, logs.join('\n'));
    assert.match(await read(home, 'CLAUDE.md'), /BEGIN fixture-bundle/);
    await cli('uninstall', bare, 'claude', 'project', home);
    await cli('uninstall', bare, 'claude', 'user');
    assert.deepEqual(await readdir(home), ['CLAUDE.md']);
    assert.equal(await read(home, 'CLAUDE.md'), '# Mine\n');
  });
});

test('opencode: a project install into the user config folder and the user install share MCP entries', async () => {
  const bundle = await loadBundle(HARNESS);
  for (const first of ['project', 'user']) {
    await withHome(async (home) => {
      const saved = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = path.join(home, '.config');
      try {
        const dir = path.join(home, '.config', 'opencode');
        await mkdir(dir, { recursive: true });
        const second = first === 'project' ? 'user' : 'project';
        for (const scope of [first, second]) await cli('install', bundle, 'opencode', scope, dir);
        const logs = await cli('uninstall', bundle, 'opencode', first, dir);
        assert.match(logs.join('\n'), /keep mcp\.fetch in opencode\.json \(still installed by/, first);
        assert.ok(JSON.parse(await read(dir, 'opencode.json')).mcp.fetch, `${first}: the other install keeps its MCP server`);
        await cli('uninstall', bundle, 'opencode', second, dir);
        assert.deepEqual(await readdir(dir), [], `${first}: nothing is left`);
      } finally {
        if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = saved;
      }
    });
  }
});

test('an unreadable record folder stops the command instead of deleting what it may record', { skip: process.getuid?.() === 0 && 'root reads any folder' }, async () => {
  const bundle = await loadBundle(HARNESS);
  await withHome(async (home) => {
    await cli('install', bundle, 'codex', 'user');
    await cli('install', bundle, 'codex', 'project', home);
    const records = path.join(home, '.codex', '.agentic-bundle');
    await chmod(records, 0o000);
    try {
      await assert.rejects(cli('uninstall', bundle, 'codex', 'project', home), /\.agentic-bundle: EACCES/);
    } finally {
      await chmod(records, 0o755);
    }
    assert.ok(existsSync(path.join(home, '.codex/agents/researcher.toml')));
  });
});

test('a corrupt or malformed record of another install is reported with its path', async () => {
  const bundle = await loadBundle(HARNESS);
  for (const text of ['{"files": ', '{"files": "x"}']) {
    await withHome(async (home) => {
      await cli('install', bundle, 'claude', 'user');
      const record = path.join(home, '.agentic-bundle', `${bundle.name}.claude.user.json`);
      await writeFile(record, text);
      // Codex's user roots are below ~, so its install reads the Claude record there.
      await assert.rejects(cli('install', bundle, 'codex', 'user'), (e) => e.message.startsWith(`${record}: `) && /delete it and install again/.test(e.message));
      assert.ok(!existsSync(path.join(home, '.codex')), 'nothing was written');
    });
  }
});

test('records above the install root that another user wrote are ignored', { skip: process.getuid?.() !== 0 && 'needs root to chown' }, async () => {
  const outer = await tmp();
  const root = path.join(outer, 'proj');
  await mkdir(path.join(root, 'cmd'), { recursive: true });
  await writeFile(path.join(root, 'cmd/x.md'), 'mine');
  await mkdir(path.join(outer, '.agentic-bundle'));
  const planted = path.join(outer, '.agentic-bundle', 'demo.t.json');
  await writeFile(planted, JSON.stringify({ files: ['proj/cmd/x.md'], blocks: [], json: [] }));
  await chown(planted, 4242, 4242);
  const warnings = [];
  await install([{ type: 'file', path: 'cmd/x.md', content: 'ours' }], root, { bundle: 'demo', target: 'u', warn: (w) => warnings.push(w) });
  assert.equal(await read(root, 'cmd/x.md'), 'mine');
  assert.match(warnings.join('\n'), /skipped cmd\/x\.md/);
});
