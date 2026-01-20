// js/index.js — Versión estable con pendientes por FID + guardado idempotente
// Incluye: normalización de área, auth ready, validación de permisos, UI con chips (PATCHES #1-5 aplicados)

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import {
  getFirestore, collection, setDoc, onSnapshot, deleteDoc, doc, serverTimestamp,
  enableIndexedDbPersistence, enableMultiTabIndexedDbPersistence
} from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// ============================================================================
// 0) CONFIG + PARÁMETROS URL
// ============================================================================
const urlParams  = new URLSearchParams(window.location.search);
const proyectoID = urlParams.get('area') ?? 'general';
const latInicial = parseFloat(urlParams.get('lat'))  ?? -27.366;
const lngInicial = parseFloat(urlParams.get('lng'))  ?? -70.332;
const zoomInicial= parseInt(urlParams.get('zoom'))   ?? 14;

const firebaseConfig = {
  apiKey: "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
  authDomain: "gis-pucobre.firebaseapp.com",
  projectId: "gis-pucobre",
  storageBucket: "gis-pucobre.firebasestorage.app",
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8014a0faa86f5027"
};
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// Habilitar persistencia offline multi-tab con fallback (PATCH #3)
enableMultiTabIndexedDbPersistence(db).catch((err) => {
  if (err?.code === 'failed-precondition') {
    console.warn('Multi-tab no disponible, intento single-tab…');
    return enableIndexedDbPersistence(db).catch((err2) => {
      if (err2?.code === 'unimplemented') {
        console.warn('IndexedDB no soportado; sin cache offline.');
      } else {
        console.warn('Sin persistencia offline:', err2?.code || err2);
      }
    });
  }
  if (err?.code === 'unimplemented') {
    console.warn('IndexedDB no soportado; sin cache offline.');
  } else {
    console.warn('Persistencia: error inesperado:', err?.code || err);
  }
});

// Identidad simple
let userEmail = localStorage.getItem('pucobre_user');
if (!userEmail || !userEmail.includes('@')) {
  userEmail = prompt("Ingrese correo corporativo:");
  if (userEmail && userEmail.includes('@')) {
    localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
  } else {
    alert("Acceso denegado.");
    throw new Error("Sin auth");
  }
}

// ============================================================================
// 0.1) NORMALIZACIÓN DE ÁREA → COLECCIÓN (PATCH #4)
// ============================================================================
function normalizeArea(raw) {
  const s = String(raw || '').toLowerCase().trim();
  const s2 = s.replace(/\s+/g, '').replace(/-/g, '_');
  
  if (s2 === 'pozo13' || s2 === 'pozo_13') {
    return { area: 'pozo13', collection: 'geometrias_pozo13' };
  }
  if (s2 === 'rol23_4' || s2 === 'rol234') {
    return { area: 'rol23_4', collection: 'geometrias_rol23_4' };
  }
  
  // Fallback a 'geometrias' (sin sufijo) para coincidir con reglas
  return { area: s2 || 'general', collection: 'geometrias' };
}

const { area: areaNorm, collection: geomCollection } = normalizeArea(proyectoID);

// ============================================================================
// 0.2) FORMATEO DE ÁREA PARA UI
// ============================================================================
function areaDisplay(norm) {
  const known = {
    'pozo13': 'POZO 13',
    'rol23_4': 'ROL 23-4',
    'general': 'GENERAL'
  };
  return known[norm] || norm.replace(/[-_]+/g, ' ').toUpperCase();
}

function escapeHTML(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const AREA_LABEL = areaDisplay(areaNorm);

// Actualizar título del navegador
document.title = `GIS Pucobre — ${AREA_LABEL}`;

// ============================================================================
// 0.3) HELPER PARA ACTUALIZAR STATUS (PATCH #1)
// ============================================================================
function updateStatus(areaLabel, totalCapas = null, misCapas = null, error = null) {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  
  // NO escapar las etiquetas HTML, solo los valores dinámicos
  let html = `<span class="chip chip--area">ÁREA: ${escapeHTML(areaLabel)}</span>`;
  
  if (error) {
    html += `<span class="muted" style="color:#ef4444">· Error: ${escapeHTML(error)}</span>`;
  } else if (totalCapas !== null) {
    html += `<span class="muted">· Total: ${totalCapas} capas</span>`;
    if (misCapas !== null && misCapas > 0) {
      html += `<span class="chip chip--mine" title="Capas propias visibles en esta área">MIS CAPAS (${misCapas})</span>`;
    }
  }
  
  statusEl.innerHTML = html;
}

// Mostrar área inicial
updateStatus(AREA_LABEL);

// ============================================================================
// 0.4) Utilidades de FID persistente
// ============================================================================
const newFID = () => (crypto?.randomUUID?.() ?? (Date.now() + '-' + Math.random().toString(36).slice(2)));

function ensureFID(geojson) {
  if (!geojson.properties) geojson.properties = {};
  if (!geojson.properties.__fid) geojson.properties.__fid = newFID();
  return geojson.properties.__fid;
}

function getFIDFromLayer(layer) {
  return layer?.feature?.properties?.__fid;
}

// Anti-hijack: fuerza nuevo FID si ya existe en nube
function forceNewFIDIfHijack(gj) {
  const fid = gj?.properties?.__fid;
  if (fid && docMap.has(fid)) {
    gj.properties.__fid = newFID();
  }
}

// ============================================================================
// 1) MAPA y TOC
// ============================================================================
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri — Pucobre', maxZoom: 19
}).addTo(map);
window.map = map;

