// OpenCode — https://opencode.ai/docs
//   project: AGENTS.md, .opencode/{skills,commands,agents}/, opencode.json (mcp)
//   user:    ~/.config/opencode/{AGENTS.md,skills,commands,agents,opencode.json}
//   package: the project layout, ready to copy into a repository

import path from 'node:path';
import { stringifyFrontmatter } from '../frontmatter.js';
import { opencodePermission, rewriteEnvRefs } from '../tools.js';
import { fetchSnippet } from '../npm.js';
import { instructionsBlock, normalizeBody, perTarget, selected, skillFiles, stripInternal, xdgConfig } from './common.js';

const ID = 'opencode';
const SCHEMA = 'https://opencode.ai/config.json';

/** OpenCode model ids are "provider/model-id"; a bare id such as "haiku" is written as-is, with a warning. */
function model(item, file, warn) {
  const id = perTarget(item.meta.model, ID);
  if (typeof id === 'string' && !id.includes('/')) {
    warn(`OpenCode: ${file}: model "${id}" has no provider prefix; OpenCode expects "provider/model-id" `
      + '(use a per-target map with an opencode key, e.g. model: { claude: haiku, opencode: anthropic/<model-id> })');
  }
  return id;
}

function command(cmd, warn) {
  const meta = stripInternal(cmd.meta);
  return stringifyFrontmatter(
    { description: meta.description, agent: perTarget(meta.agent, ID), model: model(cmd, `commands/${cmd.name}.md`, warn) },
    normalizeBody(cmd.body),
  );
}

function agent(a, warn) {
  const meta = stripInternal(a.meta);
  return stringifyFrontmatter(
    {
      description: meta.description,
      mode: perTarget(meta.mode, ID) ?? 'subagent',
      model: model(a, `agents/${a.name}.md`, warn),
      permission: opencodePermission(meta.tools),
    },
    normalizeBody(a.body),
  );
}

function mcpServer(server) {
  const s = rewriteEnvRefs(server, (name) => `{env:${name}}`);
  if (s.url) return { type: 'remote', url: s.url, enabled: true, ...(s.headers && { headers: s.headers }) };
  return { type: 'local', command: [s.command, ...(s.args ?? [])], enabled: true, ...(s.env && { environment: s.env }) };
}

function mcpServers(bundle) {
  return Object.fromEntries(selected(bundle.mcp, ID).map((s) => [s.name, mcpServer(s)]));
}

function layout(bundle, base, instructionsPath, warn) {
  const servers = mcpServers(bundle);
  const entries = [
    ...instructionsBlock(bundle, instructionsPath),
    ...skillFiles(bundle, `${base}skills`),
    ...selected(bundle.commands, ID).map((c) => ({ type: 'file', path: `${base}commands/${c.name}.md`, content: command(c, warn) })),
    ...selected(bundle.agents, ID).map((a) => ({ type: 'file', path: `${base}agents/${a.name}.md`, content: agent(a, warn) })),
  ];
  if (Object.keys(servers).length) {
    entries.push({
      type: 'json',
      path: 'opencode.json',
      value: { $schema: SCHEMA, mcp: servers },
      owns: Object.keys(servers).map((n) => ['mcp', n]),
    });
  }
  return entries;
}

export default {
  id: ID,
  label: 'OpenCode',
  supports: { instructions: true, skills: true, commands: true, agents: true, mcp: true },

  install(bundle, { scope, dir, warn = () => {} }) {
    if (scope === 'user') return { root: path.join(xdgConfig(), 'opencode'), entries: layout(bundle, '', 'AGENTS.md', warn) };
    return { root: dir, entries: layout(bundle, '.opencode/', 'AGENTS.md', warn) };
  },

  package(bundle, { warn = () => {} } = {}) {
    return { entries: layout(bundle, '.opencode/', 'AGENTS.md', warn) };
  },

  npmUsage({ name, cli }) {
    return `Into a project (run in its root), merging with any existing \`AGENTS.md\` and \`opencode.json\`:

\`\`\`bash
npx -y ${cli} install opencode
\`\`\`

Into your user config: add \`--scope user\`. To copy the files by hand instead (overwrites existing files):

\`\`\`bash
${fetchSnippet(name)}
cp -R package/.opencode package/AGENTS.md package/opencode.json /path/to/project/
\`\`\``;
  },
};
