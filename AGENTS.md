# AGENTS.md

Instructions for Codex and other agents working on this repository.

The canonical project rules live in [`CLAUDE.md`](CLAUDE.md) (Russian). Read it first, then
`docs/project/STATE.md`, `docs/project/ROADMAP.md` and `docs/project/DECISIONS.md`.

Short version:
- NODO is an Electron macOS agent workspace. DeepSeek (DSH runtime) is the main model, Codex is the
  second runtime. Claude integration and security-hardening work are deferred by the owner.
- Run `npm test` before and after a change and compare the failures. Linux runs have known
  environment-only failures, listed in CLAUDE.md. A change must not add new failures.
- Keep the dense CommonJS style. Make targeted edits and never reformat whole files. Add a
  `node:test` regression test for every bug fix. Run `npm run inventory` after you change listed
  sources.
- At the end of a session, update `docs/project/STATE.md` (log + next step) and tick
  `docs/project/ROADMAP.md`.
