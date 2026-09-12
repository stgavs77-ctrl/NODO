# NODO 1.0.0

Local-first macOS agent workspace for DeepSeek Harness, with an embedded Browser, Codex app-server adapter, Tasks, checkpoints, encrypted Remote and a signed updater.

This is a sanitized source distribution. It contains no working profile, credentials, private Git history or personal relay configuration. It does not grant access to the author's infrastructure. Public Remote/Updates configuration defaults to disabled.

## Build from public dependencies

Requires Apple Silicon macOS, Xcode command-line tools, a current Node/npm host and Git. Do not disable Gatekeeper, SIP or TCC. No administrator password is collected by the scripts.

```sh
npm run bootstrap
npm run build:dev
```

Bootstrap accepts only a fresh checkout without `runtime/` or `vendor/`. It runs `npm ci --ignore-scripts` with the committed locks, downloads official Node 26.8.2 with a pinned SHA256, and uses Electron 44.3.0's checksum-verified downloader. Codex 0.151.0 and Playwright 1.63.0-alpha-2026-08-31 are pinned. DSH 0.1.5-rc.1 UI changes are exact-hash checked. A mismatch stops the build instead of applying a fuzzy patch. No installed NODO files or Keychain credentials are copied.

Output: `build/NODO DEV.app`. DEV uses a separate `NODO DEV` profile and sandbox. `npm run build:release` makes a normal-profile application; do not replace an existing installation by copying it blindly. Build scripts use ad-hoc signatures; no Apple Developer ID/notarization is claimed.

Bootstrap and DEV build were exercised on macOS arm64 with a clean npm dependency tree. Intel, Windows and Linux application builds are not supported by this release.

## First use and optional services

Configure your own provider/model in Harness Settings. An absent legacy DeepSeek Keychain item no longer prevents the server from starting. Existing provider credentials are not distributed. Codex requires your own supported sign-in.

New profiles do not automatically start Telegram or observer adapters. Existing configured adapters remain enabled during updates. Legacy adapters contain explicit placeholder paths; configure and test them before opting in. They are not a universal Telegram service installer. REAPER is also opt-in.

## Remote

The phone uses Safari/PWA and an outgoing-only WSS relay. There is no public DSH port and no phone `window.rc`, generic IPC, shell or arbitrary filesystem API. Pairing is one-use and time-limited. Open the QR link in Safari before pressing the explicit pairing button; iOS Code Scanner has separate storage. Revoke removes the device credential on the Mac.

Deploy your own worker using `remote-relay/cloudflare/wrangler.jsonc`, with your own Cloudflare account and host credential. The source includes local helpers for dedicated Keychain items; never commit credential values. The relay credential is not the QR pairing secret. See `remote-relay/cloudflare/README.md` for the transport contract and limits. No shared author-hosted relay is configured here.

Remote displays the latest 60 messages and text stream snapshots. Mobile attachment upload and older-history pagination are outside this release. Network reachability is carrier-dependent; VPN-free LTE access is not guaranteed.

## Updates and recovery

Your distribution must configure its own HTTPS manifest endpoint and pinned Ed25519 public key. `npm run release -- --url https://your-host.example/NODO-1.0.0.zip` builds and signs a package using a dedicated release key. `--prepare-only` builds without touching signing credentials; `scripts/sign-prepared-release.cjs` validates prepared bytes before signing later. Nothing publishes or installs automatically.

The updater validates signed manifest, per-part and full archive hashes and bundle integrity. It drains configured services, refuses unknown writers, and invokes Rescue. A code-only patch retains previous code without rolling back newer user history. A data migration additionally requires a consistent encrypted backup and a verified recovery key. No name-based force kill is part of the normal path.

## Tests

After bootstrap:

```sh
node --test tests/feature-settings.test.cjs tests/optional-services.test.cjs tests/remote-api.test.cjs tests/remote-pairing.test.cjs tests/remote-view.test.cjs tests/release-signature.test.cjs
node tests/lifecycle-host.cjs
node tests/renderer-guard.cjs
```

Other tests cover isolated TLS mobile/revoke, native backup, updater failure rollback, service drain, usage and attachments. Read each integration test's fixture requirements before running. Mobile-browser tests currently use an installed Google Chrome executable, not real iOS Safari.

## Distribution boundaries

No personal binary package is included in this source repository. Third-party source licenses are retained under `third-party/`; bootstrap retains Node and Electron/Chromium notices in the generated runtime. A general-user binary release still needs its own complete dependency notice review and Apple signing/notarization workflow. A successful source build is not an Apple-notarized public installer.
