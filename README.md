# agentic-bundle

**Write your agentic harness once. Ship it to every coding agent.**

Your instructions, skills, slash commands, subagents and MCP servers live in a single canonical folder
(`harness/`). A small, dependency-free CLI translates them into each tool's native format. It can install
them straight into a project or your home directory, or build packages you can distribute: a Claude Code
plugin, a pi package and so on.

| tool | id | instructions | skills | commands | subagents | MCP |
|------|----|:-:|:-:|:-:|:-:|:-:|
| [Claude Code](https://code.claude.com) | `claude` | ✅ | ✅ | ✅ | ✅ | ✅ |
| [OpenCode](https://opencode.ai) | `opencode` | ✅ | ✅ | ✅ | ✅ | ✅ |
| [pi](https://github.com/badlogic/pi-mono) | `pi` | ✅ | ✅ | ✅ | — | — (by design) |
| [Codex CLI](https://github.com/openai/codex) | `codex` | ✅ | ✅ | user scope | ✅ | ✅ |

Features a tool lacks are skipped with a warning, never silently.

## Quick start

Requires Node.js 24 or later (developed on Node 26, see `.nvmrc`). There are no dependencies to install.

```bash
# 1. Fork or clone, then edit harness/ to taste
git clone https://github.com/myszon01/agentic-bundle && cd agentic-bundle

# 2. Check it
node bin/agentic-bundle.js validate

# 3a. Install into a project, for every tool...
node bin/agentic-bundle.js install all --dir ~/code/my-project

# 3b. ...or into your user config, for selected tools
node bin/agentic-bundle.js install claude codex --scope user

# Preview first, undo later
node bin/agentic-bundle.js install all --dry-run
node bin/agentic-bundle.js uninstall all --dir ~/code/my-project
```

Without cloning anything, install the published harness from npm:

```bash
npx -y @myszon01/agentic-bundle install all --scope user
```

`--source` points the same CLI at your own harness folder instead, for example one in your dotfiles:

```bash
npx -y @myszon01/agentic-bundle install all --scope user --source ~/dotfiles/harness
```

## What's in the box

```
harness/                 ← the only part you normally edit
├── bundle.json          name, version, metadata, default targets
├── AGENTS.md            shared instructions
├── skills/              Agent Skills (SKILL.md + scripts), copied as-is
├── commands/            slash commands  ($ARGUMENTS, canonical tool names)
├── agents/              subagents       (canonical tool names, per-target model)
└── mcp.json             MCP servers     (${ENV_VAR} references)
bin/ lib/                the CLI and one adapter per tool (lib/targets/*.js)
docs/authoring.md        file formats and the canonical tool vocabulary
docs/targets.md          where everything lands for each tool, and how to add a tool
test/                    node:test suite
```

The example harness ships two skills (`code-review`, `conventional-commits`), two commands (`/review`,
`/commit`), a read-only `researcher` subagent and the `fetch` MCP server. Replace them with your own.

## Commands

```
agentic-bundle validate
agentic-bundle build     [targets...] [--out dist]
agentic-bundle install   [targets...] [--scope project|user] [--dir .] [--force] [--dry-run]
agentic-bundle uninstall [targets...] [--scope project|user] [--dir .] [--dry-run]
agentic-bundle targets
```

`targets` can be any of `claude opencode pi codex all`, either as bare words or as `--target a,b`.
If you give none, the `targets` list in `bundle.json` is used.

## Distributing

Everything is published to npm, so nobody needs access to this repository. A release produces six packages:

| package | for | install with |
|---------|-----|--------------|
| `@myszon01/agentic-bundle` | the CLI + harness, every tool | `npx -y @myszon01/agentic-bundle install <tools> [--scope user]` |
| `@myszon01/agentic-bundle-claude` | Claude Code plugin | `tar -xzf "$(npm pack @myszon01/agentic-bundle-claude \| tail -1)"`, then `claude plugin marketplace add ./package` |
| `@myszon01/agentic-bundle-pi` | pi package | `pi install npm:@myszon01/agentic-bundle-pi` |
| `@myszon01/agentic-bundle-opencode` | OpenCode project files | the CLI, or unpack and copy into a project |
| `@myszon01/agentic-bundle-codex` | `~/.codex` files | the CLI, or unpack and copy into `~/.codex` |

Each tool package carries a README with its exact install steps. The CLI is the only route that applies
every feature for every tool and merges with existing config, so prefer it when in doubt.

The per-tool package names come from `harness/bundle.json` (`name` plus `npm.scope`). To build them locally:

```bash
node bin/agentic-bundle.js build all --npm     # dist/<tool>/ with package.json + README
scripts/pack.sh pi artifacts               # one tool → artifacts/*.tgz (or "cli" for the CLI)
```

### Releasing

CI builds every package as its own artifact on each pull request (download them from the run's
*Artifacts* section). `main` only accepts pull requests, so a release is a version-bump PR followed by a tag:

```bash
# 1. Bump the version on a branch and merge it through a pull request
git switch -c release/v0.2.0 origin/main
npm version minor --no-git-tag-version     # bumps package.json and harness/bundle.json together
git commit -am "chore: release v0.2.0"
git push -u origin release/v0.2.0          # open a PR, get it reviewed, merge it

# 2. Tag the merged commit on main; the tag starts the Release workflow
git switch main && git pull
git tag v0.2.0 && git push origin v0.2.0

# 3. When the workflow is done, approve the staged packages (npm asks for your 2FA code)
npm install -g npm@12                      # staged publishing needs npm 12
npm login
npm run approve                            # or: npm run approve -- --dry-run, to only list them
```

The Release workflow checks that the tag, `package.json` and `bundle.json` versions match, then packs all
six packages and **stages** them on npm with `npm stage publish`. Staged packages are uploaded but not
public: nothing goes live until a maintainer approves it with 2FA, so the CI token never needs publish
rights. Versions that are already published or staged are skipped, so re-running a release is safe.
*Actions → Release → Run workflow* does a dry run. The workflow's summary lists every staged package.

The first release (`v0.1.0`) needs no version bump: tag the current `main`.

**One-time npm setup:**
1. Create the `@myszon01` scope on npmjs.com (it's your npm username, or an org with that name), and turn
   on 2FA for your account; approving staged packages requires it. If the name differs, change `name` in
   `package.json` and `npm.scope` in `harness/bundle.json` (or run `npm run init`).
2. Create a granular access token with read/write access to that scope; it does **not** need to bypass
   2FA. Add it as the repository secret `NPM_TOKEN` (*Settings → Secrets and variables → Actions*).
3. Optional, after the first release: on npmjs.com, add this repository and `release.yml` as a
   *Trusted Publisher* for each package, allowing only staged publishing
   (`npm trust github <package> --file release.yml --repo myszon01/agentic-bundle --allow-stage-publish`).
   The token can then be deleted.

To publish directly instead of staging (for a token or trusted publisher that is allowed to publish), set
the repository variable `NPM_PUBLISH_MODE` to `publish` (*Settings → Secrets and variables → Actions →
Variables*).

## How install stays safe

- **Shared files are merged, not overwritten.** Instructions go into a marked block in `CLAUDE.md`,
  or `AGENTS.md`. MCP servers are merged key by key into `.mcp.json`, `opencode.json`,
  or `~/.claude.json`, and into a marked block in Codex's `config.toml`.
  Everything else in those files is left untouched.
- **Every write is recorded** in `.agentic-bundle/<bundle>.<target>.json`. Re-installing updates in place
  and removes anything you deleted from the harness. `uninstall` removes exactly what was added.
- **Foreign files are never clobbered.** If a skill, command or agent file already exists and this bundle
  did not create it, the install skips it and warns you, unless you pass `--force`.

## Use as a template

Each new plugin or extension gets its own repository made from this one, with the same CLI, CI and release
pipeline:

1. On GitHub, open this repository and choose **Use this template → Create a new repository**.
2. In the new repository:

   ```bash
   npm run init -- --clean          # rename everything after the repo; start with an empty harness/
   ```

   This renames the CLI (`@<owner>/<repo>`), the tool packages (`@<owner>/<repo>-<tool>`), the bundle,
   `CODEOWNERS`, `LICENSE` and the README. Override the defaults with `--name`, `--scope @npm-scope`,
   `--description` or `--author`. Leave out `--clean` to keep the example skills as a starting point.
3. Write your instructions, skills, commands, agents and MCP servers in `harness/`, then run
   `npm test && npm run validate`, commit and open a pull request.
4. Per repository, once: add the `NPM_TOKEN` secret (see [Releasing](#releasing)), and recreate any branch
   rules. GitHub doesn't copy secrets or rulesets from a template.

The tests use their own fixture harness (`test/fixtures/`), so emptying or rewriting `harness/` doesn't
break them.

## Development

```bash
npm test                 # unit tests (node:test)
npm run validate         # validate harness/
npm run build            # build all packages into dist/
```

To support another tool, add an adapter in `lib/targets/` (see [docs/targets.md](docs/targets.md#adding-a-target)).

<!-- setup-service -->
## Need help setting it up?

I'm setting this up, free, for a few teams that use several coding agents: one shared harness, installed
into every agent, with CI and private packages. See [SETUP-SERVICE.md](SETUP-SERVICE.md).
<!-- /setup-service -->

## License

MIT
