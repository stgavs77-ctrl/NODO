const refresh=()=>window.rc.call('state').then(s=>{document.getElementById('status').textContent=s.dsh.error||'Starting NODO…';});window.rc.onChanged(refresh);refresh();