// Grupo visual de borradores
const localDrafts = L.featureGroup().addTo(map);

// Mapas de referencias
const docMap = new Map();
const ownerByFid = new Map();

// TOC por autor
const gruposPorAutor = {};
const layerControl = L.control.layers(null, null, { collapsed: false }).addTo(map);

// Estado
let isSaving = false;
let authReady = false;

// ============================================================================
// 1.1) Pendientes por FID (PATCH #5 - FID persistente en layer)
// ============================================================================
const pending = new Map();

function actualizarBoton() {
  const btn = document.getElementById('saveBtn');
  if (!btn) return;
  const p = pending.size;
  btn.textContent = p ? `💾 Guardar Cambios (${p})` : `💾 Guardar Cambios`;
  btn.disabled = !(authReady && p > 0);
}

function markDirty(layer, extraMeta = {}) {
  const gj = layer.toGeoJSON();
  const fid = ensureFID(gj);
  
  // Persistir FID en el layer para futuras llamadas
  if (!layer.feature) layer.feature = gj;
  if (!layer.feature.properties) layer.feature.properties = {};
  layer.feature.properties.__fid = fid;
  
  layer.options.customMetadata = { ...(layer.options.customMetadata || {}), ...extraMeta };
  pending.set(fid, { layer, meta: layer.options.customMetadata });
  actualizarBoton();
  return fid;
}

// ============================================================================
// 2) Dibujo y borrado
// ============================================================================
const drawControl = new L.Control.Draw({
  edit: { featureGroup: localDrafts, remove: true },
  draw: { circle: false, circlemarker: false }
});
map.addControl(drawControl);

// Crear nuevo dibujo
map.on(L.Draw.Event.CREATED, (e) => {
  const original = e.layer;
  const gj = original.toGeoJSON();
  ensureFID(gj);
  forceNewFIDIfHijack(gj);
  const layer = L.geoJSON(gj).getLayers()[0];

  const comentario = prompt("Nombre/Descripción:") ?? "Dibujo manual";
  layer.options.customMetadata = { comentario, autor: userEmail, archivo: "Web" };

  if (layer instanceof L.Path) {
    layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2, dashArray: '5,3' });
  }

  localDrafts.addLayer(layer);
  markDirty(layer);
});

// Capturar ediciones
map.on(L.Draw.Event.EDITED, (e) => {
  e.layers.eachLayer((layer) => {
    markDirty(layer);
  });
});

// Borrado
map.on(L.Draw.Event.DELETED, async (e) => {
  const layers = e.layers;
  let borrados = 0;
  const tasks = [];

  layers.eachLayer((layer) => {
    const fid = getFIDFromLayer(layer);
    if (fid && pending.has(fid)) {
      pending.delete(fid);
    }

    const dbId = fid ? docMap.get(fid) : undefined;
    const owner = fid ? ownerByFid.get(fid) : undefined;
    
    if (dbId) {
      if (owner === userEmail) {
        tasks.push(
          deleteDoc(doc(db, geomCollection, dbId))
            .then(() => borrados++)
            .catch(err => console.error("Error Firebase:", err))
        );
      } else {
        alert(`No tienes permiso. Autor real: ${owner ?? 'desconocido'}`);
        try { localDrafts.addLayer(layer); } catch {}
      }
    }
  });

  if (tasks.length) await Promise.allSettled(tasks);
  if (borrados > 0) {
    const statusEl = document.getElementById('status');
    if (statusEl) {
      const temp = statusEl.innerHTML;
      statusEl.innerHTML = `<span style="color:#10b981">🗑️ ${borrados} eliminados</span>`;
      setTimeout(() => { statusEl.innerHTML = temp; }, 3000);
    }
  }

  actualizarBoton();
});

