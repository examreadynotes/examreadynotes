// Exam Ready Notes — Service Worker v1
// Handles push notifications only. No caching — avoids stale content bugs.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Push notifications
self.addEventListener('push', e => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){ d = { title:'Exam Ready Notes', body: e.data?.text()||'' }; }
  e.waitUntil(self.registration.showNotification(d.title||'Exam Ready Notes', {
    body: d.body || 'You have a new notification.',
    icon: d.icon || '/logo.png',
    badge: d.badge || '/logo.png',
    tag: d.tag || 'ern-notif',
    data: d.data || { url: '/' },
    requireInteraction: !!d.requireInteraction,
    actions: d.actions || [],
  }));
});

// Tap notification → open/focus the site
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      const open = clients.find(c => c.url.includes(self.location.origin));
      if(open){ open.focus(); open.postMessage({ action: e.action }); }
      else self.clients.openWindow(url);
    })
  );
});

// Fetch: pure pass-through — no caching. Offline fallback for navigation only.
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).catch(() => {
      if(e.request.mode === 'navigate'){
        return new Response(
          `<!DOCTYPE html><html><head><meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Offline — Exam Ready Notes</title>
          <style>*{margin:0;box-sizing:border-box}body{font-family:sans-serif;background:#08192E;color:#EEF2FF;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;padding:24px;text-align:center}h2{font-size:22px}p{color:#A0B4CC;max-width:280px;line-height:1.6}button{background:#F7B500;color:#000;border:none;padding:13px 28px;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer}</style>
          </head><body>
          <div style="font-size:52px">📶</div>
          <h2>You're offline</h2>
          <p>Check your internet connection and try again.</p>
          <button onclick="location.reload()">Try Again</button>
          </body></html>`,
          { headers:{'Content-Type':'text/html'} }
        );
      }
      return new Response('',{status:503});
    })
  );
});
