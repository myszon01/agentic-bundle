// Writes adapter entries to disk.
//
// build:     a clean package directory; blocks and JSON are written as plain files.
// install:   merges into an existing project/home directory. Whole files, managed
//            blocks and owned JSON keys are recorded in
//            <root>/.agentic-bundle/<bundle>.<target>.json (<bundle>.<target>.user.json for
//            --scope user) so that re-installs update in place, removed items are cleaned
//            up, and uninstall is exact. A file or block that another manifest of the bundle
//            records (another target or scope, in this root or one above the path) is shared:
//            it stays until no manifest records it. Files and JSON keys that were already there
//            are never taken over (unless forced), so uninstall cannot delete what the user had.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const MANIFEST_DIR = '.agentic-bundle';
const EMPTY = { files: [], blocks: [], json: [] };

// ---------------------------------------------------------------- build

export async function writePackage(entries, outDir, { dryRun = false } = {}) {
  const written = [];
  for (const entry of entries) {
    const abs = safeJoin(outDir, entry.path);
    let content = entry.content;
    if (entry.type === 'json') content = `${JSON.stringify(entry.value, null, 2)}\n`;
    if (entry.type === 'block') content = `${entry.content.trimEnd()}\n`;
    if (!dryRun) await writeOut(abs, content, entry.executable);
    written.push(entry.path);
  }
  return written;
}

// ---------------------------------------------------------------- install

