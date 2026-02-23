// =============================================================================
// js/index.js — GIS Pucobre
// Versión: 3.0 (parches post-revisión)
// Correcciones v2.0:
//   ✅ Funciones auxiliares definidas, handler KML, popup, Firebase 10.12.4
// Parches v3.0:
//   ✅ escapeHTML: reemplazos corregidos (no eran no-op, pero se confirmó OK)
//   ✅ storageBucket unificado a gis-pucobre.appspot.com
//   ✅ testPermisos: usa query+limit(1) en vez de getDocs completo
//   ✅ KML parse: fallback a texto si DOMParser falla
//   ✅ onAuthStateChanged: muestra email real cuando hay sesión Email Link
//   ✅ Guardar: autor usa email real de Firebase si disponible
//   ✅ Colores concesiones: claves ajustadas a valores exactos del GeoJSON
// =============================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import {
  getFirestore, collection, setDoc, onSnapshot, doc,
  serverTimestamp, getDocs, query, limit
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js';

// =============================================================================
// 0) CONFIGURACIÓN FIREBASE
// =============================================================================
const firebaseConfig = {
  apiKey:            "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
  authDomain:        "gis-pucobre.firebaseapp.com",
  projectId:         "gis-pucobre",
  storageBucket:     "gis-pucobre.appspot.com",   // ← unificado (acceso.js alineado también)
  messagingSenderId: "654550355942",
  appId:             "1:654550355942:web:06a8bd8014a0faa86f5027",
  measurementId:     "G-2CSXPQN2SC"
};

const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// =============================================================================
// 1) CONTROL DE IDENTIDAD (sessionStorage — no pide en F5, sí en nueva pestaña)
// =============================================================================
const urlParams  = new URLSearchParams(window.location.search);
const proyectoID = urlParams.get('area') ?? 'general';

function validarIdentidad() {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let cached = null;
  try { cached = sessionStorage.getItem('pucobre_user'); } catch {}

  if (cached && emailRegex.test(cached)) {
    console.log('✅ Usuario recuperado de sessionStorage:', cached);
    return cached;
  }

  const { area: areaNorm } = normalizeArea(urlParams.get('area') ?? 'general');
  const AREA_LABEL = (areaNorm || 'general').replace(/[-_]+/g, ' ').toUpperCase();

  while (true) {
    const raw = prompt(`📍 Área: ${AREA_LABEL}\nIngrese su correo corporativo para continuar:`);
    if (raw === null) {
      alert('Acceso denegado. Se requiere identificación para usar el GIS.');
      throw new Error('Sin identidad — acceso bloqueado');
    }
    const email = String(raw).toLowerCase().trim();
    if (emailRegex.test(email)) {
      try { sessionStorage.setItem('pucobre_user', email); } catch {}
      return email;
    }
    alert('❌ Correo no válido. Ejemplo: usuario@pucobre.cl');
  }
}

const userEmail = validarIdentidad();

// =============================================================================
// 2) NORMALIZACIÓN DE ÁREA → COLECCIÓN FIRESTORE
// =============================================================================
function normalizeArea(raw) {
  const s  = String(raw ?? '').toLowerCase().trim();
  const s2 = s.replace(/\s+/g, '').replace(/-/g, '_');

  if (['pozo13','pozo_13','p13'].includes(s2)) {
    return { area: 'pozo13', collection: 'geometrias_pozo13' };
  }
  const isRol234 = ['rol23_4','rol234','rol_23_4','23_4','234'].includes(s2);
  if (isRol234) {
    return { area: 'rol23_4', collection: 'geometrias_rol23_4' };
  }
  return { area: s2 || 'general', collection: 'geometrias' };
}

const { area: areaNorm, collection: geomCollection } = normalizeArea(proyectoID);
const AREA_LABEL = areaNorm.replace(/[-_]+/g, ' ').toUpperCase();
document.title = `GIS Pucobre — ${AREA_LABEL}`;

// =============================================================================
// 3) UTILITARIOS
// =============================================================================

