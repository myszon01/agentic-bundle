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
