// Minimal YAML-frontmatter reader/writer. Supports the subset agent tools use:
// scalars (plain, quoted, multi-line), inline lists and maps, block lists (also of maps),
// block scalars (| and >) and nested maps. Keeps the project dependency-free.

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const KEY = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/;
const ITEM = /^-(\s|$)/;

export function parseFrontmatter(text) {
  text = text.replace(/^﻿/, '');
  const m = FENCE.exec(text);
  if (!m) return { data: {}, body: text };
  // The YAML starts on line 2 of the file, after the opening fence.
  return { data: parseYaml(m[1], { firstLine: 2 }), body: text.slice(m[0].length).replace(/^\r?\n/, '') };
}

export function stringifyFrontmatter(data, body) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return body;
  const yaml = entries.map(([k, v]) => emit(k, v, 0)).join('\n');
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}

// ---------------------------------------------------------------- parsing

/** `firstLine` is the file line number of the first YAML line, used in error messages. */
export function parseYaml(src, { firstLine = 1 } = {}) {
  const lines = src.split(/\r?\n/);
  let i = 0;
  let current = 0; // index of the line being parsed, for error messages

  const indentOf = (line) => line.length - line.trimStart().length;
  const isBlank = (line) => !line.trim() || line.trim().startsWith('#');
  const lineNo = (index) => index + firstLine;

  function peek() {
    while (i < lines.length && isBlank(lines[i])) i++;
    return i < lines.length ? lines[i] : null;
  }

  function parseNode(indent) {
    const line = peek();
    if (line === null) return null;
    return ITEM.test(line.trim()) ? parseList(indentOf(line)) : parseMap(indent);
  }

  function parseList(indent) {
    const out = [];
    for (let line = peek(); line !== null; line = peek()) {
      if (indentOf(line) !== indent || !ITEM.test(line.trim())) break;
      current = i;
      const rest = line.trim().slice(1).trim();
      if (rest === '') {
        i++;
        const next = peek();
        out.push(next !== null && indentOf(next) > indent ? parseNode(indentOf(next)) : null);
      } else if (ITEM.test(rest) || isMapEntry(rest)) {
        // "- key: value" or "- - x": the item is a block node that starts at the column after the dash.
        const col = line.length - line.slice(indent + 1).trimStart().length;
        lines[i] = ' '.repeat(col) + line.slice(col);
        out.push(parseNode(col));
      } else {
        i++;
        out.push(/^[|>][-+]?$/.test(rest) ? blockScalar(rest, indent) : value(rest, indent));
      }
    }
    return out;
  }

  function parseMap(indent) {
    const out = {};
    for (let line = peek(); line !== null; line = peek()) {
      const ind = indentOf(line);
      if (ind < indent) break;
      current = i;
      if (ind > indent) throw new Error(`frontmatter: unexpected indentation on line ${lineNo(i)}`);
      const m = KEY.exec(line.trim());
      if (!m) throw new Error(`frontmatter: cannot parse line ${lineNo(i)}: ${line.trim()}`);
      const key = m[1].replace(/^(["'])(.*)\1$/, '$2');
      const raw = (m[2] ?? '').trim();
      i++;
      if (raw === '') {
        const next = peek();
        if (next !== null && indentOf(next) > indent) out[key] = parseNode(indentOf(next));
        else if (next !== null && indentOf(next) === indent && ITEM.test(next.trim())) out[key] = parseList(indent);
        else out[key] = null;
      } else if (/^[|>][-+]?$/.test(raw)) {
        out[key] = blockScalar(raw, indent);
      } else {
        out[key] = value(raw, indent);
      }
    }
    return out;
  }

  /** An inline value; plain and quoted scalars and flow collections may continue on later lines. */
  function value(raw, indent) {
    if (raw[0] === '"' || raw[0] === "'") return quoted(raw);
    const more = continuation(indent);
    if (!more.length) return scalar(raw);
    if (raw[0] === '[' || raw[0] === '{') return scalar([raw, ...more].join(' '));
    return fold([stripComment(raw), ...more]);
  }

  /** Lines indented more than `indent` that continue a plain scalar; '' stands for a blank line. */
  function continuation(indent) {
    const out = [];
    for (let j = i, blanks = 0; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === '') { blanks++; continue; }
      if (indentOf(lines[j]) <= indent || t.startsWith('#')) break;
      out.push(...Array(blanks).fill(''), stripComment(t));
      blanks = 0;
      i = j + 1;
    }
    return out;
  }

  /** A quoted scalar whose closing quote may be on a later line (YAML line folding applies). */
  function quoted(raw) {
    const q = raw[0];
    const start = current;
    let text = raw.trimEnd();
    let blank = false;
    while (closingQuote(text, q) < 0) {
      if (i >= lines.length) throw new Error(`frontmatter: unterminated string starting on line ${lineNo(start)}`);
      const next = lines[i++].trim();
      if (next === '') {
        text += q === '"' ? '\\n' : '\n';
        blank = true;
        continue;
      }
      // In double quotes, a backslash at the end of a line joins the lines without a space.
      if (!blank && q === '"' && /(?:^|[^\\])(?:\\\\)*\\$/.test(text)) text = text.slice(0, -1) + next;
      else text += (blank ? '' : ' ') + next;
      blank = false;
    }
    const after = stripComment(text.slice(closingQuote(text, q) + 1)).trim();
    if (i - 1 > start && after) throw new Error(`frontmatter: unexpected text after the string starting on line ${lineNo(start)}: ${after}`);
    return scalar(text);
  }

  function blockScalar(header, indent) {
    const collected = [];
    let blockIndent = null;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') { collected.push(''); i++; continue; }
      const ind = indentOf(line);
      if (ind <= indent) break;
      blockIndent ??= ind;
      collected.push(line.slice(Math.min(ind, blockIndent)));
      i++;
    }
    while (collected.length && collected[collected.length - 1] === '') collected.pop();
    const text = header[0] === '|'
      ? collected.join('\n')
      : collected.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    return header.endsWith('-') ? text : `${text}\n`;
  }

  try {
    return parseNode(0) ?? {};
  } catch (err) {
    if (/ line \d+/.test(err.message)) throw err;
    throw new Error(`${err.message} (line ${lineNo(current)})`, { cause: err });
  }
}

/** Whether the text after "- " starts a map ("key: value" or "key:"), rather than being a scalar. */
function isMapEntry(s) {
  if (s[0] === '"' || s[0] === "'") {
    const end = closingQuote(s, s[0]);
    return end > 0 && /^\s*:(\s|$)/.test(s.slice(end + 1));
  }
  return !/^[[{#]/.test(s) && KEY.test(s);
}

/** Folds plain-scalar lines: a single line break becomes a space, each blank line a newline. */
function fold(parts) {
  let out = parts[0];
  for (let k = 1; k < parts.length; k++) {
    if (parts[k] === '') out += '\n';
    else out += (parts[k - 1] === '' ? '' : ' ') + parts[k];
  }
  return out;
}

const stripComment = (s) => s.replace(/\s+#.*$/, '');

function scalar(raw) {
  let s = raw.trim();
  if (s[0] === '"' || s[0] === "'") {
    const end = closingQuote(s, s[0]);
    if (end < 0) throw new Error(`frontmatter: unterminated string: ${s}`);
    if (s[0] === "'") return s.slice(1, end).replace(/''/g, "'");
    // JSON rejects raw control characters (such as tabs) that YAML allows inside double quotes.
    const json = s.slice(0, end + 1).replace(/[\x00-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    try {
      return JSON.parse(json);
    } catch (err) {
      throw new Error(`frontmatter: invalid escape in double-quoted string ${s.slice(0, end + 1)}`, { cause: err });
    }
  }
  s = stripComment(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : splitInline(inner).map(scalar);
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const out = {};
    if (inner) for (const part of splitInline(inner)) {
      const idx = part.indexOf(':');
      out[part.slice(0, idx).trim().replace(/^(["'])(.*)\1$/, '$2')] = scalar(part.slice(idx + 1));
    }
    return out;
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Index of the quote that closes the string opened at s[0], or -1. */
function closingQuote(s, q) {
  for (let j = 1; j < s.length; j++) {
    if (q === '"' && s[j] === '\\') { j++; continue; }
    if (s[j] === q) {
      if (q === "'" && s[j + 1] === "'") { j++; continue; }
      return j;
    }
  }
  return -1;
}

function splitInline(s) {
  const parts = [];
  let depth = 0, quote = null, start = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (quote) { if (c === '\\' && quote === '"') j++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, j).trim()); start = j + 1; }
  }
  parts.push(s.slice(start).trim());
  return parts.filter((p) => p !== '');
}

// ---------------------------------------------------------------- emitting

const isCollection = (v) => v !== null && typeof v === 'object';

function emit(key, value, depth) {
  const pad = '  '.repeat(depth);
  const k = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
  if (Array.isArray(value)) {
    // Lists of scalars stay inline; lists holding maps or lists become block lists.
    if (!value.some(isCollection)) return `${pad}${k}: [${value.map(formatScalar).join(', ')}]`;
    return `${pad}${k}:\n${value.map((item) => emitItem(item, depth + 1)).join('\n')}`;
  }
  if (isCollection(value)) {
    const inner = Object.entries(value).filter(([, v]) => v !== undefined && v !== null);
    if (inner.length === 0) return `${pad}${k}: {}`;
    return `${pad}${k}:\n${inner.map(([ik, iv]) => emit(ik, iv, depth + 1)).join('\n')}`;
  }
  return `${pad}${k}: ${formatScalar(value)}`;
}

/** One "- item" of a block list whose dash sits at `depth`. */
function emitItem(item, depth) {
  const dash = `${'  '.repeat(depth)}- `;
  let lines;
  if (Array.isArray(item)) {
    if (!item.some(isCollection)) return `${dash}[${item.map(formatScalar).join(', ')}]`;
    lines = item.map((v) => emitItem(v, depth + 1));
  } else if (isCollection(item)) {
    const inner = Object.entries(item).filter(([, v]) => v !== undefined && v !== null);
    if (inner.length === 0) return `${dash}{}`;
    lines = inner.map(([k, v]) => emit(k, v, depth + 1));
  } else {
    return `${dash}${formatScalar(item)}`;
  }
  // The first nested line moves up onto the dash line; its indentation equals the dash's width.
  const [first, ...rest] = lines.join('\n').split('\n');
  return [dash + first.trimStart(), ...rest].join('\n');
}

export function formatScalar(v) {
  if (typeof v !== 'string') return String(v);
  const needsQuotes =
    v === '' ||
    /^\s|\s$/.test(v) ||
    /[:#\n\[\]{},&*!|>'"%@`]/.test(v) ||
    /^(true|false|null|yes|no|on|off|~|-|\?)$/i.test(v) ||
    /^[-+]?(\d|\.\d)/.test(v);
  return needsQuotes ? JSON.stringify(v) : v;
}
