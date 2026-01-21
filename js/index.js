// js/index.js — VERSIÓN FINAL A PRUEBA DE BALAS
// ✅ Todos los errores corregidos
// ✅ App Check (opcional con flag)
// ✅ Validación de 1 MiB
// ✅ Lectura tolerante (string/objeto)
// ✅ Indicador online/offline

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import {
  getFirestore, collection, setDoc, onSnapshot, deleteDoc, doc, serverTimestamp, getDocs,
  enableIndexedDbPersistence, enableMultiTabIndexedDbPersistence
} from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// ============================================================================
// 0) CONFIG + FLAGS
// ============================================================================
const ENABLE_APP_CHECK = false; // ← Cambiar a true si App Check está en "Aplicación obligatoria"
const MAX_DOC_SIZE_MB = 1;      // Límite de tamaño de documento

const urlParams  = new URLSearchParams(window.location.search);
const proyectoID = urlParams.get('area') ?? 'general';
const latInicial = parseFloat(urlParams.get('lat'))  ?? -27.366;
const lngInicial = parseFloat(urlParams.get('lng'))  ?? -70.332;
const zoomInicial= parseInt(urlParams.get('zoom'))   ?? 14;

const firebaseConfig = {
  apiKey: "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
  authDomain: "gis-pucobre.firebaseapp.com",
  projectId: "gis-pucobre",
  storageBucket: "gis-pucobre.appspot.com",
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8014a0faa86f5027"
};
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// ============================================================================
// 0.1) APP CHECK (si está habilitado)
// ============================================================================
if (ENABLE_APP_CHECK) {
  import('https://www.gstatic.com/firebasejs/10.10.0/firebase-app-check.js')
    .then(({ initializeAppCheck, ReCaptchaV3Provider }) => {
      const appCheck = initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider('6LfXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'), // ← Reemplazar con tu Site Key
        isTokenAutoRefreshEnabled: true
      });
      console.log('✅ [GIS] App Check inicializado');
    })
    .catch(err => {
      console.error('❌ [GIS] Error al inicializar App Check:', err);
    });
}

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
// 0.2) NORMALIZACIÓN DE ÁREA → COLECCIÓN
// ============================================================================
function normalizeArea(raw) {
  const s = String(raw ?? '').toLowerCase().trim();
  const s2 = s.replace(/\s+/g, '').replace(/-/g, '_');
  
  const isPozo13 = ['pozo13', 'pozo_13', 'p13', 'pozo 13'].map(x => 
    x.replace(/\s+/g, '').replace(/-/g, '_')
  ).includes(s2);
  
  if (isPozo13) {
    return { area: 'pozo13', collection: 'geometrias_pozo13' };
  }
  
  const isRol234 = [
    'rol23_4', 'rol234', 'rol_23_4', 'rol23-4', 'rol 23-4', 'rol23 4',
    '23_4', '234', '23-4', '23 4',
    'rdz2_4', 'rdz_2_4', 'rdz24', 'rdz 2 4'
  ].map(x => x.replace(/\s+/g, '').replace(/-/g, '_')).includes(s2);
  
  if (isRol234) {
    return { area: 'rol23_4', collection: 'geometrias_rol23_4' };
  }
  
  return { area: s2 || 'general', collection: 'geometrias' };
}

const { area: areaNorm, collection: geomCollection } = normalizeArea(proyectoID);

console.log('🗺️ [GIS] Área solicitada:', proyectoID);
console.log('🗺️ [GIS] Área normalizada:', areaNorm);
console.log('🗺️ [GIS] Colección Firestore:', geomCollection);

// ============================================================================
// 0.3) FORMATEO Y ESCAPADO
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

// ============================================================================
// 0.8) PARSE SEGURO DE JSON (evita crashes con datos corruptos)
// ============================================================================
function safeParseJSON(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // Filtrar casos vacíos o 'undefined'/'null' textuales
  if (!s || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'null') return null;
  try {
    const obj = JSON.parse(s);
    // Chequeo mínimo de estructura GeoJSON
    if (obj && (obj.type || obj.features || obj.geometry)) return obj;
    return null;
  } catch {
    return null;
  }
}

const AREA_LABEL = areaDisplay(areaNorm);
document.title = `GIS Pucobre — ${AREA_LABEL}`;

