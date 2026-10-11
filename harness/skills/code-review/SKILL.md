---
name: code-review
description: Review a diff or set of files for correctness, security and maintainability issues. Use when asked to review code, a pull request, or the current changes.
---

# Code review

1. Collect the change. If nothing specific was given, run `scripts/changed-files.sh` to list files changed against the default branch, then read the diff.
2. Review in this order, and stop to report anything severe:
   1. **Correctness** — logic errors, unhandled edge cases, broken error handling, race conditions.
   2. **Security** — injection, unsafe deserialization, secrets in code, missing authorization checks.
   3. **Tests** — is the new behaviour covered? Do existing tests still make sense?
   4. **Maintainability** — naming, duplication, dead code, unclear abstractions.
3. For each finding give: file and line, what is wrong, a concrete failure scenario, and a suggested fix.
4. Finish with a one-line verdict: *ship it*, *ship with nits*, or *needs changes*.

Do not report style nits that a formatter or linter would catch.