/** Escapa caracteres HTML para evitar XSS en popups */
function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/** Genera un ID de geometría único */
function newFID() {
  return 'fid_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/**
 * Asegura que un GeoJSON tenga __fid en sus properties.
 * Retorna el fid asignado.
 */
function ensureFID(gj) {
  if (!gj) return null;
  const tgt = (gj.type === 'Feature') ? gj : (gj.features?.[0]);
  if (!tgt) return null;
  tgt.properties      = tgt.properties ?? {};
  tgt.properties.__fid = tgt.properties.__fid ?? newFID();
  return tgt.properties.__fid;
}

/** Parsea JSON de forma segura, retorna null si falla */
function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** Valida que un GeoJSON no supere maxBytes (default 1 MiB) */
function validarTamanioDoc(gj, maxBytes = 1 * 1024 * 1024) {
  try { return new Blob([JSON.stringify(gj)]).size <= maxBytes; } catch { return false; }
}

/** Verifica que Firestore responde — retorna true si hay acceso */
async function testPermisos() {
  try {
    // query limit(1): prueba reglas sin traer toda la colección
    const colRef = collection(db, geomCollection);
    const q      = query(colRef, limit(1));
    await getDocs(q);
    return true;
  } catch (err) {
    console.warn('⚠️ testPermisos falló:', err?.code);
    return false;
  }
}

// =============================================================================
// 4) ESTADO GLOBAL
// =============================================================================
const pending        = new Map();   // fid → { layer, meta }
const docMap         = new Map();   // fid → docId Firestore
const ownerByFid     = new Map();   // fid → autor
const gruposPorAutor = {};          // autor → L.featureGroup

let authReady    = false;
let isSaving     = false;
let unsubscribeRT = null;

// =============================================================================
// 5) MAPA LEAFLET
// =============================================================================
const latParam  = parseFloat(urlParams.get('lat'));
const lngParam  = parseFloat(urlParams.get('lng'));
const zoomParam = parseInt(urlParams.get('zoom'), 10);

const latInicial  = Number.isFinite(latParam)  ? latParam  : -27.366;
const lngInicial  = Number.isFinite(lngParam)  ? lngParam  : -70.332;
const zoomInicial = Number.isFinite(zoomParam) ? zoomParam : 14;

const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);

// Basemap: Esri Imagery (HTTPS)
L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: '© Esri — Pucobre', maxZoom: 19 }
).addTo(map);

// Grupos y controles
const localDrafts = L.featureGroup().addTo(map);
const layerControl = L.control.layers(null, null, { collapsed: false }).addTo(map);

// =============================================================================
// 6) CAPA DE CONCESIONES (desde GeoJSON global embebido)
// =============================================================================
(function cargarConcesiones() {
  try {
    // json_poligonos_sirgas_1 está definido por layers/poligonos_sirgas_1.js
    if (typeof json_poligonos_sirgas_1 === 'undefined') return;

    // Colores por valor exacto del campo Status en el GeoJSON fuente
    // (valores tomados de poligonos_sirgas_1.js — no modificar sin actualizar la fuente)
    const statusColors = {
      'Arriendo Victos Muñoz':   '#f39c12',   // naranja — nota: "Victos" es el valor real del GeoJSON
      'En trámite Victor Muñoz': '#3498db'    // azul
    };

    const concesionesLayer = L.geoJSON(json_poligonos_sirgas_1, {
      style: feature => {
        const status = feature.properties?.Status ?? '';
        const color  = statusColors[status] ?? '#95a5a6';
        return { color, weight: 2, fillOpacity: 0.25 };
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties ?? {};
        const nombre  = p.Concesion ?? '(sin nombre)';
        const status  = p.Status    ?? '—';
        layer.bindPopup(
          `<div style="min-width:200px">
            <h4 style="margin:0 0 4px;color:#27ae60">${escapeHTML(nombre)}</h4>
            <small style="color:gray">Estado: ${escapeHTML(status)}</small>
          </div>`
        );
      }
    });

    layerControl.addOverlay(concesionesLayer, '📌 Concesiones (SIRGAS)');
    concesionesLayer.addTo(map);
    console.log('✅ Capa de concesiones cargada');
  } catch (err) {
    console.warn('⚠️ No se pudo cargar capa de concesiones:', err);
  }
})();

