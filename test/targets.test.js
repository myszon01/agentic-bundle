import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle, validateBundle } from '../lib/bundle.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { mcpToml } from '../lib/targets/codex.js';
import { TARGETS, resolveTargets } from '../lib/targets/index.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'harness');
const bundle = await loadBundle(HARNESS);
const noop = () => {};
const find = (entries, p) => entries.find((e) => e.path === p);
const text = (entry) => entry.content.toString();

test('the fixture harness and your harness/ are valid', async () => {
  assert.deepEqual(validateBundle(bundle).errors, []);
  const own = await loadBundle(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness'));
  assert.deepEqual(validateBundle(own).errors, []);
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

test('opencode: env references and agent permissions are converted', () => {
  const custom = { ...bundle, mcp: [{ name: 'api', url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } }] };
  const { entries } = TARGETS.opencode.install(custom, { scope: 'project', dir: '/p', warn: noop });
  assert.deepEqual(find(entries, 'opencode.json').value.mcp.api, {
    type: 'remote', url: 'https://x', enabled: true, headers: { Authorization: 'Bearer {env:TOKEN}' },
  });
  const agent = parseFrontmatter(text(find(entries, '.opencode/agents/researcher.md')));
  assert.equal(agent.data.mode, 'subagent');
  assert.deepEqual(agent.data.permission, { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' });
  assert.equal(Object.keys(agent.data.permission)[0], '*', 'deny-all must come first (last rule wins)');
});

test('pi: skips MCP and agents with warnings, keeps $ARGUMENTS (pi supports it natively)', () => {
  const warnings = [];
  const { entries } = TARGETS.pi.install(bundle, { scope: 'project', dir: '/p', warn: (w) => warnings.push(w) });
  assert.ok(warnings.some((w) => w.includes('mcp')) && warnings.some((w) => w.includes('agents')));
  assert.match(text(find(entries, '.pi/prompts/review.md')), /review \$ARGUMENTS\./);
});

test('codex: skills go to .agents/skills and agents become TOML files', () => {
  const project = TARGETS.codex.install(bundle, { scope: 'project', dir: '/p', warn: noop }).entries;
  assert.ok(find(project, '.agents/skills/code-review/SKILL.md'));
  const agent = text(find(project, '.codex/agents/researcher.toml'));
  assert.match(agent, /^name = "researcher"\ndescription = "Read-only/);
  assert.match(agent, /developer_instructions = '''\nYou are a read-only research agent/);
  assert.ok(!/^model/m.test(agent), 'claude-only model must not leak into codex');
  const user = TARGETS.codex.install(bundle, { scope: 'user', dir: '/p', warn: noop }).entries;
  assert.ok(find(user, 'skills/code-review/SKILL.md') && find(user, 'agents/researcher.toml'));
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
  const custom = { ...bundle, commands: [{ ...bundle.commands[0], meta: { ...bundle.commands[0].meta, targets: ['opencode'] } }] };
  const claude = TARGETS.claude.install(custom, { scope: 'project', dir: '/p', warn: noop }).entries;
  const opencode = TARGETS.opencode.install(custom, { scope: 'project', dir: '/p', warn: noop }).entries;
  assert.ok(!claude.some((e) => e.path.startsWith('.claude/commands/')));
  assert.ok(opencode.some((e) => e.path.startsWith('.opencode/commands/')));
});

test('resolveTargets honours "all", bundle defaults and rejects unknown ids', () => {
  assert.deepEqual(resolveTargets(['all'], bundle).map((t) => t.id), Object.keys(TARGETS));
  assert.deepEqual(resolveTargets([], bundle).map((t) => t.id), bundle.manifest.targets);
  assert.throws(() => resolveTargets(['nope'], bundle), /Unknown target/);
});

test('removed targets: named is an error, a bundle default is skipped with a warning', () => {
  assert.throws(() => resolveTargets(['gemini'], bundle), /Gemini CLI support was removed/);
  const old = { ...bundle, manifest: { ...bundle.manifest, targets: ['claude', 'gemini'] } };
  const warnings = [];
  assert.deepEqual(resolveTargets([], old, (m) => warnings.push(m)).map((t) => t.id), ['claude']);
  assert.match(warnings[0], /skipping "gemini"/);
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

test('validation rejects unknown per-item target ids and lists the known ones', () => {
  const agent = bundle.agents[0];
  const custom = {
    ...bundle,
    manifest: { ...bundle.manifest, targets: ['claude', 'opencod'] },
    commands: [{ ...bundle.commands[0], meta: { ...bundle.commands[0].meta, targets: ['claud', 'opencode'] } }],
    agents: [{ ...agent, meta: { ...agent.meta, targets: 'codx' } }],
    mcp: [{ name: 'fetch', command: 'uvx', targets: ['claude', 'gemini'] }, { name: 'web', url: 'https://x', targets: ['all'] }],
  };
  const { errors, warnings } = validateBundle(custom);
  const known = `known targets: ${Object.keys(TARGETS).join(', ')}`;
  assert.ok(errors.includes(`commands/${bundle.commands[0].name}.md: unknown target "claud" in "targets" (${known})`), errors.join('\n'));
  assert.ok(errors.includes(`agents/${agent.name}.md: unknown target "codx" in "targets" (${known})`));
  assert.ok(errors.some((e) => e.startsWith('mcp.json: server "web": "all" is not allowed in "targets"')));
  assert.ok(errors.includes(`bundle.json: unknown target "opencod" in "targets" (${known})`));
  assert.ok(!errors.some((e) => e.includes('"gemini"')), 'a removed target is a warning, not an error');
  assert.ok(warnings.some((w) => w.includes('mcp.json: server "fetch": target "gemini" is no longer supported')));
});

test('model warnings: OpenCode needs provider/model, Codex ignores a plain model string', () => {
  const agent = { name: 'helper', meta: { description: 'Helps', model: 'sonnet' }, body: 'Help.\n' };
  const command = { name: 'go', meta: { description: 'Go', model: { default: 'haiku' } }, body: 'Go.\n' };
  const custom = { ...bundle, agents: [agent], commands: [command] };
  const collect = (target, ctx = {}) => {
    const warnings = [];
    TARGETS[target].install(custom, { scope: 'user', dir: '/p', warn: (w) => warnings.push(w), ...ctx });
    return warnings;
  };

  const opencode = collect('opencode');
  assert.ok(opencode.some((w) => /^OpenCode: agents\/helper\.md: model "sonnet" has no provider prefix/.test(w)), opencode.join('\n'));
  assert.ok(opencode.some((w) => /^OpenCode: commands\/go\.md: model "haiku"/.test(w)));
  const codex = collect('codex');
  assert.ok(codex.some((w) => /^Codex: agents\/helper\.md: model "sonnet" is not used for Codex/.test(w)), codex.join('\n'));
  assert.deepEqual(collect('claude'), []);

  const fine = { ...custom, agents: [{ ...agent, meta: { ...agent.meta, model: { claude: 'sonnet', opencode: 'anthropic/fake-model-1', codex: 'fake-codex-model' } } }], commands: [] };
  for (const target of ['opencode', 'codex']) {
    const warnings = [];
    TARGETS[target].install(fine, { scope: 'user', dir: '/p', warn: (w) => warnings.push(w) });
    assert.ok(!warnings.some((w) => w.includes('model')), `${target}: ${warnings.join('\n')}`);
  }
});

test('claude: warns about agent frontmatter fields it does not carry over', () => {
  const agent = {
    name: 'hooked',
    meta: {
      description: 'Has hooks', tools: ['read'], mode: 'subagent', targets: ['claude'], color: 'blue',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }] },
    },
    body: 'Prompt.\n',
  };
  const custom = { ...bundle, agents: [agent] };
  for (const run of [
    (warn) => TARGETS.claude.install(custom, { scope: 'project', dir: '/p', warn }),
    (warn) => TARGETS.claude.package(custom, { warn }),
  ]) {
    const warnings = [];
    const { entries } = run((w) => warnings.push(w));
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /^Claude Code: agents\/hooked\.md: "color", "hooks" not written/);
    const file = entries.find((e) => e.path.endsWith('agents/hooked.md'));
    assert.deepEqual(Object.keys(parseFrontmatter(text(file)).data), ['name', 'description', 'tools']);
  }
});
