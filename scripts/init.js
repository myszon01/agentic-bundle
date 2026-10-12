// Rename a copy of this template for a new harness, plugin or extension.
//
//   npm run init -- [--name my-plugin] [--repo owner/repo] [--scope @npm-scope]
//                   [--description "..."] [--author "Name"] [--clean] [--harness-only]
//
// Defaults come from `git remote get-url origin`: name = repo name, scope = @owner.
// --clean also removes the example skills, commands, agents and MCP servers.
// --harness-only (recommended for teams) keeps the harness but not the tool: lib/, bin/, the tool's
//   tests, its packaging scripts and release.yml are removed, package.json becomes private and gets the
//   tool from npm as a dev dependency, and CI checks just the harness. Then run `npm install` and commit
//   package-lock.json. It converts an existing copy too, keeping your own files and tests.
// Safe to re-run: current names are read from package.json and harness/bundle.json.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCOPE = /^@[a-z0-9][a-z0-9._~-]*$/;
const FLAGS = new Set(['clean', 'harness-only']);

// --harness-only: the CLI as published on npm, and the parts of the template that are the tool itself.
const TOOL = '@myszon01/agentic-bundle';
const TOOL_SCRIPTS = ['scripts/pack.sh', 'scripts/approve.js', 'scripts/packages.js', 'scripts/sync-version.js'];
const TOOL_FILES = ['lib', ...TOOL_SCRIPTS, '.github/workflows/release.yml'];
const HARNESS_CI = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    # Linux only: the tool's own CI covers macOS; this repository only checks its harness.
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [24, 26]
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: \${{ matrix.node }}
      - run: npm ci
      - run: npm run test --if-present
      - run: npx agentic-bundle validate
      - run: npx agentic-bundle build all
      - name: Install round trip
        run: |
          dir=$(mktemp -d)
          npx agentic-bundle install all --dir "$dir"
          npx agentic-bundle uninstall all --dir "$dir"
          test -z "$(ls -A "$dir")"

  # Single stable check for branch protection, so the required check
  # doesn't change whenever the matrix does.
  ci-ok:
    name: ci-ok
    if: always()
    needs: [test]
    runs-on: ubuntu-latest
    steps:
      - run: test "\${{ needs.test.result }}" = success
`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].replace(/^--/, '').split(/=(.*)/s, 2);
    if (FLAGS.has(key)) opts[key] = true;
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

function removeIfEmpty(dir) {
  if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

// The tool's tests import lib/, so they go with it; tests of your own stay.
function removeToolTests() {
  if (!existsSync('test')) return;
  for (const f of readdirSync('test')) {
    const file = path.join('test', f);
    if (f.endsWith('.test.js') && /from ['"]\.\.\/lib\//.test(readFileSync(file, 'utf8'))) rmSync(file);
  }
  rmSync('test/fixtures/harness', { recursive: true, force: true });
  removeIfEmpty('test/fixtures');
  removeIfEmpty('test');
}

// Nothing to publish: the harness is checked and installed with the tool from npm.
function harnessPackage(pkg, toolRange, vendored) {
  const { bin, files, publishConfig, private: _, ...rest } = pkg;
  const scripts = {};
  for (const [key, cmd] of Object.entries(rest.scripts ?? {})) {
    if (!TOOL_SCRIPTS.some((f) => cmd.includes(f))) scripts[key] = cmd.replaceAll('node bin/agentic-bundle.js', 'agentic-bundle');
  }
  scripts.validate = 'agentic-bundle validate';
  // `npm test` only while tests of your own remain.
  if (vendored && scripts.test === 'node --test' && !existsSync('test')) delete scripts.test;
  const devDependencies = { ...rest.devDependencies, [TOOL]: toolRange };
  return { name: rest.name, version: rest.version, private: true, ...rest, scripts, devDependencies };
}

const harnessReadme = (name, description) => `# ${name}

${description ?? 'Shared instructions, skills, commands, subagents and MCP servers for coding agents.'}

