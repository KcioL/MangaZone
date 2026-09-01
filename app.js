import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc,
  onSnapshot, arrayUnion, arrayRemove, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Jikan (MyAnimeList). Contrairement à MangaDex, cette API envoie des en-têtes
// CORS, donc elle est appelable directement depuis un navigateur.
const API = "https://api.jikan.moe/v4";

const $ = (id) => document.getElementById(id);

let currentUser     = null;
let unsubscribe     = null;
let mode            = "login";      // "login" | "signup"
let collectionCache = [];
let openSeriesId    = null;         // série affichée en vue détail
let volumeFilter    = "all";        // "all" | "owned" | "missing"
let suggestionsLoaded = false;

/* ══════════════════ Authentification ══════════════════ */

onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  if (!user) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    collectionCache = [];
    openSeriesId = null;
    $("app-screen").hidden  = true;
    $("auth-screen").hidden = false;
    $("series-list").innerHTML = "";
    showReset(false);
    return;
  }

  $("auth-screen").hidden = true;
  $("app-screen").hidden  = false;
  $("user-email").textContent = user.displayName || user.email;

  watchCollection(user.uid);
  loadSuggestions();

  // Le pseudo enregistré dans Firestore fait foi si displayName n'a pas été posé.
  try {
    const profil = await getDoc(doc(db, "users", user.uid));
    if (profil.exists() && profil.data().pseudo) {
      $("user-email").textContent = profil.data().pseudo;
    }
  } catch { /* le profil n'est pas indispensable à l'affichage */ }
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
    if (mode === "signup") await signUp(email, pass);
    else await signInWithEmailAndPassword(auth, email, pass);
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

  const existant = await getDoc(doc(db, "usernames", key));
  if (existant.exists()) throw new Error("pseudo-pris");

  const { user } = await createUserWithEmailAndPassword(auth, email, pass);

  // Le compte existe désormais : en cas d'échec ici, on le garde plutôt que de
  // laisser la personne sans compte alors qu'elle vient de le créer.
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
    "auth/admin-restricted-operation": "La création de compte est bloquée dans Authentication → Settings.",
    "auth/unauthorized-domain":   "Ce domaine n'est pas autorisé. Ajoute-le dans Authentication → Settings.",
    "auth/requires-recent-login": "Reconnecte-toi, puis recommence : cette action demande une connexion récente.",
    "auth/invalid-api-key":       "La clé API de firebase-config.js est incorrecte."
  };
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

/* ══════════════════ Mot de passe oublié ══════════════════ */

$("auth-forgot").addEventListener("click", () => showReset(true));
$("reset-back").addEventListener("click", () => showReset(false));