// ============================================================================
// 3) Carga KML / GeoJSON
// ============================================================================
document.getElementById('kmlInput').addEventListener('change', function (e) {
  const file = e.target.files[0];
  if (!file) return;
  const fileName = file.name.toLowerCase();
  const reader = new FileReader();
  
  const statusEl = document.getElementById('status');
  if (statusEl) {
    const temp = statusEl.innerHTML;
    statusEl.innerHTML = `<span class="muted">📂 Leyendo ${escapeHTML(file.name)}...</span>`;
    setTimeout(() => { statusEl.innerHTML = temp; }, 2000);
  }

  reader.onload = async (event) => {
    try {
      const content = event.target.result;
      let layerToProcess;

      if (fileName.endsWith('.kml')) {
        const parser = new DOMParser();
        let kmlDOM = parser.parseFromString(content, 'text/xml');
        
        let docEl = kmlDOM.documentElement;
        if (!docEl) {
          if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444">❌ KML inválido</span>`;
          return;
        }

        if (!docEl.getAttribute('xmlns:xsi')) {
          docEl.setAttribute('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance');
        }

        if (kmlDOM.querySelector('parsererror')) {
          kmlDOM = parser.parseFromString(new XMLSerializer().serializeToString(kmlDOM), 'text/xml');
          docEl = kmlDOM.documentElement;
          if (!docEl || kmlDOM.querySelector('parsererror')) {
            if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444">❌ Error al parsear KML</span>`;
            return;
          }
        }
        
        layerToProcess = omnivore.kml.parse(kmlDOM);
        layerToProcess.on('ready', () => unificarYProcesar(layerToProcess, file.name));
      } else {
        layerToProcess = L.geoJSON(JSON.parse(content));
        unificarYProcesar(layerToProcess, file.name);
      }
    } catch (err) {
      console.error(err);
      if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444">❌ Error al procesar archivo</span>`;
    }
  };
  
  reader.readAsText(file);
  e.target.value = '';
});

async function unificarYProcesar(layerGroup, fileName) {
  const all = [];
  layerGroup.eachLayer(l => all.push(l));

  for (let i = 0; i < all.length; i++) {
    const base = all[i];
    const gj = base.toGeoJSON();
    
    if (gj.properties?.__fid && docMap.has(gj.properties.__fid)) {
      gj.properties.__fid = newFID();
    } else {
      ensureFID(gj);
    }
    
    const layer = L.geoJSON(gj).getLayers()[0];
    const props = gj.properties ?? {};
    const name  = props.name ?? props.Name ?? `Elemento ${i + 1}`;

    layer.options.customMetadata = { comentario: name, archivo: fileName, autor: userEmail };
    layer.bindPopup(generarTablaPopup(name, userEmail, "Recién cargado", props));
    
    if (layer instanceof L.Path) {
      layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2, dashArray: '5,3' });
    }

    localDrafts.addLayer(layer);
    markDirty(layer, { comentario: name, archivo: fileName, autor: userEmail });
  }

  if (localDrafts.getLayers().length) {
    try { map.fitBounds(localDrafts.getBounds(), { padding: [20, 20] }); } catch {}
  }
  actualizarBoton();
}

// ============================================================================
// 4) SINCRONIZACIÓN (TOC por autor) - SE INICIA CUANDO AUTH ESTÁ LISTO
// ============================================================================
let unsubscribeRT = null;

function initRealtime() {
  if (unsubscribeRT) {
    try { unsubscribeRT(); } catch {}
    unsubscribeRT = null;
  }

  const colRef = collection(db, geomCollection);
  
  unsubscribeRT = onSnapshot(
    colRef,
    (snap) => {
      // Limpiar TOC y capas de nube
      for (const a in gruposPorAutor) {
        try { map.removeLayer(gruposPorAutor[a]); } catch {}
        try { layerControl.removeLayer(gruposPorAutor[a]); } catch {}
        delete gruposPorAutor[a];
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
          : `👤 ${autor} (${dataByAutor[autor].length})`;

        dataByAutor[autor].forEach(item => {
          try {
            const geoJSON = JSON.parse(item.feature);
            const fid = ensureFID(geoJSON);
            
            ownerByFid.set(fid, autor);
            docMap.set(fid, item.id);
            
            const fechaLabel = item.timestamp?.toDate
              ? item.timestamp.toDate().toLocaleString('es-CL')
              : (item.fecha ?? '-');
            
            const layer = L.geoJSON(geoJSON, {
              style: { color: esMio ? '#27ae60' : '#3498db', weight: 2, fillOpacity: 0.15 }
            });
            
            layer.eachLayer(l => {
              l.options.customMetadata = { autor: autor };
              l.bindPopup(generarTablaPopup(item.comentario, autor, fechaLabel, geoJSON.properties));
              l.addTo(grupo);
            });
          } catch (err) {
            console.warn('Feature inválida en doc', item.id, err);
          }
        });

        gruposPorAutor[autor] = grupo;
        grupo.addTo(map);
        layerControl.addOverlay(grupo, label);
      }

      // Actualizar status con contadores
      const mineCount = (dataByAutor[userEmail]?.length) || 0;
      updateStatus(AREA_LABEL, snap.size, mineCount);
      actualizarBoton();
    },
    (err) => {
      console.error('[onSnapshot] error:', err?.code, err);
      updateStatus(AREA_LABEL, null, null, err?.code || 'desconocido');
    }
  );
}

