import { realpathSync } from 'node:fs';
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
 * Each root gets its own manifest per scope; groups that resolve to the same directory are merged so they share one.
 * `layouts` is `{ user, project }`, the paths each scope writes in the same root, or undefined when the other scope
 * does not use that root (Claude Code: both scopes use ~); the writer uses it to tell whose a manifest written by
 * 0.2.0 is. The paths come from this harness and from a copy that always has instructions and an MCP server, so a
 * path only one scope writes (CLAUDE.md, .mcp.json) is known even when the harness has neither. Roots are compared
 * by real path: the working directory is one, while the home directory may be reached through a symlink.
 */
export function installRoots(target, bundle, ctx) {
  const groups = (b, c) => {
    const byRoot = new Map();
    for (const { root, entries } of [target.install(b, c)].flat()) {
      const abs = path.resolve(root);
      byRoot.set(abs, [...(byRoot.get(abs) ?? []), ...entries]);
    }
    return [...byRoot].map(([root, entries]) => ({ root, entries }));
  };
  const probe = { ...bundle, instructions: bundle.instructions || '-', mcp: [...(bundle.mcp ?? []), { name: 'agentic-bundle-probe', command: 'probe' }] };
  const quiet = { ...ctx, warn: () => {} };
  // Every path a scope writes in `root`, or undefined when it has no group there.
  const at = (root, c) => {
    const found = [bundle, probe].flatMap((b) => groups(b, c)).filter((g) => sameDir(g.root, root));
    return found.length ? [...new Set(found.flatMap((g) => g.entries.map((e) => e.path)))] : undefined;
  };
  const otherScope = ctx.scope === 'user' ? 'project' : 'user';
  return groups(bundle, ctx).map((g) => {
    const theirs = at(g.root, { ...quiet, scope: otherScope, dir: g.root });
    if (!theirs) return g;
    const mine = at(g.root, quiet);
    return { ...g, layouts: ctx.scope === 'user' ? { user: mine, project: theirs } : { user: theirs, project: mine } };
  });
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const sameDir = (a, b) => a === b || real(a) === real(b);

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
