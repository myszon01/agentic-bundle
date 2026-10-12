import path from 'node:path';
import claude from './claude.js';
import codex from './codex.js';
import opencode from './opencode.js';
import pi from './pi.js';

// To add a tool, write an adapter with { id, label, supports, install, package, npmUsage } and register it here.
export const TARGETS = Object.fromEntries([claude, opencode, pi, codex].map((t) => [t.id, t]));

// Targets that used to exist. Asking for one by name is an error with this reason; a bundle that still
// lists one in its default targets gets a warning and the target is skipped.
export const REMOVED_TARGETS = {
  gemini: 'Gemini CLI support was removed in 0.2.0 (Google retired Gemini CLI for most plans in June 2026). '
    + 'To remove files installed by an earlier version, run: npx -y @myszon01/agentic-bundle@0.1.0 uninstall gemini --source <your harness folder>',
};

/**
 * `install()` returns `{ root, entries }`, or a list of them when a tool reads files from several directories.
 * Each root gets its own manifest; groups that resolve to the same directory are merged so they share one.
 */
export function installRoots(target, bundle, ctx) {
  const byRoot = new Map();
  for (const { root, entries } of [target.install(bundle, ctx)].flat()) {
    const abs = path.resolve(root);
    byRoot.set(abs, [...(byRoot.get(abs) ?? []), ...entries]);
  }
  return [...byRoot].map(([root, entries]) => ({ root, entries }));
}

export function resolveTargets(names, bundle, warn = () => {}) {
  const fromBundle = !names.length;
  const requested = fromBundle ? bundle?.manifest.targets ?? Object.keys(TARGETS) : names;
  let ids = requested.includes('all') ? Object.keys(TARGETS) : requested;
  for (const id of ids) {
    if (REMOVED_TARGETS[id] && fromBundle) warn(`skipping "${id}" from bundle.json targets. ${REMOVED_TARGETS[id]}`);
    else if (REMOVED_TARGETS[id]) throw new Error(REMOVED_TARGETS[id]);
    else if (!TARGETS[id]) throw new Error(`Unknown target "${id}". Known targets: ${Object.keys(TARGETS).join(', ')}`);
  }
  ids = ids.filter((id) => TARGETS[id]);
  return ids.map((id) => TARGETS[id]);
}
