// Helpers shared by target adapters.
//
// An adapter turns a loaded bundle into a list of entries, all with paths
// relative to an install/package root (install may return several roots, see installRoots in index.js):
//   { type: 'file',  path, content, executable? }  whole file owned by the bundle
//   { type: 'block', path, content, syntax }       managed block inside a shared file ('md' | 'toml')
//   { type: 'json',  path, value, owns }           keys merged into a shared JSON file;
//                                                  `owns` lists the key paths the bundle owns

import os from 'node:os';
import path from 'node:path';

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

export function homeDir() {
  return process.env.AGENTIC_BUNDLE_HOME || os.homedir();
}

export function skillFiles(bundle, baseDir) {
  return bundle.skills.flatMap((skill) =>
    skill.files.map((f) => ({
      type: 'file',
      path: `${baseDir}/${skill.name}/${f.rel}`,
      content: f.content,
      executable: Boolean(f.mode & 0o111),
    })),
  );
}

export function instructionsBlock(bundle, filePath) {
  if (!bundle.instructions) return [];
  return [{ type: 'block', path: filePath, content: bundle.instructions.trim(), syntax: 'md' }];
}

export function selected(items, target) {
  return items.filter((item) => appliesTo(item, target));
}

/** Agent frontmatter fields defined by the harness format (docs/authoring.md). */
export const AGENT_FIELDS = ['name', 'description', 'tools', 'model', 'mode', 'targets'];

/** Clean frontmatter fields that are only meaningful to agentic-bundle itself. */
export function stripInternal(meta) {
  const { targets, ...rest } = meta;
  return rest;
}

export function normalizeBody(body) {
  return `${body.replace(/^\n+/, '').trimEnd()}\n`;
}

/** Warn once per unsupported feature that the bundle actually uses. */
export function warnUnsupported(bundle, target, label, features, warn) {
  const used = {
    agents: selected(bundle.agents, target).length,
    commands: selected(bundle.commands, target).length,
    mcp: selected(bundle.mcp, target).length,
    skills: bundle.skills.length,
  };
  for (const [feature, reason] of Object.entries(features)) {
    if (used[feature]) warn(`${label}: ${used[feature]} ${feature} skipped (${reason})`);
  }
}

export function xdgConfig() {
  return process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
}

/** A TOML string; multi-line literal when possible so prompts stay readable. */
export function tomlString(s) {
  if (!s.includes("'''") && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return `'''\n${s}'''`;
  return JSON.stringify(s);
}
