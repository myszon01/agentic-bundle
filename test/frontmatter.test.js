import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';

test('parses scalars, lists, maps and block scalars', () => {
  const { data, body } = parseFrontmatter(`---
name: demo
description: "Quoted: with colon"
count: 3
enabled: true
tools: [read, "grep", glob]
steps:
  - one
  - two
model:
  claude: haiku
  opencode: anthropic/claude-haiku
long: >
  folded
  text
literal: |
  line 1
  line 2
---
Body here
`);
  assert.deepEqual(data, {
    name: 'demo',
    description: 'Quoted: with colon',
    count: 3,
    enabled: true,
    tools: ['read', 'grep', 'glob'],
    steps: ['one', 'two'],
    model: { claude: 'haiku', opencode: 'anthropic/claude-haiku' },
    long: 'folded text\n',
    literal: 'line 1\nline 2\n',
  });
  assert.equal(body, 'Body here\n');
});

test('text without frontmatter is all body', () => {
  assert.deepEqual(parseFrontmatter('# Title\n'), { data: {}, body: '# Title\n' });
});

test('round-trips through stringify', () => {
  const data = { description: 'Use when: "x" happens', tools: ['Read', 'Grep'], model: { claude: 'haiku' }, hint: '[file]' };
  const text = stringifyFrontmatter(data, 'Prompt\n');
  const parsed = parseFrontmatter(text);
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, 'Prompt\n');
});

test('omits undefined fields and returns bare body when empty', () => {
  assert.equal(stringifyFrontmatter({ a: undefined }, 'x\n'), 'x\n');
});

test('multi-line plain scalars fold like YAML (map values and list items)', () => {
  const { data } = parseFrontmatter(`---
description: Reviews code for
  quality and

  security issues. # a comment
notes:
  - first item
    continues here
  - second
tools: [read,
  grep]
---
`);
  assert.deepEqual(data, {
    description: 'Reviews code for quality and\nsecurity issues.',
    notes: ['first item continues here', 'second'],
    tools: ['read', 'grep'],
  });
});

test('multi-line quoted strings fold, honour escaped line breaks and blank lines', () => {
  const { data } = parseFrontmatter(`---
double: "A long string
  that wraps\\
  here: and

  ends"
single: 'it''s
  wrapped'
after: 1
---
`);
  assert.deepEqual(data, { double: 'A long string that wrapshere: and\nends', single: "it's wrapped", after: 1 });
});

test('block lists of maps parse as nested data (Claude Code hooks style)', () => {
  const { data } = parseFrontmatter(`---
name: linted-reviewer
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/check-command.sh"
  PostToolUse:
  - matcher: Edit|Write
    hooks:
    - type: command
      command: ./scripts/run-linter.sh
      timeout: 30
items:
  - - a
    - b
  - "q: stays a string"
  - https://example.com/x
  - |
    block in a list
---
Body
`);
  assert.deepEqual(data.hooks, {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/check-command.sh' }] }],
    PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: './scripts/run-linter.sh', timeout: 30 }] }],
  });
  assert.deepEqual(data.items, [['a', 'b'], 'q: stays a string', 'https://example.com/x', 'block in a list\n']);
});

test('a leading UTF-8 byte order mark is ignored', () => {
  const { data, body } = parseFrontmatter('﻿---\nname: bom\n---\nBody\n');
  assert.deepEqual(data, { name: 'bom' });
  assert.equal(body, 'Body\n');
});

test('lists of maps are emitted as block YAML and round-trip', () => {
  const data = {
    description: 'Hooked agent',
    tools: ['Read'],
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh', timeout: 5 }] }] },
    matrix: [['a', 'b'], [{ x: 1 }], {}],
  };
  const text = stringifyFrontmatter(data, 'Prompt\n');
  assert.ok(!text.includes('[object Object]'), text);
  assert.match(text, /\nhooks:\n {2}PreToolUse:\n {4}- matcher: Bash\n {6}hooks:\n {8}- type: command\n {10}command: \.\/check\.sh\n/);
  assert.deepEqual(parseFrontmatter(text).data, data);
});

test('parse errors give the line number in the file', () => {
  const cases = [
    ['---\ndescription: "closed"\n    extra: 1\n---\n', /unexpected indentation on line 3/],
    ['---\na: b\njust text\n---\n', /cannot parse line 3: just text/],
    ['---\na: x\nb: "never closed\n  more\n---\n', /unterminated string starting on line 3/],
    ['---\na: "bad \\q escape"\n---\n', /invalid escape .* \(line 2\)/],
  ];
  for (const [text, error] of cases) assert.throws(() => parseFrontmatter(text), error);
});
