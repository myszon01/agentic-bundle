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
