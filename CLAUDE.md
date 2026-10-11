# agentic-bundle — contributor notes

- Zero runtime dependencies; Node >= 24 (CI tests 24 LTS and 26 current; `.nvmrc` pins the newest), ESM. Keep it that way.
- `harness/` is example *content* (replaced in repos made from this template; tests use `test/fixtures/harness`); `lib/` is the tool. Tool-specific knowledge belongs only in `lib/targets/<id>.js` (and tool names in `lib/tools.js`).
- Adapters return entries (`file` / `block` / `json`); never write to disk from an adapter.
- Run `npm test` and `node bin/agentic-bundle.js validate` before committing. Update `docs/targets.md` when a target's paths change.
