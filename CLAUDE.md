# agentic-bundle — contributor notes

- Zero runtime dependencies; Node >= 18.17, ESM. Keep it that way.
- `harness/` is example *content*; `lib/` is the tool. Tool-specific knowledge belongs only in `lib/targets/<id>.js` (and tool names in `lib/tools.js`).
- Adapters return entries (`file` / `block` / `json`); never write to disk from an adapter.
- Run `npm test` and `node bin/agentic-bundle.js validate` before committing. Update `docs/targets.md` when a target's paths change.
