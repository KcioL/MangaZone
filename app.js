import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc,
  onSnapshot, arrayUnion, arrayRemove, query, orderBy,
  getAggregateFromServer, average, count
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);

/* Cache local persistant : la collection reste consultable et modifiable hors
   ligne, les écritures partent au retour du réseau. Sans lui, l'application
   installée afficherait une page vide dès la connexion perdue.

   Le gestionnaire multi-onglets évite l'erreur qui survient quand le site est
   ouvert deux fois : sans lui, un seul onglet obtient le cache. */
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// Jikan (MyAnimeList). Contrairement à MangaDex, cette API envoie des en-têtes
// CORS, donc elle est appelable directement depuis un navigateur.
const API = "https://api.jikan.moe/v4";

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/* Jikan renvoie régulièrement des 429 (limite de débit) et des 5xx passagers.
   Ces codes-là méritent une nouvelle tentative ; une vraie erreur 4xx, non. */
async function jikan(chemin, essais = 3) {
  let dernier = "";

  for (let i = 0; i < essais; i++) {
    try {
      const res = await fetch(`${API}${chemin}`);
      if (res.ok) return res.json();

      dernier = res.status === 429
        ? "trop de requêtes d'affilée"
        : `Jikan a répondu ${res.status}`;

      if (res.status < 500 && res.status !== 429) break;
    } catch {
      dernier = "serveur injoignable";
    }
    await attendre(900 * (i + 1));
  }

  throw new Error(dernier || "échec de la requête");
}

const $ = (id) => document.getElementById(id);

let currentUser     = null;
let unsubscribe     = null;
let mode            = "login";      // "login" | "signup"
let collectionCache = [];
let openSeriesId    = null;         // série affichée en vue détail
let volumeFilter    = "all";        // "all" | "owned" | "missing"
let suggestionsLoaded = false;
let ouvrirApresAjout  = null;      // série à ouvrir dès qu'elle arrive de Firestore

// Nom du dossier contenant les images. Une seule ligne à changer si tu le
// renommes ou si tu remontes les fichiers à la racine (mettre "").
const DOSSIER_AVATARS = "avatar";

const AVATARS = [
  { id: "homme_1", nom: "Opérateur blond"   },
  { id: "homme_2", nom: "Officier grisonnant" },
  { id: "homme_3", nom: "Éclaireur en noir" },
  { id: "femme_1", nom: "Cheveux courts"    },
  { id: "femme_2", nom: "Rousse en tenue"   },
  { id: "femme_3", nom: "Blonde à la radio" }
];

const AVATAR_DEFAUT = "homme_1";

/* Le nom de fichier n'est jamais construit depuis la valeur brute de la base :
   un identifiant inconnu retombe sur l'avatar par défaut, ce qui empêche
   d'injecter un chemin arbitraire via un document modifié. */
const fichierAvatar = (id) => {
  const sur = AVATARS.some((a) => a.id === id) ? id : AVATAR_DEFAUT;
  return DOSSIER_AVATARS ? `${DOSSIER_AVATARS}/${sur}.png` : `${sur}.png`;
};

let avatarChoisi = AVATAR_DEFAUT;   // sélection en cours sur l'écran d'inscription

/* ══════════════════ Authentification ══════════════════ */

onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  if (!user) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    collectionCache = [];
    openSeriesId = null;
    succesConnus = null;
    notesCache.clear();
    avatarChoisi = AVATAR_DEFAUT;
    $("avatar-modal").hidden = true;
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
  loadEditions();

  // Le profil Firestore fait foi pour le pseudo comme pour l'avatar.
  try {
    const profil = await getDoc(doc(db, "users", user.uid));
    if (profil.exists()) {
      if (profil.data().pseudo) $("user-email").textContent = profil.data().pseudo;
      avatarChoisi = profil.data().avatar || AVATAR_DEFAUT;
    }
  } catch { /* le profil n'est pas indispensable à l'affichage */ }

  appliquerAvatar(avatarChoisi);
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
  $("avatar-field").hidden          = !signup;
  if (signup) {
    avatarChoisi = AVATAR_DEFAUT;
    grilleAvatars($("avatar-choix"), avatarChoisi, (id) => { avatarChoisi = id; });
  }
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
    await setDoc(doc(db, "users", user.uid),
      { pseudo, avatar: avatarChoisi, createdAt: Date.now() });
    await updateProfile(user, { displayName: pseudo });
    $("user-email").textContent = pseudo;
    appliquerAvatar(avatarChoisi);
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

/* ══════════════════ Avatars ══════════════════ */

/* La même grille sert à l'inscription et au changement ultérieur ; seul le
   traitement de la sélection diffère. */
