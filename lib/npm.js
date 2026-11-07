// Turns a target's package entries into a publishable npm package:
// adds (or completes) package.json and a README with that tool's install steps.

export const SCOPE = /^@[a-z0-9][a-z0-9._~-]*$/;

/** npm access levels "npm.access" in bundle.json may set; the first is the default. */
export const ACCESS = ['public', 'restricted'];

/** npm package name for one target, e.g. @acme/my-harness-claude. */
export function npmName(bundle, target, scope = bundle.manifest.npm?.scope) {
  const base = `${bundle.name}-${target.id}`;
  return scope ? `${scope}/${base}` : base;
}

/** A GitHub URL string becomes the object form npm expects, so `npm publish` doesn't rewrite it. */
export function npmRepository(repository) {
  if (typeof repository !== 'string') return repository;
  return { type: 'git', url: `git+${repository.replace(/\.git$/, '')}.git` };
}

export function npmEntries(bundle, target, entries, { name, cli }) {
  const { manifest } = bundle;
  const access = manifest.npm?.access ?? ACCESS[0];
  // npm refuses to restrict an unscoped package; fail at build time rather than at publish time.
  if (access === 'restricted' && !name.startsWith('@')) {
    throw new Error(`npm.access "restricted" needs a scoped package name, got "${name}" (set npm.scope or --npm-scope)`);
  }
  const existing = entries.find((e) => e.type === 'file' && e.path === 'package.json');
  const base = existing ? JSON.parse(String(existing.content)) : {};
  const description = `${target.label} package of ${bundle.name}${manifest.description ? `: ${manifest.description}` : ''}`;
  const pkg = clean({
    ...base,
    name,
    version: bundle.version,
    description,
    keywords: [...new Set([...(base.keywords ?? []), 'agentic-bundle', target.id, ...(manifest.keywords ?? [])])],
    license: manifest.license,
    author: manifest.author,
    homepage: manifest.homepage,
    repository: npmRepository(manifest.repository),
    publishConfig: { access },
  });

  const top = [...new Set(entries.map((e) => e.path.split('/')[0]))].filter((p) => p !== 'package.json').sort();
  const readme = [
    `# ${name}`,
    '',
    description,
    '',
    `Generated with agentic-bundle from \`${bundle.name}@${bundle.version}\` for **${target.label}**.`,
    '',
    '## Install',
    '',
    ...(access === 'restricted' ? ['This package is private: log in first (`npm login`) as a user who can read it.', ''] : []),
    target.npmUsage({ name, cli, bundle }).trim(),
    '',
    '## Contents',
    '',
    ...top.map((p) => `- \`${p}\``),
    '',
  ].join('\n');

  return [
    ...entries.filter((e) => e !== existing && e.path !== 'README.md'),
    { type: 'file', path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { type: 'file', path: 'README.md', content: readme },
  ];
}

/** Shell snippet that downloads a package from npm and unpacks it into ./package. */
export const fetchSnippet = (name) => `tar -xzf "$(npm pack ${name} | tail -1)"   # unpacks into ./package`;

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
