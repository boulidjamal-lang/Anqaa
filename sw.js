/* Askēsis hors ligne (service worker).
   - La page (index.html) : réseau d'abord, pour toujours avoir la dernière
     version ; la copie en cache sert sans connexion, et aussi quand le
     réseau traîne plus de 3 s (salle de sport, métro) : la version du
     réseau, si elle finit par arriver, sera là à la prochaine ouverture.
   - Nos fichiers (assets/) : la copie en cache tout de suite, mise à jour en
     arrière-plan (le réseau d'abord quand l'appli se met à jour).
   - Bibliothèques et polices des CDN (versions figées) : cache d'abord.
   - Tout le reste (Supabase, OpenFoodFacts, IA…) passe sans être gardé. */
const CACHE = 'anqaa-v1';
const ATTENTE_RESEAU_MS = 3000;
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

async function reseauDabord(e) {
  const req = e.request;
  const cache = await caches.open(CACHE);
  const reseau = fetch(req).then(res => { if (gardable(req, res)) return cache.put(req, res.clone()).then(() => res); return res; });
  // Le service worker reste en vie jusqu'à la fin du téléchargement, même
  // quand la copie en cache a déjà été servie.
  e.waitUntil(reseau.catch(() => {}));
  const copie = () => cache.match(req, { ignoreSearch: true }).then(c => c || cache.match(BASE + 'index.html'));
  let delai;
  const lent = new Promise(ok => { delai = setTimeout(() => ok('lent'), ATTENTE_RESEAU_MS); });
  try {
    const premier = await Promise.race([reseau, lent]);
    if (premier !== 'lent') { clearTimeout(delai); return premier; }
    const c = await copie();
    return c || await reseau;
  } catch (err) {
    clearTimeout(delai);
    return (await copie()) || Response.error();
  }
}

async function cacheEtMiseAJour(req) {
  const cache = await caches.open(CACHE);
  const enCache = await cache.match(req);
  const frais = fetch(req).then(res => { if (gardable(req, res)) cache.put(req, res.clone()); return res; }).catch(() => null);
  // Mise à jour demandée par l'appli (bandeau « Nouvelle version ») : le réseau d'abord.
  if (req.cache === 'reload') { const r = await frais; return (r && r.ok ? r : enCache) || r || Response.error(); }
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
    if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.href === BASE) e.respondWith(reseauDabord(e));
    else if (!req.headers.has('range')) e.respondWith(cacheEtMiseAJour(req));
    return;
  }
  if (CDN.test(url.hostname)) e.respondWith(cacheDabord(req));
});
