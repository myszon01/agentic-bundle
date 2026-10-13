import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBundle, validateBundle } from '../lib/bundle.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentic-bundle.js');

/** A throwaway harness made of the given files ({ 'agents/x.md': '...' }). */
function harness(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-bundle-harness-'));
  const all = { 'bundle.json': '{ "name": "made-up-bundle" }\n', ...files };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('frontmatter parse errors name the file they came from', async () => {
  const dir = harness({ 'agents/broken.md': '---\ndescription: "closed"\n    extra: 1\n---\nPrompt\n' });
  await assert.rejects(loadBundle(dir), (err) => {
    assert.ok(err.message.includes(path.join('agents', 'broken.md')), err.message);
    assert.match(err.message, /broken\.md: frontmatter: unexpected indentation on line 3$/);
    return true;
  });
  const skill = harness({ 'skills/bad-skill/SKILL.md': '---\nname: bad-skill\ndescription: x\nnot a key\n---\n' });
  await assert.rejects(loadBundle(skill), /skills[\\/]bad-skill[\\/]SKILL\.md: frontmatter: cannot parse line 4/);
});

test('JSON parse errors name the file they came from', async () => {
  await assert.rejects(loadBundle(harness({ 'bundle.json': '{ "name": ' })), /bundle\.json: /);
  await assert.rejects(loadBundle(harness({ 'mcp.json': '{ servers: {} }' })), /mcp\.json: /);
});

test('a UTF-8 byte order mark is ignored in bundle.json, AGENTS.md and frontmatter', async () => {
  const dir = harness({
    'bundle.json': '﻿{ "name": "bom-bundle" }\n',
    'AGENTS.md': '﻿# Rules\n',
    'commands/hello.md': '﻿---\ndescription: Say hello\n---\nSay hello.\n',
  });
  const bundle = await loadBundle(dir);
  assert.equal(bundle.name, 'bom-bundle');
  assert.equal(bundle.instructions, '# Rules\n');
  assert.equal(bundle.commands[0].meta.description, 'Say hello');
  assert.deepEqual(validateBundle(bundle).errors, []);
});

test('cli says which harness it uses when ./harness is missing', () => {
  const validate = (cwd) => spawnSync(process.execPath, [CLI, 'validate'], { cwd, encoding: 'utf8' });

  const fallback = validate(mkdtempSync(path.join(os.tmpdir(), 'agentic-bundle-cwd-')));
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stderr, /Using the harness bundled with .*; no \.\/harness\/bundle\.json in the current directory/);

  const project = mkdtempSync(path.join(os.tmpdir(), 'agentic-bundle-cwd-'));
  cpSync(harness({ 'commands/hello.md': '---\ndescription: Say hello\n---\nSay hello.\n' }), path.join(project, 'harness'), { recursive: true });
  const local = validate(project);
  assert.equal(local.status, 0, local.stderr);
  assert.ok(!local.stderr.includes('Using the harness bundled'), local.stderr);
  assert.match(local.stdout, /made-up-bundle@0\.0\.0 is valid/);
});

test('files a level too deep are reported instead of silently ignored', async () => {
  const skill = (name) => `---\nname: ${name}\ndescription: Does things\n---\nDo things.\n`;
  const dir = harness({
    'AGENTS.md': '# Rules\n',
    'commands/git/commit.md': '---\ndescription: Commit\n---\nCommit.\n',
    'commands/git/README.md': '# Notes\n',
    'agents/team/helper.md': '---\ndescription: Helps\n---\nHelp.\n',
    'skills/nested/inner/SKILL.md': skill('inner'),
    // ...and only that SKILL.md: the nested skill's own files are not reported as more skills.
    'skills/nested/inner/references/SKILL.md': skill('ref'),
    // Files inside a real skill are part of it (copied as they are), never reported.
    'skills/real-skill/SKILL.md': skill('real-skill'),
    'skills/real-skill/references/SKILL.md': skill('other'),
    'skills/real-skill/scripts/run.sh': 'echo hi\n',
  });
  const { errors, warnings } = validateBundle(await loadBundle(dir));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [
    'commands/git/commit.md is ignored: commands must sit directly in commands/; flatten it, e.g. commands/git-commit.md',
    'agents/team/helper.md is ignored: agents must sit directly in agents/; flatten it, e.g. agents/team-helper.md',
    'skills/nested/inner/SKILL.md is ignored: skills/nested/ has no SKILL.md, and skills are not looked for further down; '
      + 'move skills/nested/inner/ up to skills/inner/',
  ]);
});

