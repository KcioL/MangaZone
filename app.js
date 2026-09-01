import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, deleteDoc, updateDoc,
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
    $("user-email").textContent = user.displayName || user.email;
    watchCollection(user.uid);
  } else {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    $("app-screen").hidden  = true;
    $("auth-screen").hidden = false;
    $("collection").innerHTML = "";
    showReset(false);
  }
});

$("auth-toggle").addEventListener("click", () => {
  mode = mode === "login" ? "signup" : "login";
  const signup = mode === "signup";
  $("auth-submit").textContent      = signup ? "Créer mon compte" : "Se connecter";
  $("auth-switch-text").textContent = signup ? "Tu as déjà un compte ?" : "Pas encore de compte ?";
  $("auth-toggle").textContent      = signup ? "Se connecter" : "Créer un compte";
  $("password").autocomplete        = signup ? "new-password" : "current-password";
  $("auth-forgot-wrap").hidden      = signup;
  $("pseudo-field").hidden          = !signup;
  $("pseudo").required              = signup;
  hideError();
});

/* Réinitialisation : vue séparée, avec son propre champ.
   Firebase envoie le lien et héberge la page de changement — rien à stocker ici. */

$("auth-forgot").addEventListener("click", () => showReset(true));
$("reset-back").addEventListener("click", () => showReset(false));

function showReset(on) {
  $("login-view").hidden = on;
  $("reset-view").hidden = !on;
  hideError();
  hideResetError();
  if (on) {
    $("reset-form").reset();
    $("reset-email").focus();
  }
}

$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideResetError();

  const email = $("reset-email").value.trim();
  if (!email) {
    $("reset-email").focus();
    return showResetError("Saisis l'adresse e-mail de ton compte.");
  }

  $("reset-submit").disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    confirmSent();
  } catch (err) {
    // On ne révèle pas si l'adresse a un compte : même message dans les deux cas.
    if (err.code === "auth/user-not-found") confirmSent();
    else showResetError(authMessage(err.code));
  } finally {
    $("reset-submit").disabled = false;
  }
});

function confirmSent() {
  showResetError("Si un compte existe pour cette adresse, un lien de réinitialisation vient d'y être envoyé. Regarde aussi dans les indésirables.");
  $("reset-error").classList.add("is-note");
  $("reset-form").reset();
}

const showResetError = (msg) => {
  const el = $("reset-error");
  el.textContent = msg;
  el.classList.remove("is-note");
  el.hidden = false;
};

const hideResetError = () => {
  const el = $("reset-error");
  el.hidden = true;
  el.classList.remove("is-note");
};

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
      await signUp(email, pass);
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
    $("auth-form").reset();
  } catch (err) {
    if (err.message === "pseudo-invalide") {
      showError("Le pseudo doit faire 3 à 20 caractères, sans espace ni accent.");
    } else if (err.message === "pseudo-pris") {
      showError("Ce pseudo est déjà utilisé. Choisis-en un autre.");
    } else {
      console.error("Firebase Auth :", err.code, err.message, err);
      showError(authMessage(err.code));
    }
  } finally {
    $("auth-submit").disabled = false;
  }
});

/* Le pseudo est réservé dans une collection dédiée : l'identifiant du document
   est le pseudo en minuscules, donc Firestore garantit son unicité. */
async function signUp(email, pass) {
  const pseudo = $("pseudo").value.trim();
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(pseudo)) throw new Error("pseudo-invalide");

  const key = pseudo.toLowerCase();

  // Vérification rapide, avant de créer un compte pour rien.
  const existant = await getDoc(doc(db, "usernames", key));
  if (existant.exists()) throw new Error("pseudo-pris");

  const { user } = await createUserWithEmailAndPassword(auth, email, pass);

  // Le compte existe maintenant. Si l'enregistrement du pseudo échoue (règles
  // Firestore non publiées, pseudo réservé entre-temps), on garde le compte :
  // le supprimer laisserait la personne sans rien alors qu'elle est connectée.
  try {
    await setDoc(doc(db, "usernames", key), { uid: user.uid });
    await setDoc(doc(db, "users", user.uid), { pseudo, createdAt: Date.now() });
    await updateProfile(user, { displayName: pseudo });
    $("user-email").textContent = pseudo;
  } catch (err) {
    console.error("Enregistrement du pseudo :", err.code, err.message, err);
    toast("Compte créé, mais le pseudo n'a pas pu être enregistré. Vérifie les règles Firestore.");
  }
}

$("logout").addEventListener("click", () => signOut(auth));

function authMessage(code) {
  const messages = {
    "auth/email-already-in-use":  "Cette adresse a déjà un compte. Connecte-toi.",
    "auth/invalid-email":         "Cette adresse e-mail n'est pas valide.",
    "auth/weak-password":         "Le mot de passe doit faire au moins 6 caractères.",
    "auth/invalid-credential":    "Adresse ou mot de passe incorrect — ou aucun compte pour cette adresse.",
    "auth/user-not-found":        "Aucun compte avec cette adresse.",
    "auth/wrong-password":        "Mot de passe incorrect.",
    "auth/too-many-requests":     "Trop de tentatives. Réessaie dans quelques minutes.",
    "auth/missing-email":         "Saisis d'abord ton adresse e-mail.",
    "auth/network-request-failed": "Connexion au serveur impossible. Désactive le VPN ou le bloqueur de pub et réessaie.",
    "auth/operation-not-allowed": "Active le fournisseur E-mail/Mot de passe dans Authentication → Sign-in method.",
    "auth/admin-restricted-operation": "La création de compte est bloquée. Dans Authentication → Settings → Actions utilisateur, coche « Autoriser la création de comptes ».",
    "auth/unauthorized-domain":   "Ce domaine n'est pas autorisé. Ajoute-le dans Authentication → Settings → Domaines autorisés.",
    "auth/password-does-not-meet-requirements": "Le mot de passe ne respecte pas la politique définie dans Firebase.",
    "auth/invalid-api-key":       "La clé API de firebase-config.js est incorrecte.",
    "auth/requests-from-referer-are-blocked": "Ce domaine est bloqué par les restrictions de la clé API, côté Google Cloud."
  };
  // Si le code n'est pas connu, on l'affiche tel quel : c'est ce qui permet
  // de diagnostiquer au lieu de rester bloqué sur un message générique.
  return messages[code] || `Échec de l'opération. Code renvoyé par Firebase : ${code || "inconnu"}`;
}

const showError = (msg) => {
  const el = $("auth-error");
  el.textContent = msg;
  el.classList.remove("is-note");
  el.hidden = false;
};

const hideError = () => {
  const el = $("auth-error");
  el.hidden = true;
  el.classList.remove("is-note");
};

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