function grilleAvatars(conteneur, actif, auChoix) {
  conteneur.innerHTML = "";

  AVATARS.forEach((a) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `avatar-option ${a.id === actif ? "is-active" : ""}`;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", a.id === actif);
    btn.title = a.nom;
    btn.innerHTML = `<img src="${fichierAvatar(a.id)}" alt="${a.nom}">`;

    btn.addEventListener("click", () => {
      [...conteneur.children].forEach((el) => {
        el.classList.remove("is-active");
        el.setAttribute("aria-checked", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-checked", "true");
      auChoix(a.id);
    });

    conteneur.appendChild(btn);
  });
}

function appliquerAvatar(id) {
  const src = fichierAvatar(id);
  $("brand-avatar").src  = src;
  $("succes-avatar").src = src;
}

$("change-avatar").addEventListener("click", () => {
  grilleAvatars($("avatar-choix-modal"), avatarChoisi, async (id) => {
    avatarChoisi = id;
    appliquerAvatar(id);
    try {
      await setDoc(doc(db, "users", currentUser.uid), { avatar: id }, { merge: true });
      toast("Avatar mis à jour.");
    } catch (err) {
      console.error("Avatar :", err.code, err.message);
      toast("L'avatar n'a pas pu être enregistré.");
    }
  });
  $("avatar-modal").hidden = false;
});

$("avatar-cancel").addEventListener("click", () => { $("avatar-modal").hidden = true; });

/* ══════════════════ Notes ══════════════════

   Chaque personne dépose un vote dans notes/{serie}/votes/{uid}. La moyenne
   n'est stockée nulle part : elle est demandée à Firestore, qui la calcule sur
   ses serveurs. Un compteur cumulé qu'on incrémenterait à la main serait à la
   fois faux dès la première anomalie et impossible à protéger correctement —
   n'importe qui pourrait l'augmenter sans voter.

   Ces requêtes d'agrégation sont facturées une lecture par tranche de mille
   votes, donc bien moins qu'un parcours de tous les documents.
   ═══════════════════════════════════════════ */

const notesCache = new Map();   // serieId -> { moyenne, nombre, mienne }

const votesDe = (serieId) => collection(db, "notes", serieId, "votes");

async function chargerNote(serieId, forcer = false) {
  if (!forcer && notesCache.has(serieId)) return notesCache.get(serieId);

  const vide = { moyenne: null, nombre: 0, mienne: null };

  try {
    const [agg, mien] = await Promise.all([
      getAggregateFromServer(votesDe(serieId), {
        moyenne: average("note"),
        nombre:  count()
      }),
      getDoc(doc(db, "notes", serieId, "votes", currentUser.uid))
    ]);

    const d = agg.data();
    const res = {
      moyenne: d.nombre ? d.moyenne : null,
      nombre:  d.nombre,
      mienne:  mien.exists() ? mien.data().note : null
    };
    notesCache.set(serieId, res);
    return res;
  } catch (err) {
    console.error("Lecture des notes :", err.code, err.message);
    return vide;
  }
}

async function noter(serieId, note) {
  const ref = doc(db, "notes", serieId, "votes", currentUser.uid);
  if (note === null) await deleteDoc(ref);
  else await setDoc(ref, { note, at: Date.now() });

  await chargerNote(serieId, true);   // la moyenne vient de changer
  renderCollection();
  document.querySelectorAll(`#suggestions .poster[data-serie="${serieId}"] .poster-note,
                             #editions .poster[data-serie="${serieId}"] .poster-note`)
    .forEach((el) => {
      const n = notesCache.get(serieId);
      el.textContent = n && n.moyenne !== null ? texteNote(n) : "";
    });
  if (openSeriesId === serieId) renderDetail();
}

const chiffreNote = (v) => v.toFixed(1).replace(".", ",");

/* Version simple, pour les vignettes de la collection. */
const texteNote = (n) =>
  n.moyenne === null
    ? "Pas encore noté"
    : `${chiffreNote(n.moyenne)} / 10 · ${n.nombre} avis`;

/* Version balisée, pour la vue détail : la moyenne y est mise en valeur et
   le reste passe au second plan. */
const htmlNote = (n) =>
  n.moyenne === null
    ? `<span class="note-vide">Pas encore noté</span>`
    : `<span class="note-chiffre">${chiffreNote(n.moyenne)}</span>`
    + `<span class="note-sur">/ 10</span>`
    + `<span class="note-avis">${n.nombre} avis</span>`;

/* ══════════════════ Succès ══════════════════

   Rien n'est stocké : chaque succès est recalculé à partir de la collection.
   Un compteur enregistré finirait tôt ou tard désynchronisé de la réalité,
   par exemple après le retrait d'une série.
   ═════════════════════════════════════════════ */

/* Les titres varient d'une source à l'autre : accents, ponctuation, casse.
   On compare des formes normalisées plutôt que les libellés bruts. */
const normaliser = (t) => t.toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]/g, "");

/* Deux questions différentes, deux fonctions.

   Pour une série encore en cours comme One Piece, « complète » n'a aucun sens :
   ce qui compte est le nombre de tomes réunis. Pour Naruto ou Bleach, qui sont
   terminées, c'est l'inverse — et le total varie selon l'édition, donc un seuil
   fixe serait faux. Mélanger les deux faisait débloquer « 200 tomes » à qui
   complétait une édition de 110. */
const trouver = (titres) => {
  const cibles = titres.map(normaliser);
  return collectionCache.filter((s) => cibles.includes(normaliser(s.title)));
};

const tomesDe   = (titres) => Math.max(0, ...trouver(titres).map((s) => s.owned.length));
const completee = (titres) => trouver(titres).some(
  (s) => s.totalVolumes > 0 && s.owned.length === s.totalVolumes) ? 1 : 0;

const ONE_PIECE = ["One Piece"];
const NARUTO    = ["Naruto"];
const BLEACH    = ["Bleach"];

