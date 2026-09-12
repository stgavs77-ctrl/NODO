# DEV opaque relay

This is an unhosted development component. It is not deployed, does not create accounts, and is not a pairing service.

It exposes two WebSocket paths behind an HTTPS/WSS reverse proxy:

- `/v1/host` - requires `Authorization: Bearer <256-bit host credential>`; the relay compares its SHA-256 digest to `RELAY_OWNER_TOKEN_SHA256` in constant time.
- `/v1/phone` - carries no relay privilege. A phone can only attach to a room already registered by an authenticated Host.

The Host sends a one-time JSON `register` control frame and a phone sends an `attach` frame. A room ID never authenticates a Host. Pairing is deliberately outside this process: the Host must issue, expiry-check, consume once, and verify the phone's pairing material before accepting the endpoint-encrypted payload.

After setup, endpoints exchange strict JSON envelopes with an opaque base64url `frame`. The relay only checks its encoded size and routing `connectionId`; it never decrypts or interprets the frame and never logs it. A phone's `connectionId` is relay-generated and announced to the Host as `phone_connected`; the Host targets replies with `to_phone`, while the phone uses `to_host`. The endpoints, not this service, are responsible for application-layer encryption and peer authentication. Do not describe this as Noise or E2EE until those endpoints actually implement and verify a protocol.

## Development boundary

The listener defaults to `127.0.0.1:8787`. A production deployment would need a separate HTTPS reverse proxy that preserves WSS, terminates TLS, limits public origins, and injects no authentication. Set the following only in a local deployment environment, never in source control:

```text
RELAY_OWNER_TOKEN_SHA256=<sha256 of a random 256-bit host credential>
RELAY_ALLOWED_ORIGINS=https://phone.example
RELAY_BIND=127.0.0.1
RELAY_PORT=8787
```

The Host credential must go in the HTTP `Authorization` header, never a URL, QR code, room ID, log, or browser storage. The reverse proxy must accept only the declared HTTPS origin. This relay limits rooms, peers, frame size, per-peer rate, setup time, and idle lifetime; it stores no messages or credentials.

The test suite uses the existing bundled `ws` package only as a local dependency source. Run it with a local Node environment that provides `ws`; it neither starts a persistent listener nor makes network calls outside loopback.
