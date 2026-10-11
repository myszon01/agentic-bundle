// Minimal YAML-frontmatter reader/writer. Supports the subset agent tools use:
// scalars, quoted strings, inline lists, block lists, block scalars (| and >)
// and nested maps. Keeps the project dependency-free.

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(text) {
  const m = FENCE.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: parseYaml(m[1]), body: text.slice(m[0].length).replace(/^\r?\n/, '') };
}

export function stringifyFrontmatter(data, body) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return body;
  const yaml = entries.map(([k, v]) => emit(k, v, 0)).join('\n');
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}

// ---------------------------------------------------------------- parsing

export function parseYaml(src) {
  const lines = src.split(/\r?\n/);
  let i = 0;

  const indentOf = (line) => line.length - line.trimStart().length;
  const isBlank = (line) => !line.trim() || line.trim().startsWith('#');

  function peek() {
    while (i < lines.length && isBlank(lines[i])) i++;
    return i < lines.length ? lines[i] : null;
  }

  function parseNode(indent) {
    const line = peek();
    if (line === null) return null;
    return /^-(\s|$)/.test(line.trim()) ? parseList(indentOf(line)) : parseMap(indent);
  }

  function parseList(indent) {
    const out = [];
    for (let line = peek(); line !== null; line = peek()) {
      if (indentOf(line) !== indent || !/^-(\s|$)/.test(line.trim())) break;
      i++;
      const rest = line.trim().slice(1).trim();
      if (rest === '') {
        const next = peek();
        out.push(next !== null && indentOf(next) > indent ? parseNode(indentOf(next)) : null);
      } else {
        out.push(scalar(rest));
      }
    }
    return out;
  }

  function parseMap(indent) {
    const out = {};
    for (let line = peek(); line !== null; line = peek()) {
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`frontmatter: unexpected indentation on line ${i + 1}`);
      const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(line.trim());
      if (!m) throw new Error(`frontmatter: cannot parse line ${i + 1}: ${line.trim()}`);
      const key = m[1].replace(/^(["'])(.*)\1$/, '$2');
      const raw = (m[2] ?? '').trim();
      i++;
      if (raw === '') {
        const next = peek();
        if (next !== null && indentOf(next) > indent) out[key] = parseNode(indentOf(next));
        else if (next !== null && indentOf(next) === indent && /^-(\s|$)/.test(next.trim())) out[key] = parseList(indent);
        else out[key] = null;
      } else if (/^[|>][-+]?$/.test(raw)) {
        out[key] = blockScalar(raw, indent);
      } else {
        out[key] = scalar(raw);
      }
    }
    return out;
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

  return parseNode(0) ?? {};
}

function scalar(raw) {
  let s = raw.trim();
  if (s.startsWith('"')) return JSON.parse(s.slice(0, closingQuote(s, '"') + 1));
  if (s.startsWith("'")) return s.slice(1, closingQuote(s, "'")).replace(/''/g, "'");
  s = s.replace(/\s+#.*$/, '');
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

function closingQuote(s, q) {
  for (let j = 1; j < s.length; j++) {
    if (q === '"' && s[j] === '\\') { j++; continue; }
    if (s[j] === q) {
      if (q === "'" && s[j + 1] === "'") { j++; continue; }
      return j;
    }
  }
  throw new Error(`frontmatter: unterminated string: ${s}`);
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

function emit(key, value, depth) {
  const pad = '  '.repeat(depth);
  const k = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
  if (Array.isArray(value)) return `${pad}${k}: [${value.map(formatScalar).join(', ')}]`;
  if (value && typeof value === 'object') {
    const inner = Object.entries(value).filter(([, v]) => v !== undefined && v !== null);
    if (inner.length === 0) return `${pad}${k}: {}`;
    return `${pad}${k}:\n${inner.map(([ik, iv]) => emit(ik, iv, depth + 1)).join('\n')}`;
  }
  return `${pad}${k}: ${formatScalar(value)}`;
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
