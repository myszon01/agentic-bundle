# Distributing a harness

Once a harness validates, your team needs a way to get it onto every developer's machine. There are four
routes. They differ in where the harness is stored and who can read it:

| route | stored in | who can install | tools |
|-------|-----------|-----------------|-------|
| [1. Public npm packages](#1-public-npm-packages-the-default) (default) | the public npm registry | anyone | every tool |
| [2. A private npm scope](#2-a-private-npm-scope) | the npm registry, restricted | users you give read access to the scope | every tool |
| [3. A private git repository, no registry](#3-a-private-git-repository-no-registry) | your git host | anyone who can clone the repository | every tool |
| [4. A private Claude Code marketplace](#4-claude-code-only-a-private-plugin-marketplace) | your git host | anyone who can clone the repository | Claude Code only |

Routes 3 and 4 can be combined: one private repository holds the harness, and a second one (or a branch) holds
the built Claude Code plugin.

## 1. Public npm packages (the default)

This is what the template does out of the box. The Release workflow publishes the CLI (with the harness
inside) and one package per tool, all public. See [README → Distributing](../README.md#distributing) for the
package list and [README → Releasing](../README.md#releasing) for the release steps.

Leave `npm.access` out of `bundle.json`, or set it to `"public"`.

## 2. A private npm scope

npm only keeps a package private if it has a scope (`@acme/...`). Private packages need a paid npm account:
a paid user account for packages under your user name, or a paid organization for an organization scope.
See npm's [About private packages](https://docs.npmjs.com/about-private-packages).

Set the scope and the access level in `harness/bundle.json`:

```json
{
  "name": "acme-harness",
  "npm": { "scope": "@acme", "access": "restricted" }
}
```

`build --npm` then writes `"publishConfig": { "access": "restricted" }` into each tool's `package.json`, and
each package README tells the reader to log in to npm first. `validate` accepts only `"public"` or
`"restricted"` for `npm.access`, and rejects `"restricted"` when `npm.scope` is missing.

The CLI package is published from the repository's own `package.json`, and it contains the harness too, so
set `"publishConfig": { "access": "restricted" }` there as well.

> **Don't use the Release workflow unchanged for a private scope.** `.github/workflows/release.yml` passes
> `--access public` on the command line. npm gives command-line flags priority over `publishConfig`, and
> passing `public` also makes an existing restricted package public. The workflow would therefore make
> every package public, whatever `npm.access` says. Until the workflow reads the access level from each
> package, either publish by hand, or change your copy of the workflow so it doesn't pass `--access public`.

Publishing by hand, with 2FA:

```bash
node bin/agentic-bundle.js build all --npm --out dist
for pkg in dist/*/; do npm publish "$pkg"; done   # one package per tool; publishConfig applies
npm publish                                        # the CLI package, from the repository root
```

To install, each developer runs `npm login` once, with an npm account that has read access to the scope. The
install commands are then the same as for public packages:

```bash
npx -y @acme/acme-harness install claude codex --scope user
```

- **Claude Code plugin package:** Claude Code fetches an `npm` plugin source with the npm client on the
  developer's machine, so that client needs the same login.
- **pi:** pi's documentation doesn't say whether `pi install npm:` uses your npm login. For a restricted package,
  use the CLI route instead: `npx -y @acme/acme-harness install pi --scope user`.

## 3. A private git repository, no registry

Nothing is published. The harness lives in a private git repository, for example one made from this template
(see [README → Use as a template](../README.md#use-as-a-template)), and access to that repository is the
access control. `npm.scope` and `npm.access` don't matter for this route.

Each developer clones the repository and points the public CLI at the checkout's harness folder:

```bash
git clone git@github.com:acme/acme-harness.git ~/src/acme-harness
npx -y @myszon01/agentic-bundle install claude codex --source ~/src/acme-harness/harness --scope user
```

- `--source` is the folder that contains `bundle.json`. In a repository made from this template that is the
  `harness/` folder, not the repository root.
- Leave out `--scope user` to install into a project instead: run the command in the project, or pass
  `--dir ~/code/my-project`.
- Only the CLI is downloaded from npm. Your harness never leaves your git host. To keep every developer on the
  same CLI version, pin it: `npx -y @myszon01/agentic-bundle@0.2.0 ...`.
- A repository made from this template already contains the CLI, so npm isn't needed at all. From the
  checkout root, `node bin/agentic-bundle.js install claude codex --scope user` uses `./harness`.

To update, run `git pull`, then the same install command. A re-install updates files in place and removes
anything that was deleted from the harness. To remove everything, run the same command with `uninstall`
instead of `install`, including the same `--source`.

## 4. Claude Code only: a private plugin marketplace

A Claude Code marketplace is a git repository with `.claude-plugin/marketplace.json` at its root. Claude Code
clones it, so the repository can be private. `build claude` (without `--npm`) produces exactly that: in
`dist/claude/`, a plugin whose `marketplace.json` lists the plugin itself. Both the marketplace and the plugin
are named after `name` in `bundle.json`.

Publish the build to a private repository of its own, for example `acme/acme-harness-claude`:

```bash
node bin/agentic-bundle.js build claude --out dist
git clone git@github.com:acme/acme-harness-claude.git ../acme-harness-claude
rsync -a --delete --exclude .git dist/claude/ ../acme-harness-claude/
git -C ../acme-harness-claude add -A
git -C ../acme-harness-claude commit -m "acme-harness v1.4.0"
git -C ../acme-harness-claude push
```

A dedicated branch of the harness repository works as well: users add it as `acme/acme-harness#claude-plugin`.

Each developer then runs, in Claude Code:

```
/plugin marketplace add acme/acme-harness-claude
/plugin install acme-harness@acme-harness
```

or the same from a shell: `claude plugin marketplace add ...` and `claude plugin install ...`.

- `owner/repo` always means github.com. For another git host, use the full URL, such as
  `https://git.example.com/acme/acme-harness-claude.git` or `git@git.example.com:acme/acme-harness-claude.git`.
- To register the marketplace for everyone working in a project, run
  `claude plugin marketplace add acme/acme-harness-claude --scope project` there once and commit the
  `.claude/settings.json` it writes.

**Access.** Claude Code runs `git` on the developer's machine, with prompts turned off, and uses the credentials
that machine already has. It has no git token of its own, and `marketplace.json` has no field for one.

- **SSH:** the key must work without a passphrase prompt (for example, loaded in `ssh-agent`), and the host must
  already be in `known_hosts`. For `owner/repo`, Claude Code tries SSH first and falls back to HTTPS; on a
  machine without a GitHub SSH key, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.
- **HTTPS:** a git credential helper must already hold a credential for the host. On GitHub, run
  `gh auth login`, then `gh auth setup-git`.
- A token in the environment, such as `GITHUB_TOKEN`, takes effect only through a credential helper, such as the
  `gh` CLI's helper, which reads `GH_TOKEN` and `GITHUB_TOKEN`.

**Updates.** Bump `version` in `bundle.json` for every release. Claude Code copies a plugin again only when its
version changes, and the build writes that version into the plugin. Background auto-update is off for your
marketplace until a user turns it on (in `/plugin`, under *Marketplaces*) or an administrator sets it in
managed settings. Without it, developers update with `/plugin marketplace update acme-harness`, or with
`claude plugin update acme-harness@acme-harness` from a shell.

This route covers Claude Code only. For the other tools, use route 3 with the same harness repository.

Official documentation: [Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace)
and the [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference). On a Team or
Enterprise plan, an administrator can also distribute the marketplace through claude.ai organization settings
instead, which doesn't use developers' git credentials.