const SUCCES = [
  // ── Progression ───────────────────────────────────────────
  { g: "Progression", id: "s1", nom: "Première pierre",     texte: "Ajouter une première série",                 palier: 1,   mesure: (b) => b.series },
  { g: "Progression", id: "s2", nom: "Étagère garnie",      texte: "Suivre 5 séries",                            palier: 5,   mesure: (b) => b.series },
  { g: "Progression", id: "s3", nom: "Bibliothécaire",      texte: "Suivre 15 séries",                           palier: 15,  mesure: (b) => b.series },
  { g: "Progression", id: "s4", nom: "Archiviste",          texte: "Suivre 30 séries",                           palier: 30,  mesure: (b) => b.series },

  { g: "Progression", id: "t1", nom: "Premier tome",        texte: "Posséder un premier tome",                   palier: 1,   mesure: (b) => b.tomes },
  { g: "Progression", id: "t2", nom: "Petite pile",         texte: "Posséder 10 tomes",                          palier: 10,  mesure: (b) => b.tomes },
  { g: "Progression", id: "t3", nom: "Vraie collection",    texte: "Posséder 50 tomes",                          palier: 50,  mesure: (b) => b.tomes },
  { g: "Progression", id: "t4", nom: "Mur de manga",        texte: "Posséder 100 tomes",                         palier: 100, mesure: (b) => b.tomes },
  { g: "Progression", id: "t5", nom: "Fonds de dotation",   texte: "Posséder 250 tomes",                         palier: 250, mesure: (b) => b.tomes },
  { g: "Progression", id: "t6", nom: "Rayonnage complet",   texte: "Posséder 500 tomes",                         palier: 500, mesure: (b) => b.tomes },

  { g: "Progression", id: "c1", nom: "Bouclée",             texte: "Compléter une série",                        palier: 1,   mesure: (b) => b.completes },
  { g: "Progression", id: "c2", nom: "Perfectionniste",     texte: "Compléter 5 séries",                         palier: 5,   mesure: (b) => b.completes },
  { g: "Progression", id: "c3", nom: "Intégraliste",        texte: "Compléter 10 séries",                        palier: 10,  mesure: (b) => b.completes },
  { g: "Progression", id: "c4", nom: "Sans une lacune",     texte: "Compléter 20 séries",                        palier: 20,  mesure: (b) => b.completes },

  { g: "Progression", id: "l1", nom: "Longue haleine",      texte: "Compléter une série de 20 tomes ou plus",    palier: 1,   mesure: (b) => b.longuesCompletes },
  { g: "Progression", id: "l2", nom: "Souffle infini",      texte: "Compléter une série de 50 tomes ou plus",    palier: 1,   mesure: (b) => b.tresLonguesCompletes },
  { g: "Progression", id: "e1", nom: "Sur tous les fronts", texte: "Avoir 5 séries commencées mais inachevées",  palier: 5,   mesure: (b) => b.enCours },
  { g: "Progression", id: "f1", nom: "Fondations",          texte: "Posséder le tome 1 de 10 séries",            palier: 10,  mesure: (b) => b.premiersTomes },
  { g: "Progression", id: "m1", nom: "Moitié du chemin",    texte: "Posséder la moitié de tous les tomes suivis", palier: 50,  mesure: (b) => b.pourcentage },
  { g: "Progression", id: "m2", nom: "Aucun trou",          texte: "Posséder 100 % des tomes, sur 3 séries au moins", palier: 1, mesure: (b) => b.sansTrou },

  // ── Séries mythiques ──────────────────────────────────────
  { g: "Séries mythiques", id: "b1", nom: "Sur la Grand Line", texte: "Réunir 50 tomes de One Piece",               palier: 50,  mesure: (b) => b.tomesOnePiece },
  { g: "Séries mythiques", id: "b2", nom: "Roi des pirates",   texte: "Réunir 100 tomes de One Piece",              palier: 100, mesure: (b) => b.tomesOnePiece },
  { g: "Séries mythiques", id: "b3", nom: "Hokage",            texte: "Compléter Naruto",                           palier: 1,   mesure: (b) => b.naruto },
  { g: "Séries mythiques", id: "b4", nom: "Shinigami",         texte: "Compléter Bleach",                           palier: 1,   mesure: (b) => b.bleach },
  { g: "Séries mythiques", id: "b5", nom: "Le Big 3",          texte: "One Piece à 100 tomes, Naruto et Bleach complets", palier: 3, mesure: (b) => b.big3 },
  { g: "Séries mythiques", id: "b8", nom: "À jour",            texte: "Posséder tous les tomes parus de One Piece", palier: 1,   mesure: (b) => b.onePieceAJour },
  { g: "Séries mythiques", id: "b6", nom: "Cahier noir",       texte: "Compléter une édition de Death Note",        palier: 1,   mesure: (b) => b.deathNote },
  { g: "Séries mythiques", id: "b7", nom: "Trois piliers",     texte: "Suivre les trois séries du Big 3",           palier: 3,   mesure: (b) => b.big3Suivies }
];

let succesConnus = null;    // null tant que la première lecture n'a pas eu lieu

function bilan() {
  const series    = collectionCache.length;
  const tomes     = collectionCache.reduce((n, s) => n + s.owned.length, 0);
  const total     = collectionCache.reduce((n, s) => n + s.totalVolumes, 0);
  const completes = collectionCache.filter((s) => s.owned.length === s.totalVolumes).length;

  const tomesOnePiece = tomesDe(ONE_PIECE);
  const naruto = completee(NARUTO);
  const bleach = completee(BLEACH);

  return {
    series, tomes, completes,

    longuesCompletes: collectionCache.filter(
      (s) => s.totalVolumes >= 20 && s.owned.length === s.totalVolumes).length,
    tresLonguesCompletes: collectionCache.filter(
      (s) => s.totalVolumes >= 50 && s.owned.length === s.totalVolumes).length,
    enCours: collectionCache.filter(
      (s) => s.owned.length > 0 && s.owned.length < s.totalVolumes).length,
    premiersTomes: collectionCache.filter((s) => s.owned.includes("1")).length,

    pourcentage: total ? Math.round((tomes / total) * 100) : 0,
    sansTrou: series >= 3 && total > 0 && tomes === total ? 1 : 0,

    tomesOnePiece,
    onePieceAJour: completee(ONE_PIECE),
    naruto,
    bleach,
    big3: (tomesOnePiece >= 100 ? 1 : 0) + naruto + bleach,
    big3Suivies: [ONE_PIECE, NARUTO, BLEACH].filter((t) => trouver(t).length).length,
    deathNote: collectionCache.filter(
      (s) => normaliser(s.title).startsWith("deathnote")
          && s.totalVolumes > 0 && s.owned.length === s.totalVolumes).length
  };
}

