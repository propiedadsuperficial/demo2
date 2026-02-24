// =============================================================================
// js/index.js — GIS Pucobre
// Versión: 5.0 — Autenticación Email Link (passwordless)
//
// Flujo de identidad:
//   VISOR  → sin sesión, lectura pública Firestore
//   EDITOR → sesión activa via Email Link (acceso/acceso.html)
//            el usuario ingresa su correo @pucobre.cl, recibe un enlace,
//            hace clic y queda autenticado — sin contraseña, sin Google
//
// Cambios respecto a v4:
//   ✅ Eliminado GoogleAuthProvider, signInWithPopup, setPersistence manual
//   ✅ loginBtn redirige a acceso/acceso.html (preservando ?area/lat/lng/zoom)
//   ✅ logoutBtn llama signOut() y vuelve a modo VISOR
//   ✅ onAuthStateChanged detecta sesión Email Link → modo EDITOR automático
//   ✅ Sin prompt() de correo — identidad 100% desde Firebase Auth
//   ✅ Preservado todo: Leaflet.draw, omnivore, popup, ensureFID,
//      validarTamanioDoc, processLoadedLayers, grupos por autor,
//      normalizeArea, concesiones SIRGAS, detección de storage bloqueado
// =============================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import {
  getFirestore, collection, setDoc, onSnapshot, doc,
  serverTimestamp, query, limit
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js';

// =============================================================================
// 0) FIREBASE
// =============================================================================
const firebaseConfig = {
  apiKey:            "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
  authDomain:        "gis-pucobre.firebaseapp.com",
  projectId:         "gis-pucobre",
  storageBucket:     "gis-pucobre.appspot.com",
  messagingSenderId: "654550355942",
  appId:             "1:654550355942:web:06a8bd8014a0faa86f5027",
  measurementId:     "G-2CSXPQN2SC"
};

const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// =============================================================================
// 1) DETECCIÓN DE ALMACENAMIENTO BLOQUEADO
//    (Tracking Prevention en Edge/Firefox puede bloquear IndexedDB)
// =============================================================================
(async () => {
  let bloqueado = false;
  try {
    if (typeof indexedDB?.databases === 'function') {
      await indexedDB.databases();
    } else {
      await new Promise((res, rej) => {
        const r = indexedDB.open('__pucobre_test__');
        r.onsuccess = () => { r.result.close(); res(); };
        r.onerror   = rej;
      });
    }
  } catch { bloqueado = true; }

  if (bloqueado) {
    const b = document.getElementById('storage-banner');
    if (b) b.style.display = 'block';
    console.warn('⚠️ Almacenamiento local bloqueado — la sesión no persiste entre recargas');
  }
})();

// =============================================================================
// 2) PARÁMETROS DE URL Y NORMALIZACIÓN DE ÁREA → COLECCIÓN FIRESTORE
// =============================================================================
const urlParams  = new URLSearchParams(window.location.search);
const proyectoID = urlParams.get('area') ?? 'general';

function normalizeArea(raw) {
  const s  = String(raw ?? '').toLowerCase().trim();
  const s2 = s.replace(/\s+/g, '').replace(/-/g, '_');

  if (['pozo13', 'pozo_13', 'p13'].includes(s2))
    return { area: 'pozo13',       collection: 'geometrias_pozo13'      };
  if (['altom', 'alto_m', 'altomelendez', 'alto_melendez'].includes(s2))
    return { area: 'AltoM',        collection: 'geometrias_AltoM'        };
  if (['rancagua200', 'rancagua_200', 'r200'].includes(s2))
    return { area: 'rancagua200',  collection: 'geometrias_rancagua200'  };
  if (['pbcsx', 'pbc_sx', 'biocobre', 'biocobresx', 'biocobre_sx'].includes(s2))
    return { area: 'PBCSX',        collection: 'geometrias_PBCSX'        };

  return { area: s2 || 'general', collection: 'geometrias' };
}

const { area: areaNorm, collection: geomCollection } = normalizeArea(proyectoID);
const AREA_LABEL = areaNorm.replace(/[-_]+/g, ' ').toUpperCase();
document.title = `GIS Pucobre — ${AREA_LABEL}`;

