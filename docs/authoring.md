# Authoring a harness

Everything you ship lives in `harness/`. Edit these files, then run `agentic-bundle validate`.

```
harness/
├── bundle.json           # name, version, metadata, default targets
├── AGENTS.md             # shared instructions (always-on context)
├── skills/<name>/        # Agent Skills: SKILL.md + any scripts/resources
├── commands/<name>.md    # slash commands / prompt templates
├── agents/<name>.md      # subagents
└── mcp.json              # MCP servers
```

Commands and agents sit directly in `commands/` and `agents/`, and each skill in `skills/<name>/SKILL.md`.
Files one level deeper, such as `commands/git/commit.md` or `skills/group/my-skill/SKILL.md` (without a
`skills/group/SKILL.md`), are not loaded; `validate` warns about them. Flatten them (`commands/git-commit.md`,
`skills/my-skill/`). Other files inside a skill, such as references and scripts, are fine.

To keep the harness somewhere else (for example in a dotfiles repo), pass `--source <dir>`. Without
`--source` and without `./harness/bundle.json` in the current directory, the CLI uses the harness bundled
with the package (that is how `npx <package> install` works) and prints which one it is using.

## Frontmatter

Skills, commands and agents start with YAML frontmatter. agentic-bundle reads the subset agent tools use:
plain, quoted and multi-line strings (continuation lines indented more than the key), inline and block
lists, block lists of maps (for example Claude Code `hooks:`), nested maps and block scalars (`|`, `>`).
As in YAML, a continuation line of a plain string cannot be a `key: value` pair: a more-indented
`key: value` line is reported as unexpected indentation rather than joined into the string above it.
Anchors, tags and multi-document files are not supported. A leading UTF-8 byte order mark is ignored.
Parse errors name the file and the line, e.g. `harness/agents/x.md: frontmatter: cannot parse line 4: …`.

## bundle.json

| field         | required | notes |
|---------------|----------|-------|
| `name`        | yes      | kebab-case. Used as the plugin/extension/package name and in managed-block markers. |
| `version`     | no       | semver, default `0.0.0`. |
| `description` | no       | Shown in plugin/extension listings. |
| `author`      | no       | `{ "name", "email", "url" }`. |
| `license`, `homepage`, `repository`, `keywords` | no | Copied into package manifests. |
| `targets`     | no       | Default target list when none is given on the command line. Unknown ids fail `validate`. |
| `npm.scope`   | no       | npm scope for the per-tool packages (`build --npm`), e.g. `@acme` → `@acme/<name>-claude`. |
| `npm.access`  | no       | `"public"` (default) or `"restricted"` (private). Written to each package's `publishConfig`. A restricted package needs a scope, from `npm.scope` or `build --npm --npm-scope`; `build --npm` fails without one. See [distribution.md](distribution.md). |

## AGENTS.md — instructions

Plain Markdown. It is written into each tool's instruction file (`CLAUDE.md`, `AGENTS.md`) as a
**managed block**, so any instructions already in those files are left alone.

Keep it under 32 KiB. Codex reads only the first 32 KiB by default (`project_doc_max_bytes`) and silently
drops the rest, so `validate` warns about a longer file when Codex is one of the bundle's targets. Move
details into skills.

## Skills

Skills follow the open [Agent Skills](https://agentskills.io) format and are copied **unchanged**
(including executable bits on scripts) to every target that supports them.

```markdown
---
name: code-review            # must equal the directory name; kebab-case, ≤ 64 chars
description: What it does and when to use it.   # required, ≤ 1024 chars
---

Instructions…
```

## Commands

`commands/<name>.md` becomes `/name` in each tool.

```markdown
---
description: Review the current changes        # required
argument-hint: "[path]"                        # optional
tools: [read, grep, bash]                      # optional, canonical names (see below)
model: { claude: sonnet }                      # optional, string or per-target map
agent: build                                   # optional, OpenCode only
targets: [claude, codex]                      # optional, restrict to these targets
---

Review $ARGUMENTS using the code-review skill.
```

Write `$ARGUMENTS` for the user's arguments; it is rewritten where a tool needs it.

`targets` (on commands, agents and MCP servers) may only name known targets (`claude`, `opencode`, `pi`,
`codex`); `validate` rejects anything else, since a typo would silently drop the item. A removed target
(such as `gemini`) is a warning.

Model ids are tool-specific. A plain string (`model: sonnet`) is written as-is for Claude Code and
OpenCode. OpenCode expects `provider/model-id`, so `build` and `install` warn when an OpenCode model has no
provider prefix. Use a per-target map (`model: { claude: sonnet, opencode: anthropic/<model-id> }`;
`default` is the fallback). Codex custom prompts have no model field, so for Codex a command's model (a
plain string, or a `codex` or `default` entry) is dropped with a warning.