// ============================================================================
// 5) UI helpers (PATCH #2 - Popups con HTML correcto)
// ============================================================================
function generarTablaPopup(titulo, autor, fecha, props = {}) {
  // NO escapar las etiquetas HTML, solo los valores dinámicos
  let html = `<div style="min-width:230px"><h4 style="margin:0;color:#27ae60">${escapeHTML(titulo)}</h4>`;
  html += `<small style="color:gray">👤 ${escapeHTML(autor)}  📅 ${escapeHTML(fecha ?? '-')}</small><hr><table style="width:100%;font-size:11px">`;
  
  for (const k in props) {
    if (['name','Name','description','styleUrl','styleHash','__fid'].includes(k) || !props[k]) continue;
    const val = props[k];
    const disp = (typeof val === 'string' && val.startsWith('http'))
      ? `<a href="${escapeHTML(val)}" target="_blank" rel="noopener noreferrer">${escapeHTML(val)}</a>`
      : `${escapeHTML(String(val))}`;
    html += `<tr style="border-bottom:1px solid #eee"><td><b>${escapeHTML(k.toUpperCase())}</b></td><td>${disp}</td></tr>`;
  }
  
  return html + `</table></div>`;
}

// Guardar (idempotente por FID)
document.getElementById('saveBtn').onclick = async () => {
  if (pending.size === 0 || isSaving) return;
  
  if (!authReady || !auth.currentUser) {
    alert('Autenticando… intenta guardar nuevamente en 1-2 segundos.');
    return;
  }

  const btn = document.getElementById('saveBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Guardando...';
  isSaving = true;

  try {
    const uid = auth.currentUser.uid;
    const ops = [];
    
    for (const [fid, entry] of pending.entries()) {
      const layer = entry.layer;
      const meta  = entry.meta || {};
      const gj    = layer.toGeoJSON();
      ensureFID(gj);

      const ref = doc(db, geomCollection, fid);
      const payload = {
        feature: JSON.stringify(gj),
        autor: userEmail,
        comentario: meta.comentario ?? "Sin nombre",
        archivo: meta.archivo ?? "Web",
        area: areaNorm,
        uid,
        fecha: new Date().toLocaleString('es-CL'),
        timestamp: serverTimestamp()
      };
      ops.push(setDoc(ref, payload, { merge: true }));
    }

    await Promise.all(ops);

    localDrafts.clearLayers();
    pending.clear();
    actualizarBoton();

    const statusEl = document.getElementById('status');
    if (statusEl) {
      const temp = statusEl.innerHTML;
      statusEl.innerHTML = `<span style="color:#10b981">✅ ${ops.length} cambios guardados</span>`;
      setTimeout(() => { statusEl.innerHTML = temp; }, 3000);
    }
  } catch (e) {
    console.error('Error al guardar:', e?.code, e);
    alert(e?.message ?? 'Error al guardar');
  } finally {
    isSaving = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
};

// ============================================================================
// 6) AUTH anónima y espera para iniciar realtime
// ============================================================================
signInAnonymously(auth).catch(console.error);

onAuthStateChanged(auth, (u) => {
  authReady = !!u;
  const userInfo = document.getElementById('userInfo');
  if (u && userInfo) userInfo.innerHTML = `👤 ${escapeHTML(userEmail)}`;
  
  if (unsubscribeRT) {
    unsubscribeRT();
    unsubscribeRT = null;
  }
  
  if (authReady) initRealtime();
  actualizarBoton();
});

// ============================================================================
// 7) Inicialización y protección
// ============================================================================
actualizarBoton();

window.addEventListener('beforeunload', (e) => {
  if (pending.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});
