'use strict';
// Close behaviour for the About dialog. Kept separate from main.cjs so the
// exact rules are unit-testable: Escape, Command+W / Control+W, a click outside
// the modal (blur) and the window close button all dismiss it, and it never
// closes itself before it has been focused once.
function aboutClosable(about,{focus}={}){
 const close=()=>{try{if(about&&!about.isDestroyed())about.close();}catch{}};
 let focused=false;
 const markFocused=()=>{focused=true;focus?.();};
 about.once?.('focus',markFocused);
 about.on('blur',()=>{if(focused)close();});
 about.webContents.on('before-input-event',(event,input)=>{
  if(!input||input.type!=='keyDown')return;
  const key=String(input.key||'');
  const commandClose=(input.meta||input.control)&&key.toLowerCase()==='w';
  if(key==='Escape'||commandClose){event.preventDefault?.();close();}
 });
 return {close,hasFocused:()=>focused};
}
module.exports={aboutClosable};
