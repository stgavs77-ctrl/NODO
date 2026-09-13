'use strict';
// Branding rule: every NODO surface is strictly white on transparent, and the
// shell keeps the system dark surfaces instead of a repainted black/graphite.
const test=require('node:test'),assert=require('node:assert'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../extension/client.js'),'utf8');
const svgs=[...source.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)].map(m=>Buffer.from(m[1],'base64').toString('utf8'));

test('brand surfaces are white on transparent and nothing else',()=>{
 assert.ok(svgs.length>=2,'lockup and symbol are embedded');
 const colours=new Set();
 for(const svg of svgs)for(const m of svg.matchAll(/(?:stroke|fill)="([^"]+)"/g)){const v=m[1].toLowerCase();if(!['none','transparent','currentcolor'].includes(v))colours.add(v);}
 assert.deepEqual([...colours],['#ffffff'],'only white paint is allowed in branding');
 const all=svgs.join('');
 assert.match(all,/NODO/);assert.match(all,/HARNESS/);assert.match(all,/fill="none"/);assert.match(all,/stroke="#ffffff"/);
});
test('the shell keeps system surfaces and adds no palette of its own',()=>{
 assert.doesNotMatch(source,/--dsw-alias-bg-base:#000/,'no forced black base');
 assert.doesNotMatch(source,/--dsw-specific-sidebar-fill:#000/,'no forced black sidebar');
 assert.doesNotMatch(source,/#151517|#1e1e21|#232326|GRAPHITE/,'no invented palette');
 assert.match(source,/--dsw-alias-brand-primary:#fff/,'brand tokens stay white');
});