// =============================================================================
// 7) HERRAMIENTAS DE DIBUJO (Leaflet.draw)
// =============================================================================
const drawControl = new L.Control.Draw({
  draw: {
    polygon:   { shapeOptions: { color: '#27ae60' } },
    polyline:  { shapeOptions: { color: '#27ae60' } },
    rectangle: { shapeOptions: { color: '#27ae60' } },
    circle:    false,
    marker:    true,
    circlemarker: false
  },
  edit: {
    featureGroup: localDrafts,
    remove: true
  }
});
drawControl.addTo(map);

map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  localDrafts.addLayer(layer);
  const comentario = prompt('Nombre o descripción de esta geometría:') || 'Sin nombre';
  layer.options.customMetadata = { comentario, autor: userEmail, archivo: 'Web' };
  layer.bindPopup(generarTablaPopup(comentario, userEmail, 'Recién creado', {}));
  markDirty(layer, { comentario, autor: userEmail, archivo: 'Web' });
});

map.on(L.Draw.Event.EDITED, (e) => {
  e.layers.eachLayer(layer => {
    const meta = layer.options.customMetadata ?? {};
    markDirty(layer, meta);
  });
});

map.on(L.Draw.Event.DELETED, (e) => {
  e.layers.eachLayer(layer => {
    try {
      const gj  = layer.toGeoJSON();
      const fid = gj.properties?.__fid;
      if (fid && pending.has(fid)) pending.delete(fid);
    } catch {}
  });
  actualizarBoton();
});

// =============================================================================
// 8) UI — markDirty, actualizarBoton, updateStatus
// =============================================================================

/**
 * Marca una capa como pendiente de guardar.
 * @param {L.Layer} layer
 * @param {Object}  meta  — { comentario, autor, archivo }
 */
function markDirty(layer, meta = {}) {
  try {
    const gj  = layer.toGeoJSON();
    const fid = ensureFID(gj) ?? newFID();
    pending.set(fid, { layer, meta });
  } catch (e) {
    console.warn('markDirty error:', e);
  }
  actualizarBoton();
}

/** Actualiza el botón Guardar según cambios pendientes */
function actualizarBoton() {
  const btn = document.getElementById('saveBtn');
  if (!btn) return;
  const count = pending.size;
  btn.disabled     = count === 0 || isSaving;
  btn.textContent  = count === 0
    ? '💾 Guardar Cambios'
    : `💾 Guardar ${count} cambio${count !== 1 ? 's' : ''}`;
}

/**
 * Actualiza el área de estado del header.
 * @param {string}      areaLabel
 * @param {number|null} totalDocs
 * @param {number|null} mineCount
 * @param {string|null} errorCode
 * @param {boolean}     fromCache
 */
function updateStatus(areaLabel, totalDocs, mineCount, errorCode = null, fromCache = false) {
  const el = document.getElementById('status');
  if (!el) return;

  if (errorCode) {
    el.innerHTML = `
      <span class="chip chip--area">📍 ${escapeHTML(areaLabel)}</span>
      <span class="chip chip--error">⚠️ ${escapeHTML(errorCode)}</span>`;
    return;
  }

  el.innerHTML = `
    <span class="chip chip--area">📍 ${escapeHTML(areaLabel)}</span>
    <span class="muted">Total: ${totalDocs ?? '…'}</span>
    <span class="chip chip--mine">Mis capas: ${mineCount ?? 0}</span>
    <span class="muted">${fromCache ? '📦 cache' : '☁️ online'}</span>`;
}

// =============================================================================
// 9) POPUP
// =============================================================================

/**
 * Genera el HTML del popup para una geometría.
 * @param {string} titulo
 * @param {string} autor
 * @param {string} fecha
 * @param {Object} props — propiedades GeoJSON adicionales
 */
