# How the public tree is produced

The public repository is a **generated, sanitized snapshot**, not a normal development branch.

- `scripts/export-public.cjs` copies the publishable file set out of the private development tree,
  strips personal paths and identifiers, refuses to publish credentials or personal data, and writes
  the generated files below.
- `scripts/publish-public.cjs` commits that snapshot as a single commit and force-pushes it to the
  public `main`.

## Generated at the repository root

These root files are written by the export, so edit the `docs/` source instead - a direct edit at the
root is overwritten by the next publish:

| Published file | Source of truth |
| --- | --- |
| `README.md` | `docs/PUBLIC-README.md` |
| `LICENSE` | `docs/PUBLIC-LICENSE.txt` |
| `THIRD-PARTY-NOTICES.md` | `docs/THIRD-PARTY-NOTICES.md` |
| `SECURITY.md`, `.gitignore`, `config/release-trust.json`, `config/remote-relay.json`, `source-inventory.json` | generated inline by the export script |

The copies of the three first files kept in `docs/` are the same bytes, so the published page and its
source cannot drift apart.

`config/release-trust.json` in the public tree carries the public Ed25519 update key: it is a
verification anchor, not a secret.

## Brand assets used by the README

`assets/nodo-mark-mono-black.svg` and `assets/nodo-mark-mono-white.svg` are the monochrome marks
(light and dark GitHub themes) derived from `assets/logo-master.svg`. Keep them alongside the other
brand assets when the tree is regenerated.