function showReset(on) {
  $("login-view").hidden = on;
  $("reset-view").hidden = !on;
  hideError();
  hideResetError();
  if (on) { $("reset-form").reset(); $("reset-email").focus(); }
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

/* ══════════════════ Navigation par onglets ══════════════════ */

$("tab-discover").addEventListener("click", () => showView("discover"));
$("tab-collection").addEventListener("click", () => showView("collection"));
$("back-to-collection").addEventListener("click", () => showView("collection"));

function showView(name) {
  $("view-discover").hidden   = name !== "discover";
  $("view-collection").hidden = name !== "collection";
  $("view-series").hidden     = name !== "series";

  // La vue détail reste rattachée à l'onglet Collection.
  const surCollection = name !== "discover";
  $("tab-discover").classList.toggle("is-active", !surCollection);
  $("tab-collection").classList.toggle("is-active", surCollection);
  $("tab-discover").setAttribute("aria-current", surCollection ? "false" : "page");
  $("tab-collection").setAttribute("aria-current", surCollection ? "page" : "false");

  if (name !== "series") openSeriesId = null;
  window.scrollTo(0, 0);
}

/* ══════════════════ Suggestions ══════════════════ */

async function loadSuggestions() {
  if (suggestionsLoaded) return;
  suggestionsLoaded = true;

  const grid = $("suggestions");
  grid.innerHTML = `<p class="loading">Chargement des suggestions…</p>`;

  try {
    const res = await fetch(`${API}/top/manga?type=manga&filter=bypopularity&limit=20`);
    if (!res.ok) throw new Error(`Jikan a répondu ${res.status}`);

    const { data } = await res.json();
    if (!data?.length) throw new Error("aucune série renvoyée");

    grid.innerHTML = "";
    data.forEach((manga) => grid.appendChild(suggestionCard(manga)));
  } catch (err) {
    suggestionsLoaded = false;
    console.error("Suggestions Jikan :", err);
    grid.innerHTML = `<p class="loading">Suggestions indisponibles pour le moment (${escapeHtml(err.message)}). La recherche ci-dessus fonctionne normalement.</p>`;
  }
}

function suggestionCard(manga) {
  const id    = String(manga.mal_id);
  const title = pickTitle(manga);
  const cover = pickCover(manga);

  const card = document.createElement("button");
  card.type = "button";
  card.className = "poster";
  card.innerHTML = `
    <span class="poster-img">
      <img src="${cover}" alt="" loading="lazy" referrerpolicy="no-referrer">
    </span>
    <span class="poster-name">${escapeHtml(title)}</span>
    <span class="poster-meta">${manga.volumes ? `${manga.volumes} tomes` : "Série en cours"}</span>`;

  const meta = card.querySelector(".poster-meta");
  const marquerSuivie = () => {
    if (!collectionCache.some((s) => s.id === id)) return;
    card.querySelector(".poster-img").insertAdjacentHTML(
      "beforeend", `<span class="poster-check">Suivie</span>`);
    meta.textContent = "Déjà dans ton rayon";
  };
  marquerSuivie();

  card.addEventListener("click", async () => {
    if (collectionCache.some((s) => s.id === id)) return showView("collection");
    meta.textContent = "Ajout…";
    try {
      await addSeries(manga);
      toast(`${title} est dans ton rayon.`);
      marquerSuivie();
    } catch (err) {
      meta.textContent = err.message === "annule" ? "Ajout annulé" : "Ajout impossible";
    }
  });

  return card;
}

/* ══════════════════ Recherche ══════════════════ */

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const term = $("search-input").value.trim();
  if (!term) return;

  const box = $("search-results");
  box.hidden = false;
  box.innerHTML = `<p class="result">Recherche en cours…</p>`;

  try {
    const url = `${API}/manga?q=${encodeURIComponent(term)}&limit=10&sfw=true`;
    const res = await fetch(url);
    if (res.status === 429) throw new Error("Trop de recherches d'affilée. Attends quelques secondes.");
    if (!res.ok) throw new Error(`Jikan a répondu ${res.status}`);

    const { data } = await res.json();

    if (!data.length) {
      box.innerHTML = `<p class="result">Aucune série trouvée pour « ${escapeHtml(term)} ». Essaie le titre original ou anglais.</p>`;
      return;
    }
    box.innerHTML = "";
    data.forEach((manga) => box.appendChild(resultRow(manga)));
  } catch (err) {
    console.error("Recherche Jikan :", err);
    box.innerHTML = `<p class="result">${escapeHtml(err.message)}</p>`;
  }
});

function resultRow(manga) {
  const id    = String(manga.mal_id);
  const title = pickTitle(manga);
  const suivie = collectionCache.some((s) => s.id === id);

  const row = document.createElement("div");
  row.className = "result";
  row.innerHTML = `
    <img src="${pickCover(manga)}" alt="" loading="lazy" referrerpolicy="no-referrer">
    <div class="result-info">
      <span class="result-title">${escapeHtml(title)}</span>
      <span class="result-year">${manga.volumes ? `${manga.volumes} tomes` : "nombre de tomes inconnu"}${manga.published?.prop?.from?.year ? ` · ${manga.published.prop.from.year}` : ""}</span>
    </div>
    <button type="button" ${suivie ? "disabled" : ""}>${suivie ? "Déjà suivie" : "Ajouter"}</button>`;

  const btn = row.querySelector("button");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Ajout…";
    try {
      await addSeries(manga);
      btn.textContent = "Ajoutée";
      toast(`${title} est dans ton rayon.`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Ajouter";
      if (err.message !== "annule") toast("L'ajout a échoué.");
    }
  });
  return row;
}

/* MyAnimeList référence les titres en romaji ; c'est en général celui de
   l'édition française aussi. On retombe sur l'anglais si besoin. */
function pickTitle(manga) {
  return manga.title || manga.title_english || "Sans titre";
}

function pickCover(manga) {
  const img = manga.images?.jpg || {};
  return img.large_image_url || img.image_url || img.small_image_url || "";
}

