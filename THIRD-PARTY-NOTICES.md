# Third-party notices

NODO's own original source code is MIT (`LICENSE`).

That license covers NODO's own code only. Bundled, vendored or downloaded third-party components are
**not** relicensed by it and remain under their own terms, listed below.

| Component | Version | License | Where |
| --- | --- | --- | --- |
| DeepSeek Harness (DSH) client/runtime packages | 0.1.5-rc.1 | MIT | `third-party/DSH-LICENSE`, vendored under `runtime/` (not published) |
| Codex CLI app-server | 0.151.0 | Apache-2.0 | `third-party/Codex-LICENSE` |
| Electron / Chromium and bundled components | 44.3.0 | BSD-3-Clause and component licenses | downloaded by the build, not published |
| Node.js | 26.8.2 | MIT | downloaded by the build, not published |
| Playwright | 1.63.0-alpha-2026-08-31 | Apache-2.0 | DEV/test tooling only |
| Inter (UI typeface, if bundled) | - | SIL Open Font License 1.1 | `assets/` |

Notes:

- `patches/bootstrap.json` contains exact-hash fragments of DSH client files. Those fragments stay
  under the DSH (MIT) terms and are reproduced only to keep the pinned UI change applicable.
- Runtime binaries (Node, Electron, Codex, DSH packages) are **not** part of this repository; the
  bootstrap downloads them from their official sources with pinned checksums.
- Do not describe third-party components as MIT NODO code. When redistributing a built NODO
  application, ship this file together with the application.
