// Claude Code — https://code.claude.com/docs
//   project: CLAUDE.md, .claude/{skills,commands,agents}/, .mcp.json
//   user:    ~/.claude/{CLAUDE.md,skills,commands,agents}/, ~/.claude.json (mcpServers)
//   package: a Claude Code plugin (+ single-plugin marketplace.json)

import { stringifyFrontmatter } from '../frontmatter.js';
import { mapTools } from '../tools.js';
import { fetchSnippet } from '../npm.js';
import { AGENT_FIELDS, homeDir, instructionsBlock, normalizeBody, perTarget, selected, skillFiles, stripInternal } from './common.js';

const ID = 'claude';

function command(cmd) {
  const meta = stripInternal(cmd.meta);
  const tools = mapTools(meta.tools, ID);
  return stringifyFrontmatter(
    {
      description: meta.description,
      'argument-hint': meta['argument-hint'],
      'allowed-tools': tools?.join(', '),
      model: perTarget(meta.model, ID),
    },
    normalizeBody(cmd.body),
  );
}

function agent(a, warn) {
  const meta = stripInternal(a.meta);
  const dropped = Object.keys(meta).filter((k) => !AGENT_FIELDS.includes(k));
  if (dropped.length) {
    warn(`Claude Code: agents/${a.name}.md: ${dropped.map((k) => `"${k}"`).join(', ')} not written `
      + '(only name, description, tools and model are carried over to the subagent file)');
  }
  return stringifyFrontmatter(
    {
      name: a.name,
      description: meta.description,
      tools: mapTools(meta.tools, ID)?.join(', '),
      model: perTarget(meta.model, ID),
    },
    normalizeBody(a.body),
  );
}

export function mcpServer(server) {
  if (server.url) {
    return { type: server.transport ?? 'http', url: server.url, ...(server.headers && { headers: server.headers }) };
  }
  return {
    type: 'stdio',
    command: server.command,
    args: server.args ?? [],
    ...(server.env && { env: server.env }),
  };
}

function mcpServers(bundle) {
  return Object.fromEntries(selected(bundle.mcp, ID).map((s) => [s.name, mcpServer(s)]));
}

function components(bundle, base, warn) {
  return [
    ...skillFiles(bundle, `${base}skills`),
    ...selected(bundle.commands, ID).map((c) => ({ type: 'file', path: `${base}commands/${c.name}.md`, content: command(c) })),
    ...selected(bundle.agents, ID).map((a) => ({ type: 'file', path: `${base}agents/${a.name}.md`, content: agent(a, warn) })),
  ];
}

export default {
  id: ID,
  label: 'Claude Code',
  supports: { instructions: true, skills: true, commands: true, agents: true, mcp: true },

  install(bundle, { scope, dir, warn = () => {} }) {
    const user = scope === 'user';
    const servers = mcpServers(bundle);
    const entries = [
      ...instructionsBlock(bundle, user ? '.claude/CLAUDE.md' : 'CLAUDE.md'),
      ...components(bundle, '.claude/', warn),
    ];
    if (Object.keys(servers).length) {
      entries.push({
        type: 'json',
        path: user ? '.claude.json' : '.mcp.json',
        value: { mcpServers: servers },
        owns: Object.keys(servers).map((n) => ['mcpServers', n]),
      });
    }
    return { root: user ? homeDir() : dir, entries };
  },

  package(bundle, { npm, warn = () => {} } = {}) {
    const { manifest } = bundle;
    const servers = mcpServers(bundle);
    const plugin = {
      name: bundle.name,
      version: bundle.version,
      description: manifest.description,
      author: manifest.author,
      homepage: manifest.homepage,
      repository: manifest.repository,
      license: manifest.license,
      keywords: manifest.keywords,
    };
    const entries = [
      { type: 'file', path: '.claude-plugin/plugin.json', content: json(plugin) },
      {
        type: 'file',
        path: '.claude-plugin/marketplace.json',
        content: json({
          name: bundle.name,
          owner: manifest.author ?? { name: bundle.name },
          description: manifest.description,
          plugins: [{
            name: bundle.name,
            // Published to npm, the marketplace is added by URL, where relative sources don't resolve.
            source: npm ? { source: 'npm', package: npm.name, version: bundle.version } : './',
            description: manifest.description,
            version: bundle.version,
          }],
        }),
      },
      ...components(bundle, '', warn),
    ];
    if (Object.keys(servers).length) entries.push({ type: 'file', path: '.mcp.json', content: json({ mcpServers: servers }) });
    if (bundle.instructions) {
      // Plugins cannot ship CLAUDE.md, so inject the shared instructions at session start.
      entries.push({ type: 'file', path: 'AGENTS.md', content: bundle.instructions });
      entries.push({
        type: 'file',
        path: 'hooks/hooks.json',
        content: json({
          description: `Load ${bundle.name} instructions into context`,
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'cat "${CLAUDE_PLUGIN_ROOT}/AGENTS.md"' }] }],
          },
        }),
      });
    }
    return { entries };
  },

  npmUsage({ name, cli, bundle }) {
    return `Into your user config, without cloning anything:

\`\`\`bash
npx -y ${cli} install claude --scope user
\`\`\`

Or as a Claude Code plugin. This package is a plugin whose marketplace entry installs it from npm:

\`\`\`bash
${fetchSnippet(name)}
claude plugin marketplace add ./package
claude plugin install ${bundle.name}@${bundle.name}
\`\`\``;
  },
};

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
