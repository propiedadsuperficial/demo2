
// js/index.js — Versión estable con guardado idempotente por FID
// Mantiene: parámetros URL, Leaflet/Draw/Omnivore, TOC por autor y prompts de email.
// Cambios clave: setDoc(fid, {merge:true}), isSaving, contador estable.
// (Basado en tus archivos previos)  ⟶  ref: turn3search1 / turn3search2

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import {
  getFirestore, collection, setDoc, onSnapshot, deleteDoc, doc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// ============================================================================
// 0) CONFIG + PARÁMETROS URL (se conservan)
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

// Identidad simple (como en tu código)
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
// 0.1) Utilidades de FID persistente
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

// ============================================================================
// 1) MAPA y TOC
// ============================================================================
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri — Pucobre', maxZoom: 19
}).addTo(map);
window.map = map; // para depuración rápida

const localDrafts = L.featureGroup().addTo(map); // capas en edición (pendientes)
const docMap = new Map();                        // FID -> idFirestore (para compat)
const gruposPorAutor = {};                       // TOC dinámico
const layerControl = L.control.layers(null, null, { collapsed: false }).addTo(map);

let isSaving = false;                            // <— NUEVO

// ============================================================================
// 2) Dibujo y borrado (sobre borradores locales)
// ============================================================================
const drawControl = new L.Control.Draw({
  edit: { featureGroup: localDrafts, remove: true },
  draw: { circle: false, circlemarker: false }
});
map.addControl(drawControl);

// Crear nuevo dibujo (inyecta FID y mantiene metadata)
map.on(L.Draw.Event.CREATED, (e) => {
  const original = e.layer;
  const gj = original.toGeoJSON();
  ensureFID(gj);
  const layer = L.geoJSON(gj).getLayers()[0];

  layer.options.customMetadata = {
    comentario: prompt("Nombre/Descripción:") ?? "Dibujo manual",
    autor: userEmail
  };
  if (layer instanceof L.Path) layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2 });

  localDrafts.addLayer(layer);
  actualizarBoton();
});

// Borrado (solo localDrafts). Si existe en nube y es del autor, lo elimina.
map.on(L.Draw.Event.DELETED, async (e) => {
  const layers = e.layers;
  let borrados = 0;
  const tasks = [];
  layers.eachLayer((layer) => {
    const fid = getFIDFromLayer(layer);
    const autor = layer.options.customMetadata?.autor;
    const dbId = fid ? docMap.get(fid) : undefined;
    if (dbId) {
      if (autor === userEmail) {
        tasks.push(
          deleteDoc(doc(db, `geometrias_${proyectoID}`, dbId))
            .then(() => borrados++)
            .catch(err => console.error("Error Firebase:", err))
        );
      } else {
        alert(`No tienes permiso. Autor: ${autor}`);
        location.reload(); // revertir visualmente si intentó borrar ajeno
      }
    }
  });
  if (tasks.length) await Promise.allSettled(tasks);
  if (borrados > 0) document.getElementById('status').textContent = `🗑️ ${borrados} eliminados`;
});

// ============================================================================
// 3) Carga KML / GeoJSON
// ============================================================================
document.getElementById('kmlInput').addEventListener('change', function (e) {
  const file = e.target.files[0];
  if (!file) return;
  const fileName = file.name.toLowerCase();
  const reader = new FileReader();
  document.getElementById('status').textContent = `📂 Leyendo ${file.name}...`;

  reader.onload = async (event) => {
    try {
      const content = event.target.result;
      let layerToProcess;

      if (fileName.endsWith('.kml')) {
        const parser = new DOMParser();
        let kmlDOM = parser.parseFromString(content, 'text/xml');
        // Fix común cuando falta xsi en algunos KML
        if (kmlDOM.querySelector('parsererror')?.textContent?.includes('xsi')) {
          const fixed = content.replace(/\<Document(\s+)/i, '<Document xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"$1');
          kmlDOM = parser.parseFromString(fixed, 'text/xml');
        }
        layerToProcess = omnivore.kml.parse(kmlDOM);
        layerToProcess.on('ready', () => unificarYProcesar(layerToProcess, file.name));
      } else {
        layerToProcess = L.geoJSON(JSON.parse(content));
        unificarYProcesar(layerToProcess, file.name);
      }
    } catch (err) {
      console.error(err);
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // permitir recargar el mismo archivo
});

async function unificarYProcesar(layerGroup, fileName) {
  const all = [];
  layerGroup.eachLayer(l => all.push(l));

  for (let i = 0; i < all.length; i++) {
    const base = all[i];
    const gj = base.toGeoJSON();
    ensureFID(gj);
    const layer = L.geoJSON(gj).getLayers()[0];

    const props = gj.properties ?? {};
    const name  = props.name ?? props.Name ?? `Elemento ${i + 1}`;

    layer.options.customMetadata = { comentario: name, archivo: fileName, autor: userEmail };
    layer.bindPopup(generarTablaPopup(name, userEmail, "Recién cargado", props));
    if (layer instanceof L.Path) layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2 });

    localDrafts.addLayer(layer);
  }

  if (localDrafts.getLayers().length) {
    try { map.fitBounds(localDrafts.getBounds(), { padding: [20, 20] }); } catch { /* puntos aislados */ }
  }
  actualizarBoton();
}

