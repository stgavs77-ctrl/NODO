'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { createRelay, sha256 } = require('../server.cjs');
const ORIGIN = 'https://phone.example.test';
async function setup() {
  const token = 'a'.repeat(64); const relay = createRelay({ ownerTokenHash: sha256(token), allowedOrigins: [ORIGIN] });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  return { relay, token, base: `ws://127.0.0.1:${relay.server.address().port}` };
}
function open(url, headers = {}) { return new Promise((resolve, reject) => { const ws = new WebSocket(url, { headers: { Origin: ORIGIN, ...headers } }); ws.once('open', () => resolve(ws)); ws.once('error', reject); }); }
function next(ws) { return new Promise((resolve,reject) => {const timer=setTimeout(()=>reject(Error('Expected relay frame timed out')),5000);ws.once('message', (data, binary) => {clearTimeout(timer);resolve({ data, binary });});}); }
test('only an authenticated host can create a room and opaque endpoint frames are routed by connection id', async () => {
  const { relay, token, base } = await setup();
  try {
    const host = await open(base + '/v1/host', { Authorization: `Bearer ${token}` });
    host.send(JSON.stringify({ type: 'register', roomId: 'room_1234567890123456' })); assert.deepEqual(JSON.parse(String((await next(host)).data)), { type: 'ready' });
    const phone = await open(base + '/v1/phone'); const phoneReady=next(phone),hostReady=next(host);phone.send(JSON.stringify({ type: 'attach', roomId: 'room_1234567890123456' }));
    const connected = JSON.parse(String((await phoneReady).data)); const hostNotice = JSON.parse(String((await hostReady).data));
    assert.equal(hostNotice.type, 'phone_connected'); assert.equal(hostNotice.connectionId, connected.connectionId);
    phone.send(JSON.stringify({ type: 'to_host', connectionId: connected.connectionId, frame: 'AP8BAg' }));
    assert.deepEqual(JSON.parse(String((await next(host)).data)), { type: 'from_phone', connectionId: connected.connectionId, frame: 'AP8BAg' });
    host.close(); phone.close();
  } finally { await relay.close(); }
});
test('room id cannot authorize host registration or a phone attach before host exists', async () => {
  const { relay, base } = await setup();
  try {
    const phone = await open(base + '/v1/phone'); phone.send(JSON.stringify({ type: 'attach', roomId: 'room_1234567890123456' }));
    await new Promise(resolve => phone.once('close', resolve));
    await assert.rejects(open(base + '/v1/host', { Authorization: 'Bearer wrong' }));
  } finally { await relay.close(); }
});
test('malformed endpoint frame is refused and an unapproved Origin cannot upgrade', async () => {
  const { relay, token, base } = await setup();
  try {
    const host = await open(base + '/v1/host', { Authorization: `Bearer ${token}` }); host.send(JSON.stringify({ type: 'register', roomId: 'room_1234567890123456' })); await next(host);
    host.send('not an envelope'); await new Promise(resolve => host.once('close', resolve));
    await assert.rejects(new Promise((resolve, reject) => { const ws = new WebSocket(base + '/v1/phone', { headers: { Origin: 'https://evil.test' } }); ws.once('open', resolve); ws.once('error', reject); }));
  } finally { await relay.close(); }
});
