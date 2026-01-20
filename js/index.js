// js/index.js — Versión mejorada con TODOS LOS PARCHES aplicados
// ✅ PATCH #1: Normalización robusta de área con múltiples variantes
// ✅ PATCH #2: UI inmediata (no espera auth para mostrar área)
// ✅ PATCH #3: Manejo visual de errores de autenticación
// ✅ PATCH #4: Timeout de autenticación (10s)
// ✅ PATCH #5: Debugging de colección activa
// ✅ PATCH #6: Guardado de feature como objeto (opcional, comentado)

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
  storageBucket: "gis-pucobre.appspot.com", // ✅ PATCH: Corregido de .firebasestorage.app
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8014a0faa86f5027"
};
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// Habilitar persistencia offline multi-tab con fallback
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
// 0.1) NORMALIZACIÓN DE ÁREA → COLECCIÓN (✅ PATCH #1 - ROBUSTA)
// ============================================================================
function normalizeArea(raw) {
  const s = String(raw ?? '').toLowerCase().trim();
  
  // Quitar espacios, reemplazar guiones por guión_bajo
  const s2 = s.replace(/\s+/g, '').replace(/-/g, '_');
  
  // ✅ Mapear TODAS las variantes conocidas de POZO 13
  const isPozo13 = ['pozo13', 'pozo_13', 'p13', 'pozo 13'].map(x => 
    x.replace(/\s+/g, '').replace(/-/g, '_')
  ).includes(s2);
  
  if (isPozo13) {
    return { area: 'pozo13', collection: 'geometrias_pozo13' };
  }
  
  // ✅ Mapear TODAS las variantes conocidas de ROL 23-4
  const isRol234 = [
    'rol23_4', 'rol234', 'rol_23_4', 'rol23-4', 'rol 23-4', 'rol23 4',
    '23_4', '234', '23-4', '23 4',
    'rdz2_4', 'rdz_2_4', 'rdz24', 'rdz 2 4'  // ← Variantes históricas
  ].map(x => x.replace(/\s+/g, '').replace(/-/g, '_')).includes(s2);
  
  if (isRol234) {
    return { area: 'rol23_4', collection: 'geometrias_rol23_4' };
  }
  
  // ✅ Fallback explícito (evita valores undefined/null)
  return { area: s2 || 'general', collection: 'geometrias' };
}

const { area: areaNorm, collection: geomCollection } = normalizeArea(proyectoID);

// ✅ PATCH #5: Log de debugging para confirmar colección
console.log('🗺️ [GIS] Área solicitada:', proyectoID);
console.log('🗺️ [GIS] Área normalizada:', areaNorm);
console.log('🗺️ [GIS] Colección Firestore:', geomCollection);

// ============================================================================
// 0.2) FORMATEO DE ÁREA PARA UI
// ============================================================================
function areaDisplay(norm) {
  const known = {
    'pozo13': 'POZO 13',
    'rol23_4': 'ROL 23-4',
    'general': 'GENERAL'
  };
  return known[norm] ?? norm.replace(/[-_]+/g, ' ').toUpperCase();
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
// 0.3) HELPER PARA ACTUALIZAR STATUS (✅ PATCH #2 - MEJORADO)
// ============================================================================
function updateStatus(areaLabel, totalCapas = null, misCapas = null, error = null) {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  
  // Mostrar colección activa para debugging
  const collectionBadge = `<span style="font-size:10px;opacity:0.6;margin-left:8px">[${geomCollection}]</span>`;
  
  let html = `<span class="chip chip--area">ÁREA: ${escapeHTML(areaLabel)}</span>${collectionBadge}`;
  
  if (error) {
    html += `<span class="muted" style="color:#ef4444;margin-left:8px">· Error: ${escapeHTML(error)}</span>`;
  } else if (totalCapas !== null) {
    html += `<span class="muted" style="margin-left:8px">· Total: ${totalCapas} capas</span>`;
    if (misCapas !== null && misCapas > 0) {
      html += `<span class="chip chip--mine" title="Capas propias visibles en esta área" style="margin-left:8px">MIS CAPAS (${misCapas})</span>`;
    }
  } else {
    // ✅ Estado de carga
    html += `<span class="muted" style="color:#f59e0b;margin-left:8px">· Conectando...</span>`;
  }
  
  statusEl.innerHTML = html;
}

// ✅ PATCH #2: Mostrar área INMEDIATAMENTE (no esperar auth)
updateStatus(AREA_LABEL, null, null, null);

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
// 1.1) Pendientes por FID
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

  layer.bindPopup(generarTablaPopup(comentario, userEmail, "Recién dibujado", gj.properties));
  localDrafts.addLayer(layer);
  markDirty(layer);
});

// Editar geometría
map.on(L.Draw.Event.EDITED, (e) => {
  e.layers.eachLayer(layer => {
    const fid = getFIDFromLayer(layer);
    if (fid && docMap.has(fid)) {
      const owner = ownerByFid.get(fid);
      if (owner !== userEmail) {
        alert(`Esta capa pertenece a ${owner}. No puedes editarla.`);
        return;
      }
    }
    
    const gj = layer.toGeoJSON();
    ensureFID(gj);
    const meta = layer.options.customMetadata || {};
    const newLayer = L.geoJSON(gj).getLayers()[0];
    newLayer.options.customMetadata = meta;
    
    if (newLayer instanceof L.Path) {
      newLayer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2, dashArray: '5,3' });
    }
    newLayer.bindPopup(generarTablaPopup(meta.comentario, userEmail, "Editado", gj.properties));
    
    localDrafts.addLayer(newLayer);
    markDirty(newLayer, meta);
    
    try { map.removeLayer(layer); } catch {}
  });
});