// =============================================================================
// 3) UTILITARIOS
// =============================================================================

function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function newFID() {
  return 'fid_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function ensureFID(gj) {
  if (!gj) return null;
  const tgt = (gj.type === 'Feature') ? gj : (gj.features?.[0]);
  if (!tgt) return null;
  tgt.properties       = tgt.properties ?? {};
  tgt.properties.__fid = tgt.properties.__fid ?? newFID();
  return tgt.properties.__fid;
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function validarTamanioDoc(gj, maxBytes = 1 * 1024 * 1024) {
  try { return new Blob([JSON.stringify(gj)]).size <= maxBytes; } catch { return false; }
}

// =============================================================================
// 4) ESTADO GLOBAL
// =============================================================================
const pending        = new Map();   // fid → { layer, meta }
const docMap         = new Map();   // fid → docId Firestore
const ownerByFid     = new Map();   // fid → autor
const gruposPorAutor = {};          // autor → L.featureGroup

let isSaving      = false;
let unsubscribeRT = null;
let currentUser   = null;           // usuario Firebase activo o null

// =============================================================================
// 5) MAPA LEAFLET
// =============================================================================
const latParam  = parseFloat(urlParams.get('lat'));
const lngParam  = parseFloat(urlParams.get('lng'));
const zoomParam = parseInt(urlParams.get('zoom'), 10);

const map = L.map('map').setView(
  [
    Number.isFinite(latParam)  ? latParam  : -27.366,
    Number.isFinite(lngParam)  ? lngParam  : -70.332
  ],
  Number.isFinite(zoomParam) ? zoomParam : 14
);

L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: '© Esri — Pucobre GIS', maxZoom: 19 }
).addTo(map);

const localDrafts  = L.featureGroup().addTo(map);
const layerControl = L.control.layers(null, null, { collapsed: false }).addTo(map);

// =============================================================================
// 6) CAPA DE CONCESIONES (GeoJSON embebido)
// =============================================================================
(function cargarConcesiones() {
  try {
    if (typeof json_poligonos_sirgas_1 === 'undefined') return;

    const statusColors = {
      'Arriendo Victos Muñoz':   '#f39c12',
      'En trámite Victor Muñoz': '#3498db'
    };

    const layer = L.geoJSON(json_poligonos_sirgas_1, {
      style: f => {
        const color = statusColors[f.properties?.Status ?? ''] ?? '#95a5a6';
        return { color, weight: 2, fillOpacity: 0.25 };
      },
      onEachFeature: (f, l) => {
        const p = f.properties ?? {};
        l.bindPopup(
          `<div style="min-width:200px">
             <h4 style="margin:0 0 4px;color:#27ae60">${escapeHTML(p.Concesion ?? '(sin nombre)')}</h4>
             <small style="color:gray">Estado: ${escapeHTML(p.Status ?? '—')}</small>
           </div>`
        );
      }
    });

    layerControl.addOverlay(layer, '📌 Concesiones (SIRGAS)');
    layer.addTo(map);
  } catch (err) {
    console.warn('⚠️ Error cargando concesiones:', err);
  }
})();

// =============================================================================
// 7) HERRAMIENTAS DE DIBUJO (Leaflet.draw)
//    Deshabilitadas por defecto; setDrawingEnabled(true) las activa al login
// =============================================================================
const drawControl = new L.Control.Draw({
  draw: {
    polygon:      { shapeOptions: { color: '#27ae60' } },
    polyline:     { shapeOptions: { color: '#27ae60' } },
    rectangle:    { shapeOptions: { color: '#27ae60' } },
    circle:       false,
    marker:       true,
    circlemarker: false
  },
  edit: { featureGroup: localDrafts, remove: true }
});
drawControl.addTo(map);

