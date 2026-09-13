'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('all generated NODO brand artwork is white on black with an unfilled HARNESS badge',()=>{
 for(const file of ['assets/nodo-symbol.svg','ui/nodo-symbol.svg']){
  const source=read(file);assert.match(source,/stroke="#ffffff"/);assert.match(source,/fill="#ffffff"/);assert.doesNotMatch(source,/#679efe|#4176e6|cyan|gradient|glow/i);
 }
 for(const file of ['assets/nodo-lockup.svg','ui/nodo-lockup.svg']){
  const source=read(file);assert.match(source,/<rect[^>]+fill="none"[^>]+stroke="#ffffff"/);assert.match(source,/>NODO</);assert.match(source,/>HARNESS</);assert.doesNotMatch(source,/#679efe|#4176e6|cyan|gradient|glow/i);
 }
});

test('About identifies the creator and takes the version from runtime metadata',()=>{
 const source=read('ui/about.html');
 assert.match(source,/Created by Stanislav Galitskiy/);
 assert.match(source,/background:#000/);
 // The dialog shows what the main process reports (app.getVersion()); the
 // literal in the template is only a fallback the build rewrites.
 assert.match(source,/id="version"/);
 assert.match(source,/window\.nodoAbout\.info\(\)/);
 assert.match(read('scripts/brand-assets.cjs'),/about\.html/);
 const preload=read('about-preload.cjs');
 assert.match(preload,/rc:about-request/);
 const main=read('main.cjs');
 assert.match(main,/sender\.send\('rc:about-info',\{name:app\.getName\(\),version:app\.getVersion\(\)/);
 assert.match(main,/'closed',\(\)=>\{this\.about=null/);
 assert.match(main,/about-lifecycle\.cjs'\)\.aboutClosable\(about\)/);
});

test('Remote and PWA are monochrome',()=>{
 const source=['remote-web/index.html','remote-web/style.css','remote-web/icon.svg','remote-web/manifest.webmanifest'].map(read).join('\n');
 assert.match(source,/HARNESS/);assert.match(source,/background_color":"#000000"/);assert.match(source,/stroke="#ffffff"/);assert.doesNotMatch(source,/#10141b|#679efe|#4176e6|#202a3a|#41516b|#93a9c7|#a0adc1|cyan|gradient|glow/i);
});
