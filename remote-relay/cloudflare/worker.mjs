// Opaque transport only. No chat storage, endpoint keys, DSH API or native IPC.
const MAX_FRAME = 2 * 1024 * 1024;
const ROOM = /^[A-Za-z0-9_-]{20,80}$/;
const ASSETS = new Set(['/', '/index.html', '/client.js', '/style.css', '/manifest.webmanifest', '/sw.js', '/icon.svg']);
const reject = (status = 403) => new Response('Unavailable', {status});
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (request.method !== 'GET') return reject(405);
    if (u.pathname === '/relay') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return reject(426);
      if (request.headers.get('Origin') !== u.origin || u.search) return reject();
      return env.RELAY.get(env.RELAY.idFromName('nodo-relay-v1')).fetch(request);
    }
    if (u.pathname === '/health') return Response.json({service:'nodo-relay',version:1,configured:/^[a-f0-9]{64}$/.test(env.RELAY_OWNER_TOKEN_SHA256 || '')});
    if (!ASSETS.has(u.pathname)) return reject(404);
    const asset = await env.ASSETS.fetch(request);
    const res = new Response(asset.body, asset);
    res.headers.set('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self' wss://" + u.host);
    res.headers.set('X-Content-Type-Options', 'nosniff');
    res.headers.set('Referrer-Policy', 'no-referrer');
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
};

export class RelayHub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  sockets() { return this.ctx.getWebSockets().filter(ws => ws.readyState === 1); }
  meta(ws) { return ws.deserializeAttachment(); }
  send(ws, data) { try { ws.send(JSON.stringify(data)); } catch { this.drop(ws); } }
  drop(ws, code = 1008) {
    const m = this.meta(ws);
    // Mark first so close/error callbacks and host replacement cannot notify twice.
    if (!m || m.closed) return;
    ws.serializeAttachment({...m, closed:true});
    try { ws.close(code, 'Connection ended'); } catch {}
    // Do not depend on a later close callback to remove the last expiry alarm.
    this.ctx.waitUntil(this.schedule());
    if (!m.ready) return;
    if (m.kind === 'host') {
      for (const peer of this.sockets()) {
        const p = this.meta(peer);
        if (!p.closed && p.roomId === m.roomId && p.kind === 'phone') this.drop(peer, 1012);
      }
    } else {
      const host = this.host(m.roomId);
      if (host) this.send(host, {type:'phone_disconnected',connectionId:m.connectionId});
    }
  }
  host(roomId) { return this.sockets().find(ws => { const m=this.meta(ws); return !m.closed && m.ready && m.kind==='host' && m.roomId===roomId; }); }
  async schedule() {
    const deadlines=this.sockets().map(ws=>this.meta(ws)).filter(m=>!m.closed).map(m=>m.deadline);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(Date.now()+1, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Origin') !== url.origin) return reject();
    const expected = this.env.RELAY_OWNER_TOKEN_SHA256;
    if (!/^[a-f0-9]{64}$/.test(expected || '')) return reject(503);
    const auth=request.headers.get('Authorization'), kind=auth===null?'phone':'host';
    if (kind==='host') {
      if (!/^Bearer [A-Za-z0-9_-]{32,128}$/.test(auth)) return reject();
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(auth.slice(7))));
      let diff=0;for(let i=0;i<32;i++)diff|=digest[i]^parseInt(expected.slice(i*2,i*2+2),16);
      if(diff) return reject();
    }
    const active=this.sockets().filter(ws=>!this.meta(ws).closed);
    if (active.length>=8 || (kind==='phone' && active.filter(ws=>this.meta(ws).kind==='phone').length>=6)) return reject(429);
    const [client,server]=Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({kind,ready:false,closed:false,deadline:Date.now()+5000,rateAt:Date.now(),count:0});
    await this.schedule();
    return new Response(null,{status:101,webSocket:client});
  }
  async webSocketMessage(ws, raw) {
    const m=this.meta(ws),now=Date.now();
    if (!m || m.closed) return;
    if (now>m.deadline || typeof raw!=='string' || raw.length>MAX_FRAME) return this.drop(ws);
    let e;try{e=JSON.parse(raw);}catch{return this.drop(ws);}
    if (!e || typeof e!=='object' || Array.isArray(e)) return this.drop(ws);
    if (now-m.rateAt>=10000){m.rateAt=now;m.count=0;}
    if(++m.count>64) return this.drop(ws);
    if (!m.ready) {
      if (Object.keys(e).some(k=>!['type','roomId'].includes(k)) || !ROOM.test(e.roomId||'')) return this.drop(ws);
      if (m.kind==='host') {
        if(e.type!=='register') return this.drop(ws);
        const old=this.host(e.roomId);if(old)this.drop(old,1012);
      } else {
        if(e.type!=='attach' || !this.host(e.roomId))return this.drop(ws);
        if(this.sockets().filter(p=>{const a=this.meta(p);return !a.closed && a.ready && a.kind==='phone' && a.roomId===e.roomId;}).length>=2)return this.drop(ws);
        m.connectionId=crypto.randomUUID();
      }
      m.ready=true;m.roomId=e.roomId;m.deadline=now+900000;ws.serializeAttachment(m);
      if(m.kind==='phone')this.send(this.host(m.roomId),{type:'phone_connected',connectionId:m.connectionId});
      this.send(ws,m.kind==='host'?{type:'ready'}:{type:'connected',connectionId:m.connectionId});
      await this.schedule();return;
    }
    if(Object.keys(e).some(k=>!['type','connectionId','frame'].includes(k)) || typeof e.connectionId!=='string' || typeof e.frame!=='string' || e.frame.length>MAX_FRAME-512 || !/^[A-Za-z0-9_-]+$/.test(e.frame))return this.drop(ws);
    m.deadline=now+900000;ws.serializeAttachment(m);
    if(m.kind==='host') {
      if(e.type!=='to_phone')return this.drop(ws);
      const peer=this.sockets().find(p=>{const a=this.meta(p);return !a.closed && a.kind==='phone' && a.roomId===m.roomId && a.connectionId===e.connectionId;});
      if(peer)this.send(peer,{type:'from_host',connectionId:e.connectionId,frame:e.frame});
    } else {
      const host=this.host(m.roomId);
      if(e.type!=='to_host'||e.connectionId!==m.connectionId||!host)return this.drop(ws);
      this.send(host,{type:'from_phone',connectionId:m.connectionId,frame:e.frame});
    }
    // Existing alarm may fire early; alarm() recomputes deadlines without a write per frame.
  }
  async alarm(){for(const ws of this.sockets())if(this.meta(ws).deadline<=Date.now())this.drop(ws,1001);await this.schedule();}
  async webSocketClose(ws){this.drop(ws,1000);await this.schedule();}
  async webSocketError(ws){this.drop(ws,1011);await this.schedule();}
}
