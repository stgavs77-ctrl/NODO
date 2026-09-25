// The loading page is served from file:// where window.rc is not exposed;
// startup errors are written into #status by the main process instead.
if(window.rc){const refresh=()=>window.rc.call('state').then(s=>{document.getElementById('status').textContent=s.dsh?.error||'Starting NODO…';}).catch(()=>{});window.rc.onChanged(refresh);refresh();}
