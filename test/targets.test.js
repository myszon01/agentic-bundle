import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle, validateBundle } from '../lib/bundle.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { mcpToml } from '../lib/targets/codex.js';
import { TARGETS, resolveTargets } from '../lib/targets/index.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness');
const bundle = await loadBundle(HARNESS);
const noop = () => {};
const find = (entries, p) => entries.find((e) => e.path === p);
const text = (entry) => entry.content.toString();

test('the shipped harness is valid', () => {
  const { errors } = validateBundle(bundle);
  assert.deepEqual(errors, []);
});

test('every target installs and packages without throwing', () => {
  for (const target of Object.values(TARGETS)) {
    for (const scope of ['project', 'user']) {
      const { root, entries } = target.install(bundle, { scope, dir: '/project', warn: noop });
      assert.ok(root, `${target.id} ${scope} root`);
      assert.ok(entries.length, `${target.id} ${scope} entries`);
      for (const e of entries) assert.ok(!path.isAbsolute(e.path) && !e.path.includes('..'), e.path);
    }
    assert.ok(target.package(bundle, { warn: noop }).entries.length);
  }
});

test('claude: commands and agents get mapped tool names', () => {
  const { entries } = TARGETS.claude.install(bundle, { scope: 'project', dir: '/p', warn: noop });
  const review = parseFrontmatter(text(find(entries, '.claude/commands/review.md')));
  assert.equal(review.data['allowed-tools'], 'Read, Grep, Glob, Bash');
  const agent = parseFrontmatter(text(find(entries, '.claude/agents/researcher.md')));
  assert.equal(agent.data.name, 'researcher');
  assert.equal(agent.data.model, 'haiku');
  assert.deepEqual(find(entries, '.mcp.json').value.mcpServers.fetch, { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] });
});

test('claude: package is a plugin that injects instructions via a SessionStart hook', () => {
  const { entries } = TARGETS.claude.package(bundle, { warn: noop });
  const plugin = JSON.parse(text(find(entries, '.claude-plugin/plugin.json')));
  assert.equal(plugin.name, bundle.name);
  assert.ok(find(entries, 'hooks/hooks.json'));
  assert.ok(find(entries, 'skills/code-review/scripts/changed-files.sh').executable);
});

test('gemini: commands become TOML with {{args}}', () => {
  const { entries } = TARGETS.gemini.install(bundle, { scope: 'project', dir: '/p', warn: noop });
  const toml = text(find(entries, '.gemini/commands/review.toml'));
  assert.match(toml, /^description = "Review/);
  assert.match(toml, /review \{\{args\}\}\./);
  assert.ok(!toml.includes('$ARGUMENTS'));
});

test('opencode: env references and tool maps are converted', () => {
  const custom = { ...bundle, mcp: [{ name: 'api', url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } }] };
  const { entries } = TARGETS.opencode.install(custom, { scope: 'project', dir: '/p', warn: noop });
  assert.deepEqual(find(entries, 'opencode.json').value.mcp.api, {
    type: 'remote', url: 'https://x', enabled: true, headers: { Authorization: 'Bearer {env:TOKEN}' },
  });
  const agent = parseFrontmatter(text(find(entries, '.opencode/agents/researcher.md')));
  assert.equal(agent.data.mode, 'subagent');
  assert.equal(agent.data.tools.bash, false);
  assert.equal(agent.data.tools.read, undefined);
});

test('pi: skips MCP and agents with warnings, rewrites $ARGUMENTS', () => {
  const warnings = [];
  const { entries } = TARGETS.pi.install(bundle, { scope: 'project', dir: '/p', warn: (w) => warnings.push(w) });
  assert.ok(warnings.some((w) => w.includes('mcp')) && warnings.some((w) => w.includes('agents')));
  assert.match(text(find(entries, '.pi/prompts/review.md')), /review \$@\./);
});

test('codex: env refs become env_vars / bearer tokens', () => {
  const toml = mcpToml([
    { name: 'local', command: 'srv', args: ['--x'], env: { API_KEY: '${API_KEY}', MODE: 'fast' } },
    { name: 'remote.api', url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Org': '${ORG}' } },
  ]);
  assert.match(toml, /\[mcp_servers\.local\]\ncommand = "srv"\nargs = \["--x"\]\nenv_vars = \["API_KEY"\]/);
  assert.match(toml, /\[mcp_servers\.local\.env\]\nMODE = "fast"/);
  assert.match(toml, /\[mcp_servers\."remote\.api"\]\nurl = "https:\/\/x"\nbearer_token_env_var = "TOKEN"/);
  assert.match(toml, /env_http_headers\]\nX-Org = "ORG"/);
});

test('per-item targets filter restricts output', () => {
  const custom = { ...bundle, commands: [{ ...bundle.commands[0], meta: { ...bundle.commands[0].meta, targets: ['gemini'] } }] };
  const claude = TARGETS.claude.install(custom, { scope: 'project', dir: '/p', warn: noop }).entries;
  const gemini = TARGETS.gemini.install(custom, { scope: 'project', dir: '/p', warn: noop }).entries;
  assert.ok(!claude.some((e) => e.path.startsWith('.claude/commands/')));
  assert.ok(gemini.some((e) => e.path.startsWith('.gemini/commands/')));
});

test('resolveTargets honours "all", bundle defaults and rejects unknown ids', () => {
  assert.deepEqual(resolveTargets(['all'], bundle).map((t) => t.id), Object.keys(TARGETS));
  assert.deepEqual(resolveTargets([], bundle).map((t) => t.id), bundle.manifest.targets);
  assert.throws(() => resolveTargets(['nope'], bundle), /Unknown target/);
});

test('validation catches common mistakes', () => {
  const broken = {
    ...bundle,
    manifest: { ...bundle.manifest, name: 'Bad Name' },
    skills: [{ name: 'x', meta: { name: 'y' }, files: [] }],
    mcp: [{ name: 'm' }],
  };
  const { errors } = validateBundle(broken);
  assert.ok(errors.some((e) => e.includes('bundle.json')));
  assert.ok(errors.some((e) => e.includes('must equal the directory name')));
  assert.ok(errors.some((e) => e.includes('"description" is required')));
  assert.ok(errors.some((e) => e.includes('"command"')));
});