map.on(L.Draw.Event.CREATED, (e) => {
  if (!esEditor()) return;
  const layer      = e.layer;
  const comentario = prompt('Nombre o descripción de esta geometría:') || 'Sin nombre';
  const autor      = currentUser.email;
  localDrafts.addLayer(layer);
  layer.options.customMetadata = { comentario, autor, archivo: 'Web' };
  layer.bindPopup(generarTablaPopup(comentario, autor, 'Recién creado', {}));
  markDirty(layer, { comentario, autor, archivo: 'Web' });
});

map.on(L.Draw.Event.EDITED,  (e) => {
  if (!esEditor()) return;
  e.layers.eachLayer(l => markDirty(l, l.options.customMetadata ?? {}));
});

map.on(L.Draw.Event.DELETED, (e) => {
  e.layers.eachLayer(l => {
    try { const fid = l.toGeoJSON().properties?.__fid; if (fid) pending.delete(fid); } catch {}
  });
  actualizarBoton();
});

// =============================================================================
// 8) esEditor — ¿el usuario puede editar?
// =============================================================================
function esEditor() {
  return !!(currentUser && !currentUser.isAnonymous);
}

// =============================================================================
// 9) setDrawingEnabled — activa / desactiva controles de edición
// =============================================================================
function setDrawingEnabled(enabled) {
  // Controles internos de Leaflet.draw
  const dc = document.querySelector('.leaflet-draw');
  if (dc) {
    dc.style.pointerEvents = enabled ? 'auto'  : 'none';
    dc.style.opacity       = enabled ? '1'     : '0.35';
    dc.title               = enabled ? '' : 'Inicia sesión para editar';
  }
  // Botón KML
  const kmlLabel = document.getElementById('kmlLabel');
  const kmlInput = document.getElementById('kmlInput');
  if (kmlLabel) {
    kmlLabel.style.opacity       = enabled ? '1'    : '0.4';
    kmlLabel.style.pointerEvents = enabled ? 'auto' : 'none';
  }
  if (kmlInput) kmlInput.disabled = !enabled;

  actualizarBoton();
}

// =============================================================================
// 10) UI — markDirty / actualizarBoton / updateStatus / updateModo
// =============================================================================
function markDirty(layer, meta = {}) {
  try {
    const gj  = layer.toGeoJSON();
    const fid = ensureFID(gj) ?? newFID();
    pending.set(fid, { layer, meta });
  } catch (e) { console.warn('markDirty:', e); }
  actualizarBoton();
}

function actualizarBoton() {
  const btn = document.getElementById('saveBtn');
  if (!btn) return;
  const count    = pending.size;
  btn.disabled   = count === 0 || isSaving || !esEditor();
  btn.textContent = count === 0
    ? '💾 Guardar'
    : `💾 Guardar ${count} cambio${count !== 1 ? 's' : ''}`;
}

function updateStatus(totalDocs, mineCount, errorCode = null, fromCache = false) {
  const el = document.getElementById('status');
  if (!el) return;

  if (errorCode) {
    el.innerHTML = `
      <span class="chip chip--area">📍 ${escapeHTML(AREA_LABEL)}</span>
      <span class="chip chip--error">⚠️ ${escapeHTML(errorCode)}</span>`;
    return;
  }

  const mineChip = mineCount > 0
    ? `<span class="chip chip--mine">Mis capas: ${mineCount}</span>` : '';

  el.innerHTML = `
    <span class="chip chip--area">📍 ${escapeHTML(AREA_LABEL)}</span>
    <span class="muted">Total: ${totalDocs ?? '…'}</span>
    ${mineChip}
    <span class="muted">${fromCache ? '📦 cache' : '☁️ online'}</span>`;
}

