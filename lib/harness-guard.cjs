// Keep the native Harness renderer separate from browser automation targets.
const {pathToFileURL}=require('node:url');
function allowed(raw,origin,ui){try{const u=new URL(raw);return u.origin===origin||u.href===ui;}catch{return false;}}
function bounded(rect,width,height){const left=Math.min(320,Math.floor(width*.35)),top=88;const x=Math.max(left,Math.min(width,rect.x||0)),y=Math.max(top,Math.min(height,rect.y||0));return{x,y,width:Math.max(0,Math.min(rect.width||0,width-x)),height:Math.max(0,Math.min(rect.height||0,height-y))};}
function install(win,browser,port,uiPath){
 const wc=win.webContents,origin='http://127.0.0.1:'+port,ui=pathToFileURL(uiPath).href;let last=ui,recovering=false;
 const trusted=url=>allowed(url,origin,ui);
 const home=()=>{browser.layout(browser.rect,false);browser.state.view='chat';wc.focus();browser.changed();};
 // Unlike will-navigate, the network gate also covers Page.navigate/page.goto.
 wc.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>done({cancel:request.webContentsId===wc.id&&request.resourceType==='mainFrame'&&!trusted(request.url)}));
 const recover=()=>{if(recovering)return;recovering=true;wc.stop();home();wc.loadURL(last).catch(()=>{}).finally(()=>{recovering=false;});};
 wc.on('did-navigate',(_event,url)=>{if(trusted(url)){last=url;return;}recover();});
 // A cancelled CDP navigation can commit Chromium's error page without did-navigate.
 wc.on('did-fail-load',(_event,_code,_description,url,isMainFrame)=>{if(isMainFrame&&!trusted(url))recover();});
 const escape=(event,input)=>{if((input.meta||input.control)&&input.shift&&input.key.toLowerCase()==='h'){event.preventDefault();home();}};
 wc.on('before-input-event',escape);
 const materialize=browser.materialize.bind(browser);browser.materialize=async(...args)=>{const view=await materialize(...args);if(!view.__harnessGuard){view.__harnessGuard=true;view.webContents.on('before-input-event',escape);view.webContents.on('render-process-gone',home);view.webContents.on('unresponsive',home);}return view;};
 const layout=browser.layout.bind(browser);browser.layout=(rect=browser.rect,visible=browser.visible)=>{const b=win.getContentBounds();const safe=bounded(rect,b.width,b.height);return layout(safe,visible&&safe.width>0&&safe.height>0&&!win.getChildWindows().some(w=>w.isVisible()));};
 win.on('resize',()=>browser.layout());browser.returnToChat=home;return{trusted,home};
}
module.exports={install,allowed,bounded};
