# agentic-bundle

**Write your agentic harness once. Ship it to every coding agent.**

Your instructions, skills, slash commands, subagents and MCP servers live in a single canonical folder
(`harness/`). A small, dependency-free CLI translates them into each tool's native format. It can install
them straight into a project or your home directory, or build packages you can distribute: a Claude Code
plugin, a Gemini CLI extension, a pi package and so on.

| tool | id | instructions | skills | commands | subagents | MCP |
|------|----|:-:|:-:|:-:|:-:|:-:|
| [Claude Code](https://code.claude.com) | `claude` | ✅ | ✅ | ✅ | ✅ | ✅ |
| [OpenCode](https://opencode.ai) | `opencode` | ✅ | ✅ | ✅ | ✅ | ✅ |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini` | ✅ | ✅ | ✅ | ✅ | ✅ |
| [pi](https://github.com/badlogic/pi-mono) | `pi` | ✅ | ✅ | ✅ | — | — (by design) |
| [Codex CLI](https://github.com/openai/codex) | `codex` | ✅ | ✅ | user scope | ✅ | ✅ |

Features a tool lacks are skipped with a warning, never silently.

## Quick start

Requires Node.js 18.17 or later. There are no dependencies to install.

```bash
# 1. Fork or clone, then edit harness/ to taste
git clone https://github.com/myszon01/agentic-bundle && cd agentic-bundle

# 2. Check it
node bin/agentic-bundle.js validate

# 3a. Install into a project, for every tool...
node bin/agentic-bundle.js install all --dir ~/code/my-project

# 3b. ...or into your user config, for selected tools
node bin/agentic-bundle.js install claude gemini --scope user

# Preview first, undo later
node bin/agentic-bundle.js install all --dry-run
node bin/agentic-bundle.js uninstall all --dir ~/code/my-project
```

Without cloning, you can run it straight from GitHub. `--source` points at your own harness folder, which
can live anywhere, for example in your dotfiles:

```bash
npx github:myszon01/agentic-bundle install all --scope user --source ~/dotfiles/harness
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

`targets` can be any of `claude opencode gemini pi codex all`, either as bare words or as `--target a,b`.
If you give none, the `targets` list in `bundle.json` is used.

## Distributing

**Option 1: the installer.** Teammates run `install` (or the `npx` one-liner above) against your fork.
This is the only route that applies every feature for every tool.

**Option 2: native packages.** `build` writes one package per tool to `dist/<target>/`:

| tool | install the package with |
|------|--------------------------|
| Claude Code | `/plugin marketplace add ./dist/claude` then `/plugin install <name>@<name>` |
| Gemini CLI | `gemini extensions install ./dist/gemini` |
| pi | `pi install ./dist/pi` |
| OpenCode | copy `dist/opencode/.` into the repository |
| Codex CLI | copy `dist/codex/.` into `~/.codex` (append `config.toml`) |

On every push to `main`, the **Publish packages** workflow pushes each package to its own branch
(`dist/claude`, `dist/gemini`, …). Each tool can then install from git at that ref instead of a local path.

## How install stays safe

- **Shared files are merged, not overwritten.** Instructions go into a marked block in `CLAUDE.md`,
  `GEMINI.md` or `AGENTS.md`. MCP servers are merged key by key into `.mcp.json`, `opencode.json`,
  `.gemini/settings.json` or `~/.claude.json`, and into a marked block in Codex's `config.toml`.
  Everything else in those files is left untouched.
- **Every write is recorded** in `.agentic-bundle/<bundle>.<target>.json`. Re-installing updates in place
  and removes anything you deleted from the harness. `uninstall` removes exactly what was added.
- **Foreign files are never clobbered.** If a skill, command or agent file already exists and this bundle
  did not create it, the install skips it and warns you, unless you pass `--force`.

## Development

```bash
npm test                 # unit tests (node:test)
npm run validate         # validate harness/
npm run build            # build all packages into dist/
```

To support another tool, add an adapter in `lib/targets/` (see [docs/targets.md](docs/targets.md#adding-a-target)).

## License

MIT
