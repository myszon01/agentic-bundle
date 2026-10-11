---
name: conventional-commits
description: Write commit messages that follow the Conventional Commits spec. Use when committing changes, drafting a commit message, or squashing a branch.
---

# Conventional Commits

Format every commit message as:

```
<type>(<optional scope>): <imperative summary, max 72 chars>

<optional body: what changed and why, wrapped at 72 chars>

<optional footer: BREAKING CHANGE: ..., Refs: #123>
```

## Types

| type       | use for                                             |
|------------|-----------------------------------------------------|
| `feat`     | a new user-facing capability                        |
| `fix`      | a bug fix                                           |
| `docs`     | documentation only                                  |
| `refactor` | code change that neither fixes a bug nor adds a feature |
| `perf`     | performance improvement                             |
| `test`     | adding or fixing tests                              |
| `build`    | build system or dependencies                        |
| `ci`       | CI configuration                                    |
| `chore`    | anything else that does not touch src or tests      |

## Rules

1. Summary in the imperative mood ("add", not "added"), no trailing period.
2. Mark breaking changes with `!` after the type/scope **and** a `BREAKING CHANGE:` footer.
3. Inspect the staged diff (`git diff --cached`) before writing the message; describe what it actually does.
