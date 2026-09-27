/* Background Web Push. Inbox data stays on the API; this worker only displays a message. */
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function safePath(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  )
    return '/notifications';
  try {
    const url = new URL(value, self.location.origin);
    if (
      url.origin !== self.location.origin ||
      !/^\/(account|scenarios|play\/[^/]+|progress|results\/[^/]+|team|notifications|leaderboard)(\/)?$/.test(
        url.pathname,
      )
    )
      return '/notifications';
    return url.pathname + url.search;
  } catch {
    return '/notifications';
  }
}

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data?.json() || {};
  } catch {
    // Every push must remain visible, including malformed payloads.
  }
  const title =
    typeof message.title === 'string' && message.title.trim()
      ? message.title.slice(0, 100)
      : 'ВСМ · Практика';
  const body =
    typeof message.body === 'string' && message.body.trim()
      ? message.body.slice(0, 240)
      : 'Новое сообщение доступно в уведомлениях.';
  const href = safePath(message.href);
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        icon: '/vsm-icon.svg',
        badge: '/vsm-icon.svg',
        tag:
          typeof message.notificationId === 'string'
            ? `vsm:${message.notificationId.slice(0, 80)}`
            : undefined,
        data: { href },
      });
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const windowClient of windows) windowClient.postMessage({ type: 'vsm:push' });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = safePath(event.notification.data?.href);
  event.waitUntil(
    (async () => {
      const target = new URL(href, self.location.origin).href;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        await existing.focus();
        if (existing.url !== target) await existing.navigate(target);
      } else {
        await self.clients.openWindow(target);
      }
    })(),
  );
});