export async function install(entries, root, { bundle, target, scope = 'project', other, force = false, dryRun = false, log = () => {}, warn = () => {} }) {
  const { file: manifestPath, prev = EMPTY, skip, extra } = await locate(root, { bundle, target, scope, entries, other, dryRun, log });
  const next = { bundle, target, scope, files: [], blocks: [], json: [] };
  const marker = markers(bundle);
  const others = [...extra, ...await otherManifests(bundle, skip, [...entries.map((e) => e.path), ...recorded(prev)].map((p) => safeJoin(root, p)))];

  for (const entry of entries) {
    const abs = safeJoin(root, entry.path);
    if (entry.type === 'file') {
      const content = typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content;
      const current = existsSync(abs) ? await readFile(abs) : null;
      if (current && !prev.files.includes(entry.path) && !holder(others, 'files', abs) && !force) {
        // Never record a file the user already had, even an identical one: uninstall would delete it.
        if (current.equals(content)) log(`keep ${entry.path} (identical file already there; left unmanaged)`);
        else warn(`skipped ${entry.path}: file exists and was not installed by ${bundle} (use --force to overwrite)`);
        continue;
      }
      next.files.push(entry.path);
      if (current?.equals(content)) continue;
      log(`${current ? 'update' : 'create'} ${entry.path}`);
      if (!dryRun) await writeOut(abs, content, entry.executable);
    } else if (entry.type === 'block') {
      const current = existsSync(abs) ? await readFile(abs, 'utf8') : '';
      const clash = entry.syntax === 'toml' ? duplicateTables(removeBlock(current, marker.toml), entry.content) : [];
      if (clash.length) {
        // A TOML table may be defined only once; writing the block would make the whole file unreadable.
        warn(`skipped ${entry.path}: ${clash.map((t) => `[${t}]`).join(', ')} already defined outside the ${bundle} block; `
          + 'remove it there (or from the harness) and install again');
        continue;
      }
      // Remember a missing final newline so uninstall can give the file back byte for byte.
      const known = [{ ...prev, base: root }, ...others].flatMap((m) => m.blocks.filter((b) => path.resolve(m.base, b.path) === abs))[0];
      const noFinalNewline = known ? !!known.noFinalNewline
        : !blockPattern(marker[entry.syntax]).test(current) && current !== '' && !current.endsWith('\n');
      next.blocks.push({ path: entry.path, syntax: entry.syntax, ...(noFinalNewline && { noFinalNewline }) });
      const updated = upsertBlock(current, entry.content, marker[entry.syntax]);
      if (updated === current) continue;
      log(`${current ? 'update' : 'create'} ${entry.path} (managed block)`);
      if (!dryRun) await writeOut(abs, updated);
    } else if (entry.type === 'json') {
      const current = existsSync(abs) ? await readFile(abs, 'utf8') : null;
      let data;
      try {
        data = current ? JSON.parse(current) : {};
      } catch {
        warn(`skipped ${entry.path}: not valid JSON (comments are not supported); add these keys by hand: ${JSON.stringify(entry.value)}`);
        continue;
      }
      const prevOwns = prev.json.find((j) => j.path === entry.path)?.owns ?? [];
      const value = structuredClone(entry.value);
      const owns = [];
      for (const k of entry.owns) {
        const existing = getKey(data, k);
        if (existing !== undefined && !prevOwns.some((o) => sameKey(o, k)) && !force) {
          // Same rule as files: a key the user already had stays theirs.
          deleteKey(value, k);
          if (isDeepStrictEqual(existing, getKey(entry.value, k))) log(`keep ${k.join('.')} in ${entry.path} (identical entry already there; left unmanaged)`);
          else warn(`skipped ${k.join('.')} in ${entry.path}: it exists and was not installed by ${bundle} (use --force to overwrite)`);
          continue;
        }
        owns.push(k);
      }
      if (owns.length) next.json.push({ path: entry.path, owns });
      const original = structuredClone(data);
      const stale = prevOwns.filter((k) => !owns.some((o) => sameKey(o, k)));
      for (const k of stale) deleteKey(data, k);
      deepMerge(data, value);
      if (current && isDeepStrictEqual(data, original)) continue; // keep the user's formatting
      const updated = `${JSON.stringify(data, null, 2)}\n`;
      log(`${current ? 'update' : 'create'} ${entry.path} (merged keys)`);
      if (!dryRun) await writeOut(abs, updated);
    }
  }

  await removeStale(root, prev, next, { others, marker, dryRun, log });

  const empty = !next.files.length && !next.blocks.length && !next.json.length;
  if (!dryRun) {
    if (empty) await removeFile(manifestPath, root);
    else await writeOut(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return next;
}

export async function uninstall(root, { bundle, target, scope = 'project', entries = [], other, dryRun = false, log = () => {} }) {
  const { file, prev, skip, extra } = await locate(root, { bundle, target, scope, entries, other, dryRun, log });
  if (!prev) return false;
  const others = [...extra, ...await otherManifests(bundle, skip, recorded(prev).map((p) => safeJoin(root, p)))];
  await removeStale(root, prev, EMPTY, { others, marker: markers(bundle), dryRun, log });
  if (!dryRun) await removeFile(file, root);
  return true;
}

async function removeStale(root, prev, next, { others, marker, dryRun, log }) {
  for (const file of prev.files.filter((f) => !next.files.includes(f))) {
    const shared = holder(others, 'files', safeJoin(root, file));
    log(shared ? `keep ${file} (still installed by ${path.relative(root, shared.file)})` : `remove ${file}`);
    if (!shared && !dryRun) await removeFile(safeJoin(root, file), root);
  }

  // A block may be shared with another target (e.g. AGENTS.md) or scope (e.g. Codex's config.toml) of the bundle.
  for (const block of prev.blocks.filter((b) => !next.blocks.some((n) => n.path === b.path))) {
    const abs = safeJoin(root, block.path);
    if (holder(others, 'blocks', abs) || !existsSync(abs)) continue;
    const updated = removeBlock(await readFile(abs, 'utf8'), marker[block.syntax], { finalNewline: !block.noFinalNewline });
    log(`remove managed block from ${block.path}`);
    if (dryRun) continue;
    if (updated.trim()) await writeFile(abs, updated);
    else await removeFile(abs, root);
  }

  for (const j of prev.json) {
    const keep = next.json.find((n) => n.path === j.path)?.owns ?? [];
    const drop = j.owns.filter((k) => !keep.some((o) => sameKey(o, k)));
    if (!drop.length || keep.length) continue; // partial updates were handled during install
    const abs = safeJoin(root, j.path);
    if (!existsSync(abs)) continue;
    const data = JSON.parse(await readFile(abs, 'utf8'));
    drop.forEach((k) => deleteKey(data, k));
    log(`remove keys from ${j.path}`);
    if (dryRun) continue;
    // Delete the file when nothing but empty containers (and a $schema) is left.
    if (Object.entries(data).every(([k, v]) => k === '$schema' || isEmptyObject(v))) await removeFile(abs, root);
    else await writeFile(abs, `${JSON.stringify(data, null, 2)}\n`);
  }
}

const manifestFile = (root, bundle, target, scope) => path.resolve(root, MANIFEST_DIR, `${bundle}.${target}${scope === 'user' ? '.user' : ''}.json`);
const recorded = (m) => [...m.files, ...m.blocks.map((b) => b.path), ...m.json.map((j) => j.path)];

/**
 * This scope's manifest and its previous install (prev undefined: none), plus what otherManifests() must skip
 * and add. Up to 0.2.0 both scopes wrote <bundle>.<target>.json, with no `scope` field. In a root the user scope
 * uses (`entries` and `other` are what this scope and the other one write here; `other` is undefined where the
 * other scope does not use this root), such a manifest is the user install's unless it records a path only a
 * project install writes here. The user's is moved into <bundle>.<target>.user.json (merged, if 0.2.0 ran again
 * after an upgrade); a dry run moves it in memory only.
 */
async function locate(root, { bundle, target, scope, entries = [], other, dryRun, log = () => {} }) {
  const [projectFile, userFile] = [manifestFile(root, bundle, target), manifestFile(root, bundle, target, 'user')];
  const file = scope === 'user' ? userFile : projectFile;
  const own = { file, prev: await readJson(file), skip: [file], extra: [] };
  const [user, project] = scope === 'user' ? [entries, other ?? []] : [other, entries];
  const legacy = user && await readJson(projectFile);
  if (!legacy || legacy.scope) return own;
  const projectOnly = project.map((e) => e.path).filter((p) => !user.some((e) => e.path === p));
  if (recorded(legacy).some((p) => projectOnly.includes(p))) return own;
  const moved = { bundle, target, scope: 'user', ...union(await readJson(userFile, EMPTY), legacy) };
  log(`move ${path.relative(root, projectFile)} to ${path.basename(userFile)} (an earlier version's record of --scope user)`);
  if (!dryRun) {
    await writeOut(userFile, `${JSON.stringify(moved, null, 2)}\n`);
    await rm(projectFile);
  }
  if (scope === 'user') return { file, prev: moved, skip: [userFile, projectFile], extra: [] };
  return { file, prev: undefined, skip: [projectFile, userFile], extra: [{ ...moved, base: root, file: userFile }] };
}

/** Two records of one install in one: files, blocks by path, JSON keys by file. */
function union(a, b) {
  const json = a.json.map((j) => ({ ...j, owns: [...j.owns] }));
  for (const j of b.json) {
    const same = json.find((x) => x.path === j.path);
    if (same) same.owns.push(...j.owns.filter((k) => !same.owns.some((o) => sameKey(o, k))));
    else json.push(j);
  }
  return { files: [...new Set([...a.files, ...b.files])], blocks: [...a.blocks, ...b.blocks.filter((x) => !a.blocks.some((y) => y.path === x.path))], json };
}

/**
 * The bundle's other manifests that can record any of these absolute paths: those in .agentic-bundle/ of every
 * folder above a path, since a manifest records only paths below its own folder. That covers other targets and
 * the other scope in the same root, and installs rooted elsewhere that write the same files (Codex: a project
 * install in ~ writes into ~/.codex and ~/.agents). `skip`: manifest files to leave out.
 */
async function otherManifests(bundle, skip, paths) {
  const dirs = new Set();
  for (const p of paths) for (let d = path.dirname(p); !dirs.has(d); d = path.dirname(d)) dirs.add(d);
  const out = [];
  for (const base of dirs) {
    const dir = path.join(base, MANIFEST_DIR);
    for (const name of await readdir(dir).catch(() => [])) {
      const file = path.join(dir, name);
      if (name.startsWith(`${bundle}.`) && name.endsWith('.json') && !skip.includes(file)) out.push({ ...EMPTY, ...(await readJson(file)), base, file });
    }
  }
  return out;
}

/** The first other manifest that records this absolute file or block path. */
const holder = (others, kind, abs) => others.find((m) => m[kind].some((x) => path.resolve(m.base, x.path ?? x) === abs));

// ---------------------------------------------------------------- managed blocks

export function markers(bundle) {
  return {
    md: { begin: `<!-- BEGIN ${bundle} (managed by agentic-bundle, do not edit) -->`, end: `<!-- END ${bundle} -->` },
    toml: { begin: `# BEGIN ${bundle} (managed by agentic-bundle, do not edit)`, end: `# END ${bundle}` },
  };
}

function blockPattern({ begin, end }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${esc(begin)}[\\s\\S]*?${esc(end)}\\n?`);
}

export function upsertBlock(text, content, marker) {
  const block = `${marker.begin}\n${content.trimEnd()}\n${marker.end}\n`;
  const re = blockPattern(marker);
  if (re.test(text)) return text.replace(re, () => block);
  if (!text.trim()) return block;
  return `${text.trimEnd()}\n\n${block}`;
}

/** Remove the block and the blank line upsertBlock put before it; the user's own text is left as it was. */
export function removeBlock(text, marker, { finalNewline = true } = {}) {
  const m = blockPattern(marker).exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index).replace(/\n+$/, '');
  const after = text.slice(m.index + m[0].length).replace(/^\n+/, '');
  if (!before.trim() && !after.trim()) return '';
  if (after) return before ? `${before}\n\n${after}` : after;
  return finalNewline ? `${before}\n` : before;
}

/** Standard ([name]) tables defined in both TOML texts. Arrays of tables ([[name]]) may repeat. */
export function duplicateTables(outside, block) {
  const tables = (text) => new Set([...text.matchAll(/^[ \t]*\[(?!\[)([^\]\n]+)\][ \t]*(?:#.*)?$/gm)].map((m) => tableName(m[1])));
  const mine = tables(block);
  return [...tables(outside)].filter((t) => mine.has(t));
}

/** Normalise a dotted TOML key: whitespace and quotes around segments do not change its meaning. */
function tableName(raw) {
  const parts = [];
  for (const m of raw.matchAll(/\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^.\s"']+)\s*/g)) {
    const seg = m[1];
    parts.push(seg.startsWith('"') ? JSON.parse(seg) : seg.startsWith("'") ? seg.slice(1, -1) : seg);
  }
  return parts.join('.');
}

// ---------------------------------------------------------------- json helpers

export function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function getKey(obj, keyPath) {
  let v = obj;
  for (const k of keyPath) {
    if (!v || typeof v !== 'object' || !Object.hasOwn(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

/** Delete a nested key, then prune the parent objects it leaves empty. */
function deleteKey(obj, keyPath) {
  const chain = [obj];
  for (const k of keyPath.slice(0, -1)) {
    const next = chain[chain.length - 1][k];
    if (!next || typeof next !== 'object') return;
    chain.push(next);
  }
  delete chain[chain.length - 1][keyPath[keyPath.length - 1]];
  for (let i = chain.length - 1; i > 0 && isEmptyObject(chain[i]); i--) delete chain[i - 1][keyPath[i - 1]];
}

const isEmptyObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;

const sameKey = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

// ---------------------------------------------------------------- fs helpers

function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error(`Refusing to write outside ${root}: ${rel}`);
  return abs;
}

async function writeOut(abs, content, executable) {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  if (executable) await chmod(abs, 0o755);
}

async function removeFile(abs, root) {
  root = path.resolve(root);
  await rm(abs, { force: true });
  // Prune now-empty parent directories, but never the root itself.
  for (let dir = path.dirname(abs); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      break;
    }
  }
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}