/* ══════════════════ Ajout d'une série ══════════════════ */

async function addSeries(manga) {
  let total = Number(manga.volumes) || 0;

  // Une série en cours n'a pas de total connu : on demande où elle en est.
  if (!total) {
    const saisi = prompt(
      `Combien de tomes sont parus pour « ${pickTitle(manga)} » ?\n` +
      `MyAnimeList ne le sait pas pour les séries en cours. Tu pourras corriger plus tard.`,
      "10");
    if (saisi === null) throw new Error("annule");
    total = Number(saisi);
  }

  if (!Number.isInteger(total) || total < 1 || total > 500) {
    toast("Indique un nombre de tomes entre 1 et 500.");
    throw new Error("total invalide");
  }

  await setDoc(doc(db, "users", currentUser.uid, "series", String(manga.mal_id)), {
    id: String(manga.mal_id),
    title: pickTitle(manga),
    cover: pickCover(manga),
    totalVolumes: total,
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
    if (openSeriesId) renderDetail();
  }, (err) => {
    console.error("Firestore :", err.code, err.message);
    $("loading").textContent = "Impossible de lire ta collection. Vérifie les règles Firestore.";
  });
}

function renderCollection() {
  const grid = $("series-list");
  grid.innerHTML = "";

  $("empty-state").hidden = collectionCache.length > 0;
  $("stats").hidden       = collectionCache.length === 0;

  let owned = 0, total = 0;

  collectionCache.forEach((series) => {
    owned += series.owned.length;
    total += series.totalVolumes;

    const manquants = series.totalVolumes - series.owned.length;
    const complete  = manquants === 0;

    const card = document.createElement("button");
    card.type = "button";
    card.className = "poster";
    card.innerHTML = `
      <span class="poster-img">
        <img src="${series.cover}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <span class="poster-badge">${series.owned.length} / ${series.totalVolumes}</span>
        ${complete ? `<span class="poster-check">Complète</span>` : ""}
      </span>
      <span class="poster-name">${escapeHtml(series.title)}</span>
      <span class="poster-meta">${complete ? "Rien ne manque" : `${manquants} ${manquants > 1 ? "tomes" : "tome"} à trouver`}</span>`;

    card.addEventListener("click", () => openSeries(series.id));
    grid.appendChild(card);
  });

  $("stat-owned").textContent   = owned;
  $("stat-missing").textContent = total - owned;
  $("stat-series").textContent  = collectionCache.length;
}

/* ══════════════════ Détail d'une série ══════════════════ */

function openSeries(id) {
  openSeriesId = id;
  volumeFilter = "all";
  document.querySelectorAll(".filter").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.filter === "all"));
  renderDetail();
  showView("series");
}

document.querySelectorAll(".filter").forEach((btn) => {
  btn.addEventListener("click", () => {
    volumeFilter = btn.dataset.filter;
    document.querySelectorAll(".filter").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    renderDetail();
  });
});

function renderDetail() {
  const series = collectionCache.find((s) => s.id === openSeriesId);
  if (!series) return showView("collection");   // la série vient d'être retirée

  const manquants = series.totalVolumes - series.owned.length;
  const pct = series.totalVolumes
    ? Math.round((series.owned.length / series.totalVolumes) * 100) : 0;

  $("detail-cover").src         = series.cover || "";
  $("detail-title").textContent = series.title;
  $("detail-count").textContent = manquants === 0
    ? `Collection complète : ${series.totalVolumes} tomes`
    : `${series.owned.length} tomes sur ${series.totalVolumes} — il t'en manque ${manquants}`;
  $("detail-bar").style.width = `${pct}%`;

  const grid = $("detail-volumes");
  grid.innerHTML = "";

  // Les numéros sont déduits du total : rien n'est stocké pour un tome manquant.
  const numeros = Array.from({ length: series.totalVolumes }, (_, i) => String(i + 1));

  const visibles = numeros.filter((n) => {
    const has = series.owned.includes(n);
    return volumeFilter === "all"
        || (volumeFilter === "owned"   && has)
        || (volumeFilter === "missing" && !has);
  });

  $("detail-nothing").hidden = visibles.length > 0;
  $("detail-nothing").textContent = volumeFilter === "owned"
    ? "Tu ne possèdes encore aucun tome de cette série."
    : "Il ne te manque aucun tome.";

  visibles.forEach((n) => {
    const has = series.owned.includes(n);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `vol ${has ? "vol-owned" : "vol-missing"}`;
    btn.setAttribute("aria-pressed", has);
    btn.title = has
      ? `Tome ${n} — possédé. Cliquer pour retirer.`
      : `Tome ${n} — manquant. Cliquer pour ajouter.`;
    btn.innerHTML = `<span class="vol-num">${n}</span>`;
    btn.addEventListener("click", () => toggleVolume(series.id, n, has));
    grid.appendChild(btn);
  });
}

