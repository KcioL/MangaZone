/* Service worker de MangaZone.

   Rôle : rendre l'application installable et instantanée au lancement, en
   gardant sa coque en cache. Les données, elles, restent en ligne — Firestore
   gère son propre cache hors ligne, voir app.js.

   Changer VERSION suffit à forcer le renouvellement de tous les fichiers. */

const VERSION = "mangazone-v1";

const COQUE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./logo.png",
  "./Onglet-32.png",
  "./Onglet-64.png",
  "./icone-192.png",
  "./icone-512.png",
  "./avatar/homme_1.png",
  "./avatar/homme_2.png",
  "./avatar/homme_3.png",
  "./avatar/femme_1.png",
  "./avatar/femme_2.png",
  "./avatar/femme_3.png",
  "./death-note-black-edition.jpg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll échoue en bloc si un seul fichier manque : on ajoute donc
      // chaque entrée séparément, pour qu'un oubli ne casse pas l'installation.
      .then((cache) => Promise.allSettled(COQUE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(
        noms.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  // Firebase, AniList, Google Fonts : jamais interceptés. Ces échanges doivent
  // rester frais, et Firestore a besoin de sa propre connexion persistante.
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // Pour la page elle-même : le réseau d'abord, afin qu'une mise en ligne soit
  // prise en compte immédiatement ; le cache sert de filet hors ligne.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((rep) => {
          const copie = rep.clone();
          caches.open(VERSION).then((c) => c.put("./index.html", copie));
          return rep;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Pour le reste : le cache d'abord, c'est ce qui rend le lancement instantané.
  e.respondWith(
    caches.match(req).then((cache) => cache || fetch(req).then((rep) => {
      if (rep.ok) {
        const copie = rep.clone();
        caches.open(VERSION).then((c) => c.put(req, copie));
      }
      return rep;
    }))
  );
});