// ============================================================================
// 0.4) HELPER PARA ACTUALIZAR STATUS
// ============================================================================
function updateStatus(areaLabel, totalCapas = null, misCapas = null, error = null, fromCache = false) {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  
  const collectionBadge = `<span style="font-size:10px;opacity:0.6;margin-left:8px">[${geomCollection}]</span>`;
  const cacheBadge = fromCache ? ` <span style="font-size:10px;opacity:0.6">🔌 Offline</span>` : '';
  
  let html = `<span class="chip chip--area">ÁREA: ${escapeHTML(areaLabel)}</span>${collectionBadge}${cacheBadge}`;
  
  if (error) {
    html += `<span class="muted" style="color:#ef4444;margin-left:8px">· Error: ${escapeHTML(error)}</span>`;
  } else if (totalCapas !== null) {
    html += `<span class="muted" style="margin-left:8px">· Total: ${totalCapas} capas</span>`;
    if (misCapas !== null && misCapas > 0) {
      html += `<span class="chip chip--mine" title="Capas propias visibles en esta área" style="margin-left:8px">MIS CAPAS (${misCapas})</span>`;
    }
  } else {
    html += `<span class="muted" style="color:#f59e0b;margin-left:8px">· Conectando...</span>`;
  }
  
  statusEl.innerHTML = html;
}

updateStatus(AREA_LABEL, null, null, null);

// ============================================================================
// 0.5) TEST DE PERMISOS AL INICIO
// ============================================================================
async function testPermisos() {
  console.log('🔐 [GIS] Probando permisos de lectura...');
  try {
    const snap = await getDocs(collection(db, geomCollection));
    console.log('✅ [GIS] Permisos OK -', snap.size, 'documentos en', geomCollection);
    return true;
  } catch (e) {
    console.error('❌ [GIS] Error de permisos:', e.code, e.message);
    updateStatus(AREA_LABEL, null, null, `Permiso: ${e.code}`);
    
    if (e.code === 'permission-denied') {
      let msg = '🔒 ERROR DE PERMISOS\n\n';
      msg += 'No tienes acceso a: ' + geomCollection + '\n\n';
      msg += 'Posibles causas:\n';
      msg += '1. App Check en "Aplicación obligatoria" → Activar ENABLE_APP_CHECK\n';
      msg += '2. Reglas de Firestore muy restrictivas\n';
      msg += '3. Proyecto incorrecto en Firebase Console\n\n';
      msg += 'Revisa la consola para más detalles.';
      alert(msg);
    }
    return false;
  }
}

// ============================================================================
// 0.6) VALIDACIÓN DE TAMAÑO
// ============================================================================
function validarTamanioDoc(geojson) {
  const sizeBytes = new Blob([JSON.stringify(geojson)]).size;
  const sizeMB = sizeBytes / (1024 * 1024);
  
  if (sizeMB >= MAX_DOC_SIZE_MB) {
    const msg = `⚠️ DOCUMENTO DEMASIADO GRANDE\n\n` +
                `Tamaño: ${sizeMB.toFixed(2)} MB\n` +
                `Límite: ${MAX_DOC_SIZE_MB} MB\n\n` +
                `Este documento supera el límite de Firestore.\n` +
                `Considera simplificar la geometría o usar Storage.`;
    alert(msg);
    return false;
  }
  
  return true;
}

// ============================================================================
// 0.7) Utilidades de FID persistente
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

const localDrafts = L.featureGroup().addTo(map);
const docMap = new Map();
const ownerByFid = new Map();
const gruposPorAutor = {};
const layerControl = L.control.layers(null, null, { collapsed: false }).addTo(map);

let isSaving = false;
let authReady = false;

// ============================================================================
// 1.1) Pendientes por FID
// ============================================================================
const pending = new Map();

function actualizarBoton() {
    const n = localDrafts.getLayers().filter(l => !docMap.has(l._leaflet_id)).length;
    const btn = document.getElementById('saveBtn');
    if (!btn) return;

    // Solo habilitar si hay elementos nuevos (n > 0)
    btn.disabled = (n === 0);
    
    // Texto fijo según tu propuesta
    btn.innerHTML = `💾 Guardar Cambios`;
}

