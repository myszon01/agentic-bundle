// Canonical tool vocabulary used in harness/commands and harness/agents, and
// how each target names the same capability. Unknown names pass through as-is,
// so a bundle can still reference target-specific tools.

export const CANONICAL_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'list', 'webfetch', 'websearch', 'todo'];

const TOOL_NAMES = {
  claude: {
    read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', grep: 'Grep', glob: 'Glob',
    list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', todo: 'TodoWrite',
  },
  opencode: {
    read: 'read', write: 'write', edit: 'edit', bash: 'bash', grep: 'grep', glob: 'glob',
    list: 'list', webfetch: 'webfetch', websearch: 'websearch', todo: 'todowrite',
  },
  gemini: {
    read: 'read_file', write: 'write_file', edit: 'replace', bash: 'run_shell_command',
    grep: 'grep_search', glob: 'glob', list: 'list_directory', webfetch: 'web_fetch',
    websearch: 'google_web_search', todo: 'write_todos',
  },
  pi: { read: 'read', write: 'write', edit: 'edit', bash: 'bash', grep: 'grep', glob: 'find', list: 'ls' },
};

export function mapTools(tools, target) {
  if (!tools) return undefined;
  const table = TOOL_NAMES[target] ?? {};
  return [...new Set((Array.isArray(tools) ? tools : [tools]).map((t) => table[t] ?? t))];
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
