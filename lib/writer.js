// Writes adapter entries to disk.
//
// build:     a clean package directory; blocks and JSON are written as plain files.
// install:   merges into an existing project/home directory. Whole files, managed
//            blocks and owned JSON keys are recorded in
//            <root>/.agentic-bundle/<bundle>.<target>.json so that re-installs
//            update in place, removed items are cleaned up, and uninstall is exact.
//            Files and JSON keys that were already there are never taken over
//            (unless forced), so uninstall cannot delete what the user had.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const MANIFEST_DIR = '.agentic-bundle';

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

export async function install(entries, root, { bundle, target, force = false, dryRun = false, log = () => {}, warn = () => {} }) {
  const manifestPath = path.join(root, MANIFEST_DIR, `${bundle}.${target}.json`);
  const prev = await readJson(manifestPath, { files: [], blocks: [], json: [] });
  const next = { bundle, target, files: [], blocks: [], json: [] };
  const marker = markers(bundle);
  const others = await otherManifests(root, bundle, target);

  for (const entry of entries) {
    const abs = safeJoin(root, entry.path);
    if (entry.type === 'file') {
      const content = typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content;
      const current = existsSync(abs) ? await readFile(abs) : null;
      if (current && !prev.files.includes(entry.path) && !force) {
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
      const known = [prev, ...others].flatMap((m) => m.blocks ?? []).find((b) => b.path === entry.path);
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

  await removeStale(root, prev, next, { bundle, target, marker, dryRun, log });

  const empty = !next.files.length && !next.blocks.length && !next.json.length;
  if (!dryRun) {
    if (empty) await removeFile(manifestPath, root);
    else await writeOut(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return next;
}

export async function uninstall(root, { bundle, target, dryRun = false, log = () => {} }) {
  const manifestPath = path.join(root, MANIFEST_DIR, `${bundle}.${target}.json`);
  if (!existsSync(manifestPath)) return false;
  const prev = await readJson(manifestPath);
  await removeStale(root, prev, { files: [], blocks: [], json: [] }, { bundle, target, marker: markers(bundle), dryRun, log });
  if (!dryRun) await removeFile(manifestPath, root);
  return true;
}

async function removeStale(root, prev, next, { bundle, target, marker, dryRun, log }) {
  for (const file of prev.files.filter((f) => !next.files.includes(f))) {
    log(`remove ${file}`);
    if (!dryRun) await removeFile(safeJoin(root, file), root);
  }

  // A block may be shared with another target of the same bundle (e.g. AGENTS.md).
  const others = await otherManifests(root, bundle, target);
  for (const block of prev.blocks.filter((b) => !next.blocks.some((n) => n.path === b.path))) {
    if (others.some((m) => m.blocks.some((b2) => b2.path === block.path))) continue;
    const abs = safeJoin(root, block.path);
    if (!existsSync(abs)) continue;
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

async function otherManifests(root, bundle, target) {
  const dir = path.join(root, MANIFEST_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith(`${bundle}.`) && name.endsWith('.json') && name !== `${bundle}.${target}.json`) {
      out.push(await readJson(path.join(dir, name), { blocks: [] }));
    }
  }
  return out;
}

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
  return JSON.parse(await readFile(file, 'utf8'));
}