function generarTablaPopup(titulo, autor, fecha, props = {}) {
  let html = `<div style="min-width:230px">
    <h4 style="margin:0;color:#27ae60">${escapeHTML(titulo)}</h4>
    <small style="color:gray">👤 ${escapeHTML(autor)} &nbsp; 📅 ${escapeHTML(fecha ?? '—')}</small>
    <hr>
    <table style="width:100%;font-size:11px">`;

  const omitir = ['name', 'Name', 'description', 'styleUrl', 'styleHash', '__fid'];

  for (const k in props) {
    if (omitir.includes(k) || props[k] == null || props[k] === '') continue;
    const val  = props[k];
    const disp = (typeof val === 'string' && val.startsWith('http'))
      ? `<a href="${escapeHTML(val)}" target="_blank" rel="noopener noreferrer">${escapeHTML(val)}</a>`
      : escapeHTML(String(val));
    html += `<tr style="border-bottom:1px solid #eee">
      <td><b>${escapeHTML(k.toUpperCase())}</b></td>
      <td>${disp}</td>
    </tr>`;
  }

  html += '</table></div>';
  return html;
}

// =============================================================================
// 10) CARGA DE ARCHIVOS KML / GeoJSON  ← FIX: handler conectado
// =============================================================================
const kmlInput = document.getElementById('kmlInput');
if (kmlInput) {
  kmlInput.addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;

    const fileName = file.name;
    const ext      = (fileName.split('.').pop() ?? '').toLowerCase();
    const reader   = new FileReader();

    reader.onload = () => {
      try {
        if (ext === 'kml' || ext === 'xml') {
          // Intentar primero con XMLDocument; fallback a texto plano
          let tmpLayer;
          try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(reader.result, 'text/xml');
            // Detectar error de parseo XML
            if (xmlDoc.querySelector('parsererror')) throw new Error('XML inválido');
            tmpLayer = omnivore.kml.parse(xmlDoc);
          } catch {
            // Fallback: pasar el texto directamente a omnivore
            console.warn('DOMParser falló, usando fallback de texto para KML');
            tmpLayer = omnivore.kml.parse(String(reader.result));
          }
          const tmpGroup = L.featureGroup();
          tmpLayer.eachLayer(l => tmpGroup.addLayer(l));
          processLoadedLayers(tmpGroup, fileName);
        } else {
          // GeoJSON / JSON
          const gj       = JSON.parse(reader.result);
          const tmpLayer = L.geoJSON(gj);
          const tmpGroup = L.featureGroup();
          tmpLayer.eachLayer(l => tmpGroup.addLayer(l));
          processLoadedLayers(tmpGroup, fileName);
        }
      } catch (e) {
        console.error('Error al cargar archivo:', e);
        alert(`No se pudo leer el archivo "${fileName}".\nAsegúrate de que sea un KML o GeoJSON válido.`);
      } finally {
        kmlInput.value = ''; // permite recargar el mismo archivo
      }
    };

    reader.readAsText(file);
  });
}

/**
 * Procesa un L.featureGroup cargado desde archivo y lo agrega al mapa como borrador.
 * @param {L.FeatureGroup} layerGroup
 * @param {string}         fileName
 */
