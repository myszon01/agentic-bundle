# Working agreements

These instructions are shared by every coding agent this harness is installed into.

## How to work

- Read the relevant code before changing it; match the surrounding style, naming and comment density.
- Prefer small, focused changes. Do not refactor unrelated code in the same change.
- Run the project's own checks (tests, linter, type checker) before declaring work done, and report failures honestly.
- Ask before destructive or hard-to-reverse actions (deleting data, force-pushing, rewriting history).

## Commits

- Use Conventional Commits (`type(scope): summary`). The `conventional-commits` skill has the details.
- One logical change per commit; explain *why* in the body when it is not obvious.

## Reviews

- When asked to review, use the `code-review` skill and lead with correctness issues before style.