function updateModo(user) {
  const badge     = document.getElementById('modoBadge');
  const userInfo  = document.getElementById('userInfo');
  const loginBtn  = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  if (user && !user.isAnonymous) {
    // ── EDITOR ───────────────────────────────────────────────────────────
    if (badge)    { badge.className = 'editor'; badge.textContent = '✏️ EDITOR'; }
    if (userInfo) userInfo.textContent = `✏️ ${user.email}`;
    if (loginBtn)  loginBtn.style.display  = 'none';
    if (logoutBtn) logoutBtn.style.display = '';
  } else {
    // ── VISOR ─────────────────────────────────────────────────────────────
    if (badge)    { badge.className = 'visor'; badge.textContent = '👁 VISOR'; }
    if (userInfo) userInfo.textContent = '👁 Sin sesión';
    if (loginBtn)  loginBtn.style.display  = '';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}

// =============================================================================
// 11) POPUP
// =============================================================================
function generarTablaPopup(titulo, autor, fecha, props = {}) {
  let html = `<div style="min-width:230px">
    <h4 style="margin:0;color:#27ae60">${escapeHTML(titulo)}</h4>
    <small style="color:gray">👤 ${escapeHTML(autor)} &nbsp;📅 ${escapeHTML(fecha ?? '—')}</small>
    <hr><table style="width:100%;font-size:11px">`;

  const omitir = ['name', 'Name', 'description', 'styleUrl', 'styleHash', '__fid'];
  for (const k in props) {
    if (omitir.includes(k) || props[k] == null || props[k] === '') continue;
    const val  = props[k];
    const disp = (typeof val === 'string' && val.startsWith('http'))
      ? `<a href="${escapeHTML(val)}" target="_blank" rel="noopener noreferrer">${escapeHTML(val)}</a>`
      : escapeHTML(String(val));
    html += `<tr style="border-bottom:1px solid #eee">
      <td><b>${escapeHTML(k.toUpperCase())}</b></td><td>${disp}</td></tr>`;
  }
  return html + '</table></div>';
}

// =============================================================================
// 12) CARGA KML / GeoJSON
// =============================================================================
document.getElementById('kmlInput')?.addEventListener('change', (ev) => {
  if (!esEditor()) { alert('Inicia sesión para cargar archivos.'); return; }
  const file = ev.target.files?.[0];
  if (!file) return;

  const fileName = file.name;
  const ext      = fileName.split('.').pop().toLowerCase();
  const reader   = new FileReader();

  reader.onload = () => {
    try {
      if (ext === 'kml' || ext === 'xml') {
        let tmpLayer;
        try {
          const xmlDoc = new DOMParser().parseFromString(reader.result, 'text/xml');
          if (xmlDoc.querySelector('parsererror')) throw new Error('XML inválido');
          tmpLayer = omnivore.kml.parse(xmlDoc);
        } catch {
          console.warn('DOMParser falló — fallback a texto');
          tmpLayer = omnivore.kml.parse(String(reader.result));
        }
        const grp = L.featureGroup();
        tmpLayer.eachLayer(l => grp.addLayer(l));
        processLoadedLayers(grp, fileName);
      } else {
        const grp = L.featureGroup();
        L.geoJSON(JSON.parse(reader.result)).eachLayer(l => grp.addLayer(l));
        processLoadedLayers(grp, fileName);
      }
    } catch (e) {
      console.error('Error al cargar:', e);
      alert(`No se pudo leer "${fileName}".\nVerifica que sea KML o GeoJSON válido.`);
    } finally {
      ev.target.value = '';
    }
  };

  reader.readAsText(file);
});

function processLoadedLayers(layerGroup, fileName) {
  const all = [];
  layerGroup.eachLayer(l => all.push(l));
  if (all.length === 0) { alert('El archivo no contiene geometrías válidas.'); return; }

  const autor    = currentUser?.email ?? '(importado)';
  let   agregados = 0;

  for (let i = 0; i < all.length; i++) {
    let gj;
    try { gj = all[i].toGeoJSON(); } catch { continue; }
    if (!validarTamanioDoc(gj)) { console.warn('Geometría muy grande, omitida:', i); continue; }

    if (gj.properties?.__fid && docMap.has(gj.properties.__fid)) {
      gj.properties.__fid = newFID();
    } else { ensureFID(gj); }

    const layer = L.geoJSON(gj).getLayers()[0];
    if (!layer) continue;

    const props      = gj.properties ?? {};
    const comentario = props.name ?? props.Name ?? `Elemento ${i + 1}`;

    layer.options.customMetadata = { comentario, archivo: fileName, autor };
    layer.bindPopup(generarTablaPopup(comentario, autor, 'Recién cargado', props));

    if (layer instanceof L.Path) {
      layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2, dashArray: '5,3' });
    }

    localDrafts.addLayer(layer);
    markDirty(layer, { comentario, archivo: fileName, autor });
    agregados++;
  }

  if (agregados > 0) {
    try { map.fitBounds(localDrafts.getBounds(), { padding: [20, 20] }); } catch {}
    console.log(`✅ ${agregados} geometría(s) cargada(s) desde "${fileName}"`);
  } else {
    alert('No se pudo cargar ninguna geometría del archivo.');
  }
  actualizarBoton();
}

