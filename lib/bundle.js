// Loads the canonical harness source (see docs/authoring.md for the format).

import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { SCOPE } from './npm.js';
import { CANONICAL_TOOLS } from './tools.js';

export async function loadBundle(dir) {
  const root = path.resolve(dir);
  const manifestPath = path.join(root, 'bundle.json');
  if (!existsSync(manifestPath)) throw new Error(`No bundle.json found in ${root}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const instructionsPath = path.join(root, 'AGENTS.md');
  const instructions = existsSync(instructionsPath) ? await readFile(instructionsPath, 'utf8') : null;

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
    const { data } = parseFrontmatter(await readFile(skillFile, 'utf8'));
    skills.push({ name: entry.name, meta: data, files: await readTree(skillDir) });
  }
  return skills;
}

async function loadMarkdownDir(dir) {
  if (!existsSync(dir)) return [];
  const items = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(byName)) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.toLowerCase() === 'readme.md') continue;
    const { data, body } = parseFrontmatter(await readFile(path.join(dir, entry.name), 'utf8'));
    items.push({ name: data.name ?? entry.name.slice(0, -3), meta: data, body });
  }
  return items;
}

async function loadMcp(file) {
  if (!existsSync(file)) return [];
  const json = JSON.parse(await readFile(file, 'utf8'));
  return Object.entries(json.servers ?? json.mcpServers ?? {}).map(([name, cfg]) => ({ name, ...cfg }));
}

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

/** Whether an item (command, agent, MCP server) should be emitted for a target. */
export function appliesTo(item, target) {
  const targets = item.meta?.targets ?? item.targets;
  if (!targets) return true;
  return (Array.isArray(targets) ? targets : [targets]).includes(target);
}

/** Resolve a value that may be a plain value or a per-target map ({ claude: x, default: y }). */
export function perTarget(value, target) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value[target] ?? value.default;
  return value;
}

// ---------------------------------------------------------------- validation

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
  }

  return { errors, warnings };
}
