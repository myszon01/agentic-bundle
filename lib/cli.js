import { existsSync, readFileSync } from 'node:fs';
import { readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundle, validateBundle } from './bundle.js';
import { TARGETS, resolveTargets } from './targets/index.js';
import { install, uninstall, writePackage } from './writer.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_STAMP = '.agentic-bundle-build';

const HELP = `agentic-bundle — write an agent harness once, ship it to every coding agent.

Usage
  agentic-bundle <command> [targets...] [options]

Commands
  validate                 Check the harness source for errors
  build [targets...]       Build distributable packages into <out>/<target>/
  install [targets...]     Install into a project (default) or your user config
  uninstall [targets...]   Remove everything a previous install wrote
  targets                  List supported targets and what each supports

Targets
  ${Object.keys(TARGETS).join(', ')}, all   (default: "targets" in bundle.json, else all)

Options
  --source <dir>   Harness source directory (default: ./harness if present, else the bundled one)
  --out <dir>      Build output directory (default: ./dist)
  --scope <scope>  project | user (default: project)
  --dir <dir>      Project directory for --scope project (default: current directory)
  --force          Overwrite files that exist but were not installed by this bundle
  --dry-run        Show what would change without writing anything
  -h, --help       Show this help
  -v, --version    Show version
`;

export async function main(argv) {
  const { command, positionals, opts } = parseArgs(argv);
  if (opts.version) return console.log(JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version);
  if (opts.help || !command || command === 'help') return console.log(HELP);

  if (command === 'targets') return printTargets();

  const source = path.resolve(opts.source ?? (existsSync('harness/bundle.json') ? 'harness' : path.join(PKG_ROOT, 'harness')));
  const bundle = await loadBundle(source);
  const { errors, warnings } = validateBundle(bundle);
  warnings.forEach((w) => console.warn(`warning: ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.error(`error: ${e}`));
    throw new Error(`${errors.length} validation error(s) in ${source}`);
  }

  const warn = (msg) => console.warn(`warning: ${msg}`);
  const dryRun = Boolean(opts['dry-run']);
  const prefix = dryRun ? '[dry-run] ' : '';

  switch (command) {
    case 'validate': {
      const counts = `${bundle.skills.length} skills, ${bundle.commands.length} commands, ${bundle.agents.length} agents, ${bundle.mcp.length} MCP servers`;
      console.log(`✓ ${bundle.name}@${bundle.version} is valid (${counts})`);
      return;
    }
    case 'build': {
      const out = path.resolve(opts.out ?? 'dist');
      await prepareOutDir(out, { force: opts.force, dryRun });
      for (const target of resolveTargets(positionals, bundle)) {
        const { entries } = target.package(bundle, { warn });
        const dir = path.join(out, target.id);
        if (!dryRun) await rm(dir, { recursive: true, force: true });
        const files = await writePackage(entries, dir, { dryRun });
        console.log(`${prefix}${target.label}: ${files.length} files → ${path.relative(process.cwd(), dir) || '.'}`);
      }
      return;
    }
    case 'install':
    case 'uninstall': {
      const scope = opts.scope ?? 'project';
      if (!['project', 'user'].includes(scope)) throw new Error(`--scope must be "project" or "user", got "${scope}"`);
      const dir = path.resolve(opts.dir ?? '.');
      for (const target of resolveTargets(positionals, bundle)) {
        const { root, entries } = target.install(bundle, { scope, dir, warn });
        const absRoot = path.resolve(root);
        const log = (msg) => console.log(`  ${prefix}${msg}`);
        console.log(`${target.label} → ${absRoot}`);
        if (command === 'install') {
          await install(entries, absRoot, { bundle: bundle.name, target: target.id, force: opts.force, dryRun, log, warn });
        } else if (!(await uninstall(absRoot, { bundle: bundle.name, target: target.id, dryRun, log }))) {
          log('nothing installed');
        }
      }
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Run with --help for usage.`);
  }
}

function parseArgs(argv) {
  const opts = {};
  const positionals = [];
  const flags = new Set(['force', 'dry-run', 'help', 'version']);
  const alias = { h: 'help', v: 'version' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (flags.has(name)) opts[name] = true;
      else if (inline !== undefined) opts[name] = inline;
      else if (i + 1 < argv.length) opts[name] = argv[++i];
      else throw new Error(`Option --${name} needs a value`);
    } else if (/^-[a-z]$/.test(arg) && alias[arg[1]]) {
      opts[alias[arg[1]]] = true;
    } else {
      positionals.push(arg);
    }
  }
  // Accept the documented `--target x` form as well as bare positionals.
  if (opts.target) positionals.push(String(opts.target));
  const [command, ...rest] = positionals;
  return { command, positionals: rest.flatMap((p) => p.split(',')).filter(Boolean), opts };
}

async function prepareOutDir(out, { force, dryRun }) {
  if (existsSync(out) && (await readdir(out)).length && !existsSync(path.join(out, BUILD_STAMP)) && !force) {
    throw new Error(`${out} is not empty and was not created by agentic-bundle; pick another --out or pass --force`);
  }
  if (dryRun) return;
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, BUILD_STAMP), 'Build output of agentic-bundle. Safe to delete.\n');
}

function printTargets() {
  const features = ['instructions', 'skills', 'commands', 'agents', 'mcp'];
  const rows = Object.values(TARGETS).map((t) => [
    t.id,
    t.label,
    ...features.map((f) => (t.supports[f] === true ? 'yes' : t.supports[f] ? String(t.supports[f]) : '—')),
  ]);
  const header = ['id', 'tool', ...features];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log([line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n'));
}
