'use strict';
// The header status cluster must be laid out by flex, never by absolute
// positioning, and secondary statuses must be the first to collapse.
const test=require('node:test'),assert=require('node:assert'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../extension/client.js'),'utf8');
const start=source.indexOf('const centerStyle'),end=source.indexOf('// Graphite surfaces');
const style=source.slice(start,end>start?end:source.length);

test('header cluster is flex with shrinkable groups',()=>{
 assert.match(style,/\.nodo-command-center\{display:flex/);
 assert.match(style,/\.nodo-primary-status\{display:inline-flex[^}]*min-width:0/);
 assert.match(style,/\.nodo-secondary-status\{display:inline-flex[^}]*flex:0 0 auto/);
 assert.doesNotMatch(style,/position:absolute/);
 assert.doesNotMatch(source,/nodo-secondary-status[^`]*z-index/);
});
test('secondary statuses collapse before primary ones',()=>{
 const breaks=[...style.matchAll(/@media\(max-width:(\d+)px\)\{([^@]*?)\}(?=@media|'|\))/g)].map(m=>({width:Number(m[1]),body:m[2]}));
 assert.ok(breaks.length>=5,'collapse breakpoints are declared');
 const secondary=breaks.find(b=>/\.nodo-secondary-status\{display:none\}/.test(b.body));
 const tasks=breaks.find(b=>/nodo-tasks-status/.test(b.body));
 const modeLabel=breaks.find(b=>/nodo-collapse-mode-label/.test(b.body));
 assert.ok(secondary&&tasks&&modeLabel,'collapse rules exist');
 assert.ok(secondary.width>modeLabel.width,'secondary group hides before the context label');
 assert.ok(modeLabel.width>tasks.width,'context label hides before the task counter');
});
test('the provider indicator stays visible at every width',()=>{
 assert.doesNotMatch(style,/\.nodo-provider-indicator\{display:none/);
 for(const b of [...style.matchAll(/@media\(max-width:(\d+)px\)\{([^@]*?)\}(?=@media|'|\))/g)])assert.doesNotMatch(b[2],/nodo-provider-indicator/,'indicator must not be hidden by '+b[1]+'px');
 assert.match(style,/\.nodo-provider-indicator\{[^}]*max-width:150px/);
});
test('no custom palette: the UI keeps the system dark theme tokens',()=>{
 assert.doesNotMatch(source,/#1e1e21|#232326|GRAPHITE/,'NODO must not repaint the shell with its own greys');
 assert.match(source,/--dsw-alias-/,'the extension styles against the host semantic tokens');
 assert.match(source,/nativeTheme|--dsw-alias-bg-base/,'system colours come from the shell');
});
test('the host utility row is allowed to shrink instead of overflowing',()=>{
 assert.match(style,/header \[class\*=headerUtilities\]\{min-width:0;flex:0 1 auto;overflow:hidden\}/,'the host row must shrink');
});