function renderSucces() {
  const b = bilan();
  const etat = SUCCES.map((s) => ({
    ...s,
    valeur:   Math.min(s.mesure(b), s.palier),
    debloque: s.mesure(b) >= s.palier
  }));

  const obtenus = etat.filter((s) => s.debloque);

  $("succes-resume").textContent = `${obtenus.length} succès sur ${SUCCES.length}`;
  $("succes-bar").style.width = `${Math.round((obtenus.length / SUCCES.length) * 100)}%`;

  // Groupés dans l'ordre d'apparition du catalogue.
  const groupes = [];
  etat.forEach((s) => {
    let g = groupes.find((x) => x.nom === s.g);
    if (!g) groupes.push(g = { nom: s.g, items: [] });
    g.items.push(s);
  });

  $("succes-liste").innerHTML = groupes.map((g) => {
    const faits = g.items.filter((s) => s.debloque).length;
    return `
      <section class="succes-groupe">
        <h3 class="succes-groupe-titre">
          ${escapeHtml(g.nom)}
          <span>${faits} / ${g.items.length}</span>
        </h3>
        <div class="succes-cartes">
          ${g.items.map((s) => `
            <article class="succes ${s.debloque ? "is-done" : ""}">
              <span class="succes-marque">${s.debloque ? "✦" : ""}</span>
              <h4 class="succes-nom">${escapeHtml(s.nom)}</h4>
              <p class="succes-texte">${escapeHtml(s.texte)}</p>
              <p class="succes-jauge">${s.debloque ? "Débloqué" : `${s.valeur} / ${s.palier}`}</p>
            </article>`).join("")}
        </div>
      </section>`;
  }).join("");

  // Signaler les nouveaux succès, mais pas au premier chargement : tout
  // paraîtrait débloqué à l'instant.
  const ids = new Set(obtenus.map((s) => s.id));
  if (succesConnus) {
    const nouveaux = obtenus.filter((s) => !succesConnus.has(s.id));
    if (nouveaux.length === 1) toast(`Succès débloqué : ${nouveaux[0].nom}`);
    else if (nouveaux.length > 1) toast(`${nouveaux.length} nouveaux succès débloqués`);
  }
  succesConnus = ids;
}

/* ══════════════════ Navigation par onglets ══════════════════ */

/* Les onglets du haut et la barre du bas partagent le même attribut data-vue :
   un seul gestionnaire suffit, et rien à rebrancher si une barre change. */
document.querySelectorAll("[data-vue]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.vue));
});
$("back-to-collection").addEventListener("click", () => showView("collection"));

function showView(name) {
  $("view-discover").hidden   = name !== "discover";
  $("view-collection").hidden = name !== "collection";
  $("view-succes").hidden     = name !== "succes";
  $("view-series").hidden     = name !== "series";

  // La vue détail reste rattachée à l'onglet Collection.
  const onglet = name === "discover" ? "discover"
               : name === "succes"   ? "succes"
               : "collection";

  document.querySelectorAll("[data-vue]").forEach((btn) => {
    const actif = btn.dataset.vue === onglet;
    btn.classList.toggle("is-active", actif);
    btn.setAttribute("aria-current", actif ? "page" : "false");
  });

  // Position du curseur glissant de la barre du bas : le CSS traduit ce rang
  // en déplacement, et anime la transition.
  const rang = ["discover", "collection", "succes"].indexOf(onglet);
  document.querySelector(".barre-basse")?.style.setProperty("--onglet", rang);

  if (name !== "series") openSeriesId = null;
  window.scrollTo(0, 0);
}

/* ══════════════════ Sources de données ══════════════════

   AniList est la source principale : elle possède sa propre base, autorise
   CORS et ne dépend d'aucun service tiers. Jikan sert de repli, mais il se
   contente de relayer MyAnimeList et renvoie un 504 dès que MAL ne répond pas.
   ═══════════════════════════════════════════════════════ */

const ANILIST = "https://graphql.anilist.co";

/* Les bases internationales référencent la tomaison d'origine, qui ne
   correspond pas toujours à l'édition française. Ces corrections priment. */
const TOMES_VF = {
  "solo leveling": 19
};

/* Coffrets et rééditions françaises absents des bases. La couverture est
   récupérée à l'affichage via `source`, pour ne pas figer une URL d'image. */
const EDITIONS_VF = [
  {
    id: "vf-death-note-black-edition",
    title: "Death Note — Black Edition",
    volumes: 6,
    cover: "death-note-black-edition.jpg",
    note: "Réédition en 6 tomes doubles"
  }
];

const CHAMPS = `
  id
  title { romaji english }
  volumes
  coverImage { large }
  startDate { year }
`;

