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
docs/distribution.md     public npm, a private npm scope, a private git repo, a private Claude marketplace
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

Everything is published to npm, so nobody needs access to this repository. To keep a harness private instead
(a restricted npm scope, a private git repository with no registry, or a private Claude Code marketplace), see
[docs/distribution.md](docs/distribution.md).

A release produces five packages:

| package | for | install with |
|---------|-----|--------------|
| `@myszon01/agentic-bundle` | the CLI + harness, every tool | `npx -y @myszon01/agentic-bundle install <tools> [--scope user]` |
| `@myszon01/agentic-bundle-claude` | Claude Code plugin | `tar -xzf "$(npm pack @myszon01/agentic-bundle-claude \| tail -1)"`, then `claude plugin marketplace add ./package` |
| `@myszon01/agentic-bundle-pi` | pi package | `pi install npm:@myszon01/agentic-bundle-pi` |
| `@myszon01/agentic-bundle-opencode` | OpenCode project files | the CLI, or unpack and copy into a project |
| `@myszon01/agentic-bundle-codex` | `~/.codex` files | the CLI, or unpack and copy into `~/.codex` (skills into `~/.agents/skills`) |

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
git switch -c release/v0.3.0 origin/main
npm version minor --no-git-tag-version     # bumps package.json and harness/bundle.json together
git commit -am "chore: release v0.3.0"
git push -u origin release/v0.3.0          # open a PR, get it reviewed, merge it

# 2. Publish a GitHub release with tag v0.3.0 on main (Releases → Draft a new release),
#    or tag it yourself; the tag starts the Release workflow
git switch main && git pull
git tag v0.3.0 && git push origin v0.3.0
```

The Release workflow checks that the tag, `package.json` and `bundle.json` versions match, then packs all
five packages (the CLI plus one per tool) and sends them to npm in one of two modes:

- **Publish (`NPM_PUBLISH_MODE=publish`, used by this repository):** packages go live straight away
  through npm **Trusted Publishing**: npm trusts this repository's `release.yml`, so no npm token is
  stored, and each package gets a provenance badge. Publishing the GitHub release is the approval step.
- **Stage (the default):** packages are uploaded with `npm stage publish` but stay private until a
  maintainer approves them with 2FA: `npm install -g npm@12 && npm login && npm run approve`.

Versions that are already published or staged are skipped, so re-running a release is safe.
*Actions → Release → Run workflow* does a dry run. The workflow's summary lists every package.

The first release (`v0.1.0`) needs no version bump: tag the current `main`.

**One-time npm setup:**
1. Create the `@myszon01` scope on npmjs.com (it's your npm username, or an org with that name), and turn
   on 2FA for your account. If the name differs, change `name` in `package.json` and `npm.scope` in
   `harness/bundle.json` (or run `npm run init`).
2. **First release only:** create a granular access token with read/write access to that scope; it does
   **not** need to bypass 2FA. Add it as the repository secret `NPM_TOKEN` (*Settings → Secrets and
   variables → Actions*). The first release is staged; approve it with `npm run approve`. You delete this
   secret again in step 3.
3. Then switch to Trusted Publishing: on npmjs.com, for each package, open *Settings → Trusted
   Publisher → GitHub Actions* and enter this repository and `release.yml` (or run
   `npm trust github <package> --file release.yml --repo myszon01/agentic-bundle`). Set the repository
   variable `NPM_PUBLISH_MODE` to `publish` (*Settings → Secrets and variables → Actions → Variables*),
   and delete the `NPM_TOKEN` secret. To keep a manual 2FA gate instead, allow only staged publishing
   (`--allow-stage-publish`) and leave `NPM_PUBLISH_MODE` unset.

Things Trusted Publishing can't do, such as `npm deprecate`, are done by hand with 2FA.

## How install stays safe

- **Shared files are merged, not overwritten.** Instructions go into a marked block in `CLAUDE.md`,
  or `AGENTS.md`. MCP servers are merged key by key into `.mcp.json`, `opencode.json`,
  or `~/.claude.json`, and into a marked block in Codex's `config.toml`.
  Everything else in those files is left untouched.
- **Every write is recorded** in `.agentic-bundle/<bundle>.<target>.json`. Re-installing updates in place
  and removes anything you deleted from the harness. `uninstall` removes exactly what was added.
- **What you already had stays yours.** If a skill, command or agent file, or an MCP server entry with the
  same name, already exists and this bundle did not create it, the install leaves it alone: an identical one
  is kept as it is, a different one is skipped with a warning. `--force` takes it over (and `uninstall` will
  then remove it). A Codex `config.toml` that already defines one of the bundle's `[mcp_servers.<name>]`
  tables is skipped with a warning, because Codex rejects a table defined twice.

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
   If the repository only shares a harness, add `--harness-only` (see below).
3. Write your instructions, skills, commands, agents and MCP servers in `harness/`, then run
   `npm test && npm run validate`, commit and open a pull request. A harness-only repository gets the tool
   from npm, so run `npm install` first (and commit `package-lock.json`), then `npm run validate`; it has no
   `npm test` until you add tests of your own.
4. Per repository: add the `NPM_TOKEN` secret for the first release only, then delete it once you switch to
   Trusted Publishing (see [Releasing](#releasing)). A harness-only repository publishes nothing and needs no
   npm token. Recreate any branch rules too. GitHub doesn't copy secrets or rulesets from a template.

The tests use their own fixture harness (`test/fixtures/`), so emptying or rewriting `harness/` doesn't
break them.

### Harness-only repos (recommended for teams)

A plain copy of the template carries its own copy of the CLI, so fixes released to npm never reach it. If
the repository only holds a harness, such as a team's shared instructions and skills, and doesn't publish
a CLI or packages of its own, make it harness-only:

```bash
npm run init -- --clean --harness-only   # a fresh copy: rename it, empty harness/, remove the tool
npm install                              # then commit package-lock.json (CI runs npm ci)
```

To convert a copy that was already initialised, leave out `--clean`, which would empty its `harness/` (init
refuses the combination there):

```bash
npm run init -- --harness-only           # an existing copy: keeps harness/ and your own files
npm install
```

This keeps `harness/` (renamed as above) and removes the copy of the tool: `lib/`, `bin/`, its tests and
docs, its contributor notes in `CLAUDE.md`, the packaging scripts and `release.yml`. `package.json` becomes
private, with the agentic-bundle CLI from npm as a dev dependency at the template's version (`latest` for a
copy that was already renamed), and loses the scripts that build npm packages. Then `npm run validate` and
the `npx` commands in the README that init writes run the released tool, the installed dev dependency (they
use the tool's scoped npm name: the unscoped `agentic-bundle` on npm is not this tool), and updating it is an
ordinary dependency bump. `ci.yml` is replaced by one that checks just the harness on Linux with Node 24
and 26 (validate, build and an install round trip, plus `npm test` if you have tests), still behind a
single `ci-ok` check. Your own files and tests are kept, and re-running init doesn't convert anything
twice. An existing copy keeps its README too, in case you edited it; init warns when it still documents
the removed CLI, so you can replace it.

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
