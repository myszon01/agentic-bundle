// Rename a copy of this template for a new harness, plugin or extension.
//
//   npm run init -- [--name my-plugin] [--repo owner/repo] [--scope @npm-scope]
//                   [--description "..."] [--author "Name"] [--clean]
//
// Defaults come from `git remote get-url origin`: name = repo name, scope = @owner.
// --clean also removes the example skills, commands, agents and MCP servers.
// Safe to re-run: current names are read from package.json and harness/bundle.json.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCOPE = /^@[a-z0-9][a-z0-9._~-]*$/;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].replace(/^--/, '').split(/=(.*)/s, 2);
    if (key === 'clean') opts.clean = true;
    else opts[key] = inline ?? argv[++i];
  }
  return opts;
}

function originRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : undefined;
  } catch {
    return undefined;
  }
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJson = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `bounded` stops a name matching inside a longer one (e.g. @acme inside @acme-tools).
function replaceAll(text, pairs) {
  return pairs.reduce((t, [from, to, bounded]) => {
    if (!from || from === to) return t;
    return t.replace(new RegExp(`${escape(from)}${bounded ? '(?![A-Za-z0-9._~-])' : ''}`, 'g'), () => to);
  }, text);
}

const opts = parseArgs(process.argv.slice(2));
const pkg = readJson('package.json');
const bundle = readJson('harness/bundle.json');

const repo = opts.repo ?? originRepo();
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  console.error('Could not determine the GitHub repository; pass --repo owner/repo');
  process.exit(1);
}
const [owner, repoName] = repo.split('/');
const name = opts.name ?? repoName.toLowerCase();
const scope = opts.scope ?? `@${owner.toLowerCase()}`;
const author = opts.author ?? owner;
if (!KEBAB.test(name)) throw new Error(`--name must be kebab-case, got "${name}"`);
if (!SCOPE.test(scope)) throw new Error(`--scope must look like "@name", got "${scope}"`);

const old = {
  cli: pkg.name,
  scope: bundle.npm?.scope,
  repo: /github\.com\/([^/]+\/[^/#.]+)/.exec(pkg.repository?.url ?? '')?.[1],
  owner: /github\.com\/([^/]+)\//.exec(pkg.repository?.url ?? '')?.[1],
};
const url = `https://github.com/${owner}/${repoName}`;
const cli = `${scope}/${name}`;

// package.json: the CLI, published as <scope>/<name>
Object.assign(pkg, {
  name: cli,
  version: '0.1.0',
  ...(opts.description && { description: opts.description }),
  repository: { type: 'git', url: `git+${url}.git` },
  homepage: `${url}#readme`,
});
writeJson('package.json', pkg);

// harness/bundle.json: the content, published as <scope>/<name>-<tool>
Object.assign(bundle, {
  name,
  version: '0.1.0',
  ...(opts.description && { description: opts.description }),
  author: { name: author },
  repository: url,
  npm: { ...bundle.npm, scope },
});
writeJson('harness/bundle.json', bundle);

writeFileSync('.github/CODEOWNERS', `# Every change needs approval from a code owner.\n* @${owner}\n`);

if (existsSync('LICENSE')) {
  const license = readFileSync('LICENSE', 'utf8').replace(/^Copyright \(c\) .*$/m, `Copyright (c) ${new Date().getFullYear()} ${author}`);
  writeFileSync('LICENSE', license);
}

// Most specific first. The CLI name is a prefix of the tool packages (<cli>-claude), so it is unbounded.
const pairs = [[old.cli, cli, false], [old.repo, `${owner}/${repoName}`, true], [old.scope, scope, true]];
for (const file of ['README.md']) {
  if (existsSync(file)) writeFileSync(file, replaceAll(readFileSync(file, 'utf8'), pairs));
}

// The template's own setup-service offer doesn't belong in repositories made from it.
rmSync('SETUP-SERVICE.md', { force: true });
if (existsSync('README.md')) {
  const readme = readFileSync('README.md', 'utf8').replace(/<!-- setup-service -->[\s\S]*?<!-- \/setup-service -->\n\n?/, '');
  writeFileSync('README.md', readme);
}

if (opts.clean) {
  for (const dir of ['skills', 'commands', 'agents']) {
    const abs = path.join('harness', dir);
    if (existsSync(abs)) for (const entry of readdirSync(abs)) rmSync(path.join(abs, entry), { recursive: true });
    mkdirSync(abs, { recursive: true });
    writeFileSync(path.join(abs, '.gitkeep'), '');
  }
  writeJson('harness/mcp.json', { servers: {} });
  writeFileSync('harness/AGENTS.md', `# ${name}\n\nInstructions shared by every coding agent this harness is installed into.\n`);
}

console.log(`Initialised ${name}
  CLI package:    ${cli}
  tool packages:  ${scope}/${name}-<tool>
  repository:     ${url}
  code owner:     @${owner}${opts.clean ? '\n  examples:       removed (harness/ is empty)' : ''}

Next: edit harness/, run \`npm test && npm run validate\`, then commit.
The first release needs an NPM_TOKEN secret in this repository; delete it once you
switch to npm Trusted Publishing (see README → Releasing).`);