async function anilist(query, variables = {}) {
  const res = await fetch(ANILIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) throw new Error(`AniList a répondu ${res.status}`);

  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

/* Les deux sources sont ramenées à une même forme, pour que le reste du code
   ignore d'où viennent les données. */
// Le titre anglais colle bien mieux aux éditions françaises que le romaji :
// « Solo Leveling » plutôt que « Na Honjaman Level Up ».
const depuisAniList = (m) => corrigerVF({
  id:      `al-${m.id}`,
  title:   m.title?.english || m.title?.romaji || "Sans titre",
  cover:   m.coverImage?.large || "",
  volumes: m.volumes || 0,
  year:    m.startDate?.year || null
});

const depuisJikan = (m) => corrigerVF({
  id:      `mal-${m.mal_id}`,
  title:   m.title_english || m.title || "Sans titre",
  cover:   m.images?.jpg?.large_image_url || m.images?.jpg?.image_url || "",
  volumes: m.volumes || 0,
  year:    m.published?.prop?.from?.year || null
});

function corrigerVF(serie) {
  const vf = TOMES_VF[serie.title.toLowerCase()];
  if (vf) serie.volumes = vf;
  return serie;
}

async function seriesPopulaires() {
  try {
    const d = await anilist(
      `query { Page(perPage: 40) { media(
         type: MANGA, format: MANGA, sort: POPULARITY_DESC, isAdult: false
       ) { ${CHAMPS} } } }`);
    return d.Page.media.map(depuisAniList);
  } catch (err) {
    console.warn("AniList indisponible, repli sur Jikan :", err.message);
    const { data } = await jikan("/top/manga?limit=25");
    return data.map(depuisJikan);
  }
}

async function chercherSeries(terme) {
  try {
    const d = await anilist(
      `query ($q: String) { Page(perPage: 10) { media(
         type: MANGA, search: $q, format_not: NOVEL, isAdult: false
       ) { ${CHAMPS} } } }`,
      { q: terme });
    return d.Page.media.map(depuisAniList);
  } catch (err) {
    console.warn("AniList indisponible, repli sur Jikan :", err.message);
    const { data } = await jikan(`/manga?q=${encodeURIComponent(terme)}&limit=10&sfw=true`);
    return data.map(depuisJikan);
  }
}

/* ══════════════════ Suggestions ══════════════════ */

async function loadSuggestions() {
  if (suggestionsLoaded) return;
  suggestionsLoaded = true;

  const grid = $("suggestions");
  grid.innerHTML = `<p class="loading">Chargement des suggestions…</p>`;

  try {
    const series = await seriesPopulaires();
    if (!series.length) throw new Error("aucune série renvoyée");

    grid.innerHTML = "";
    series.forEach((serie) => grid.appendChild(suggestionCard(serie)));
  } catch (err) {
    suggestionsLoaded = false;
    console.error("Suggestions :", err);
    grid.innerHTML = `
      <p class="loading">
        Suggestions indisponibles pour le moment (${escapeHtml(err.message)}).
        <button type="button" class="btn-link" id="suggest-retry">Réessayer</button>
      </p>`;
    $("suggest-retry").addEventListener("click", loadSuggestions);
  }
}

function suggestionCard(serie) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "poster";
  card.dataset.serie = serie.id;

  // Libellé d'origine conservé : il doit pouvoir être rétabli si la série est
  // retirée de la collection.
  card.dataset.meta = serie.note
    || (serie.volumes ? `${serie.volumes} tomes` : "Série en cours");

  card.innerHTML = `
    <span class="poster-img">
      <img src="${serie.cover}" alt="" loading="lazy" referrerpolicy="no-referrer">
    </span>
    <span class="poster-name">${escapeHtml(serie.title)}</span>
    <span class="poster-meta"></span>
    <span class="poster-note"></span>`;

  synchroniserCarte(card);
  observateurNotes.observe(card);

  card.addEventListener("click", async () => {
    if (collectionCache.some((s) => s.id === serie.id)) return showView("collection");
    card.querySelector(".poster-meta").textContent = "Ajout…";
    try {
      await addSeries(serie);
      toast(`${serie.title} est dans ton rayon.`);
    } catch (err) {
      card.dataset.meta = err.message === "annule" ? "Ajout annulé" : "Ajout impossible";
      synchroniserCarte(card);
    }
  });

  return card;
}

/* Le badge « Suivie » doit refléter l'état courant, pas celui du moment où la
   carte a été fabriquée : sans ça, il subsiste après le retrait d'une série. */
function synchroniserCarte(card) {
  const suivie = collectionCache.some((s) => s.id === card.dataset.serie);

  card.querySelector(".poster-meta").textContent =
    suivie ? "Déjà dans ton rayon" : card.dataset.meta;

  const image = card.querySelector(".poster-img");
  const badge = image.querySelector(".poster-check");

  if (suivie && !badge) {
    image.insertAdjacentHTML("beforeend", `<span class="poster-check">Suivie</span>`);
  } else if (!suivie && badge) {
    badge.remove();
  }
}

/* Rejoué à chaque changement de collection, pour les deux grilles. */
function majSuggestions() {
  document.querySelectorAll("#suggestions .poster, #editions .poster")
    .forEach(synchroniserCarte);
}

/* Les notes ne sont demandées que pour les cartes qui entrent à l'écran :
   interroger d'un coup les quarante suggestions ferait autant de requêtes
   pour des séries que personne ne regardera. */
const observateurNotes = new IntersectionObserver((entrees) => {
  entrees.forEach((e) => {
    if (!e.isIntersecting) return;
    observateurNotes.unobserve(e.target);

    chargerNote(e.target.dataset.serie)
      .then((n) => {
        const cible = e.target.querySelector(".poster-note");
        if (cible) cible.textContent = n.moyenne === null ? "" : texteNote(n);
      })
      .catch(() => { /* une moyenne absente ne doit pas casser la grille */ });
  });
}, { rootMargin: "300px" });

/* ══════════════════ Recherche ══════════════════ */

let minuteurRecherche = null;
let jetonRecherche    = 0;      // identifie la dernière requête lancée

/* Recherche au fil de la frappe.

   Deux protections indispensables ici. L'amortissement évite de lancer une
   requête par lettre, ce qui épuiserait vite le quota d'AniList. Le jeton écarte
   les réponses périmées : « nar » peut très bien revenir après « naruto », et
   afficherait alors les mauvais résultats. */
$("search-input").addEventListener("input", () => {
  const terme = $("search-input").value.trim();
  clearTimeout(minuteurRecherche);

  if (terme.length < 2) {
    jetonRecherche++;                 // annule une réponse encore en vol
    $("search-results").hidden = true;
    $("search-input").classList.remove("is-searching");
    return;
  }

  $("search-input").classList.add("is-searching");
  minuteurRecherche = setTimeout(() => lancerRecherche(terme), 350);
});

// Entrée cherche immédiatement, sans attendre l'amortissement.
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(minuteurRecherche);
  const terme = $("search-input").value.trim();
  if (terme) lancerRecherche(terme);
});

async function lancerRecherche(terme) {
  const jeton = ++jetonRecherche;
  const box   = $("search-results");

  // On ne vide pas la liste précédente : elle reste lisible pendant la requête,
  // ce qui évite un clignotement à chaque lettre.
  box.hidden = false;
  if (!box.children.length) box.innerHTML = `<p class="result">Recherche en cours…</p>`;

  try {
    const series = await chercherSeries(terme);
    if (jeton !== jetonRecherche) return;      // une frappe plus récente a pris le relais

    if (!series.length) {
      box.innerHTML = `<p class="result">Aucune série trouvée pour « ${escapeHtml(terme)} ».</p>`;
    } else {
      box.innerHTML = "";
      series.forEach((serie) => box.appendChild(resultRow(serie)));
    }
  } catch (err) {
    if (jeton !== jetonRecherche) return;
    console.error("Recherche :", err);
    box.innerHTML = `<p class="result">La recherche n'a pas abouti : ${escapeHtml(err.message)}.</p>`;
  } finally {
    if (jeton === jetonRecherche) $("search-input").classList.remove("is-searching");
  }
}

