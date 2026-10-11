import claude from './claude.js';
import codex from './codex.js';
import gemini from './gemini.js';
import opencode from './opencode.js';
import pi from './pi.js';

// To add a tool, write an adapter with { id, label, supports, install, package, npmUsage } and register it here.
export const TARGETS = Object.fromEntries([claude, opencode, gemini, pi, codex].map((t) => [t.id, t]));

export function resolveTargets(names, bundle) {
  const requested = !names.length ? bundle?.manifest.targets ?? Object.keys(TARGETS) : names;
  const ids = requested.includes('all') ? Object.keys(TARGETS) : requested;
  for (const id of ids) {
    if (!TARGETS[id]) throw new Error(`Unknown target "${id}". Known targets: ${Object.keys(TARGETS).join(', ')}`);
  }
  return ids.map((id) => TARGETS[id]);
}
