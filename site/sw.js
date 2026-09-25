// Retires the service worker installed by the previous (Gatsby) version of this site.
// Browsers that still have it check this URL for updates; this version clears every cache the old
// worker created, unregisters itself, and reloads open tabs onto the live site. Keep this file.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
