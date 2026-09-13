<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/nodo-mark-mono-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/nodo-mark-mono-black.svg">
    <img src="assets/nodo-mark-mono-black.svg" alt="NODO" width="84" height="84">
  </picture>
</p>

<h1 align="center">NODO</h1>

<p align="center"><strong>Local-first AI agent workspace for macOS</strong></p>

<p align="center">
  <img alt="macOS 13+ Apple Silicon" src="https://img.shields.io/badge/macOS_13+-Apple_Silicon-black?style=flat-square">
  <img alt="Version 1.4.0" src="https://img.shields.io/badge/version-1.4.0-black?style=flat-square">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-black?style=flat-square">
  <a href="https://github.com/stgavs77-ctrl/NODO/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/stgavs77-ctrl/NODO?style=flat-square&label=latest_release&color=black"></a>
</p>

NODO is a desktop environment for running AI agents on real projects: it works in your files, drives
an embedded browser, keeps project memory and rules, runs long tasks in the background, can be
reached from a phone through an encrypted remote, and updates itself from signed releases. Project
state, sessions and credentials stay on your Mac; only the context a request needs goes to the model
provider you configured.

<p align="center">
  <a href="https://github.com/stgavs77-ctrl/NODO/releases/latest"><strong>Download NODO for macOS</strong></a>
</p>

## Download

