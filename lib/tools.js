// Canonical tool vocabulary used in harness/commands and harness/agents, and
// how each target names the same capability. A canonical name can map to several
// tools. Unknown names pass through as-is, so a bundle can still reference
// target-specific tools.

export const CANONICAL_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'list', 'webfetch', 'websearch', 'todo'];

const TOOL_NAMES = {
  claude: {
    read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', grep: 'Grep', glob: 'Glob',
    // Claude Code has no LS tool; directories are listed with Glob (or `ls` through Bash).
    list: 'Glob', webfetch: 'WebFetch', websearch: 'WebSearch',
    // TodoWrite is off by default in favour of the Task tools (CLAUDE_CODE_ENABLE_TASKS=0 brings it back),
    // so list both. Claude Code ignores names a session doesn't have.
    todo: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite'],
  },
  opencode: {
    read: 'read', write: 'write', edit: 'edit', bash: 'bash', grep: 'grep', glob: 'glob',
    list: 'list', webfetch: 'webfetch', websearch: 'websearch', todo: 'todowrite',
  },
  pi: { read: 'read', write: 'write', edit: 'edit', bash: 'bash', grep: 'grep', glob: 'find', list: 'ls' },
};

export function mapTools(tools, target) {
  if (!tools) return undefined;
  const table = TOOL_NAMES[target] ?? {};
  return [...new Set((Array.isArray(tools) ? tools : [tools]).flatMap((t) => table[t] ?? t))];
}

/**
 * OpenCode restricts agents through a `permission` map. Rules are matched last-wins, so deny
 * everything first and then allow the listed tools. The `edit` permission also covers write/patch.
 */
export function opencodePermission(tools) {
  if (!tools) return undefined;
  const permission = { '*': 'deny' };
  for (const name of mapTools(tools, 'opencode')) permission[name === 'write' ? 'edit' : name] = 'allow';
  return permission;
}

// ---------------------------------------------------------------- env vars
// Canonical MCP config uses ${VAR} for environment references.

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function envRefs(value) {
  return [...String(value).matchAll(ENV_REF)].map((m) => m[1]);
}

export function rewriteEnvRefs(value, fn) {
  if (typeof value === 'string') return value.replace(ENV_REF, (_, name) => fn(name));
  if (Array.isArray(value)) return value.map((v) => rewriteEnvRefs(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteEnvRefs(v, fn)]));
  }
  return value;
}