function resultRow(serie) {
  const suivie = collectionCache.some((s) => s.id === serie.id);

  const row = document.createElement("div");
  row.className = "result";
  row.innerHTML = `
    <img src="${serie.cover}" alt="" loading="lazy" referrerpolicy="no-referrer">
    <div class="result-info">
      <span class="result-title">${escapeHtml(serie.title)}</span>
      <span class="result-year">${serie.volumes ? `${serie.volumes} tomes` : "nombre de tomes inconnu"}${serie.year ? ` · ${serie.year}` : ""}</span>
    </div>
    <button type="button" ${suivie ? "disabled" : ""}>${suivie ? "Déjà suivie" : "Ajouter"}</button>`;

  const btn = row.querySelector("button");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Ajout…";
    try {
      await addSeries(serie);
      btn.textContent = "Ajoutée";
      toast(`${serie.title} est dans ton rayon.`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Ajouter";
      if (err.message !== "annule") toast("L'ajout a échoué.");
    }
  });
  return row;
}

/* ══════════════════ Ajout d'une série ══════════════════ */

async function addSeries(serie) {
  let total = Number(serie.volumes) || 0;

  // Une série en cours n'a pas de total connu : on demande où elle en est.
  if (!total) {
    const saisi = prompt(
      `Combien de tomes sont parus pour « ${serie.title} » ?\n` +
      `La série est en cours, le total n'est pas référencé. Tu pourras le corriger plus tard.`,
      "10");
    if (saisi === null) throw new Error("annule");
    total = Number(saisi);
  }

  if (!Number.isInteger(total) || total < 1 || total > 500) {
    toast("Indique un nombre de tomes entre 1 et 500.");
    throw new Error("total invalide");
  }

  // À poser AVANT l'écriture : Firestore déclenche onSnapshot localement dès
  // que la donnée est mise en file, souvent avant que setDoc soit résolu.
  ouvrirApresAjout = serie.id;

  try {
    await setDoc(doc(db, "users", currentUser.uid, "series", serie.id), {
      id: serie.id,
      title: serie.title,
      cover: serie.cover || "",
      totalVolumes: total,
      owned: [],
      addedAt: Date.now()
    });
  } catch (err) {
    ouvrirApresAjout = null;
    throw err;
  }

  // Filet de sécurité si l'instantané est déjà passé entre-temps.
  if (ouvrirApresAjout === serie.id
      && collectionCache.some((s) => s.id === serie.id)) {
    ouvrirApresAjout = null;
    openSeries(serie.id);
  }
}

/* ══════════════════ Éditions françaises ══════════════════ */

async function loadEditions() {
  const grid = $("editions");
  grid.innerHTML = "";

  for (const edition of EDITIONS_VF) {
    // L'image est un fichier du dépôt : rien à aller chercher en ligne, et
    // aucun risque de lien mort.
    let cover = edition.cover || "";

    if (!cover && edition.source) {
      try {
        const trouvees = await chercherSeries(edition.source);
        cover = trouvees[0]?.cover || "";
      } catch { /* la carte reste utilisable sans image */ }
    }

    grid.appendChild(suggestionCard({
      id: edition.id,
      title: edition.title,
      cover,
      volumes: edition.volumes,
      year: null,
      note: edition.note
    }));
  }
}

/* ══════════════════ Ajout manuel ══════════════════ */

/* Couverture choisie depuis l'appareil.

   Beaucoup de sites marchands refusent que leurs images soient affichées
   ailleurs : le lien s'ouvre bien dans un onglet mais renvoie une erreur
   depuis un autre domaine. La seule solution fiable est de détenir l'image.

   Elle est donc réduite et recompressée dans le navigateur, puis enregistrée
   avec la série. Un document Firestore est plafonné à un peu moins d'un
   mégaoctet : d'où la réduction à 360 pixels de large, largement suffisante
   pour l'affichage, et la boucle qui abaisse la qualité si besoin. */
let couvertureLocale = null;

const LARGEUR_COUV = 360;
const POIDS_MAX    = 180 * 1024;   // marge confortable sous la limite du document

function reduireImage(fichier) {
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onerror = () => reject(new Error("lecture impossible"));
    lecteur.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("ce fichier n'est pas une image"));
      img.onload = () => {
        const ratio = Math.min(1, LARGEUR_COUV / img.width);
        const c = document.createElement("canvas");
        c.width  = Math.round(img.width  * ratio);
        c.height = Math.round(img.height * ratio);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);

        // On descend la qualité par paliers jusqu'à tenir dans le poids visé.
        let q = 0.82, sortie = c.toDataURL("image/jpeg", q);
        while (sortie.length > POIDS_MAX && q > 0.4) {
          q -= 0.12;
          sortie = c.toDataURL("image/jpeg", q);
        }
        resolve(sortie);
      };
      img.src = lecteur.result;
    };
    lecteur.readAsDataURL(fichier);
  });
}

$("manual-fichier").addEventListener("change", async (e) => {
  const fichier = e.target.files?.[0];
  if (!fichier) return;

  try {
    couvertureLocale = await reduireImage(fichier);
    $("manual-apercu").src = couvertureLocale;
    $("manual-apercu").hidden = false;
    $("manual-retirer").hidden = false;
    $("manual-cover").value = "";            // le fichier prime sur le lien
    zoneImage("Remplacer l'image", "Une autre photo ou capture");
    toast(`Image prête (${Math.round(couvertureLocale.length / 1024)} Ko).`);
  } catch (err) {
    reinitialiserImage();
    toast(`Image refusée : ${err.message}.`);
  }
});

