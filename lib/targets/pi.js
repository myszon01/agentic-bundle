// pi coding agent — https://github.com/badlogic/pi-mono
//   project: AGENTS.md, .pi/{skills,prompts}/
//   user:    ~/.pi/agent/{AGENTS.md,skills,prompts}/
//   package: a pi package (package.json with a "pi" manifest), installable with `pi install`
// pi deliberately ships without MCP and subagents; those are skipped with a warning.

import path from 'node:path';
import { stringifyFrontmatter } from '../frontmatter.js';
import { homeDir, instructionsBlock, normalizeBody, selected, skillFiles, stripInternal, warnUnsupported } from './common.js';

const ID = 'pi';
const UNSUPPORTED = {
  mcp: 'pi has no built-in MCP support; wrap servers in a pi extension instead',
  agents: 'pi has no built-in subagents; build one as a pi extension (see examples/extensions/subagent in pi-mono) or run `pi -p` in tmux',
};

function prompt(cmd) {
  const meta = stripInternal(cmd.meta);
  return stringifyFrontmatter(
    { description: meta.description, 'argument-hint': meta['argument-hint'] },
    normalizeBody(cmd.body),
  );
}

function components(bundle, base) {
  return [
    ...skillFiles(bundle, `${base}skills`),
    ...selected(bundle.commands, ID).map((c) => ({ type: 'file', path: `${base}prompts/${c.name}.md`, content: prompt(c) })),
  ];
}

export default {
  id: ID,
  label: 'pi',
  supports: { instructions: true, skills: true, commands: true, agents: false, mcp: false },

  install(bundle, { scope, dir, warn }) {
    warnUnsupported(bundle, ID, 'pi', UNSUPPORTED, warn);
    if (scope === 'user') {
      const root = process.env.PI_CODING_AGENT_DIR || path.join(homeDir(), '.pi', 'agent');
      return { root, entries: [...instructionsBlock(bundle, 'AGENTS.md'), ...components(bundle, '')] };
    }
    return { root: dir, entries: [...instructionsBlock(bundle, 'AGENTS.md'), ...components(bundle, '.pi/')] };
  },

  package(bundle, { warn }) {
    warnUnsupported(bundle, ID, 'pi', UNSUPPORTED, warn);
    const { manifest } = bundle;
    const resources = {};
    if (bundle.skills.length) resources.skills = ['./skills'];
    if (selected(bundle.commands, ID).length) resources.prompts = ['./prompts'];
    const pkg = {
      name: bundle.name,
      version: bundle.version,
      description: manifest.description,
      keywords: ['pi-package', ...(manifest.keywords ?? [])],
      license: manifest.license,
      repository: manifest.repository,
      pi: resources,
    };
    const entries = [{ type: 'file', path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` }, ...components(bundle, '')];
    if (bundle.instructions) {
      warn('pi: packages cannot carry AGENTS.md context; it is included for reference — use `install --target pi` to apply it');
      entries.push({ type: 'file', path: 'AGENTS.md', content: bundle.instructions });
    }
    return { entries };
  },

  npmUsage({ name, cli }) {
    return `This package is a pi package (skills and prompt templates):

\`\`\`bash
pi install npm:${name}
\`\`\`

pi packages cannot carry \`AGENTS.md\`. To install the shared instructions too:

\`\`\`bash
npx -y ${cli} install pi --scope user
\`\`\``;
  },
};
