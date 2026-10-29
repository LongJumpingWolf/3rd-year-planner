// App shell cache (network first, cache fallback) so the planner opens offline after the first visit.
const CACHE = 'study-desk-v12';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'favicon.svg', 'css/styles.css',
  'js/app.js', 'js/actions.js', 'js/planner.js', 'js/taskOps.js', 'js/store.js', 'js/utils.js', 'js/data.js',
  'js/exportPlan.js', 'js/cloud.js', 'js/syncLogic.js', 'js/supabase-config.js', 'js/ui/account.js', 'js/ui/viewerLink.js', 'js/ui/tuner.js', 'js/ui/catchup.js', 'js/share.js', 'js/viewerSnapshot.js', 'js/insights.js', 'js/ui/audit.js', 'js/ui/blocks.js', 'js/ui/calendar.js', 'js/ui/dashboard.js',
  'js/ui/day.js', 'js/ui/dialogs.js', 'js/ui/dom.js', 'js/ui/insights.js', 'js/ui/settings.js', 'js/ui/simulator.js',
  'js/ui/taskCard.js', 'js/ui/tasks.js', 'js/ui/toast.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