test('an AGENTS.md over 32 KiB is reported when Codex is among the targets', async () => {
  const sized = async (bytes) => loadBundle(harness({ 'AGENTS.md': `# Rules\n${'x'.repeat(bytes - 8)}` }));
  const big = await sized(32 * 1024 + 1);
  const warns = (b, targets) => validateBundle({ ...b, manifest: { ...b.manifest, targets } }).warnings
    .filter((w) => w.includes('project_doc_max_bytes'));
  assert.deepEqual(warns(big, undefined), [
    'AGENTS.md is 32769 bytes: Codex reads only the first 32 KiB by default (project_doc_max_bytes) and silently cuts the rest; move details into skills',
  ]);
  assert.equal(warns(big, ['claude', 'codex']).length, 1);
  assert.equal(warns(big, ['all']).length, 1);
  assert.deepEqual(warns(big, ['claude', 'opencode']), []);
  assert.deepEqual(warns(await sized(32 * 1024), undefined), []);
});

test('secret-looking literals in mcp.json env and headers are reported by key, never by value', async () => {
  // Built at run time from obviously fake parts, so no scanner mistakes this file for a leak.
  const fake = (prefix, n) => `${prefix}${'0'.repeat(n)}`;
  const secrets = {
    GH: fake('gh' + 'p_', 36), PAT: fake('github_' + 'pat_', 40), OPENAI: fake('s' + 'k-', 40), ANTHROPIC: fake('sk-' + 'ant-', 40),
    SLACK: fake('xo' + 'xb-', 20), AWS: fake('AK' + 'IA', 16), GOOGLE: fake('AI' + 'za', 35), GITLAB: fake('gl' + 'pat-', 20),
    NPM: fake('np' + 'm_', 36), KEY: `-----BEGIN ${'PRIVATE'} KEY-----\nfake\n-----END PRIVATE KEY-----`,
  };
  const fine = {
    REF: '${GH_TOKEN}', MIXED: `${fake('gh' + 'p_', 36)}\${SUFFIX}`, MODE: 'fast', SHORT: 'sk-1', PLAIN: 'Basic mode',
    X: fake('gh' + 'p_xxxx', 32), ANGLE: 'Bearer <token>', YOURS: 'sk-your-key-goes-here-please', CHANGE: fake('changeme-gh' + 'p_', 36),
    AWS_DOCS: 'AKIA' + 'IOSFODNN7EXAMPLE',
  };
  const base = await loadBundle(harness({ 'AGENTS.md': '# Rules\n' }));
  const mcp = [
    { name: 'local', command: 'srv', env: { ...secrets, ...fine } },
    { name: 'remote', url: 'https://example.invalid/mcp', headers: { Authorization: `Bearer ${'0'.repeat(32)}`, 'X-Basic': 'Basic ZmFrZTpmYWtl', 'X-Ok': 'Bearer ${TOKEN}' } },
  ];
  const { errors, warnings } = validateBundle({ ...base, mcp });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [
    ...Object.keys(secrets).map((k) => `mcp.json: server "local": env "${k}" looks like a secret written literally; use \${VAR} and set it in the environment`),
    ...['Authorization', 'X-Basic'].map((k) => `mcp.json: server "remote": header "${k}" looks like a secret written literally; use \${VAR} and set it in the environment`),
  ]);
  for (const v of [...Object.values(secrets), 'ZmFrZTpmYWtl']) assert.ok(!warnings.join('\n').includes(v));
});
