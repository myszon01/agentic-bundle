// OpenCode — https://opencode.ai/docs
//   project: AGENTS.md, .opencode/{skills,commands,agents}/, opencode.json (mcp)
//   user:    ~/.config/opencode/{AGENTS.md,skills,commands,agents,opencode.json}
//   package: the project layout, ready to copy into a repository

import path from 'node:path';
import { perTarget } from '../bundle.js';
import { stringifyFrontmatter } from '../frontmatter.js';
import { opencodeToolMap, rewriteEnvRefs } from '../tools.js';
import { instructionsBlock, normalizeBody, selected, skillFiles, stripInternal, xdgConfig } from './common.js';

const ID = 'opencode';
const SCHEMA = 'https://opencode.ai/config.json';

function command(cmd) {
  const meta = stripInternal(cmd.meta);
  return stringifyFrontmatter(
    { description: meta.description, agent: perTarget(meta.agent, ID), model: perTarget(meta.model, ID) },
    normalizeBody(cmd.body),
  );
}

function agent(a) {
  const meta = stripInternal(a.meta);
  return stringifyFrontmatter(
    {
      description: meta.description,
      mode: perTarget(meta.mode, ID) ?? 'subagent',
      model: perTarget(meta.model, ID),
      tools: opencodeToolMap(meta.tools),
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

function layout(bundle, base, instructionsPath) {
  const servers = mcpServers(bundle);
  const entries = [
    ...instructionsBlock(bundle, instructionsPath),
    ...skillFiles(bundle, `${base}skills`),
    ...selected(bundle.commands, ID).map((c) => ({ type: 'file', path: `${base}commands/${c.name}.md`, content: command(c) })),
    ...selected(bundle.agents, ID).map((a) => ({ type: 'file', path: `${base}agents/${a.name}.md`, content: agent(a) })),
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

  install(bundle, { scope, dir }) {
    if (scope === 'user') return { root: path.join(xdgConfig(), 'opencode'), entries: layout(bundle, '', 'AGENTS.md') };
    return { root: dir, entries: layout(bundle, '.opencode/', 'AGENTS.md') };
  },

  package(bundle) {
    return { entries: layout(bundle, '.opencode/', 'AGENTS.md') };
  },
};