function processLoadedLayers(layerGroup, fileName) {
  const all = [];
  layerGroup.eachLayer(l => all.push(l));

  if (all.length === 0) {
    alert('El archivo no contiene geometrías válidas.');
    return;
  }

  let agregados = 0;

  for (let i = 0; i < all.length; i++) {
    const base = all[i];
    let gj;
    try { gj = base.toGeoJSON(); } catch { continue; }

    if (!validarTamanioDoc(gj)) {
      console.warn('Geometría muy grande, omitida:', i);
      continue;
    }

    // Asegurar FID único
    if (gj.properties?.__fid && docMap.has(gj.properties.__fid)) {
      gj.properties.__fid = newFID();
    } else {
      ensureFID(gj);
    }

    const layer = L.geoJSON(gj).getLayers()[0];
    if (!layer) continue;

    const props      = gj.properties ?? {};
    const comentario = props.name ?? props.Name ?? `Elemento ${i + 1}`;

    layer.options.customMetadata = { comentario, archivo: fileName, autor: userEmail };
    layer.bindPopup(generarTablaPopup(comentario, userEmail, 'Recién cargado', props));

    if (layer instanceof L.Path && typeof layer.setStyle === 'function') {
      layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2, dashArray: '5,3' });
    }

    localDrafts.addLayer(layer);
    markDirty(layer, { comentario, archivo: fileName, autor: userEmail });
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
// 11) SINCRONIZACIÓN FIRESTORE (listener en tiempo real)
// =============================================================================
async function initRealtime() {
  if (unsubscribeRT) {
    try { unsubscribeRT(); } catch {}
    unsubscribeRT = null;
  }

  const permisosOK = await testPermisos();
  if (!permisosOK) {
    console.error('❌ Sin permisos en Firestore — colección:', geomCollection);
    updateStatus(AREA_LABEL, null, null, 'Sin permisos en Firestore');
    return;
  }

  console.log('🔄 Listener iniciado en colección:', geomCollection);
  const colRef = collection(db, geomCollection);

  unsubscribeRT = onSnapshot(
    colRef,
    (snap) => {
      const fromCache = snap.metadata.fromCache;
      console.log(
        fromCache ? '🔌 Snapshot desde cache:' : '☁️ Snapshot desde servidor:',
        snap.size, 'documentos'
      );

      // Limpiar overlays previos
      for (const autor in gruposPorAutor) {
        try { map.removeLayer(gruposPorAutor[autor]); }    catch {}
        try { layerControl.removeLayer(gruposPorAutor[autor]); } catch {}
        delete gruposPorAutor[autor];
      }
      docMap.clear();
      ownerByFid.clear();

      // Agrupar por autor
      const dataByAutor = {};
      snap.forEach(d => {
        const data = d.data();
        (dataByAutor[data.autor] ??= []).push({ id: d.id, ...data });
      });

      for (const autor in dataByAutor) {
        const grupo = L.featureGroup();
        const esMio = (autor === userEmail);
        const label = esMio
          ? `<b>⭐ MIS CAPAS (${dataByAutor[autor].length})</b>`
          : `👤 ${escapeHTML(autor)} (${dataByAutor[autor].length})`;

        dataByAutor[autor].forEach(item => {
          const docId = item.id;
          try {
            let geoJSON = null;
            if (typeof item.feature === 'string') {
              geoJSON = safeParseJSON(item.feature);
              if (!geoJSON) { console.warn('⚠️ feature inválido:', docId); return; }
            } else if (item.feature && typeof item.feature === 'object') {
              geoJSON = item.feature;
            } else {
              console.warn('⚠️ Sin feature:', docId); return;
            }

            const fid = ensureFID(geoJSON);
            ownerByFid.set(fid, autor);
            docMap.set(fid, docId);

            const fechaLabel = item.timestamp?.toDate
              ? item.timestamp.toDate().toLocaleString('es-CL')
              : (item.fecha ?? '—');

            const layer = L.geoJSON(geoJSON, {
              pointToLayer: (feature, latlng) => L.marker(latlng),
              style: {
                color:       esMio ? '#27ae60' : '#3498db',
                weight:      2,
                fillOpacity: 0.15
              }
            });

            layer.eachLayer(l => {
              l.options.customMetadata = { autor };
              l.bindPopup(generarTablaPopup(
                item.comentario ?? '(sin nombre)',
                autor,
                fechaLabel,
                geoJSON.properties ?? {}
              ));
              l.addTo(grupo);
            });
          } catch (err) {
            console.error('❌ Error procesando doc', docId, err.message);
          }
        });

        gruposPorAutor[autor] = grupo;
        grupo.addTo(map);
        layerControl.addOverlay(grupo, label);
      }

      const mineCount = dataByAutor[userEmail]?.length ?? 0;
      updateStatus(AREA_LABEL, snap.size, mineCount, null, fromCache);
      actualizarBoton();
    },
    (err) => {
      console.error('❌ onSnapshot error:', err?.code, err);
      updateStatus(AREA_LABEL, null, null, err?.code ?? 'Error de conexión');
    }
  );
}