Everything lives in \`harness/\`. [agentic-bundle](https://www.npmjs.com/package/${TOOL}), a dev dependency,
checks it and installs it into each coding agent it supports (\`npx agentic-bundle targets\`):

\`\`\`bash
npm ci
npx agentic-bundle validate
npx agentic-bundle install all --dir ~/code/my-project     # or --scope user
npx agentic-bundle uninstall all --dir ~/code/my-project
\`\`\`

File formats: \`node_modules/${TOOL}/docs/authoring.md\`. Update the tool with \`npm install -D ${TOOL}@latest\`.
`;

const opts = parseArgs(process.argv.slice(2));
const pkg = readJson('package.json');
const bundle = readJson('harness/bundle.json');
const harnessOnly = Boolean(opts['harness-only']);
// Converted now or by an earlier --harness-only run: the tool comes from npm, not from this repository.
const harnessRepo = harnessOnly || (pkg.private === true && Boolean(pkg.devDependencies?.[TOOL]));
// The tool is still copied in: a fresh template copy, or a copy not converted yet.
const vendored = existsSync('bin/agentic-bundle.js');
const templateReadme = existsSync('README.md') && readFileSync('README.md', 'utf8').includes('<!-- setup-service -->');

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
// A fresh copy's package.json is the tool's own. Re-runs keep the range; other copies get the newest.
const toolRange = pkg.devDependencies?.[TOOL] ?? (pkg.name === TOOL ? `^${pkg.version}` : 'latest');

if (harnessOnly && vendored) {
  for (const f of TOOL_FILES) rmSync(f, { recursive: true, force: true });
  removeToolTests();
  mkdirSync('.github/workflows', { recursive: true });
  writeFileSync('.github/workflows/ci.yml', HARNESS_CI);
  rmSync('bin/agentic-bundle.js'); // last: while it exists, a re-run converts again
  removeIfEmpty('bin');
}

// package.json: the CLI, published as <scope>/<name> (with --harness-only: private, not published)
Object.assign(pkg, {
  name: cli,
  version: '0.1.0',
  // The template's description is the tool's; a harness-only repository describes its harness.
  ...(harnessOnly && pkg.name === TOOL && { description: bundle.description }),
  ...(opts.description && { description: opts.description }),
  repository: { type: 'git', url: `git+${url}.git` },
  homepage: `${url}#readme`,
});
writeJson('package.json', harnessOnly ? harnessPackage(pkg, toolRange, vendored) : pkg);

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
if (harnessOnly && templateReadme) {
  // The template's README documents the tool, which this repository no longer contains.
  writeFileSync('README.md', harnessReadme(name, bundle.description));
} else if (existsSync('README.md')) {
  // In a harness-only repository the tool's name means the package on npm, so it is left alone.
  const readme = readFileSync('README.md', 'utf8');
  const parts = harnessRepo ? readme.split(TOOL) : [readme];
  writeFileSync('README.md', parts.map((part) => replaceAll(part, pairs)).join(TOOL));
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

const packages = harnessRepo
  ? `  package:        ${cli} (private)\n  agentic-bundle: ${TOOL}@${toolRange} (dev dependency)`
  : `  CLI package:    ${cli}\n  tool packages:  ${scope}/${name}-<tool>`;
const next = harnessRepo
  ? `Next: run \`npm install\` and commit package-lock.json (CI runs \`npm ci\`).
Then edit harness/, run \`npx agentic-bundle validate\`, and commit.`
  : `Next: edit harness/, run \`npm test && npm run validate\`, then commit.
The first release needs an NPM_TOKEN secret in this repository; delete it once you
switch to npm Trusted Publishing (see README → Releasing).`;

console.log(`Initialised ${name}${harnessRepo ? ' (harness-only)' : ''}
${packages}
  repository:     ${url}
  code owner:     @${owner}${opts.clean ? '\n  examples:       removed (harness/ is empty)' : ''}

${next}`);
