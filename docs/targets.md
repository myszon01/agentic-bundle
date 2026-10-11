# Targets

Where each part of the harness goes. Paths are relative to the project directory (`--scope project`)
or the tool's user config directory (`--scope user`).

These tools change quickly. If a path drifts, the fix is usually a one-line change in `lib/targets/<id>.js`.

## Claude Code (`claude`)

| harness       | project                          | user                       | package (`dist/claude`) |
|---------------|----------------------------------|----------------------------|-------------------------|
| AGENTS.md     | `CLAUDE.md` (managed block)      | `~/.claude/CLAUDE.md`      | `AGENTS.md` + `SessionStart` hook that prints it |
| skills        | `.claude/skills/<name>/`         | `~/.claude/skills/`        | `skills/` |
| commands      | `.claude/commands/<name>.md`     | `~/.claude/commands/`      | `commands/` |
| agents        | `.claude/agents/<name>.md`       | `~/.claude/agents/`        | `agents/` |
| MCP           | `.mcp.json` → `mcpServers`       | `~/.claude.json` → `mcpServers` | `.mcp.json` |

The package is a Claude Code **plugin** with its own single-plugin `marketplace.json`:

```
/plugin marketplace add ./dist/claude
/plugin install agentic-bundle@agentic-bundle
```

## OpenCode (`opencode`)

| harness   | project                         | user (`~/.config/opencode`) |
|-----------|---------------------------------|-----------------------------|
| AGENTS.md | `AGENTS.md` (managed block)     | `AGENTS.md`                 |
| skills    | `.opencode/skills/<name>/`      | `skills/`                   |
| commands  | `.opencode/commands/<name>.md`  | `commands/`                 |
| agents    | `.opencode/agents/<name>.md` (`mode: subagent`, tools as a `permission` map: `"*": deny` plus the listed tools) | `agents/` |
| MCP       | `opencode.json` → `mcp` (`local` / `remote`) | `opencode.json` |

The package is the project layout; copy `dist/opencode/.` into a repository. `opencode.jsonc` files with
comments are not merged automatically; the installer prints the keys to add by hand. OpenCode also loads
`~/.claude/skills` and `~/.agents/skills` by default (`OPENCODE_DISABLE_EXTERNAL_SKILLS=1` turns that off),
so skills installed for other tools can show up twice.

## pi (`pi`)

| harness   | project                       | user (`~/.pi/agent`) |
|-----------|-------------------------------|----------------------|
| AGENTS.md | `AGENTS.md` (managed block)   | `AGENTS.md`          |
| skills    | `.pi/skills/<name>/`          | `skills/`            |
| commands  | `.pi/prompts/<name>.md` (`$ARGUMENTS` supported natively) | `prompts/` |
| agents    | not built in (skipped with a warning; see `examples/extensions/subagent` in pi-mono) | |
| MCP       | not supported by design (skipped with a warning; write a pi extension if you need it) | |

The package is a **pi package** (`package.json` with a `pi` manifest):

```
pi install ./dist/pi
```

`PI_CODING_AGENT_DIR` overrides the user directory.

## Codex CLI (`codex`)

| harness   | project                           | user (`~/.codex`, or `$CODEX_HOME`) |
|-----------|-----------------------------------|-------------------------------------|
| AGENTS.md | `AGENTS.md` (managed block)       | `AGENTS.md`                         |
| skills    | `.agents/skills/<name>/`          | `skills/`                           |
| commands  | not available per project (warning) | `prompts/<name>.md` (deprecated by Codex in favour of skills) |
| agents    | `.codex/agents/<name>.toml` (`developer_instructions`; `tools` dropped, `model` only from a `codex` key) | `agents/` |
| MCP       | `.codex/config.toml` (managed block) | `config.toml` (managed block)    |

Codex only reads a project's `.codex/config.toml` once that project is **trusted**, either by accepting
the trust prompt or with `[projects."<path>"] trust_level = "trusted"` in `~/.codex/config.toml`.
The package mirrors `~/.codex`. Copy it in and append `config.toml` to your existing one.

## Adding a target

1. Create `lib/targets/<id>.js` that exports `{ id, label, supports, install(bundle, ctx), package(bundle, ctx), npmUsage({ name, cli, bundle }) }`.
   `npmUsage` returns the Markdown install steps for the README of the tool's npm package.
   Both functions return entries (`file`, `block` or `json`, see `lib/targets/common.js`). The writer handles
   merging, manifests and uninstalling.
2. Register it in `lib/targets/index.js`, and add tool names to `lib/tools.js` if the tool supports subagents.
3. Add a test in `test/targets.test.js` and a section to this file. CI and the release workflow pick up the
   new target automatically (`scripts/packages.js`).