**[Download NODO for macOS](https://github.com/stgavs77-ctrl/NODO/releases/latest)** - the
ready-to-run binary from the latest GitHub Release (current: **NODO 1.4.0**, `NODO-1.4.0.zip`,
about 345 MB).

- **Apple Silicon (arm64) macOS only**, macOS 13 Ventura or newer.
- Unzip, drag **NODO** into `Applications`, open it.
- You need your own model API key - a DeepSeek key or another supported provider.
- Later versions arrive through NODO's built-in updater: signed checks, one click, no terminal and
  no source build.

You do **not** need to build NODO from source to use it; that is only for development.

> **First launch:** NODO releases are ad-hoc signed, not notarized with an Apple Developer ID yet. macOS
> may report that the app cannot be verified - open it with **Control-click -> Open**, or allow it in
> System Settings -> Privacy & Security -> **Open Anyway**. Keep Gatekeeper, SIP and TCC enabled:
> NODO never asks you to disable them and never collects an administrator password.

## Why NODO

- **Measured context and cost economy.** NODO's context layer decides what actually goes into a
  request and shows what it costs. Across two real measured working periods it cut model spend by
  **43%** and **49%** against the previous context settings - see
  [the measurement](#real-world-measured-workload).
- **Local-first.** Workspaces, sessions, project brain, checkpoints and credentials live on the Mac;
  only the context a request needs is sent to the provider you configured. No telemetry.
- **Work, not just chat.** The agent has real tools: project files, an embedded browser, background
  tasks and integrations - with checkpoints and undo.
- **Updates you can undo.** Signed manifests, an independent installer, a health check after restart
  and automatic rollback of the previous code. Code-only updates keep your data.
- **Reachable without exposing your Mac.** Encrypted Remote is off until you enable and pair it; no
  public port and no shell or generic RPC surface.

## Features

**Agent workspace**

- **AI agent workspace** - one window for conversation, agent tools, project files and background work.
- **DeepSeek as the main working agent** - the default agent runs on the DeepSeek Harness runtime;
  provider balance or usage is shown in the header.
- **Additional providers and models** - the provider layer also covers other API providers and
  OpenAI-compatible endpoints. You connect your own credentials; keys are stored in the macOS Keychain.
- **Codex integration** - the Codex CLI app-server adapter as a second agent runtime.
- **Tasks and background jobs** - long-running delegated work with progress, checkpoints and undo.

**Projects and context**

- **Projects / Workspaces** - every project has its own folder, sessions and state.
- **Project Rules** - persistent instructions the agent follows inside a project.
- **Project Brain / memory** - durable project memory: decisions, facts and context that survive sessions.
- **Smart Context** - decides what actually goes into the request, with a live cache and cost meter.
- **Current State** - a compact, up-to-date snapshot of what the project is and where it stands.
- **Economy / Balanced / Full** - context modes that trade cost against how much context is sent.

**Reach and recovery**

- **Browser** - an embedded browser the agent can drive, behind an explicit security boundary.
- **Telegram integration** - opt-in bridge so the agent can be reached from a phone; connect your own
  bot. Personal live adapters and tokens are not part of this public snapshot.
- **Encrypted Remote** - pair a phone or another Mac over an outgoing encrypted relay; revocable from
  the Mac at any time.
- **Checkpoints and recovery** - code and profile checkpoints with undo.
- **Rescue** - a separate recovery app: verify, repair, roll back and diagnose while the main app is closed.

**Updates**

- **Signed updates** - Ed25519-signed manifest, sha256 verification, update drain, independent installer.
- **Health check and automatic rollback** - if a new build does not start healthy, the previous code
  is restored.
- **User data preserved** - a code-only update replaces application code and keeps profile, sessions
  and project brain; a data migration additionally creates a consistent encrypted backup first.

## Real-world measured workload

<p align="center">
  <strong>43% and 49% lower model spend</strong> &nbsp;·&nbsp;
  <strong>44% and 52% lower average context</strong> &nbsp;·&nbsp;
  <strong>two real measured periods</strong>
</p>

Two real working periods measured on **13 Sep 2026**, not synthetic benchmarks.

**Period 1 - 11 hours of active use (08:00-19:11), 2,139 model requests**

| Measurement | Result |
| --- | --- |
| Actual spend for the period | **$2.59** |
| Estimated cost of the same workload with the previous context settings | ≈ $4.54 |
| **Saved by NODO context / economy optimization** | **≈ $1.95 - about 43%** |
| Average context per request, current optimization | 125,108 tokens |
| Average context per request, previous baseline | 222,306 tokens |
| **Context reduction** | **about 44%** |

**Period 2 - a short 24-minute workload (19:03-19:27), 222 model requests**

| Measurement | Result |
| --- | --- |
| Actual spend for the period | **$0.22** |
| Estimated cost of the same workload with the previous context settings | ≈ $0.43 |
| **Saved by NODO context / economy optimization** | **≈ $0.21 - about 49%** |
| Average context per request, current optimization | 106,315 tokens |
| Average context per request, previous baseline | 222,306 tokens |
| **Context reduction** | **about 52%** |
| Cache hit | 99.0% |

Observed across these two real periods: **NODO model-spend saving 43-49%.**

<sub>
**Method and scope.** These numbers come from two measured periods of real work on one machine, with
NODO's own cache and cost meter plus provider balance deltas as the source; the counterfactual prices
the same requests with the previous settings' baseline cost per request. The windows are short (11
hours and 24 minutes), the absolute amounts are small and the balance is read in $0.01 steps. They
report what happened in those two periods; they are not a guarantee, an average or a promise for every
user. The saving depends on project size, context mode, how much of a workload is cache-friendly and
which provider and model you use.

**Provider off-peak pricing is separate.** Both periods fell on a Sunday, entirely inside DeepSeek's
off-peak window, which reduced provider prices by roughly another 50%. That is an external pricing
effect and is **not** included in the 43% or the 49% above. At peak pricing the same work would have
cost about twice as much (about $0.22 more for period 2 alone). Counting the provider's off-peak
discount and peak pricing together, the effective total spend was roughly **71% lower** for period 1
and roughly **75% lower** for period 2 than the same workload priced with the previous context
settings at peak pricing - a combined effect of NODO optimization **plus** provider pricing, not
NODO's own saving.
</sub>

## How it works

```
User
  |
  v
NODO project and context layer     workspaces, project rules, project brain,
  |                                smart context, checkpoints  -  on your Mac
  v
Selected AI provider               your credentials; only the context a request
  |                                needs is sent out
  v
Browser / Files / Tasks / integrations
  |
  v
Result
```

**Local-first, not local-only.** Workspaces, session history, project brain, checkpoints and
credentials stay on the Mac, and NODO sends no telemetry. Requests themselves do go to the model
provider you configure, so the context needed for a request leaves the machine: NODO does not claim
privacy from your provider, it controls what is sent and shows you the cost.

## Models and providers

NODO is bring-your-own-model: you connect your own API credentials and choose the model, so you pay
your provider directly and are not tied to a NODO subscription.

- **DeepSeek** is the primary, day-to-day agent runtime.
- The same provider layer covers other API providers, including OpenAI-compatible endpoints.
- Credentials are stored in the macOS Keychain, not in this repository and not in plain files.
- Settings -> Provider is where you paste a key; the header shows balance or usage where the provider
  exposes it.

This public repository ships the provider *infrastructure*, never credentials.

## Remote

- The phone uses Safari/PWA and an outgoing-only encrypted WSS relay. There is no public DSH port and
  no phone-side `window.rc`, generic IPC, shell or arbitrary filesystem API.
- Pairing is one-use and time-limited; revoking removes the device credential on the Mac.
- Remote is opt-in and off by default. You can deploy your own relay with your own Cloudflare account
  (`remote-relay/cloudflare/`).
- Public source grants no access to any existing relay or to the author's infrastructure.

## Safe updates and recovery

NODO 1.3.0 introduced the production release and update pipeline:

- **Signed manifest** - an Ed25519 signature over the update manifest, published as `latest.json`.
- **sha256 verification** of the package and its parts before anything is staged.
- **Update drain** - running work finishes; new agent tasks, Telegram events and background jobs are
  queued instead of lost, and continue after the restart.
- **Independent Rescue installer** - completes the update even if the app or DSH is already closed.
- **Health check after restart** and **automatic rollback** of the previous code if the new build does
  not come up healthy.
- **User data preserved** - a `patch` update changes code and runtime only; a `migration` update
  additionally creates a consistent encrypted backup of the profile first.
- **GitHub Releases** as the public distribution channel, so the shipped app can verify what it
  downloads.

This path is not theoretical: production **NODO 1.2.1 was updated to 1.3.0** through it.

## Installation and first run

1. Download `NODO-1.4.0.zip` from [Releases](https://github.com/stgavs77-ctrl/NODO/releases/latest),
   unzip it and drag **NODO** into `Applications`.
2. Open NODO. If macOS blocks the ad-hoc signed build, use **Control-click -> Open** once.
3. **Settings -> Provider**: paste your own API key (stored in the macOS Keychain).
4. **Pick a workspace folder** - the agent reads and writes there.
5. **Settings -> Updates**: channel `Stable`, automatic checks on, install manual or when idle.
6. Optional: **Settings -> Remote** to pair a phone - one QR code plus an explicit confirmation in the
   browser.

## For developers: build from source

Requires Apple Silicon macOS, Xcode command-line tools, a current Node/npm host and Git. Do not
disable Gatekeeper, SIP or TCC. No administrator password is collected by the scripts.

```sh
npm run bootstrap     # pinned dependencies, checksum-verified downloads
npm run build:dev     # build/NODO DEV.app with an isolated DEV profile
npm run release -- --version X.Y.Z --dry-run   # full release check, publishes nothing
```

- Bootstrap accepts only a fresh checkout without `runtime/` or `vendor/`. It runs `npm ci
  --ignore-scripts` with committed locks, downloads official Node with a pinned SHA256 and uses
  Electron's checksum-verified downloader. Codex CLI and Playwright are pinned as well, and DSH UI
  changes are exact-hash checked - a mismatch stops the build instead of applying a fuzzy patch.
- DEV builds use a separate `NODO DEV` profile, port and sandbox, so they cannot touch a normal
  installation.
- The release pipeline (`npm run release -- --version X.Y.Z`) checks the tree, builds a clean
  production app, packs one update artifact, runs integrity and fixture checks, signs the manifest,
  publishes it, tags the source, creates the GitHub Release and verifies that the published release is
  retrievable and correctly signed.
- Source layout: `main.cjs` (Electron host), `lib/` (updater, lifecycle, balance, remote, project
  brain), `extension/` (NODO client UI on DSH), `rescue/` (independent recovery app), `scripts/`
  (build, release, export), `tests/` (`node:test`).
- Build scripts use ad-hoc signatures; no Apple Developer ID or notarization is claimed, so a source
  build is not a notarized public installer.

<!-- Screenshots: none are shipped yet. The list of images to capture and where they belong is in
     docs/SCREENSHOTS-TODO.md. Add them here as a row of 2-4 interface screenshots once they exist;
     do not insert placeholder or mocked images. -->

## Security

- No telemetry, no analytics endpoint, no silent outbound calls beyond the provider you configured.
- API keys live in the macOS Keychain; this repository contains no credentials, no profile, no session
  history and no personal paths.
- Remote is allowlisted and endpoint-encrypted; the update trust anchor in `config/release-trust.json`
  is a public verification key, not a secret.
- NODO never asks to disable Gatekeeper, SIP or TCC and never collects an administrator password.
- Report vulnerabilities without real credentials, chat content or personal data - see
  [`SECURITY.md`](SECURITY.md).

## License

NODO's own source code is MIT - see [`LICENSE`](LICENSE). Third-party components keep their own
licenses and are listed separately in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md); nothing here
relicenses them.

## Author

Created by **Stanislav Galitskiy**.
