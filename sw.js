/* Askēsis hors ligne (service worker).
   - La page (index.html) : réseau d'abord, pour toujours avoir la dernière
     version ; la copie en cache ne sert que sans connexion.
   - Nos fichiers (assets/) : la copie en cache tout de suite, mise à jour en
     arrière-plan.
   - Bibliothèques et polices des CDN (versions figées) : cache d'abord.
   - Tout le reste (Supabase, OpenFoodFacts, IA…) passe sans être gardé. */
const CACHE = 'anqaa-v1';
const BASE = new URL('./', self.location).href;
const A_PRECHARGER = [BASE, BASE + 'index.html', BASE + 'assets/donnees.js'];
const CDN = /(^|\.)(cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(A_PRECHARGER.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(cles => Promise.all(cles.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Une réponse partielle (vidéo lue par morceaux) ou en erreur ne se garde pas.
function gardable(req, res) {
  return res && (res.status === 200 || res.type === 'opaque') && !req.headers.has('range');
}

async function reseauDabord(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (gardable(req, res)) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match(BASE + 'index.html')) || Response.error();
  }
}

async function cacheEtMiseAJour(req) {
  const cache = await caches.open(CACHE);
  const enCache = await cache.match(req);
  const frais = fetch(req).then(res => { if (gardable(req, res)) cache.put(req, res.clone()); return res; }).catch(() => null);
  return enCache || (await frais) || Response.error();
}

async function cacheDabord(req) {
  const cache = await caches.open(CACHE);
  const enCache = await cache.match(req);
  if (enCache) return enCache;
  const res = await fetch(req);
  if (gardable(req, res)) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.href === BASE) e.respondWith(reseauDabord(req));
    else if (!req.headers.has('range')) e.respondWith(cacheEtMiseAJour(req));
    return;
  }
  if (CDN.test(url.hostname)) e.respondWith(cacheDabord(req));
});
