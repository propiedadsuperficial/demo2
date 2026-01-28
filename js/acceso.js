// demo2/js/acceso.js
// Flujo de autenticación con "Email Link (passwordless)" usando Firebase v10 modular (ESM por CDN).
// Requisitos:
// - Preservar SIEMPRE los parámetros: area, lat, lng, zoom.
// - Persistencia local (browserLocalPersistence).
// - Redirigir a PROD al finalizar, sin oobCode/mode/apiKey/lang en la URL.
// - Si ya hay sesión en la página de acceso, redirigir a PROD con los mismos parámetros.

const PROD_BASE  = 'https://propiedadsuperficial.github.io/demo2/';
const ACCESO_URL = 'https://propiedadsuperficial.github.io/demo2/acceso/acceso.html';

// --- Utilidades de URL / parámetros ---
const MAP_KEYS = ['area', 'lat', 'lng', 'zoom'];

function getSearchParams(url = window.location.href) {
  const u = new URL(url);
  return u.searchParams;
}

function pickMapParams(sp = getSearchParams()) {
  const out = new URLSearchParams();
  for (const k of MAP_KEYS) {
    const v = sp.get(k);
    if (v !== null && v !== '') out.set(k, v);
  }
  return out;
}

function paramsToString(params) {
  const s = params.toString();
  return s ? `?${s}` : '';
}

function setCtxPill() {
  const pill = document.getElementById('ctx-pill');
  if (!pill) return;
  const p = pickMapParams();
  pill.textContent = p.toString() || 'sin parámetros';
}

// Persistencia simple de parámetros por si hay navegación intermedia
const MAP_PARAMS_KEY = 'demo2:lastMapParams';
function saveMapParamsLocally(params) {
  try { localStorage.setItem(MAP_PARAMS_KEY, params.toString()); } catch {}
}
function loadMapParamsLocally() {
  try {
    const raw = localStorage.getItem(MAP_PARAMS_KEY);
    if (!raw) return null;
    const src = new URLSearchParams(raw);
    const pure = new URLSearchParams();
    for (const k of MAP_KEYS) {
      const v = src.get(k);
      if (v !== null && v !== '') pure.set(k, v);
    }
    return pure;
  } catch { return null; }
}