// =============================================================================
// 13) SINCRONIZACIÓN FIRESTORE — lectura siempre activa (pública)
// =============================================================================
async function initRealtime() {
  if (unsubscribeRT) { try { unsubscribeRT(); } catch {} unsubscribeRT = null; }

  console.log('🔄 Listener en:', geomCollection);

  unsubscribeRT = onSnapshot(
    collection(db, geomCollection),
    (snap) => {
      const fromCache = snap.metadata.fromCache;
      console.log(fromCache ? '🔌 cache:' : '☁️ servidor:', snap.size, 'docs');

      // Limpiar overlays previos
      for (const a in gruposPorAutor) {
        try { map.removeLayer(gruposPorAutor[a]); }          catch {}
        try { layerControl.removeLayer(gruposPorAutor[a]); } catch {}
        delete gruposPorAutor[a];
      }
      docMap.clear();
      ownerByFid.clear();

      // Agrupar por autor
      const byAutor = {};
      snap.forEach(d => {
        const data = d.data();
        (byAutor[data.autor] ??= []).push({ id: d.id, ...data });
      });

      const myEmail = currentUser?.email ?? null;

      for (const autor in byAutor) {
        const grupo = L.featureGroup();
        const esMio = autor === myEmail;
        const label = esMio
          ? `<b>⭐ MIS CAPAS (${byAutor[autor].length})</b>`
          : `👤 ${escapeHTML(autor)} (${byAutor[autor].length})`;

        byAutor[autor].forEach(item => {
          try {
            let gj = typeof item.feature === 'string'
              ? safeParseJSON(item.feature)
              : (item.feature ?? null);
            if (!gj) { console.warn('⚠️ feature inválido:', item.id); return; }

            const fid = ensureFID(gj);
            ownerByFid.set(fid, autor);
            docMap.set(fid, item.id);

            const fecha = item.timestamp?.toDate
              ? item.timestamp.toDate().toLocaleString('es-CL')
              : (item.fecha ?? '—');

            L.geoJSON(gj, {
              pointToLayer: (_, ll) => L.marker(ll),
              style: { color: esMio ? '#27ae60' : '#3498db', weight: 2, fillOpacity: 0.15 }
            }).eachLayer(l => {
              l.options.customMetadata = { autor };
              l.bindPopup(generarTablaPopup(
                item.comentario ?? '(sin nombre)', autor, fecha, gj.properties ?? {}
              ));
              l.addTo(grupo);
            });
          } catch (err) {
            console.error('❌ doc', item.id, ':', err.message);
          }
        });

        gruposPorAutor[autor] = grupo;
        grupo.addTo(map);
        layerControl.addOverlay(grupo, label);
      }

      updateStatus(snap.size, myEmail ? (byAutor[myEmail]?.length ?? 0) : 0, null, fromCache);
      actualizarBoton();
    },
    (err) => {
      console.error('❌ onSnapshot:', err?.code);
      updateStatus(null, 0, err?.code ?? 'Error de conexión');
    }
  );
}

