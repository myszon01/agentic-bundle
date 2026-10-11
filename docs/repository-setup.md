# Repository setup: protecting `main`

`main` only changes through reviewed pull requests with green CI. The rules are kept in
[`.github/rulesets/main.json`](../.github/rulesets/main.json) so they are versioned and reviewable like code.

## What the ruleset enforces (on the default branch)

| rule | effect |
|------|--------|
| pull request required | No direct pushes; every change lands through a PR. |
| 1 approval, from a code owner | Reviewers come from [`CODEOWNERS`](../.github/CODEOWNERS). |
| stale approvals dismissed, last push must be approved | New commits after an approval need a fresh review. |
| conversations resolved | All review threads must be resolved before merging. |
| status check `ci-ok`, branch up to date | CI (tests on Linux and macOS, Node 18/20/22, build, install round trip) must pass on the latest `main`. `ci-ok` is pinned to GitHub Actions so it can't be faked by another app. |
| squash merge only, linear history | One commit per PR on `main`. |
| no force pushes, no deletion | History on `main` can't be rewritten or removed. |

**Who can commit:** only collaborators with write access can push branches and open PRs from this repo.
Manage them in *Settings → Collaborators*. Nobody can push to `main` directly.

**Bypass:** the repository **Admin** role may bypass the rules *only when merging a pull request*
(`bypass_mode: pull_request`), never with a direct push. This exists because GitHub does not let you approve
your own PR, so a solo maintainer would otherwise be unable to merge anything. Once there is a second
reviewer, delete the `bypass_actors` entry to make review mandatory for everyone.

## Applying it (one time, by a repository admin)

1. *Settings → General → Default branch*: switch the default branch to `main`.
2. *Settings → Rules → Rulesets → New ruleset → Import a ruleset*, choose `.github/rulesets/main.json`, then **Create**.
3. Optional, under *Settings → General → Pull Requests*: turn off merge commits and rebase merging (only squash),
   and turn on *Automatically delete head branches*.

Or with the GitHub CLI:

```bash
gh api -X POST repos/OWNER/REPO/rulesets --input .github/rulesets/main.json
gh api -X PATCH repos/OWNER/REPO -f default_branch=main
```

> **Plan requirement:** GitHub only enforces rulesets on **private** repositories owned by a personal account
> with **GitHub Pro** (or a Team/Enterprise organization). On GitHub Free they are enforced on public
> repositories only.

When you change the ruleset in the GitHub UI, export it (*… → Export ruleset*) and commit it here so the file stays the source of truth.