// --- Firebase (v10, ES Modules por CDN) ---
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import {
  getAuth, isSignInWithEmailLink, signInWithEmailLink, sendSignInLinkToEmail,
  setPersistence, browserLocalPersistence, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
  authDomain: "gis-pucobre.firebaseapp.com",
  projectId: "gis-pucobre",
  storageBucket: "gis-pucobre.firebasestorage.app",
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8014a0faa86f5027",
  measurementId: "G-2CSXPQN2SC"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Persistencia local (requisito)
await setPersistence(auth, browserLocalPersistence);

// --- Estado UI ---
const form = document.getElementById('form-acceso');
const emailInput = document.getElementById('email');
const btnEnviar = document.getElementById('btn-enviar');
const statusEl = document.getElementById('status');

function setStatus(msg, cls = '') {
  if (!statusEl) return;
  statusEl.className = `status ${cls}`.trim();
  statusEl.textContent = msg;
}
function disableForm(disabled) {
  if (btnEnviar) btnEnviar.disabled = disabled;
  if (emailInput) emailInput.readOnly = disabled;
}

// (Opcional) UX: exigir dominio @pucobre.cl (la seguridad real va en Reglas)
const REQUIRE_PUCOBRE_DOMAIN = false;
function isValidCorporate(email) {
  if (!REQUIRE_PUCOBRE_DOMAIN) return true;
  return /@pucobre\.cl$/i.test(String(email || '').trim());
}

// --- Redirige a PROD si ya hay sesión activa en la página de acceso ---
onAuthStateChanged(auth, (user) => {
  const isOnAcceso = window.location.pathname.endsWith('/acceso.html');
  if (user && isOnAcceso) {
    const mapParams = pickMapParams();
    const paramsForRedirect = (mapParams.toString() ? mapParams : (loadMapParamsLocally() || new URLSearchParams()));
    const target = `${PROD_BASE}${paramsToString(paramsForRedirect)}`;
    window.location.replace(target);
  }
});

// --- Completar sign-in si el email-link abre en /acceso/acceso.html ---
const LS_EMAIL_KEY = 'demo2:emailForSignIn';
async function maybeCompleteEmailLink() {
  const href = window.location.href;
  if (!isSignInWithEmailLink(auth, href)) return false;

  // Recupera o solicita el correo
  let email = '';
  try { email = localStorage.getItem(LS_EMAIL_KEY) || ''; } catch {}
  if (!email) {
    email = window.prompt('Confirma tu correo para completar el acceso:') || '';
  }
  email = email.trim();
  if (!email) {
    setStatus('No se pudo completar el acceso: correo no proporcionado.', 'err');
    return true;
  }

  try {
    disableForm(true);
    setStatus('Completando acceso…', 'warn');

    await signInWithEmailLink(auth, email, href);

    // Limpieza de correo almacenado
    try { localStorage.removeItem(LS_EMAIL_KEY); } catch {}

    // Conserva parámetros del mapa y redirige a PROD sin parámetros de auth
    const usp = getSearchParams(href);
    const mapParams = pickMapParams(usp);
    if (mapParams.toString()) saveMapParamsLocally(mapParams);

    const target = `${PROD_BASE}${paramsToString(mapParams)}`;
    setStatus('Acceso completado. Redirigiendo…', 'ok');
    window.location.replace(target);
    return true;
  } catch (err) {
    console.error(err);
    setStatus(describeAuthError(err), 'err');
    disableForm(false);
    return true;
  }
}

// --- Envío del email-link desde la página de acceso ---
function buildActionCodeUrl() {
  // El enlace debe regresar a PRODUCCIÓN con los mismos parámetros
  const params = pickMapParams();
  if (params.toString()) saveMapParamsLocally(params);
  return `${PROD_BASE}${paramsToString(params)}`;
}

function buildActionCodeSettings() {
  return {
    url: buildActionCodeUrl(),
    handleCodeInApp: true
  };
}

function describeAuthError(err) {
  const code = (err && err.code) || '';
  if (code.includes('operation-not-allowed')) {
    return 'Email Link no está habilitado en Firebase Authentication (operation-not-allowed). Activa "Email link (passwordless)".';
  }
  if (code.includes('invalid-continue-uri')) {
    return 'La URL de retorno no está autorizada (invalid-continue-uri). Agrega el dominio de GitHub Pages en Authentication > Settings > Authorized domains.';
  }
  if (code.includes('invalid-email')) {
    return 'Correo inválido. Verifica el formato.';
  }
  if (code.includes('too-many-requests')) {
    return 'Demasiados intentos. Espera unos minutos y vuelve a intentar.';
  }
  return `Error de autenticación: ${err?.message || err}`;
}

// Submit del formulario
form?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = (emailInput?.value || '').trim();

  if (!email) {
    setStatus('Ingresa tu correo para enviar el enlace.', 'warn');
    emailInput?.focus();
    return;
  }
  if (!isValidCorporate(email)) {
    setStatus('Este acceso requiere correo @pucobre.cl', 'warn');
    emailInput?.focus();
    return;
  }

  try {
    disableForm(true);
    setStatus('Enviando enlace…', 'warn');

    // Guarda email para completar sin re-pedirlo
    try { localStorage.setItem(LS_EMAIL_KEY, email); } catch {}

    const acs = buildActionCodeSettings();
    await sendSignInLinkToEmail(auth, email, acs);

    setStatus('Enlace enviado. Revisa tu correo y ábrelo desde este navegador.', 'ok');
  } catch (err) {
    console.error(err);
    setStatus(describeAuthError(err), 'err');
    disableForm(false);
  }
});

// Inicialización de UI y, si aplica, completar el email-link
setCtxPill();
await maybeCompleteEmailLink();