// =============================================================================
// 14) GUARDAR CAMBIOS
// =============================================================================
document.getElementById('saveBtn').onclick = async () => {
  if (!esEditor()) {
    alert('⚠️ Debes iniciar sesión para guardar.\nPresiona "✉️ Iniciar sesión" en el header.');
    return;
  }
  if (pending.size === 0 || isSaving) return;

  const btn = document.getElementById('saveBtn');
  const txt = btn.textContent;
  btn.disabled    = true;
  btn.textContent = '⏳ Guardando…';
  isSaving = true;

  try {
    const uid   = currentUser.uid;
    const autor = currentUser.email;
    const ops   = [];

    for (const [fid, { layer, meta }] of pending.entries()) {
      let gj;
      try { gj = layer.toGeoJSON(); } catch { continue; }
      ensureFID(gj);
      if (!validarTamanioDoc(gj)) { console.warn('Omitido (muy grande):', fid); continue; }

      ops.push(setDoc(doc(db, geomCollection, fid), {
        feature:    JSON.stringify(gj),
        autor,
        comentario: meta.comentario ?? 'Sin nombre',
        archivo:    meta.archivo    ?? 'Web',
        area:       areaNorm,
        uid,
        fecha:      new Date().toLocaleString('es-CL'),
        timestamp:  serverTimestamp()
      }, { merge: true }));
    }

    if (ops.length === 0) { alert('No hay cambios válidos para guardar.'); return; }

    await Promise.all(ops);
    localDrafts.clearLayers();
    pending.clear();
    actualizarBoton();

    const el = document.getElementById('status');
    if (el) {
      const prev = el.innerHTML;
      el.innerHTML = `<span style="color:#10b981;font-weight:700">✅ ${ops.length} cambio(s) guardado(s)</span>`;
      setTimeout(() => { el.innerHTML = prev; }, 3000);
    }

  } catch (e) {
    console.error('❌ Error al guardar:', e?.code, e);
    let msg = `❌ Error al guardar\nCódigo: ${e?.code ?? 'desconocido'}\n${e?.message ?? ''}`;
    if (e?.code === 'permission-denied')
      msg += '\n\n💡 Verifica que las Reglas de Firestore permitan escritura a tu cuenta.';
    alert(msg);
  } finally {
    isSaving        = false;
    btn.disabled    = false;
    btn.textContent = txt;
    actualizarBoton();
  }
};

// =============================================================================
// 15) BOTONES LOGIN / LOGOUT
//     Login: redirige a acceso/acceso.html conservando ?area, lat, lng, zoom
//     Logout: signOut() → vuelve a modo VISOR automáticamente
// =============================================================================
document.getElementById('loginBtn')?.addEventListener('click', () => {
  // Construir URL de la página de acceso preservando los parámetros del mapa
  const MAP_KEYS  = ['area', 'lat', 'lng', 'zoom'];
  const params    = new URLSearchParams();
  for (const k of MAP_KEYS) {
    const v = urlParams.get(k);
    if (v !== null && v !== '') params.set(k, v);
  }
  const qs     = params.toString();
  const target = `acceso/acceso.html${qs ? '?' + qs : ''}`;
  window.location.href = target;
});

document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  if (pending.size > 0) {
    const ok = confirm('Tienes cambios sin guardar. ¿Cerrar sesión de todas formas?');
    if (!ok) return;
    localDrafts.clearLayers();
    pending.clear();
  }
  try {
    await signOut(auth);
    // onAuthStateChanged se dispara → updateModo(null) + setDrawingEnabled(false)
  } catch (err) {
    console.error('❌ Error al cerrar sesión:', err);
  }
});

// =============================================================================
// 16) onAuthStateChanged — orquesta VISOR ↔ EDITOR
// =============================================================================
onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  console.log(user
    ? `🔑 ${user.isAnonymous ? 'anónimo' : user.email} (uid: ${user.uid})`
    : '🔓 Sin sesión'
  );

  updateModo(user);                // badge + header + botones
  setDrawingEnabled(esEditor());   // habilitar/deshabilitar dibujo y KML
  await initRealtime();            // lectura siempre, independiente de auth
  actualizarBoton();
});

// =============================================================================
// 17) INICIALIZACIÓN
// =============================================================================
updateStatus(null, 0);      // chips vacíos mientras carga
updateModo(null);           // VISOR por defecto
setDrawingEnabled(false);   // controles de edición deshabilitados

window.addEventListener('beforeunload', (e) => {
  if (pending.size > 0) { e.preventDefault(); e.returnValue = ''; }
});