$("manual-retirer").addEventListener("click", reinitialiserImage);

/* La zone annonce ce qu'un clic va faire : ajouter, ou remplacer. */
function zoneImage(titre, note) {
  document.querySelector(".zone-image-titre").textContent = titre;
  document.querySelector(".zone-image-note").textContent  = note;
}

function reinitialiserImage() {
  couvertureLocale = null;
  $("manual-fichier").value = "";
  $("manual-apercu").hidden = true;
  $("manual-retirer").hidden = true;
  zoneImage("Choisir une image", "Photo ou capture depuis ton appareil");
}

$("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = $("manual-title").value.trim();
  const total = Number($("manual-volumes").value);
  const cover = couvertureLocale || $("manual-cover").value.trim();

  if (!title) return toast("Donne un titre à cette édition.");
  if (!Number.isInteger(total) || total < 1 || total > 500) {
    return toast("Indique un nombre de tomes entre 1 et 500.");
  }

  // Identifiant lisible et stable, dérivé du titre.
  const id = "vf-" + title.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  if (collectionCache.some((s) => s.id === id)) {
    return toast("Cette édition est déjà dans ta collection.");
  }

  try {
    await addSeries({ id, title, cover, volumes: total });
    $("manual-form").reset();
    reinitialiserImage();
    document.querySelector(".manual").open = false;
    toast(`${title} est dans ta collection.`);
  } catch {
    toast("L'ajout a échoué.");
  }
});

/* ══════════════════ Lecture temps réel ══════════════════ */