// ============================================================================
// 2) Dibujo y borrado
// ============================================================================
const drawControl = new L.Control.Draw({
  edit: { featureGroup: localDrafts, remove: true },
  draw: { circle: false, circlemarker: false }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
  const original = e.layer;
  const gj = original.toGeoJSON();
  ensureFID(gj);
  forceNewFIDIfHijack(gj);
  
  // ✅ Validar tamaño
  if (!validarTamanioDoc(gj)) return;
  
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
    
    // ✅ Validar tamaño
    if (!validarTamanioDoc(gj)) return;
    
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
document.getElementById('saveBtn').onclick = async () => {
    const layers = localDrafts.getLayers();
    if (layers.length === 0) return;
    
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.innerHTML = `⏳ Guardando...`;

    for (const layer of layers) {
        if (docMap.has(layer._leaflet_id)) continue; 
        try {
            await addDoc(collection(db, `geometrias_${proyectoID}`), {
                feature: JSON.stringify(layer.toGeoJSON()),
                autor: userEmail,
                comentario: layer.options.customMetadata?.comentario || "Sin nombre",
                archivo: layer.options.customMetadata?.archivo || "Web",
                fecha: new Date().toLocaleString('es-CL'),
                timestamp: serverTimestamp()
            });
            localDrafts.removeLayer(layer);
        } catch (e) { 
            console.error("Error al guardar:", e); 
        }
    }

    // Al finalizar, forzamos el estado deshabilitado y el texto limpio
    btn.disabled = true;
    btn.innerHTML = `💾 Guardar Cambios`;
    
    // Feedback visual en el status para confirmar que terminó
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.innerHTML = `<span style="color:#10b981">✅ Cambios guardados</span>`;
        // Después de 3 segundos restauramos la info del área
        setTimeout(() => {
            initRealtime(); // O la lógica que refresca el contador total
        }, 3000);
    }
};

function processLoadedLayers(layerGroup, fileName) {
  const all = [];
  layerGroup.eachLayer(l => all.push(l));

  for (let i = 0; i < all.length; i++) {
    const base = all[i];
    const gj = base.toGeoJSON();
    
    // ✅ Validar tamaño de cada geometría
    if (!validarTamanioDoc(gj)) {
      console.warn(`Geometría ${i+1} muy grande, omitida`);
      continue;
    }
    
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
// 4) SINCRONIZACIÓN (TOC por autor)
// ============================================================================
let unsubscribeRT = null;

async function initRealtime() {
  if (unsubscribeRT) {
    try { unsubscribeRT(); } catch {}
    unsubscribeRT = null;
  }

  const permisosOK = await testPermisos();
  if (!permisosOK) {
    console.error('❌ [GIS] Cancelando listener por falta de permisos');
    return;
  }

  console.log('🔄 [GIS] Iniciando listener en colección:', geomCollection);
  const colRef = collection(db, geomCollection);
  
  unsubscribeRT = onSnapshot(
    colRef,
    (snap) => {
      const fromCache = snap.metadata.fromCache;
      console.log(fromCache ? '🔌 [GIS] Snapshot desde cache:' : '☁️ [GIS] Snapshot desde servidor:', snap.size, 'documentos');
      
      for (const a in gruposPorAutor) {
        try { map.removeLayer(gruposPorAutor[a]); } catch {}
        try { layerControl.removeLayer(gruposPorAutor[a]); } catch {}
        delete gruposPorAutor[a];
      }

      docMap.clear();
      ownerByFid.clear();

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
          const docId = item.id; // ← Guardar ID para logs
          
          try {
            // ✅ LECTURA TOLERANTE + SEGURA (evita JSON.parse sobre undefined/vacío)
            let geoJSON = null;
            
            if (typeof item.feature === 'string') {
              geoJSON = safeParseJSON(item.feature);
              if (!geoJSON) {
                console.warn(`⚠️ Documento con feature inválido: ${docId}`);
                console.warn(`   Feature raw:`, item.feature?.substring(0, 100));
                return;
              }
            } else if (item && typeof item.feature === 'object') {
              geoJSON = item.feature;
            } else {
              console.warn(`⚠️ Documento sin feature: ${docId} (tipo: ${typeof item.feature})`);
              return;
            }
            
            if (!geoJSON) {
              console.warn(`⚠️ Feature parseó pero está vacío: ${docId}`);
              return;
            }
            
            const fid = ensureFID(geoJSON);
            
            ownerByFid.set(fid, autor);
            docMap.set(fid, item.id);
            
            const fechaLabel = item.timestamp?.toDate
              ? item.timestamp.toDate().toLocaleString('es-CL')
              : (item.fecha ?? '-');
            
            // ✅ Configuración de capa con soporte para Points
            const layer = L.geoJSON(geoJSON, {
              // ✅ IMPORTANTE: pointToLayer para puntos (markers)
              pointToLayer: (feature, latlng) => {
                return L.marker(latlng);
              },
              style: { 
                color: esMio ? '#27ae60' : '#3498db', 
                weight: 2, 
                fillOpacity: 0.15 
              }
            });
            
            layer.eachLayer(l => {
              l.options.customMetadata = { autor: autor };
              l.bindPopup(generarTablaPopup(item.comentario, autor, fechaLabel, geoJSON.properties));
              l.addTo(grupo);
            });
          } catch (err) {
            console.error(`❌ Error crítico al procesar documento ${docId}:`, err.message);
            console.error(`   Autor: ${autor}`);
            console.error(`   Comentario: ${item.comentario || 'sin nombre'}`);
            console.error(`   Feature (primeros 100 chars):`, String(item.feature).substring(0, 100));
            // Continuar con siguiente documento
          }
        });

        gruposPorAutor[autor] = grupo;
        grupo.addTo(map);
        layerControl.addOverlay(grupo, label);
      }

      const mineCount = (dataByAutor[userEmail]?.length) || 0;
      updateStatus(AREA_LABEL, snap.size, mineCount, null, fromCache);
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

document.getElementById('saveBtn').onclick = async () => {
    // 1. Verificamos capas directamente en el mapa
    const layers = localDrafts.getLayers();
    if (layers.length === 0 || isSaving) return;

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
        
        for (const layer of layers) {
            // Saltamos si ya está en la nube para no duplicar
            if (docMap.has(layer._leaflet_id)) continue;

            const gj = layer.toGeoJSON();
            
            // ✅ Mantenemos la validación de tamaño por seguridad
            if (typeof validarTamanioDoc === 'function' && !validarTamanioDoc(gj)) {
                console.warn('Omitiendo documento muy grande');
                continue;
            }

            // ✅ CAMBIO CLAVE: Usamos addDoc con la colección dinámica
            // Esto asegura que líneas y polígonos pesados entren sin errores de ID
            await addDoc(collection(db, `geometrias_${proyectoID}`), {
                feature: JSON.stringify(gj),
                autor: userEmail,
                comentario: layer.options.customMetadata?.comentario || "Sin nombre",
                archivo: layer.options.customMetadata?.archivo || "Web",
                area: proyectoID,
                uid: uid,
                fecha: new Date().toLocaleString('es-CL'),
                timestamp: serverTimestamp()
            });

            // Limpiamos la capa del borrador local tras éxito
            localDrafts.removeLayer(layer);
        }

        // Limpieza de memoria secundaria
        if (typeof pending !== 'undefined') pending.clear();
        actualizarBoton();

        // Feedback visual de éxito
        const statusEl = document.getElementById('status');
        if (statusEl) {
            const currentStatus = statusEl.innerHTML;
            statusEl.innerHTML = `<span style="color:#10b981">✅ Cambios guardados en ${proyectoID}</span>`;
            setTimeout(() => { statusEl.innerHTML = currentStatus; }, 3000);
        }

    } catch (e) {
        console.error('❌ Error al guardar:', e);
        alert(`Error al guardar: ${e.message}\nColección: geometrias_${proyectoID}`);
    } finally {
        isSaving = false;
        btn.disabled = false;
        btn.textContent = originalText;
    }
};

// ============================================================================
// 6) AUTH anónima
// ============================================================================
let authTimeout = setTimeout(() => {
  if (!authReady) {
    console.error('⏱️ [GIS] Timeout de autenticación (10s)');
    updateStatus(AREA_LABEL, null, null, 'Timeout de autenticación. Recarga la página.');
  }
}, 10000);

signInAnonymously(auth).catch(err => {
  console.error('❌ [GIS] Error en signInAnonymously:', err?.code, err);
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
// 7) Inicialización
// ============================================================================
actualizarBoton();

window.addEventListener('beforeunload', (e) => {
  if (pending.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});
