// Do not cache chat responses, credentials, pairing URLs or obsolete app code.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
