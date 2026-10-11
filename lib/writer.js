// Writes adapter entries to disk.
//
// build:     a clean package directory; blocks and JSON are written as plain files.
// install:   merges into an existing project/home directory. Whole files, managed
//            blocks and owned JSON keys are recorded in
//            <root>/.agentic-bundle/<bundle>.<target>.json so that re-installs
//            update in place, removed items are cleaned up, and uninstall is exact.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

  for (const entry of entries) {
    const abs = safeJoin(root, entry.path);
    if (entry.type === 'file') {
      const content = typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content;
      const current = existsSync(abs) ? await readFile(abs) : null;
      if (current && !current.equals(content) && !prev.files.includes(entry.path) && !force) {
        warn(`skipped ${entry.path}: file exists and was not installed by ${bundle} (use --force to overwrite)`);
        continue;
      }
      next.files.push(entry.path);
      if (current?.equals(content)) continue;
      log(`${current ? 'update' : 'create'} ${entry.path}`);
      if (!dryRun) await writeOut(abs, content, entry.executable);
    } else if (entry.type === 'block') {
      next.blocks.push({ path: entry.path, syntax: entry.syntax });
      const current = existsSync(abs) ? await readFile(abs, 'utf8') : '';
      const updated = upsertBlock(current, entry.content, marker[entry.syntax]);
      if (updated === current) continue;
      log(`${current ? 'update' : 'create'} ${entry.path} (managed block)`);
      if (!dryRun) await writeOut(abs, updated);
    } else if (entry.type === 'json') {
      next.json.push({ path: entry.path, owns: entry.owns });
      const current = existsSync(abs) ? await readFile(abs, 'utf8') : null;
      let data;
      try {
        data = current ? JSON.parse(current) : {};
      } catch {
        warn(`skipped ${entry.path}: not valid JSON (comments are not supported); add these keys by hand: ${JSON.stringify(entry.value)}`);
        next.json.pop();
        continue;
      }
      const stale = (prev.json.find((j) => j.path === entry.path)?.owns ?? []).filter((k) => !entry.owns.some((o) => sameKey(o, k)));
      for (const k of stale) deleteKey(data, k);
      deepMerge(data, entry.value);
      const updated = `${JSON.stringify(data, null, 2)}\n`;
      if (updated === current) continue;
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
    const updated = removeBlock(await readFile(abs, 'utf8'), marker[block.syntax]);
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

export function removeBlock(text, marker) {
  const out = text.replace(blockPattern(marker), '').replace(/\n{3,}/g, '\n\n').trim();
  return out ? `${out}\n` : '';
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
