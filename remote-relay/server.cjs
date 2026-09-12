'use strict';
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_ROOMS = 100;
const MAX_PEERS_PER_ROOM = 2;
const MAX_TOTAL_PEERS = 200;
const HANDSHAKE_MS = 5_000;
const IDLE_MS = 15 * 60_000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 64;
const roomPattern = /^[A-Za-z0-9_-]{16,80}$/;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function validHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }
function safeEqual(left, right) {
  if (!validHash(left) || !validHash(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function parseOrigin(value) { try { return new URL(value).origin; } catch { return null; } }

function createRelay(options = {}) {
  const ownerHash = options.ownerTokenHash;
  if (!validHash(ownerHash)) throw new Error('RELAY_OWNER_TOKEN_SHA256 must be a SHA-256 hex digest.');
  const allowedOrigins = new Set((options.allowedOrigins || []).map(parseOrigin).filter(Boolean));
  if (allowedOrigins.size === 0) throw new Error('At least one allowed HTTPS origin is required.');
  const rooms = new Map();
  const webRoot = options.webRoot || path.resolve(__dirname, '../remote-web');
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/client.js', ['client.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
    ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
    ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ]);
  let peers = 0;
  const server = http.createServer((request, res) => {
    if (request.method !== 'GET') { res.statusCode = 405; return res.end(); }
    const entry = assets.get(new URL(request.url, 'http://relay.invalid').pathname);
    if (!entry) { res.statusCode = 404; return res.end(); }
    const file = path.join(webRoot, entry[0]);
    // `entry[0]` is selected only from the fixed map above, never from request input.
    fs.readFile(file, (error, body) => {
      if (error) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', entry[1]);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self' wss://" + request.headers.host);
      res.end(body);
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  function close(ws, code = 1008) { if (ws.readyState === WebSocketServer.prototype.OPEN || ws.readyState === 1) ws.close(code); }
  function remove(ws) {
    clearTimeout(ws.handshakeTimer);
    if (ws.room) {
      const room = rooms.get(ws.room);
      if (room) {
        if (room.host === ws) { for (const peer of room.peers.values()) close(peer, 1012); rooms.delete(ws.room); }
        else if (ws.connectionId !== undefined) {
          room.peers.delete(ws.connectionId);
          if (usable(room.host)) room.host.send(JSON.stringify({ type: 'phone_disconnected', connectionId: ws.connectionId }));
        }
      }
    }
    if (ws.counted) { ws.counted = false; peers--; }
  }
  function usable(ws) { return ws && ws.readyState === 1; }
  function rateOk(ws) {
    const now = Date.now();
    ws.rate = ws.rate.filter(t => now - t < RATE_WINDOW_MS);
    if (ws.rate.length >= RATE_MAX) return false;
    ws.rate.push(now); return true;
  }
  function parseControl(data) {
    if (!Buffer.isBuffer(data) && typeof data !== 'string') return null;
    try { const value = JSON.parse(String(data)); return value && typeof value === 'object' ? value : null; } catch { return null; }
  }
  function attach(ws, control) {
    if (!control || typeof control.roomId !== 'string' || !roomPattern.test(control.roomId)) return close(ws);
    const roomId = control.roomId;
    if (ws.kind === 'host') {
      if (control.type !== 'register' || rooms.has(roomId) || rooms.size >= MAX_ROOMS) return close(ws);
      rooms.set(roomId, { host: ws, peers: new Map() }); ws.room = roomId; ws.ready = true;
    } else {
      const room = rooms.get(roomId);
      if (control.type !== 'attach' || !room || !usable(room.host) || room.peers.size >= MAX_PEERS_PER_ROOM) return close(ws);
      ws.connectionId = crypto.randomUUID(); room.peers.set(ws.connectionId, ws); ws.room = roomId; ws.ready = true;
    }
    clearTimeout(ws.handshakeTimer);
    if (ws.kind === 'phone') rooms.get(ws.room).host.send(JSON.stringify({ type: 'phone_connected', connectionId: ws.connectionId }));
    ws.send(JSON.stringify(ws.kind === 'phone' ? { type: 'connected', connectionId: ws.connectionId } : { type: 'ready' }));
  }
  function relay(ws, data, isBinary) {
    if (!ws.ready) return attach(ws, parseControl(data));
    if (isBinary || !rateOk(ws)) return close(ws);
    const envelope = parseControl(data);
    if (!envelope || typeof envelope.connectionId !== 'string' || typeof envelope.frame !== 'string' || envelope.frame.length>MAX_FRAME_BYTES-512 || !/^[A-Za-z0-9_-]+$/.test(envelope.frame)) return close(ws);
    let frame; try { frame = Buffer.from(envelope.frame, 'base64url'); } catch { return close(ws); }
    if (frame.length === 0 || frame.length > MAX_FRAME_BYTES) return close(ws);
    const room = rooms.get(ws.room); if (!room) return close(ws, 1011);
    if (ws.kind === 'host') {
      if (envelope.type !== 'to_phone') return close(ws);
      const peer = room.peers.get(envelope.connectionId); if (!usable(peer)) return;
      peer.send(JSON.stringify({ type: 'from_host', connectionId: peer.connectionId, frame: envelope.frame }));
    } else {
      if (envelope.type !== 'to_host' || envelope.connectionId !== ws.connectionId || !usable(room.host)) return close(ws);
      room.host.send(JSON.stringify({ type: 'from_phone', connectionId: ws.connectionId, frame: envelope.frame }));
    }
  }
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://relay.invalid');
    let kind = url.pathname === '/v1/host' ? 'host' : url.pathname === '/v1/phone' ? 'phone' : null;
    const origin = parseOrigin(request.headers.origin);
    // Both endpoint types must originate from an explicit browser/app origin.
    if (url.pathname === '/relay') kind = typeof request.headers.authorization === 'string' ? 'host' : 'phone';
    if (!kind || !origin || !allowedOrigins.has(origin) || peers >= MAX_TOTAL_PEERS) { socket.destroy(); return; }
    if (kind === 'host') {
      const auth = request.headers.authorization;
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!safeEqual(sha256(token), ownerHash)) { socket.destroy(); return; }
    }
    wss.handleUpgrade(request, socket, head, ws => {
      ws.kind = kind; ws.ready = false; ws.room = undefined; ws.counted = true; ws.rate = []; peers++;
      ws.handshakeTimer = setTimeout(() => close(ws), HANDSHAKE_MS);
      ws.lastActivity = Date.now();
      ws.on('message', (data, isBinary) => { ws.lastActivity = Date.now(); relay(ws, data, isBinary); });
      ws.on('close', () => remove(ws)); ws.on('error', () => undefined);
    });
  });
  const sweep = setInterval(() => { for (const client of wss.clients) if (Date.now() - client.lastActivity > IDLE_MS) close(client, 1001); }, 60_000).unref();
  return { server, rooms, close: async () => {
    clearInterval(sweep);
    // `server.close()` does not close upgraded WebSocket connections itself.
    for (const ws of wss.clients) { close(ws, 1001); ws.terminate(); }
    await new Promise(resolve => server.close(resolve));
  } };
}

if (require.main === module) {
  const origins = (process.env.RELAY_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const relay = createRelay({ ownerTokenHash: process.env.RELAY_OWNER_TOKEN_SHA256, allowedOrigins: origins });
  const host = process.env.RELAY_BIND || '127.0.0.1'; const port = Number(process.env.RELAY_PORT || 8787);
  relay.server.listen(port, host, () => console.log(`relay listening on ${host}:${port}`));
}
module.exports = { createRelay, sha256, MAX_FRAME_BYTES };