## Agents

`agents/<name>.md` becomes a subagent where the tool supports them.

```markdown
---
description: When to delegate to this agent     # required
tools: [read, grep, glob]                       # optional; omit for all tools
model:                                          # optional, string or per-target map
  claude: haiku
  opencode: anthropic/claude-haiku-5-5
mode: subagent                                  # optional, OpenCode only (default subagent)
targets: [claude, opencode]                     # optional
---

System prompt for the agent…
```

For Codex, an agent's model comes only from a `codex` (or `default`) entry of a per-target map
(`model: { claude: haiku, codex: <model-id> }`). A plain string is not used for Codex (model ids are
tool-specific), and `build` / `install` warn about it.

The Claude Code subagent file gets `name`, `description`, `tools` and `model` only. Other fields, such as
Claude Code's `hooks`, `color` or `permissionMode`, are not carried over, and `build` / `install` warn
about them.

## Canonical tool names

| canonical  | Claude Code | OpenCode    | pi     |
|------------|-------------|-------------|--------|
| `read`     | Read        | read        | read   |
| `write`    | Write       | write       | write  |
| `edit`     | Edit        | edit        | edit   |
| `bash`     | Bash        | bash        | bash   |
| `grep`     | Grep        | grep        | grep   |
| `glob`     | Glob        | glob        | find   |
| `list`     | Glob ¹      | list        | ls     |
| `webfetch` | WebFetch    | webfetch    | —      |
| `websearch`| WebSearch   | websearch   | —      |
| `todo`     | TaskCreate, TaskGet, TaskList, TaskUpdate, TodoWrite ² | todowrite | — |

¹ Claude Code has no `LS` tool; it lists directories with Glob, or `ls` through Bash.
² Claude Code turns TodoWrite off by default in favour of the four Task tools (`CLAUDE_CODE_ENABLE_TASKS=0`
brings it back), so both are listed. Claude Code drops the names a session lacks.

Any other name is passed through unchanged (with a validation warning), so you can still use tool-specific
names such as `mcp__fetch__fetch`, ideally together with `targets:`.

## mcp.json

```json
{
  "servers": {
    "fetch":  { "command": "uvx", "args": ["mcp-server-fetch"] },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
      "targets": ["claude", "opencode", "codex"]
    }
  }
}
```

| field       | notes |
|-------------|-------|
| `command`, `args`, `env`, `cwd` | stdio server. |
| `url`, `headers`, `transport`   | remote server; `transport` is `http` (default) or `sse`. |
| `targets`   | optional target filter. |

Reference environment variables as `${VAR}`. They are converted per tool: kept as-is for Claude Code, `{env:VAR}` for OpenCode, and `env_vars` / `bearer_token_env_var` / `env_http_headers`
for Codex. Codex expands references only through `env` and `headers`: a `${VAR}` in `command`, `args`, `url`
or `cwd` is written literally, and `build` / `install` warn about it. Pass the value through `env` (or a
header whose whole value is `${VAR}`), or leave `codex` out of that server's `targets`.

**Never put secret values in `mcp.json`.** `validate` warns when a literal `env` or `headers` value looks
like a token (for example `ghp_…`, `github_pat_…`, `sk-…`, `xoxb-…`, `AKIA…`, `glpat-…`, `npm_…`, a private
key, or `Bearer` / `Basic` followed by a literal). The warning names the server and key, never the value.
Obvious placeholders such as `<token>`, `your-…`, `xxxx` or `changeme` are not reported.
