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

To keep the harness somewhere else (for example in a dotfiles repo), pass `--source <dir>`.

## bundle.json

| field         | required | notes |
|---------------|----------|-------|
| `name`        | yes      | kebab-case. Used as the plugin/extension/package name and in managed-block markers. |
| `version`     | no       | semver, default `0.0.0`. |
| `description` | no       | Shown in plugin/extension listings. |
| `author`      | no       | `{ "name", "email", "url" }`. |
| `license`, `homepage`, `repository`, `keywords` | no | Copied into package manifests. |
| `targets`     | no       | Default target list when none is given on the command line. |
| `npm.scope`   | no       | npm scope for the per-tool packages (`build --npm`), e.g. `@acme` → `@acme/<name>-claude`. |

## AGENTS.md — instructions

Plain Markdown. It is written into each tool's instruction file (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`) as a
**managed block**, so any instructions already in those files are left alone.

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
targets: [claude, gemini]                      # optional, restrict to these targets
---

Review $ARGUMENTS using the code-review skill.
```

Write `$ARGUMENTS` for the user's arguments; it is rewritten where a tool needs it (`{{args}}` for Gemini).

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

## Canonical tool names

| canonical  | Claude Code | OpenCode    | Gemini CLI            | pi     |
|------------|-------------|-------------|-----------------------|--------|
| `read`     | Read        | read        | read_file             | read   |
| `write`    | Write       | write       | write_file            | write  |
| `edit`     | Edit        | edit        | replace               | edit   |
| `bash`     | Bash        | bash        | run_shell_command     | bash   |
| `grep`     | Grep        | grep        | grep_search           | grep   |
| `glob`     | Glob        | glob        | glob                  | find   |
| `list`     | LS          | list        | list_directory        | ls     |
| `webfetch` | WebFetch    | webfetch    | web_fetch             | —      |
| `websearch`| WebSearch   | websearch   | google_web_search     | —      |
| `todo`     | TodoWrite   | todowrite   | write_todos           | —      |

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
      "targets": ["claude", "opencode", "gemini"]
    }
  }
}
```

| field       | notes |
|-------------|-------|
| `command`, `args`, `env`, `cwd` | stdio server. |
| `url`, `headers`, `transport`   | remote server; `transport` is `http` (default) or `sse`. |
| `targets`   | optional target filter. |

Reference environment variables as `${VAR}`. They are converted per tool: kept as-is for Claude Code
and Gemini CLI, `{env:VAR}` for OpenCode, and `env_vars` / `bearer_token_env_var` / `env_http_headers`
for Codex. **Never put secret values in `mcp.json`.**