// Borrar geometría
map.on(L.Draw.Event.DELETED, (e) => {
  e.layers.eachLayer(async (layer) => {
    const fid = getFIDFromLayer(layer);
    if (!fid) return;
    
    const owner = ownerByFid.get(fid);
    if (owner && owner !== userEmail) {
      alert(`Esta capa pertenece a ${owner}. No puedes borrarla.`);
      return;
    }
    
    if (!docMap.has(fid)) {
      pending.delete(fid);
      actualizarBoton();
      return;
    }
    
    const docId = docMap.get(fid);
    if (!confirm(`¿Borrar capa "${layer.options.customMetadata?.comentario ?? 'sin nombre'}" del servidor?`)) return;
    
    try {
      await deleteDoc(doc(db, geomCollection, docId));
      docMap.delete(fid);
      ownerByFid.delete(fid);
      pending.delete(fid);
      actualizarBoton();
      updateStatus(AREA_LABEL, docMap.size, Array.from(ownerByFid.values()).filter(a => a === userEmail).length);
    } catch (err) {
      console.error('Error al borrar:', err);
      alert('Error al borrar: ' + (err?.message ?? 'desconocido'));
    }
  });
});

// ============================================================================
// 3) CARGA DE ARCHIVOS (KML/GeoJSON)
// ============================================================================
document.getElementById('kmlInput').onchange = (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      
      if (file.name.toLowerCase().endsWith('.kml')) {
        const parser = new DOMParser();
        const kmlDoc = parser.parseFromString(text, 'text/xml');
        const layerGroup = omnivore.kml.parse(kmlDoc);
        processLoadedLayers(layerGroup, file.name);
      } else {
        const geojson = JSON.parse(text);
        const layerGroup = L.geoJSON(geojson);
        processLoadedLayers(layerGroup, file.name);
      }
    } catch (err) {
      console.error('Error al cargar archivo:', err);
      alert('Error al cargar archivo: ' + (err?.message ?? 'formato inválido'));
    }
  };
  reader.readAsText(file);
  ev.target.value = '';
};

function processLoadedLayers(layerGroup, fileName) {
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

  console.log('🔄 [GIS] Iniciando listener en colección:', geomCollection);
  const colRef = collection(db, geomCollection);
  
  unsubscribeRT = onSnapshot(
    colRef,
    (snap) => {
      console.log('✅ [GIS] Snapshot recibido:', snap.size, 'documentos');
      
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
            // ✅ PATCH #6 (OPCIONAL): Si guardas como objeto, quitar JSON.parse
            const geoJSON = JSON.parse(item.feature);
            // Para usar objeto directo: const geoJSON = item.feature;
            
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
            console.warn('⚠️ Feature inválida en doc', item.id, err);
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
      console.error('❌ [GIS] Error en onSnapshot:', err?.code, err);
      updateStatus(AREA_LABEL, null, null, err?.code || 'desconocido');
    }
  );
}

// ============================================================================
// 5) UI helpers
// ============================================================================
function generarTablaPopup(titulo, autor, fecha, props = {}) {
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
        // ✅ PATCH #6 (OPCIONAL): Guardar como objeto en vez de string
        feature: JSON.stringify(gj),  // Para objeto: feature: gj,
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
    console.error('❌ Error al guardar:', e?.code, e);
    alert(e?.message ?? 'Error al guardar');
  } finally {
    isSaving = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
};

// ============================================================================
// 6) AUTH anónima y espera para iniciar realtime (✅ PATCH #3 y #4)
// ============================================================================

// ✅ PATCH #4: Timeout de 10 segundos para autenticación
let authTimeout = setTimeout(() => {
  if (!authReady) {
    console.error('⏱️ [GIS] Timeout de autenticación (10s)');
    updateStatus(AREA_LABEL, null, null, 'Timeout de autenticación. Recarga la página.');
  }
}, 10000);

signInAnonymously(auth).catch(err => {
  console.error('❌ [GIS] Error en signInAnonymously:', err?.code, err);
  // ✅ PATCH #3: Mostrar error visualmente
  updateStatus(AREA_LABEL, null, null, `Auth: ${err?.code || 'error desconocido'}`);
  clearTimeout(authTimeout);
});

onAuthStateChanged(auth, (u) => {
  authReady = !!u;
  
  if (authReady) {
    clearTimeout(authTimeout);
    console.log('✅ [GIS] Usuario autenticado:', u.uid);
  }
  
  const userInfo = document.getElementById('userInfo');
  if (u && userInfo) userInfo.innerHTML = `👤 ${escapeHTML(userEmail)}`;
  
  if (unsubscribeRT) {
    unsubscribeRT();
    unsubscribeRT = null;
  }
  
  if (authReady) {
    initRealtime();
  } else {
    console.warn('⚠️ [GIS] Auth no lista, esperando...');
  }
  
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
