# NODO Remote relay

Separate Cloudflare Workers Free deployment. It does not publish a Mac listener,
DSH server, profile, model credential or native API. Static PWA + one bounded
SQLite Durable Object forwards opaque endpoint-encrypted frames.

Deploy only `wrangler.jsonc` in this directory with Wrangler 4.131.1. Do not
modify existing Workers, DNS, account plan or other Cloudflare resources.
`wrangler login --use-keyring --scopes account:read user:read workers_scripts:write`
keeps the deployment credential encrypted with its key in macOS Keychain.

The dedicated Mac host key is provisioned by `scripts/remote-keychain.swift`.
It never overwrites an existing item or emits the bearer key. Pipe the emitted
SHA-256 verifier into `wrangler secret put RELAY_OWNER_TOKEN_SHA256`.
No key belongs in source, build assets, CLI arguments, or log output.

Limits: 8 total sockets, of which at most 6 are anonymous phone handshakes,
2 ready phones per room, 5-second handshake, 15-minute idle expiry, 64 frames
per 10 seconds per socket. A 2 MiB application-frame limit is enforced after
Cloudflare receives the frame, not at the network edge. Anonymous clients may
temporarily consume handshake slots; these limits are not a guarantee against
distributed denial of service. Free-tier exhaustion fails unavailable, not paid
upgrade. Endpoint authentication and ciphertext validation remain on the Mac.

`/health` is only public transport/configuration health, never proof NODO is up.
The relay stores socket metadata through the hibernation API, never ciphertext
or chat history in application storage. Runtime logs are disabled. This does
not remove Cloudflare's ordinary network/operational metadata.

Tests:
- `tests/remote-cloudflare.test.cjs` - isolated actual workerd via Miniflare.
- `tests/remote-cloudflare-live.cjs` - explicit deployed-relay test using only
  in-memory synthetic sessions/devices. Reads the dedicated Keychain key, never
  the working NODO profile. Also verifies the public PWA in mobile Chromium.

Neither test is real Safari/iPhone/LTE acceptance or a live DSH model turn.
