import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, updateDoc,
  onSnapshot, arrayUnion, arrayRemove, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

const API   = "https://api.mangadex.org";
const COVER = "https://uploads.mangadex.org/covers";

const $ = (id) => document.getElementById(id);

let currentUser  = null;
let unsubscribe  = null;
let mode         = "login";   // "login" | "signup"
let collectionCache = [];

/* ══════════════════ Authentification ══════════════════ */

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    $("auth-screen").hidden = true;
    $("app-screen").hidden  = false;
    $("user-email").textContent = user.email;
    watchCollection(user.uid);
  } else {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    $("app-screen").hidden  = true;
    $("auth-screen").hidden = false;
    $("collection").innerHTML = "";
  }
});

$("auth-toggle").addEventListener("click", () => {
  mode = mode === "login" ? "signup" : "login";
  const signup = mode === "signup";
  $("auth-submit").textContent      = signup ? "Créer mon compte" : "Se connecter";
  $("auth-switch-text").textContent = signup ? "Tu as déjà un compte ?" : "Pas encore de compte ?";
  $("auth-toggle").textContent      = signup ? "Se connecter" : "Créer un compte";
  $("password").autocomplete        = signup ? "new-password" : "current-password";
  hideError();
});

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();

  const email = $("email").value.trim();
  const pass  = $("password").value;

  if (!email || pass.length < 6) {
    return showError("Il faut une adresse valide et un mot de passe d'au moins 6 caractères.");
  }

  $("auth-submit").disabled = true;
  try {
    if (mode === "signup") {
      await createUserWithEmailAndPassword(auth, email, pass);
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
    $("auth-form").reset();
  } catch (err) {
    showError(authMessage(err.code));
  } finally {
    $("auth-submit").disabled = false;
  }
});

$("logout").addEventListener("click", () => signOut(auth));

function authMessage(code) {
  const messages = {
    "auth/email-already-in-use":  "Cette adresse a déjà un compte. Connecte-toi.",
    "auth/invalid-email":         "Cette adresse e-mail n'est pas valide.",
    "auth/weak-password":         "Le mot de passe doit faire au moins 6 caractères.",
    "auth/invalid-credential":    "Adresse ou mot de passe incorrect.",
    "auth/user-not-found":        "Aucun compte avec cette adresse.",
    "auth/wrong-password":        "Mot de passe incorrect.",
    "auth/too-many-requests":     "Trop de tentatives. Réessaie dans quelques minutes.",
    "auth/operation-not-allowed": "Active la connexion par e-mail dans la console Firebase."
  };
  return messages[code] || "La connexion a échoué. Vérifie ta configuration Firebase.";
}

const showError = (msg) => { $("auth-error").textContent = msg; $("auth-error").hidden = false; };
const hideError = () => { $("auth-error").hidden = true; };

/* ══════════════════ Recherche de séries ══════════════════ */

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const term = $("search-input").value.trim();
  if (!term) return;

  const box = $("search-results");
  box.hidden = false;
  box.innerHTML = `<p class="result">Recherche en cours…</p>`;

  try {
    const url = `${API}/manga?title=${encodeURIComponent(term)}`
              + `&limit=8&includes[]=cover_art&order[relevance]=desc`
              + `&contentRating[]=safe&contentRating[]=suggestive`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const { data } = await res.json();

    if (!data.length) {
      box.innerHTML = `<p class="result">Aucune série trouvée pour « ${escapeHtml(term)} ». Essaie le titre original ou anglais.</p>`;
      return;
    }
    box.innerHTML = "";
    data.forEach((manga) => box.appendChild(resultRow(manga)));
  } catch {
    box.innerHTML = `<p class="result">La recherche n'a pas abouti. Vérifie ta connexion et réessaie.</p>`;
  }
});

function resultRow(manga) {
  const title = pickTitle(manga.attributes);
  const art   = manga.relationships.find((r) => r.type === "cover_art");
  const thumb = art ? `${COVER}/${manga.id}/${art.attributes.fileName}.256.jpg` : "";
  const year  = manga.attributes.year || "";
  const owned = collectionCache.some((s) => s.id === manga.id);

  const row = document.createElement("div");
  row.className = "result";
  row.innerHTML = `
    <img src="${thumb}" alt="" loading="lazy">
    <div class="result-info">
      <span class="result-title">${escapeHtml(title)}</span>
      <span class="result-year">${year}</span>
    </div>
    <button type="button" ${owned ? "disabled" : ""}>${owned ? "Déjà suivie" : "Ajouter"}</button>`;

  const btn = row.querySelector("button");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Ajout…";
    try {
      await addSeries(manga, title);
      btn.textContent = "Ajoutée";
      toast(`${title} est dans ton rayon.`);
    } catch {
      btn.disabled = false;
      btn.textContent = "Réessayer";
      toast("L'ajout a échoué.");
    }
  });
  return row;
}