/* Le nombre de tomes de l'édition française diffère souvent du référencement
   japonais, et une série en cours avance : il faut pouvoir le corriger. */
$("detail-count-edit").addEventListener("click", async () => {
  const series = collectionCache.find((s) => s.id === openSeriesId);
  if (!series) return;

  const saisi = prompt(
    `Combien de tomes compte « ${series.title} » ?`,
    String(series.totalVolumes));
  if (saisi === null) return;

  const total = Number(saisi);
  if (!Number.isInteger(total) || total < 1 || total > 500) {
    return toast("Indique un nombre entre 1 et 500.");
  }

  // On retire de la liste les tomes cochés qui dépassent le nouveau total.
  const owned = series.owned.filter((n) => Number(n) <= total);

  await updateDoc(doc(db, "users", currentUser.uid, "series", series.id),
    { totalVolumes: total, owned });
  toast("Nombre de tomes mis à jour.");
});

async function toggleVolume(seriesId, n, has) {
  const ref = doc(db, "users", currentUser.uid, "series", seriesId);
  await updateDoc(ref, { owned: has ? arrayRemove(n) : arrayUnion(n) });
}

$("detail-remove").addEventListener("click", async () => {
  const series = collectionCache.find((s) => s.id === openSeriesId);
  if (!series) return;
  if (!confirm(`Retirer « ${series.title} » de ton rayon ?`)) return;
  await deleteDoc(doc(db, "users", currentUser.uid, "series", series.id));
  showView("collection");
  toast("Série retirée.");
});

/* ══════════════════ Suppression du compte ══════════════════ */

$("delete-account").addEventListener("click", () => {
  $("delete-modal").hidden = false;
  $("delete-error").hidden = true;
  $("delete-pass").value = "";
  $("delete-pass").focus();
});

$("delete-cancel").addEventListener("click", () => { $("delete-modal").hidden = true; });

$("delete-confirm").addEventListener("click", async () => {
  const pass = $("delete-pass").value;
  $("delete-error").hidden = true;

  if (!pass) {
    $("delete-error").textContent = "Saisis ton mot de passe pour confirmer.";
    $("delete-error").hidden = false;
    return;
  }

  $("delete-confirm").disabled = true;
  $("delete-confirm").textContent = "Suppression…";

  try {
    const user = auth.currentUser;

    // Firebase exige une connexion récente avant de supprimer un compte.
    await reauthenticateWithCredential(
      user, EmailAuthProvider.credential(user.email, pass));

    // Les données d'abord : une fois le compte supprimé, plus aucune règle
    // Firestore ne nous laisserait y toucher.
    const series = await getDocs(collection(db, "users", user.uid, "series"));
    await Promise.all(series.docs.map((d) => deleteDoc(d.ref)));

    const profil = await getDoc(doc(db, "users", user.uid));
    if (profil.exists() && profil.data().pseudo) {
      await deleteDoc(doc(db, "usernames", profil.data().pseudo.toLowerCase()));
    }
    await deleteDoc(doc(db, "users", user.uid));

    await deleteUser(user);   // déclenche onAuthStateChanged et renvoie à l'accueil

    $("delete-modal").hidden = true;
    toast("Compte et données supprimés.");
  } catch (err) {
    console.error("Suppression :", err.code, err.message, err);
    $("delete-error").textContent =
      err.code === "auth/invalid-credential" || err.code === "auth/wrong-password"
        ? "Mot de passe incorrect."
        : authMessage(err.code);
    $("delete-error").hidden = false;
  } finally {
    $("delete-confirm").disabled = false;
    $("delete-confirm").textContent = "Tout supprimer";
  }
});

/* ══════════════════ Utilitaires ══════════════════ */

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("auth-screen").hidden = false;
