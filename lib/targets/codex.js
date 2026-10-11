// OpenAI Codex CLI — https://github.com/openai/codex
//   project: AGENTS.md, .agents/skills/, .codex/agents/*.toml, .codex/config.toml (mcp_servers; trusted projects only)
//   user:    ~/.codex/{AGENTS.md,skills,prompts,agents,config.toml}   ($CODEX_HOME)
//   package: the user layout, ready to merge into ~/.codex
// Custom prompts (commands) are user-scoped and deprecated in Codex in favour of skills.

import path from 'node:path';
import { envRefs } from '../tools.js';
import { stringifyFrontmatter } from '../frontmatter.js';
import { perTarget } from '../bundle.js';
import { fetchSnippet } from '../npm.js';
import { homeDir, instructionsBlock, normalizeBody, selected, skillFiles, stripInternal, tomlString, warnUnsupported } from './common.js';

const ID = 'codex';

const key = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const str = (v) => JSON.stringify(String(v));
const array = (vs) => `[${vs.map(str).join(', ')}]`;

/** Render mcp_servers tables. `${VAR}` references become env_vars / env_http_headers / bearer tokens. */
export function mcpToml(servers, warn) {
  const out = [];
  for (const s of servers) {
    const table = `mcp_servers.${key(s.name)}`;
    const lines = [`[${table}]`];
    const sub = [];
    if (s.url) {
      lines.push(`url = ${str(s.url)}`);
      const literal = {};
      const fromEnv = {};
      for (const [h, v] of Object.entries(s.headers ?? {})) {
        const bearer = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
        const whole = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
        if (h.toLowerCase() === 'authorization' && bearer) lines.push(`bearer_token_env_var = ${str(bearer[1])}`);
        else if (whole) fromEnv[h] = whole[1];
        else {
          if (envRefs(v).length) warn?.(`Codex: header "${h}" of MCP server "${s.name}" mixes text and env references; written literally`);
          literal[h] = v;
        }
      }
      if (Object.keys(literal).length) sub.push(table, 'http_headers', literal);
      if (Object.keys(fromEnv).length) sub.push(table, 'env_http_headers', fromEnv);
    } else {
      lines.push(`command = ${str(s.command)}`);
      if (s.args?.length) lines.push(`args = ${array(s.args)}`);
      if (s.cwd) lines.push(`cwd = ${str(s.cwd)}`);
      const literal = {};
      const passthrough = [];
      for (const [k, v] of Object.entries(s.env ?? {})) {
        if (v === `\${${k}}`) passthrough.push(k);
        else {
          if (envRefs(v).length) warn?.(`Codex: env "${k}" of MCP server "${s.name}" uses env references; written literally`);
          literal[k] = v;
        }
      }
      if (passthrough.length) lines.push(`env_vars = ${array(passthrough)}`);
      if (Object.keys(literal).length) sub.push(table, 'env', literal);
    }
    for (let j = 0; j < sub.length; j += 3) {
      lines.push('', `[${sub[j]}.${sub[j + 1]}]`, ...Object.entries(sub[j + 2]).map(([k, v]) => `${key(k)} = ${str(v)}`));
    }
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

function prompt(cmd) {
  const meta = stripInternal(cmd.meta);
  return stringifyFrontmatter({ description: meta.description, 'argument-hint': meta['argument-hint'] }, normalizeBody(cmd.body));
}

/** Codex agent files are standalone TOML; tool lists have no equivalent and are dropped. */
function agent(a) {
  const lines = [`name = ${str(a.name)}`, `description = ${str(a.meta.description)}`];
  // Model ids are tool-specific, so only an explicit codex (or default) entry is used.
  const model = typeof a.meta.model === 'object' ? perTarget(a.meta.model, ID) : undefined;
  if (model) lines.push(`model = ${str(model)}`);
  lines.push(`developer_instructions = ${tomlString(normalizeBody(a.body))}`);
  return `${lines.join('\n')}\n`;
}

function layout(bundle, { base, skillsDir, prompts, warn }) {
  const servers = selected(bundle.mcp, ID);
  const entries = [
    ...instructionsBlock(bundle, 'AGENTS.md'),
    ...skillFiles(bundle, skillsDir),
    ...selected(bundle.agents, ID).map((a) => ({ type: 'file', path: `${base}agents/${a.name}.toml`, content: agent(a) })),
  ];
  if (prompts) {
    entries.push(...selected(bundle.commands, ID).map((c) => ({ type: 'file', path: `${base}prompts/${c.name}.md`, content: prompt(c) })));
  }
  if (servers.length) entries.push({ type: 'block', path: `${base}config.toml`, content: mcpToml(servers, warn), syntax: 'toml' });
  return entries;
}

export default {
  id: ID,
  label: 'Codex CLI',
  supports: { instructions: true, skills: true, commands: 'user scope', agents: true, mcp: true },

  install(bundle, { scope, dir, warn }) {
    if (scope === 'user') {
      const root = process.env.CODEX_HOME || path.join(homeDir(), '.codex');
      return { root, entries: layout(bundle, { base: '', skillsDir: 'skills', prompts: true, warn }) };
    }
    warnUnsupported(bundle, ID, 'Codex', { commands: 'Codex custom prompts are user-scoped; use --scope user' }, warn);
    return { root: dir, entries: layout(bundle, { base: '.codex/', skillsDir: '.agents/skills', prompts: false, warn }) };
  },

  package(bundle, { warn }) {
    return { entries: layout(bundle, { base: '', skillsDir: 'skills', prompts: true, warn }) };
  },

  npmUsage({ name, cli }) {
    return `Into \`~/.codex\`, merging with your existing \`AGENTS.md\` and \`config.toml\`:

\`\`\`bash
npx -y ${cli} install codex --scope user
\`\`\`

Or by hand: this package mirrors \`~/.codex\`.

\`\`\`bash
${fetchSnippet(name)}
cp -R package/skills package/prompts package/agents ~/.codex/
cat package/AGENTS.md >> ~/.codex/AGENTS.md && cat package/config.toml >> ~/.codex/config.toml
\`\`\``;
  },
};
