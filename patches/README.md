# Pinned runtime UI patches

`node scripts/prepare-patches.cjs` applies reproducible patches to runtime; `--check` validates without writes. Package versions and complete SHA-256 hashes must match. All targets validate before any write. Repeated application is a no-op; incompatible upstream versions/hashes fail explicitly.

`ui.json` records the diff from original DSH 0.1.5-rc.1 client files. Throttles streaming markdown at 80 ms and retains composer focus recovery. Keyboard diagnostics are disabled unless `window.__nodoComposerDiagnostics === true` before composer mount. It records event types, never typed characters. A page reload clears this opt-in. Renderer CPU improvements still need a measured real-stream comparison.

REAPER integration: `config/reaper.patch.yml` uses the locally configured executable and composition profile. It is prepared only, not activated or live-tested. Isolated DEV blocks all external MCP even if the opt-in environment flag is set. A future non-isolated profile must explicitly include this patch and set `NODO_ENABLE_REAPER=1`. No REAPER project/session was touched.

The test suite verifies MCP initialization, tools/list and a synthetic read-only probe using paired in-memory SDK transports. This proves the mock protocol path only, not the real REAPER stdio server or DAW connection.
