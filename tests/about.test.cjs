'use strict';
// The About dialog must always be dismissable and must never leave the main
// window blocked. These tests drive the real handler logic with a fake window.
const test=require('node:test'),assert=require('node:assert');
const {aboutClosable}=require('../lib/about-lifecycle.cjs');
function fakeWindow(){
 const handlers={},inputHandlers=[];
 let destroyed=false,closed=0;
 const about={
  close(){closed++;destroyed=true;handlers.closed?.forEach(f=>f());},
  isDestroyed:()=>destroyed,
  on(name,fn){(handlers[name]||(handlers[name]=[])).push(fn);return about;},
  once(name,fn){(handlers[name]||(handlers[name]=[])).push(fn);return about;},
  focus(){handlers.focus?.forEach(f=>f());},
  blur(){handlers.blur?.forEach(f=>f());},
  webContents:{on(name,fn){if(name==='before-input-event')inputHandlers.push(fn);}},
  key(key,mods={}){let prevented=false;inputHandlers.forEach(fn=>fn({preventDefault:()=>{prevented=true;}},{type:'keyDown',key,...mods}));return prevented;}
 };
 return {about,closed:()=>closed};
}
test('About closes on Escape',()=>{
 const {about,closed}=fakeWindow();aboutClosable(about);about.focus();
 const prevented=about.key('Escape');
 assert.equal(prevented,true,'Escape is consumed by the dialog');
 assert.equal(closed(),1);
});
test('About closes on Command+W and Control+W',()=>{
 const a=fakeWindow();aboutClosable(a.about);a.about.focus();a.about.key('w',{meta:true});
 assert.equal(a.closed(),1);
 const b=fakeWindow();aboutClosable(b.about);b.about.focus();b.about.key('W',{control:true});
 assert.equal(b.closed(),1);
});
test('About closes when the modal loses focus, but never before it was focused',()=>{
 const early=fakeWindow();aboutClosable(early.about);early.about.blur();
 assert.equal(early.closed(),0,'opening must not close the dialog by itself');
 const late=fakeWindow();aboutClosable(late.about);late.about.focus();late.about.blur();
 assert.equal(late.closed(),1,'click outside the modal closes it');
});
test('Escape on an already destroyed dialog is a no-op',()=>{
 const {about,closed}=fakeWindow();aboutClosable(about);about.focus();about.key('Escape');
 assert.doesNotThrow(()=>about.key('Escape'));
 assert.equal(closed(),1);
});
