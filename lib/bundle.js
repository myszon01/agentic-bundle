// Loads the canonical harness source (see docs/authoring.md for the format).

import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { SCOPE } from './npm.js';
import { REMOVED_TARGETS, TARGETS } from './targets/index.js';
import { CANONICAL_TOOLS } from './tools.js';

export async function loadBundle(dir) {
  const root = path.resolve(dir);
  const manifestPath = path.join(root, 'bundle.json');
  if (!existsSync(manifestPath)) throw new Error(`No bundle.json found in ${root}`);
  const manifest = await readJson(manifestPath);

  const instructionsPath = path.join(root, 'AGENTS.md');
  const instructions = existsSync(instructionsPath) ? await readText(instructionsPath) : null;

  return {
    root,
    manifest,
    name: manifest.name,
    version: manifest.version ?? '0.0.0',
    instructions,
    skills: await loadSkills(path.join(root, 'skills')),
    commands: await loadMarkdownDir(path.join(root, 'commands')),
    agents: await loadMarkdownDir(path.join(root, 'agents')),
    mcp: await loadMcp(path.join(root, 'mcp.json')),
  };
}

async function loadSkills(dir) {
  if (!existsSync(dir)) return [];
  const skills = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(byName)) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(dir, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const { data } = await readMarkdown(skillFile);
    skills.push({ name: entry.name, meta: data, files: await readTree(skillDir) });
  }
  return skills;
}

async function loadMarkdownDir(dir) {
  if (!existsSync(dir)) return [];
  const items = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(byName)) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.toLowerCase() === 'readme.md') continue;
    const { data, body } = await readMarkdown(path.join(dir, entry.name));
    items.push({ name: data.name ?? entry.name.slice(0, -3), meta: data, body });
  }
  return items;
}

async function loadMcp(file) {
  if (!existsSync(file)) return [];
  const json = await readJson(file);
  return Object.entries(json.servers ?? json.mcpServers ?? {}).map(([name, cfg]) => ({ name, ...cfg }));
}

// Every parse error names the file it came from. A leading UTF-8 byte order mark is ignored.

async function readText(file) {
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
}

async function parsing(file, parse) {
  const text = await readText(file);
  try {
    return parse(text);
  } catch (err) {
    const rel = path.relative(process.cwd(), file);
    const where = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
    throw new Error(`${where}: ${err.message}`, { cause: err });
  }
}

const readJson = (file) => parsing(file, JSON.parse);
const readMarkdown = (file) => parsing(file, parseFrontmatter);

async function readTree(dir, prefix = '') {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(byName)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await readTree(abs, rel)));
    else if (entry.isFile()) out.push({ rel, content: await readFile(abs), mode: (await stat(abs)).mode });
  }
  return out;
}

const byName = (a, b) => a.name.localeCompare(b.name);

// Kept here for compatibility; they live with the adapters so that targets never import the loader.
export { appliesTo, perTarget } from './targets/common.js';

// ---------------------------------------------------------------- validation

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Per-item `targets` must name known targets; a typo would silently drop the item everywhere. */
function checkTargets(where, targets, errors, warnings) {
  if (targets === undefined || targets === null) return;
  const known = Object.keys(TARGETS);
  for (const id of Array.isArray(targets) ? targets : [targets]) {
    if (Object.hasOwn(REMOVED_TARGETS, id)) warnings.push(`${where}: target "${id}" is no longer supported; it is ignored`);
    else if (id === 'all') errors.push(`${where}: "all" is not allowed in "targets"; omit "targets" to include every target`);
    else if (!known.includes(id)) errors.push(`${where}: unknown target "${id}" in "targets" (known targets: ${known.join(', ')})`);
  }
}

export function validateBundle(bundle) {
  const errors = [];
  const warnings = [];
  const { manifest } = bundle;

  if (!manifest.name || !SKILL_NAME.test(manifest.name)) {
    errors.push('bundle.json: "name" is required and must be kebab-case (lowercase letters, digits, hyphens)');
  }
  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push(`bundle.json: "version" must be semver, got "${manifest.version}"`);
  }
  if (manifest.npm?.scope && !SCOPE.test(manifest.npm.scope)) {
    errors.push(`bundle.json: "npm.scope" must look like "@name", got "${manifest.npm.scope}"`);
  }
  for (const id of [manifest.targets ?? []].flat()) {
    if (id !== 'all' && !Object.hasOwn(TARGETS, id) && !Object.hasOwn(REMOVED_TARGETS, id)) {
      errors.push(`bundle.json: unknown target "${id}" in "targets" (known targets: ${Object.keys(TARGETS).join(', ')})`);
    }
  }
  if (!bundle.instructions) warnings.push('AGENTS.md is missing: no shared instructions will be installed');

  for (const skill of bundle.skills) {
    const where = `skills/${skill.name}/SKILL.md`;
    if (!SKILL_NAME.test(skill.name) || skill.name.length > 64) {
      errors.push(`${where}: directory name must be kebab-case and at most 64 characters`);
    }
    if (skill.meta.name !== skill.name) errors.push(`${where}: frontmatter "name" must equal the directory name "${skill.name}"`);
    if (!skill.meta.description) errors.push(`${where}: frontmatter "description" is required`);
    else if (String(skill.meta.description).length > 1024) errors.push(`${where}: "description" must be at most 1024 characters`);
  }

  for (const [kind, items] of [['commands', bundle.commands], ['agents', bundle.agents]]) {
    const seen = new Set();
    for (const item of items) {
      const where = `${kind}/${item.name}.md`;
      if (!SKILL_NAME.test(item.name)) errors.push(`${where}: name must be kebab-case`);
      if (seen.has(item.name)) errors.push(`${where}: duplicate name "${item.name}"`);
      seen.add(item.name);
      if (!item.meta.description) errors.push(`${where}: frontmatter "description" is required`);
      if (!item.body.trim()) errors.push(`${where}: body (the prompt) is empty`);
      checkTargets(where, item.meta.targets, errors, warnings);
      for (const tool of item.meta.tools ?? []) {
        if (!CANONICAL_TOOLS.includes(tool)) {
          warnings.push(`${where}: tool "${tool}" is not canonical (${CANONICAL_TOOLS.join(', ')}); it is passed through unchanged`);
        }
      }
    }
  }

  for (const server of bundle.mcp) {
    const where = `mcp.json: server "${server.name}"`;
    if (!server.command && !server.url) errors.push(`${where} needs either "command" (stdio) or "url" (remote)`);
    if (server.command && server.url) errors.push(`${where} must not set both "command" and "url"`);
    if (server.args && !Array.isArray(server.args)) errors.push(`${where}: "args" must be an array`);
    checkTargets(where, server.targets, errors, warnings);
  }

  return { errors, warnings };
}