// ============================================================================
// 4) SINCRONIZACIÓN (TOC por autor) — ignora durante guardado
// ============================================================================
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
  if (isSaving) return; // evita “eco” visual mientras se confirma el commit

  // Limpiar TOC y capas de nube
  for (const a in gruposPorAutor) {
    try { map.removeLayer(gruposPorAutor[a]); } catch {}
    try { layerControl.removeLayer(gruposPorAutor[a]); } catch {}
    delete gruposPorAutor[a];
  }

  docMap.clear();

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
      const geoJSON = JSON.parse(item.feature);
      const fid = ensureFID(geoJSON);     // asegura existencia de fid (compat)
      const layer = L.geoJSON(geoJSON, {
        style: { color: esMio ? '#27ae60' : '#3498db', weight: 2, fillOpacity: 0.15 }
      });
      layer.eachLayer(l => {
        if (fid) docMap.set(fid, item.id); // mapea FID -> docId (en nuevo flujo id==fid)
        l.options.customMetadata = { autor: autor };
        l.bindPopup(generarTablaPopup(item.comentario, autor, item.fecha, geoJSON.properties));
        l.addTo(grupo);
      });
    });

    gruposPorAutor[autor] = grupo;
    grupo.addTo(map);
    layerControl.addOverlay(grupo, label);
  }

  document.getElementById('status').textContent = `📡 ÁREA: ${proyectoID.toUpperCase()}  —  Total: ${snap.size}`;
});

// ============================================================================
// 5) UI helpers
// ============================================================================
function generarTablaPopup(titulo, autor, fecha, props = {}) {
  let html = `<div style="min-width:230px"><h4 style="margin:0;color:#27ae60">${titulo}</h4>`;
  html += `<small style="color:gray">👤 ${autor}  📅 ${fecha ?? '-'}</small><hr><table style="width:100%;font-size:11px">`;
  for (const k in props) {
    if (['name','Name','description','styleUrl','styleHash','__fid'].includes(k) || !props[k]) continue;
    const val = props[k];
    const disp = (typeof val === 'string' && val.startsWith('http')) ? `<{val}Link 🔗</a>` : val;
    html += `<tr style="border-bottom:1px solid #eee"><td><b>${k.toUpperCase()}</b></td><td>${disp}</td></tr>`;
  }
  return html + `</table></div>`;
}

// Guardar (idempotente por FID) — limpia borradores tras commit
document.getElementById('saveBtn').onclick = async () => {
  const layers = localDrafts.getLayers();
  if (!layers.length) return;

  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  isSaving = true;

  try {
    const ops = layers.map((layer) => {
      const gj  = layer.toGeoJSON();
      const fid = ensureFID(gj); // ID estable del documento
      const ref = doc(db, `geometrias_${proyectoID}`, fid);
      const payload = {
        feature: JSON.stringify(gj),
        autor: userEmail,
        comentario: layer.options.customMetadata?.comentario ?? "Sin nombre",
        archivo: layer.options.customMetadata?.archivo ?? "Web",
        fecha: new Date().toLocaleString('es-CL'),
        timestamp: serverTimestamp()
      };
      return setDoc(ref, payload, { merge: true }); // ⟵ idempotente
    });

    await Promise.all(ops);

    localDrafts.clearLayers();  // limpiamos borradores locales
    actualizarBoton();
    document.getElementById('status').textContent = `✅ Cambios guardados (${layers.length})`;
  } catch (e) {
    console.error('Error al guardar:', e);
    alert(e?.message ?? 'Error al guardar');
  } finally {
    isSaving = false;
    btn.disabled = false;
  }
};

function actualizarBoton() {
  const n = localDrafts.getLayers().length;
  const btn = document.getElementById('saveBtn');
  btn.disabled = n === 0;
  btn.textContent = n ? `💾 Guardar Cambios (${n})` : `💾 Guardar Cambios`;
}

// ============================================================================
// 6) AUTH anónima (como tenías), y mostrar usuario
// ============================================================================
signInAnonymously(auth);
onAuthStateChanged(auth, (u) => {
  if (u) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
});
