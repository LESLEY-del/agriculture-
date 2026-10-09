self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: 'Soil Buddies', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'A crop needs attention', {
    body: d.body || '',
    tag: d.tag || 'soil-buddies-alert',
    requireInteraction: true,
    data: { url: d.url || '/dashboard' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/dashboard';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.navigate) return c.navigate(url).then(w => (w || c).focus());
      return c.focus();
    }
    return clients.openWindow(url);
  }));
});
