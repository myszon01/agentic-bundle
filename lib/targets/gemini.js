// Gemini CLI — https://github.com/google-gemini/gemini-cli
//   project: GEMINI.md, .gemini/{commands/*.toml,skills,agents}/, .gemini/settings.json (mcpServers)
//   user:    ~/.gemini/...
//   package: a Gemini CLI extension (gemini-extension.json)

import { perTarget } from '../bundle.js';
import { stringifyFrontmatter } from '../frontmatter.js';
import { mapTools } from '../tools.js';
import { homeDir, instructionsBlock, normalizeBody, selected, skillFiles, stripInternal, tomlString } from './common.js';

const ID = 'gemini';

function command(cmd) {
  const prompt = normalizeBody(cmd.body).replace(/\$ARGUMENTS\b/g, '{{args}}');
  const lines = [];
  if (cmd.meta.description) lines.push(`description = ${JSON.stringify(String(cmd.meta.description))}`);
  lines.push(`prompt = ${tomlString(prompt)}`);
  return `${lines.join('\n')}\n`;
}

function agent(a) {
  const meta = stripInternal(a.meta);
  return stringifyFrontmatter(
    {
      name: a.name,
      description: meta.description,
      kind: 'local',
      tools: mapTools(meta.tools, ID),
      model: perTarget(meta.model, ID),
    },
    normalizeBody(a.body),
  );
}

function mcpServer(server) {
  if (server.url) {
    const key = (server.transport ?? 'http') === 'sse' ? 'url' : 'httpUrl';
    return { [key]: server.url, ...(server.headers && { headers: server.headers }) };
  }
  return { command: server.command, args: server.args ?? [], ...(server.env && { env: server.env }), ...(server.cwd && { cwd: server.cwd }) };
}

function mcpServers(bundle) {
  return Object.fromEntries(selected(bundle.mcp, ID).map((s) => [s.name, mcpServer(s)]));
}

function components(bundle, base) {
  return [
    ...skillFiles(bundle, `${base}skills`),
    ...selected(bundle.commands, ID).map((c) => ({ type: 'file', path: `${base}commands/${c.name}.toml`, content: command(c) })),
    ...selected(bundle.agents, ID).map((a) => ({ type: 'file', path: `${base}agents/${a.name}.md`, content: agent(a) })),
  ];
}

export default {
  id: ID,
  label: 'Gemini CLI',
  supports: { instructions: true, skills: true, commands: true, agents: true, mcp: true },

  install(bundle, { scope, dir }) {
    const user = scope === 'user';
    const servers = mcpServers(bundle);
    const entries = [
      ...instructionsBlock(bundle, user ? '.gemini/GEMINI.md' : 'GEMINI.md'),
      ...components(bundle, '.gemini/'),
    ];
    if (Object.keys(servers).length) {
      entries.push({
        type: 'json',
        path: '.gemini/settings.json',
        value: { mcpServers: servers },
        owns: Object.keys(servers).map((n) => ['mcpServers', n]),
      });
    }
    return { root: user ? homeDir() : dir, entries };
  },

  package(bundle) {
    const servers = mcpServers(bundle);
    const extension = {
      name: bundle.name,
      version: bundle.version,
      description: bundle.manifest.description,
      ...(bundle.instructions && { contextFileName: 'GEMINI.md' }),
      ...(Object.keys(servers).length && { mcpServers: servers }),
    };
    return {
      entries: [
        { type: 'file', path: 'gemini-extension.json', content: `${JSON.stringify(extension, null, 2)}\n` },
        ...(bundle.instructions ? [{ type: 'file', path: 'GEMINI.md', content: bundle.instructions }] : []),
        ...components(bundle, ''),
      ],
    };
  },
};
