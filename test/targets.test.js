import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle, validateBundle } from '../lib/bundle.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { mcpToml } from '../lib/targets/codex.js';
import { TARGETS, installRoots, resolveTargets } from '../lib/targets/index.js';
import { mapTools } from '../lib/tools.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'harness');
const bundle = await loadBundle(HARNESS);
const noop = () => {};
const find = (entries, p) => entries.find((e) => e.path === p);
const text = (entry) => entry.content.toString();

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('the fixture harness and your harness/ are valid', async () => {
  assert.deepEqual(validateBundle(bundle).errors, []);
  const own = await loadBundle(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness'));
  assert.deepEqual(validateBundle(own).errors, []);
});

test('every target installs and packages without throwing', () => {
  for (const target of Object.values(TARGETS)) {
    for (const scope of ['project', 'user']) {
      const groups = installRoots(target, bundle, { scope, dir: '/project', warn: noop });
      assert.ok(groups.flatMap((g) => g.entries).length, `${target.id} ${scope} entries`);
      for (const { root, entries } of groups) {
        assert.ok(path.isAbsolute(root), `${target.id} ${scope} root`);
        for (const e of entries) assert.ok(!path.isAbsolute(e.path) && !e.path.includes('..'), e.path);
      }
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
  assert.equal(agent.data.tools, 'Read, Grep, Glob', 'list maps to Glob (Claude Code has no LS tool)');
  assert.equal(agent.data.model, 'haiku');
  assert.deepEqual(find(entries, '.mcp.json').value.mcpServers.fetch, { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] });
});

test('claude: todo maps to the Task tools and TodoWrite, never to a missing LS tool', () => {
  assert.deepEqual(mapTools(['todo', 'read'], 'claude'), ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite', 'Read']);
  assert.deepEqual(mapTools(['list'], 'claude'), ['Glob']);
  assert.deepEqual(mapTools(['todo', 'list'], 'opencode'), ['todowrite', 'list']);
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

test('installRoots says what each scope writes in a root both use', () => {
  withEnv({ AGENTIC_BUNDLE_HOME: '/home/u', CODEX_HOME: '/home/u/.codex' }, () => {
    // Claude Code: a project install in ~ shares its root with the user install, and only there.
    const [inHome] = installRoots(TARGETS.claude, bundle, { scope: 'project', dir: '/home/u', warn: noop });
    assert.ok(inHome.layouts.user.includes('.claude/CLAUDE.md') && inHome.layouts.user.includes('.claude.json'));
    assert.ok(inHome.layouts.project.includes('CLAUDE.md') && inHome.layouts.project.includes('.mcp.json'));
    assert.equal(installRoots(TARGETS.claude, bundle, { scope: 'project', dir: '/p', warn: noop })[0].layouts, undefined);
    const [user] = installRoots(TARGETS.claude, bundle, { scope: 'user', dir: '/p', warn: noop });
    assert.ok(user.layouts.project.includes('CLAUDE.md') && user.layouts.project.includes('.mcp.json'), 'project layout at ~, whatever --dir is');
    // A harness without instructions or MCP servers still shows which paths only a project install writes.
    const bare = { ...bundle, instructions: null, mcp: [] };
    const [bareHome] = installRoots(TARGETS.claude, bare, { scope: 'project', dir: '/home/u', warn: noop });
    assert.ok(bareHome.layouts.project.includes('CLAUDE.md') && bareHome.layouts.project.includes('.mcp.json'));
    assert.ok(!bareHome.entries.some((e) => e.path === 'CLAUDE.md'), 'the probe adds nothing to what is installed');
    // Codex: the user roots are never a project install's root unless --dir points there.
    const codex = installRoots(TARGETS.codex, bundle, { scope: 'user', dir: '/p', warn: noop });
    assert.ok(codex.every((g) => g.layouts.project.includes('.agents/skills/code-review/SKILL.md')));
    assert.equal(installRoots(TARGETS.codex, bundle, { scope: 'project', dir: '/home/u', warn: noop })[0].layouts, undefined);
  });
});

test('installRoots matches roots by real path, so a symlinked home directory still counts as ~', () => {
  const real = mkdtempSync(path.join(os.tmpdir(), 'agentic-bundle-home-'));
  const link = `${real}-link`;
  symlinkSync(real, link);
  withEnv({ AGENTIC_BUNDLE_HOME: link }, () => {
    // The working directory is always a real path, while the home directory keeps its symlink spelling.
    const [inHome] = installRoots(TARGETS.claude, bundle, { scope: 'project', dir: realpathSync(real), warn: noop });
    assert.ok(inHome.layouts?.user.includes('.claude.json'));
  });
});

test('codex: skills go to .agents/skills and agents become TOML files', () => {
  const project = TARGETS.codex.install(bundle, { scope: 'project', dir: '/p', warn: noop }).entries;
  assert.ok(find(project, '.agents/skills/code-review/SKILL.md'));
  const agent = text(find(project, '.codex/agents/researcher.toml'));
  assert.match(agent, /^name = "researcher"\ndescription = "Read-only/);
  assert.match(agent, /developer_instructions = '''\nYou are a read-only research agent/);
  assert.ok(!/^model/m.test(agent), 'claude-only model must not leak into codex');
  const user = (env) => withEnv(env, () => installRoots(TARGETS.codex, bundle, { scope: 'user', dir: '/p', warn: noop }));
  const [codexHome, home] = user({ AGENTIC_BUNDLE_HOME: '/home/u', CODEX_HOME: '/home/u/.codex' });
  assert.equal(codexHome.root, '/home/u/.codex');
  assert.ok(find(codexHome.entries, 'agents/researcher.toml') && !codexHome.entries.some((e) => e.path.startsWith('skills/')));
  // Not ~ itself: the user skills root is ~/.agents.
  assert.equal(home.root, '/home/u/.agents');
  assert.deepEqual(home.entries.map((e) => e.path).filter((p) => p.endsWith('SKILL.md')).sort(),
    ['skills/code-review/SKILL.md', 'skills/conventional-commits/SKILL.md']);
  // CODEX_HOME set to the skills root: one root, so one manifest.
  assert.equal(user({ AGENTIC_BUNDLE_HOME: '/home/u', CODEX_HOME: '/home/u/.agents' }).length, 1);
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

test('codex: warns about env references it would write literally', () => {
  const warnings = [];
  mcpToml([
    { name: 'local', command: '${BIN_DIR}/srv', args: ['--token', '${TOKEN}', '--org=${ORG}', '${TOKEN}'], cwd: '${HOME}/x', env: { API_KEY: '${API_KEY}' } },
    { name: 'remote', url: 'https://x/${ORG}/mcp', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Org': '${ORG}' } },
    { name: 'clean', command: 'srv', args: ['--x'], env: { MODE: 'fast' } },
  ], (w) => warnings.push(w));
  const tail = (hint) => `which Codex does not expand, so it is written literally; ${hint}, or leave codex out of the server's "targets"`;
  assert.deepEqual(warnings, [
    `Codex: "command" of MCP server "local" uses \${BIN_DIR}, ${tail('write a literal path (or wrap the server in a script)')}`,
    `Codex: "args" of MCP server "local" uses \${TOKEN}, \${ORG}, ${tail('pass it through "env" if the server reads it from there')}`,
    `Codex: "cwd" of MCP server "local" uses \${HOME}, ${tail('write a literal path')}`,
    `Codex: "url" of MCP server "remote" uses \${ORG}, ${tail('move it into a header whose whole value is ${VAR} if the server accepts one')}`,
  ]);
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

test('model warnings: OpenCode needs provider/model, Codex ignores a plain model string and command models', () => {
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
  // Codex custom prompts have no model field at all: one warning per command, at install and at build.
  const dropped = 'Codex: commands/go.md: model is dropped (Codex custom prompts have no model field)';
  assert.equal(codex.filter((w) => w === dropped).length, 1, codex.join('\n'));
  const built = [];
  TARGETS.codex.package(custom, { warn: (w) => built.push(w) });
  assert.ok(built.includes(dropped), built.join('\n'));
  assert.deepEqual(collect('claude'), []);

  const fine = {
    ...custom,
    agents: [{ ...agent, meta: { ...agent.meta, model: { claude: 'sonnet', opencode: 'anthropic/fake-model-1', codex: 'fake-codex-model' } } }],
    commands: [{ ...command, meta: { ...command.meta, model: { claude: 'sonnet', opencode: 'anthropic/fake-model-1' } } }],
  };
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