function pickTitle(attr) {
  if (attr.title?.fr) return attr.title.fr;
  const altFr = (attr.altTitles || []).find((t) => t.fr);
  if (altFr) return altFr.fr;
  return attr.title?.en || Object.values(attr.title || {})[0] || "Sans titre";
}

/* ══════════════════ Ajout d'une série ══════════════════ */

async function addSeries(manga, title) {
  const res = await fetch(`${API}/cover?manga[]=${manga.id}&limit=100&order[volume]=asc`);
  const { data } = await res.json();

  // Plusieurs éditions publient la même couverture : on garde une image par tome,
  // en privilégiant l'édition française puis japonaise.
  const rank = { fr: 3, ja: 2 };
  const best = new Map();

  data.forEach((cover) => {
    const vol = cover.attributes.volume;
    if (!vol) return;
    const score = rank[cover.attributes.locale] || 1;
    const kept  = best.get(vol);
    if (!kept || score > kept.score) {
      best.set(vol, { score, file: cover.attributes.fileName });
    }
  });

  const volumes = [...best.entries()]
    .map(([n, v]) => ({ n, file: v.file }))
    .sort((a, b) => parseFloat(a.n) - parseFloat(b.n));

  if (!volumes.length) throw new Error("no volumes");

  await setDoc(doc(db, "users", currentUser.uid, "series", manga.id), {
    id: manga.id,
    title,
    volumes,
    owned: [],
    addedAt: Date.now()
  });
}

/* ══════════════════ Lecture temps réel ══════════════════ */

function watchCollection(uid) {
  $("loading").hidden = false;
  const q = query(collection(db, "users", uid, "series"), orderBy("addedAt", "asc"));

  unsubscribe = onSnapshot(q, (snap) => {
    $("loading").hidden = true;
    collectionCache = snap.docs.map((d) => d.data());
    renderCollection();
  }, () => {
    $("loading").textContent = "Impossible de lire ta collection. Vérifie les règles Firestore.";
  });
}

function renderCollection() {
  const box = $("collection");
  box.innerHTML = "";

  $("empty-state").hidden = collectionCache.length > 0;
  $("stats").hidden       = collectionCache.length === 0;

  let owned = 0, total = 0;

  collectionCache.forEach((series) => {
    owned += series.owned.length;
    total += series.volumes.length;
    box.appendChild(seriesBlock(series));
  });

  $("stat-owned").textContent   = owned;
  $("stat-missing").textContent = total - owned;
  $("stat-series").textContent  = collectionCache.length;
}

function seriesBlock(series) {
  const section = document.createElement("section");
  section.className = "series";

  const pct = series.volumes.length
    ? Math.round((series.owned.length / series.volumes.length) * 100)
    : 0;

  section.innerHTML = `
    <div class="series-head">
      <h2 class="series-title">${escapeHtml(series.title)}</h2>
      <span class="series-count">${series.owned.length} / ${series.volumes.length} tomes</span>
    </div>
    <div class="progress"><span style="width:${pct}%"></span></div>
    <div class="volumes"></div>
    <p style="margin-top:14px"><button type="button" class="series-remove">Retirer cette série</button></p>`;

  const grid = section.querySelector(".volumes");

  series.volumes.forEach((vol) => {
    const has = series.owned.includes(vol.n);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `vol ${has ? "vol-owned" : "vol-missing"}`;
    btn.setAttribute("aria-pressed", has);
    btn.title = has
      ? `Tome ${vol.n} — possédé. Cliquer pour retirer.`
      : `Tome ${vol.n} — manquant. Cliquer pour ajouter.`;
    btn.innerHTML = `
      <img src="${COVER}/${series.id}/${vol.file}.256.jpg" alt="Tome ${vol.n}" loading="lazy">
      <span class="vol-num">${vol.n}</span>`;

    btn.addEventListener("click", () => toggleVolume(series.id, vol.n, has));
    grid.appendChild(btn);
  });

  section.querySelector(".series-remove").addEventListener("click", async () => {
    if (!confirm(`Retirer « ${series.title} » de ton rayon ?`)) return;
    await deleteDoc(doc(db, "users", currentUser.uid, "series", series.id));
    toast("Série retirée.");
  });

  return section;
}

async function toggleVolume(seriesId, n, has) {
  const ref = doc(db, "users", currentUser.uid, "series", seriesId);
  await updateDoc(ref, { owned: has ? arrayRemove(n) : arrayUnion(n) });
}

/* ══════════════════ Utilitaires ══════════════════ */

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("auth-screen").hidden = false;