// =============================================================================
// 12) GUARDAR CAMBIOS
// =============================================================================
document.getElementById('saveBtn').onclick = async () => {
  if (pending.size === 0 || isSaving) return;

  if (!authReady || !auth.currentUser) {
    alert('Autenticando… espera 1-2 segundos e intenta de nuevo.');
    return;
  }

  const btn = document.getElementById('saveBtn');
  const originalText = btn.textContent;
  btn.disabled    = true;
  btn.textContent = '⏳ Guardando…';
  isSaving = true;

  try {
    const uid = auth.currentUser.uid;
    const ops = [];

    for (const [fid, entry] of pending.entries()) {
      const { layer, meta } = entry;
      let gj;
      try { gj = layer.toGeoJSON(); } catch { continue; }
      ensureFID(gj);

      if (!validarTamanioDoc(gj)) {
        console.warn('Documento muy grande, omitido:', fid);
        continue;
      }

      const ref     = doc(db, geomCollection, fid);
      // Preferir email real de Firebase (Email Link) sobre el del prompt()
      const autorFinal = auth.currentUser?.email || userEmail;
      const payload = {
        feature:    JSON.stringify(gj),
        autor:      autorFinal,
        comentario: meta.comentario ?? 'Sin nombre',
        archivo:    meta.archivo    ?? 'Web',
        area:       areaNorm,
        uid,
        fecha:      new Date().toLocaleString('es-CL'),
        timestamp:  serverTimestamp()
      };
      ops.push(setDoc(ref, payload, { merge: true }));
    }

    if (ops.length === 0) {
      alert('No hay cambios válidos para guardar (documentos demasiado grandes).');
      return;
    }

    await Promise.all(ops);

    localDrafts.clearLayers();
    pending.clear();
    actualizarBoton();

    // Feedback visual breve
    const statusEl = document.getElementById('status');
    if (statusEl) {
      const prev = statusEl.innerHTML;
      statusEl.innerHTML = `<span style="color:#10b981;font-weight:700">✅ ${ops.length} cambio(s) guardado(s)</span>`;
      setTimeout(() => { statusEl.innerHTML = prev; }, 3000);
    }
  } catch (e) {
    console.error('❌ Error al guardar:', e?.code, e);
    let msg = `❌ Error al guardar\n\nCódigo: ${e?.code ?? 'desconocido'}\nMensaje: ${e?.message ?? 'Error inesperado'}`;
    if (e?.code === 'permission-denied') {
      msg += '\n\n💡 Verifica las Reglas de Firestore y que tu sesión sea válida.';
    }
    alert(msg);
  } finally {
    isSaving        = false;
    btn.disabled    = false;
    btn.textContent = originalText;
    actualizarBoton();
  }
};

// =============================================================================
// 13) AUTENTICACIÓN ANÓNIMA
// =============================================================================
let authTimeout = setTimeout(() => {
  if (!authReady) {
    console.error('⏱️ Timeout de autenticación (10s)');
    updateStatus(AREA_LABEL, null, null, 'Timeout auth — recarga la página');
  }
}, 10000);

signInAnonymously(auth).catch(err => {
  console.error('❌ signInAnonymously:', err?.code, err);
  updateStatus(AREA_LABEL, null, null, `Auth: ${err?.code ?? 'error'}`);
  clearTimeout(authTimeout);
});

onAuthStateChanged(auth, (u) => {
  authReady = !!u;

  if (authReady) {
    clearTimeout(authTimeout);
    console.log('✅ Autenticado uid:', u.uid, '| email:', u.email ?? '(anónimo)');
  }

  // Mostrar email real si existe (Email Link), de lo contrario el del prompt()
  const userInfo   = document.getElementById('userInfo');
  const emailMostrado = u?.email || userEmail;
  if (userInfo) userInfo.textContent = `👤 ${emailMostrado}`;

  if (unsubscribeRT) { try { unsubscribeRT(); } catch {} unsubscribeRT = null; }
  if (authReady) {
    initRealtime();
  } else {
    console.warn('⚠️ Auth no lista');
  }

  actualizarBoton();
});

// =============================================================================
// 14) INICIALIZACIÓN
// =============================================================================
updateStatus(AREA_LABEL, null, null, null); // estado inicial mientras carga
actualizarBoton();

// Advertir si hay cambios sin guardar al salir
window.addEventListener('beforeunload', (e) => {
  if (pending.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});