function watchCollection(uid) {
  $("loading").hidden = false;
  const q = query(collection(db, "users", uid, "series"), orderBy("addedAt", "asc"));

  unsubscribe = onSnapshot(q, (snap) => {
    $("loading").hidden = true;
    collectionCache = snap.docs.map((d) => d.data());
    renderCollection();
    renderSucces();
    majSuggestions();
    if (openSeriesId) renderDetail();

    // L'ajout est confirmé par Firestore, pas par le clic : on attend que la
    // série soit bien là avant d'ouvrir sa page.
    if (ouvrirApresAjout && collectionCache.some((s) => s.id === ouvrirApresAjout)) {
      openSeries(ouvrirApresAjout);
      ouvrirApresAjout = null;
    }
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

  let owned = 0, total = 0, completes = 0, commencees = 0;

  const estComplete = (s) => s.totalVolumes > 0 && s.owned.length === s.totalVolumes;

  /* Les séries complètes d'abord, puis l'ordre alphabétique à l'intérieur de
     chaque groupe.

     `localeCompare` en français traite correctement les accents et les
     caractères non latins, là où une comparaison brute placerait « Ère » après
     « Zone ». L'option `base` ignore casse et accents, et `numeric` range
     « Baki 2 » avant « Baki 10 » au lieu de l'inverse.

     La copie évite de réordonner le cache lui-même, qui doit rester tel que
     Firestore l'a renvoyé pour les succès et les recherches. */
  const ordonnees = [...collectionCache].sort((a, b) =>
    Number(estComplete(b)) - Number(estComplete(a))
    || a.title.localeCompare(b.title, "fr", { sensitivity: "base", numeric: true }));

  ordonnees.forEach((series) => {
    owned += series.owned.length;
    total += series.totalVolumes;

    const manquants = series.totalVolumes - series.owned.length;
    const complete  = estComplete(series);
    if (complete) completes++;
    // Une série est commencée dès le premier tome coché. Toute série complète
    // est donc aussi commencée : le premier nombre ne dépasse jamais le second.
    if (series.owned.length > 0) commencees++;

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
      <span class="poster-meta">${complete ? "Rien ne manque" : `${manquants} ${manquants > 1 ? "tomes" : "tome"} à trouver`}</span>
      <span class="poster-note"></span>`;

    // La moyenne arrive après coup : la carte s'affiche sans attendre.
    const cible = card.querySelector(".poster-note");
    const connu = notesCache.get(series.id);
    if (connu) cible.textContent = texteNote(connu);
    else chargerNote(series.id).then((n) => { cible.textContent = texteNote(n); });

    card.addEventListener("click", () => openSeries(series.id));
    grid.appendChild(card);
  });

  $("stat-owned").textContent    = owned;
  $("stat-missing").textContent  = total - owned;
  $("stat-series").textContent   = collectionCache.length;
  $("stat-complete").textContent = `${completes} / ${commencees}`;
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

  rendreNotes(series.id);

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

/* Les dix boutons de notation, plus la moyenne. La moyenne arrive de façon
   asynchrone : on affiche d'abord ce qu'on a en cache, puis on rafraîchit. */
async function rendreNotes(serieId) {
  const zone = $("detail-notes");
  const connu = notesCache.get(serieId);

  const dessiner = (n) => {
    if (openSeriesId !== serieId) return;   // la personne a changé de page
    $("detail-note").innerHTML = htmlNote(n);

    zone.innerHTML = "";
    for (let i = 1; i <= 10; i++) {
      const b = document.createElement("button");
      b.type = "button";
      const atteint = n.mienne !== null && i <= n.mienne;
      b.className = "note-btn"
        + (atteint ? " is-atteint" : "")
        + (n.mienne === i ? " is-active" : "");
      b.textContent = i;
      b.setAttribute("aria-pressed", n.mienne === i);
      b.title = n.mienne === i ? "Cliquer pour retirer ta note" : `Noter ${i} sur 10`;
      b.addEventListener("click", () => noter(serieId, n.mienne === i ? null : i));
      zone.appendChild(b);
    }

    const info = document.createElement("span");
    info.className = "note-mienne";
    info.textContent = n.mienne
      ? `Ta note : ${n.mienne} sur 10 — clique à nouveau dessus pour la retirer`
      : "Tu n'as pas encore noté cette série";
    zone.appendChild(info);
  };

  dessiner(connu || { moyenne: null, nombre: 0, mienne: null });
  const frais = await chargerNote(serieId);
  dessiner(frais);
}

/* Coche d'un coup tous les tomes de 1 à N.

   L'opération est purement additive : les tomes déjà cochés au-delà de N sont
   conservés. Quelqu'un qui possède les tomes 1 à 10 et le tome 22 coche donc
   la plage jusqu'à 10, puis le 22 séparément.

   Intérêt secondaire mais réel : une seule écriture Firestore au lieu d'une
   par tome. Saisir une collection de cent tomes passe de cent écritures à
   quelques-unes, ce qui compte sur un quota quotidien. */
$("detail-plage").addEventListener("click", async () => {
  const series = collectionCache.find((s) => s.id === openSeriesId);
  if (!series) return;

  const saisi = prompt(
    `Jusqu'à quel tome de « ${series.title} » ?\n` +
    `Tous les tomes de 1 à ce numéro seront cochés. ` +
    `Ceux que tu possèdes déjà au-delà sont conservés.`,
    String(series.totalVolumes));
  if (saisi === null) return;

  const n = Number(saisi);
  if (!Number.isInteger(n) || n < 1 || n > series.totalVolumes) {
    return toast(`Indique un numéro entre 1 et ${series.totalVolumes}.`);
  }

  const plage = Array.from({ length: n }, (_, i) => String(i + 1));
  const ajoutes = plage.filter((v) => !series.owned.includes(v)).length;

  if (!ajoutes) return toast("Tu possèdes déjà tous ces tomes.");

  // L'ensemble dédoublonne, puis on trie pour garder une liste lisible en base.
  const owned = [...new Set([...series.owned, ...plage])]
    .sort((a, b) => Number(a) - Number(b));

  await updateDoc(doc(db, "users", currentUser.uid, "series", series.id), { owned });
  toast(`${ajoutes} ${ajoutes > 1 ? "tomes ajoutés" : "tome ajouté"}.`);
});

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

/* ══════════════════ Fond réactif au défilement ══════════════════ */

/* Écrit --defile entre 0 et 1 sur <html>, que le CSS utilise pour déplacer
   les halos. La mise à jour est calée sur le rafraîchissement de l'écran :
   l'événement de défilement se déclenche bien plus souvent que nécessaire,
   et écrire dans le style à chaque fois provoquerait des saccades. */
(function fondReactif() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let enAttente = false;

  const racine = document.documentElement;

  /* Trajectoire sinueuse du halo.

     Un vrai tirage aléatoire produirait des sursauts, et le halo se retrouverait
     ailleurs à chaque remontée de page. On combine plutôt deux sinusoïdes de
     fréquences non harmoniques : le chemin ne se répète jamais à l'identique,
     paraît libre, reste fluide, et se retrace exactement en sens inverse.

     x oscille de part et d'autre du centre, y descend en ondulant : le halo
     serpente du haut vers le bas au lieu de filer en diagonale. */
  const majuster = () => {
    const hauteur = racine.scrollHeight - window.innerHeight;
    const part = hauteur > 0 ? Math.min(1, window.scrollY / hauteur) : 0;

    const x = Math.sin(part * 8.2 + 0.9) * 20      // grande oscillation
            + Math.sin(part * 17.5 + 1.2) * 9;     // ondulation plus courte
    const y = part * 104                            // descente d'ensemble
            + Math.sin(part * 8.6) * 11;           // flânerie en chemin

    racine.style.setProperty("--defile", part.toFixed(4));
    racine.style.setProperty("--halo-x", x.toFixed(2));
    racine.style.setProperty("--halo-y", y.toFixed(2));
    enAttente = false;
  };

  const auDefilement = () => {
    if (enAttente) return;
    enAttente = true;
    requestAnimationFrame(majuster);
  };

  addEventListener("scroll", auDefilement, { passive: true });
  addEventListener("resize", auDefilement);
  majuster();
})();

/* ══════════════════ Application installable ══════════════════ */

/* Le service worker garde la coque en cache : l'application s'ouvre
   instantanément et survit à une coupure réseau. Il n'est disponible qu'en
   HTTPS ou sur localhost — en ouvrant le fichier directement, rien ne se passe,
   ce qui est sans conséquence. */
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .catch((err) => console.warn("Service worker non enregistré :", err.message));
  });
}

/* Raccourcis du manifeste : ouvrir directement la collection ou les succès. */
addEventListener("DOMContentLoaded", () => {
  const vue = new URLSearchParams(location.search).get("vue");
  if (!["collection", "succes"].includes(vue)) return;

  // La vue ne peut s'afficher qu'une fois la session rétablie.
  const attendre = setInterval(() => {
    if (!currentUser) return;
    clearInterval(attendre);
    showView(vue);
  }, 120);
  setTimeout(() => clearInterval(attendre), 8000);
});

/* ══════════════════ Utilitaires ══════════════════ */

/* Une couverture peut disparaître à tout moment : fichier absent du dépôt,
   image distante supprimée. Plutôt qu'une icône cassée, on laisse le fond de
   la carte et on affiche l'initiale du titre.
   L'écoute est en phase de capture parce que l'événement "error" d'une image
   ne remonte pas naturellement jusqu'au document. */
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName !== "IMG" || img.dataset.remplace) return;
  img.dataset.remplace = "1";

  const carte = img.closest(".poster-img");
  if (carte) {
    const titre = img.closest(".poster")?.querySelector(".poster-name")?.textContent || "?";
    img.remove();
    carte.insertAdjacentHTML("afterbegin",
      `<span class="cover-fallback">${escapeHtml(titre.trim().charAt(0).toUpperCase())}</span>`);
    return;
  }

  // Vignette de résultat ou couverture de la vue détail : on masque simplement.
  img.style.visibility = "hidden";
}, true);

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
