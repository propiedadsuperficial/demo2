// demo2/js/acceso.js
// Autenticación "Email Link (passwordless)" preservando area/lat/lng/zoom.
// Requiere Firebase v10 modular por CDN.

const PROD_BASE   = 'https://propiedadsuperficial.github.io/demo2/';
const ACCESO_BASE = 'https://propiedadsuperficial.github.io/demo2/acceso/';

// --- Utilidades de URL / parámetros ---

function getSearchParams(url = window.location.href) {
  const u = new URL(url);
  return u.searchParams;
}
function pickMapParams(sp = getSearchParams()) {
  // Solo los 4 soportados, en el mismo orden
  const keys = ['area', 'lat', 'lng', 'zoom'];
  const out = new URLSearchParams();
  for (const k of keys) {
    const v = sp.get(k);
    if (v != null && v !== '') out.set(k, v);
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
  const text = p.toString() || 'sin parámetros';
  pill.textContent = text;
}

// Guarda/carga parámetros para fallback
const MAP_PARAMS_KEY = 'demo2:lastMapParams';
function saveMapParamsLocally(params) {
  try { localStorage.setItem(MAP_PARAMS_KEY, params.toString()); } catch {}
}
function loadMapParamsLocally() {
  try {
    const raw = localStorage.getItem(MAP_PARAMS_KEY);
    if (!raw) return null;
    const usp = new URLSearchParams(raw);
    return pickMapParams(usp);
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

// Persistencia local
await setPersistence(auth, browserLocalPersistence);

// --- Estado UI ---
const form = document.getElementById('form-acceso');
const emailInput = document.getElementById('email');
const btnEnviar = document.getElementById('btn-enviar');
const statusEl = document.getElementById('status');

function setStatus(msg, cls = '') {
  statusEl.className = `status ${cls}`.trim();
  statusEl.textContent = msg;
}
function disableForm(disabled) {
  btnEnviar.disabled = disabled;
  emailInput.readOnly = disabled;
}

// (Opcional) validar dominio. Cambia a true si quieres exigir @pucobre.cl en la UI.
const REQUIRE_PUCOBRE_DOMAIN = false;
function isValidCorporate(email) {
  if (!REQUIRE_PUCOBRE_DOMAIN) return true;
  return /@pucobre\.cl$/i.test(email.trim());
}

// --- Flujo: si ya hay sesión activa en /acceso, redirigir a PROD con params ---
onAuthStateChanged(auth, (user) => {
  const mapParams = pickMapParams();
  if (user && window.location.pathname.endsWith('/acceso.html')) {
    const paramsForRedirect = (mapParams.toString() ? mapParams : (loadMapParamsLocally() || new URLSearchParams()));
    const target = `${PROD_BASE}${paramsToString(paramsForRedirect)}`;
    window.location.replace(target);
  }
});

// --- Completar sign-in si el email-link abre en /acceso ---
const LS_EMAIL_KEY = 'demo2:emailForSignIn';
async function maybeCompleteEmailLink() {
  const href = window.location.href;
  if (!isSignInWithEmailLink(auth, href)) return false;

  // Extrae o pide email
  let email = null;
  try { email = localStorage.getItem(LS_EMAIL_KEY) || ''; } catch {}
  if (!email) {
    email = window.prompt('Confirma tu correo para completar el acceso:') || '';
  }
  email = email.trim();
  if (!email) {
    setStatus('No se pudo completar el acceso: correo no proporcionado.', 'err');
    return true; // hubo intento, pero falló
  }

  try {
    disableForm(true);
    setStatus('Completando acceso…', 'warn');
    const cred = await signInWithEmailLink(auth, email, href);
    // Limpia la referencia local
    try { localStorage.removeItem(LS_EMAIL_KEY); } catch {}

    // Conserva parámetros del mapa
    const usp = getSearchParams(href);
    const mapParams = pickMapParams(usp);
    if (mapParams.toString()) saveMapParamsLocally(mapParams);

    // Redirige a producción SIN oobCode/mode/apiKey/lang
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

// --- Envío del email-link desde /acceso ---
function buildActionCodeUrl() {
  // El enlace debe regresar a PRODUCCIÓN con los mismos parámetros
  const params = pickMapParams();
  if (params.toString()) saveMapParamsLocally(params);
  return `${PROD_BASE}${paramsToString(params)}`;
}

function currentContinueUrlForPWA() {
  // Para email link en web pública, handleCodeInApp = true, y url debe estar en Authorized domains
  return buildActionCodeUrl();
}

function buildActionCodeSettings() {
  return {
    url: currentContinueUrlForPWA(),
    handleCodeInApp: true
    // iOS/Android bundles no aplican en web estática.
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
  return `Error de autenticación: ${err?.message || err}`;
}

// UI submit
form?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = (emailInput.value || '').trim();

  if (!email) {
    setStatus('Ingresa tu correo para enviar el enlace.', 'warn');
    emailInput.focus();
    return;
  }
  if (!isValidCorporate(email)) {
    setStatus('Este acceso requiere correo @pucobre.cl', 'warn');
    emailInput.focus();
    return;
  }

  try {
    disableForm(true);
    setStatus('Enviando enlace…', 'warn');

    // Guarda email para completar el flujo sin re-pedirlo
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

// Init vista
setCtxPill();

// Intenta completar sign-in si el enlace llegó a /acceso
await maybeCompleteEmailLink();
