/* Service worker de MangaZone.

   Rôle : rendre l'application installable et instantanée au lancement, en
   gardant sa coque en cache. Les données, elles, restent en ligne — Firestore
   gère son propre cache hors ligne, voir app.js.

   Changer VERSION suffit à forcer le renouvellement de tous les fichiers. */

const VERSION = "mangazone-v3";

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

  if (req.method !== "GET") return;

  const url = new URL(req.url);

  /* Les bibliothèques servies par Google — SDK Firebase et polices — sont sur
     un autre domaine, mais elles sont indispensables au démarrage. Sans elles
     en cache, l'import du module échoue hors ligne et aucune ligne de app.js
     ne s'exécute : on voit le fond du site, et rien d'autre.

     Elles sont versionnées dans leur URL, donc jamais périmées : le cache
     d'abord est ici sans risque. */
  const BIBLIOTHEQUES = [
    "www.gstatic.com",        // SDK Firebase
    "fonts.googleapis.com",   // feuille de style des polices
    "fonts.gstatic.com"       // fichiers de polices
  ];

  if (BIBLIOTHEQUES.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((cache) => cache || fetch(req).then((rep) => {
        // Une réponse opaque ne peut pas être relue : on ne garde que les vraies.
        if (rep.ok) {
          const copie = rep.clone();
          caches.open(VERSION).then((c) => c.put(req, copie));
        }
        return rep;
      }))
    );
    return;
  }

  /* Les échanges de données restent toujours en direct : authentification,
     Firestore, AniList. Les mettre en cache donnerait des réponses périmées,
     et Firestore gère lui-même son mode hors ligne. */
  if (url.origin !== self.location.origin) return;

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

  /* Le code du site — feuille de style et scripts — passe par le réseau
     d'abord, le cache ne servant qu'en secours.

     Le cache d'abord posait un vrai problème : la page est servie en réseau
     d'abord, si bien qu'une mise en ligne donnait un HTML neuf accompagné d'un
     CSS périmé, et l'affichage cassait jusqu'au changement de version. Deux
     ressources qui doivent évoluer ensemble ne peuvent pas suivre deux
     stratégies différentes. */
  const estDuCode = /\.(css|js|json)$/.test(url.pathname);

  if (estDuCode) {
    e.respondWith(
      fetch(req)
        .then((rep) => {
          if (rep.ok) {
            const copie = rep.clone();
            caches.open(VERSION).then((c) => c.put(req, copie));
          }
          return rep;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  /* Les images et polices, elles, ne changent pratiquement jamais : le cache
     d'abord garde tout son intérêt et rend le lancement instantané. */
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
