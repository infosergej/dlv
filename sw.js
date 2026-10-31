// Maršruto planavimo sistemos Service Worker
// Strategijos:
//  - programos apvalkalas (HTML/CSS/JS) -> tinklas pirmiausia, kai nėra tinklo - talpykla
//  - CDN bibliotekos -> stale-while-revalidate
//  - žemėlapio plytelės -> talpykla pirmiausia (ribotas kiekis)
const CACHE_VERSION = 'v10';
const SHELL_CACHE = `marsrutas-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `marsrutas-runtime-${CACHE_VERSION}`;
const TILE_CACHE = `marsrutas-tiles-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './favicon.svg',
  './favicon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// Kiekvienas failas cache'inamas atskirai: vienas nepavykęs neturi sugriauti viso įdiegimo
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_ASSETS.map(async (asset) => {
      try {
        await cache.add(new Request(asset, { cache: 'reload' }));
      } catch (error) {
        console.warn('[SW] Nepavyko įtraukti į talpyklą:', asset, error);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE && key !== TILE_CACHE)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

const CDN_HOSTS = ['unpkg.com', 'cdnjs.cloudflare.com'];
const TILE_HOSTS = ['tile.openstreetmap.org', 'basemaps.cartocdn.com'];
const MAX_RUNTIME_TILES = 500;

function isTileRequest(hostname) {
  return TILE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put('./index.html', response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match('./index.html');
    if (cached) return cached;
    return new Response('Programa nepasiekiama be interneto ryšio.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    cache.put(request, response.clone());
    if (maxEntries) trimCache(cacheName, maxEntries);
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isTileRequest(url.hostname)) {
    event.respondWith(
      cacheFirst(request, TILE_CACHE, MAX_RUNTIME_TILES).catch(() => Response.error())
    );
    return;
  }

  // Programos failai ir CDN bibliotekos
  if (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
  }

  // Nominatim / HeiGIT (openrouteservice) užklausos visada eina į tinklą (duomenys turi būti švieži)
});
