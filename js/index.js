
// js/index.js - VERSIÓN "GIS PROFESIONAL" (TOC + TABULAR + BORRADO POR AUTOR)
// Correcciones: FID persistente, desduplicación, limpieza de docMap y guardado estable.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// ============================================================================
// 0) CONFIGURACIÓN Y PARÁMETROS URL
// ============================================================================
const urlParams = new URLSearchParams(window.location.search);
const proyectoID = urlParams.get('area') || 'general';
const latInicial = parseFloat(urlParams.get('lat')) || -27.366;
const lngInicial = parseFloat(urlParams.get('lng')) || -70.332;
const zoomInicial = parseInt(urlParams.get('zoom')) || 14;

const firebaseConfig = {
  apiKey: "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
  authDomain: "gis-pucobre.firebaseapp.com",
  projectId: "gis-pucobre",
  storageBucket: "gis-pucobre.firebasestorage.app",
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8014a0faa86f5027"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Manejo de Identidad
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
// 0.1) Utilidades FID (ID persistente dentro de GeoJSON)
// ============================================================================
const newFID = () => (crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2)));

function ensureFID(geojson) {
  if (!geojson.properties) geojson.properties = {};
  if (!geojson.properties.__fid) geojson.properties.__fid = newFID();
  return geojson.properties.__fid;
}

function getFIDFromLayer(layer) {
  return layer?.feature?.properties?.__fid;
}

// ============================================================================
// 1) INICIALIZACIÓN DE MAPA Y TOC
// ============================================================================
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri — Pucobre',
  maxZoom: 19
}).addTo(map);

// Exponer para debug rápido en consola
window.map = map;

// Grupos de capas
const localDrafts = L.featureGroup().addTo(map);   // Capas en edición (propias, pendientes de guardar)
const docMap = new Map();                          // Mapa FID -> idFirestore
const gruposPorAutor = {};                         // TOC dinámico

// Control de Capas (TOC) - Estilo GIS Profesional
const layerControl = L.control.layers(null, null, { collapsed: false }).addTo(map);

// ============================================================================
// 2) HERRAMIENTAS DE DIBUJO Y BORRADO
// ============================================================================
const drawControl = new L.Control.Draw({
  edit: { featureGroup: localDrafts, remove: true },
  draw: { circle: false, circlemarker: false }
});
map.addControl(drawControl);

// Crear nuevo dibujo (inyecta FID dentro del GeoJSON)
map.on(L.Draw.Event.CREATED, (e) => {
  const original = e.layer;

  // Inyectar FID persistente en properties y recrear la capa desde GeoJSON
  const gj = original.toGeoJSON();
  ensureFID(gj);
  const layer = L.geoJSON(gj).getLayers()[0];

  layer.options.customMetadata = {
    comentario: prompt("Nombre/Descripción:") || "Dibujo manual",
    autor: userEmail
  };

  localDrafts.addLayer(layer);
  actualizarBoton();
});

// Borrado con validación de Autor (opera sobre capas de localDrafts)
map.on(L.Draw.Event.DELETED, async (e) => {
  const layers = e.layers;
  let borrados = 0;

  const tasks = [];
  layers.eachLayer((layer) => {
    const fid = getFIDFromLayer(layer);
    const dbId = fid ? docMap.get(fid) : undefined;
    const autor = layer.options.customMetadata?.autor;

    if (dbId) {
      if (autor === userEmail) {
        tasks.push(deleteDoc(doc(db, `geometrias_${proyectoID}`, dbId)).then(() => borrados++).catch(err => console.error("Error Firebase:", err)));
      } else {
        alert(`No tienes permiso. Autor: ${autor}`);
        location.reload(); // Revertir visualmente si intentó borrar ajeno
      }
    }
  });

  if (tasks.length) await Promise.allSettled(tasks);
  if (borrados > 0) document.getElementById('status').textContent = `🗑️ ${borrados} eliminados`;
});

// ============================================================================
// 3) PROCESAMIENTO KML / GEOJSON
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

        // Fix común de KML con xsi faltante
        if (kmlDOM.querySelector('parsererror')?.textContent?.includes('xsi')) {
          const fixed = content.replace(/<Document(\s+)/i, '<Document xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"$1');
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
  // Permite volver a cargar el mismo archivo si se desea
  e.target.value = '';
});

async function unificarYProcesar(layerGroup, fileName) {
  const all = [];
  layerGroup.eachLayer(l => all.push(l));

  for (let i = 0; i < all.length; i++) {
    const base = all[i];

    // Asegurar FID en GeoJSON y recrear la capa desde GeoJSON
    const gj = base.toGeoJSON();
    ensureFID(gj);
    const layer = L.geoJSON(gj).getLayers()[0];

    const props = gj.properties || {};
    const name = props.name || props.Name || `Elemento ${i + 1}`;

    layer.options.customMetadata = { comentario: name, archivo: fileName, autor: userEmail };
    layer.bindPopup(generarTablaPopup(name, userEmail, "Recién cargado", props));

    if (layer instanceof L.Path) layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2 });

    localDrafts.addLayer(layer);
  }

  if (localDrafts.getLayers().length) {
    try {
      map.fitBounds(localDrafts.getBounds(), { padding: [20, 20] });
    } catch { /* puede fallar si solo hay puntos aislados */ }
  }

  actualizarBoton();
}

// ============================================================================
// 4) SINCRONIZACIÓN Y TOC PROFESIONAL
// ============================================================================
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
  // Limpiar TOC y capas de nube
  for (const a in gruposPorAutor) {
    try { map.removeLayer(gruposPorAutor[a]); } catch { }
    try { layerControl.removeLayer(gruposPorAutor[a]); } catch { }
    delete gruposPorAutor[a];
  }

  // Limpia referencias previas (evita memoria y colisiones)
  docMap.clear();

  // Agrupar por autor
  const dataByAutor = {};
  snap.forEach(d => {
    const data = d.data();
    if (!dataByAutor[data.autor]) dataByAutor[data.autor] = [];
    dataByAutor[data.autor].push({ id: d.id, ...data });
  });

  for (const autor in dataByAutor) {
    const grupo = L.featureGroup();
    const esMio = (autor === userEmail);
    const label = esMio ? `<b>⭐ MIS CAPAS (${dataByAutor[autor].length})</b>` : `👤 ${autor} (${dataByAutor[autor].length})`;

    dataByAutor[autor].forEach(item => {
      const geoJSON = JSON.parse(item.feature);
      const fid = ensureFID(geoJSON); // asegura que exista

      const layer = L.geoJSON(geoJSON, {
        style: { color: esMio ? '#27ae60' : '#3498db', weight: 2, fillOpacity: 0.15 }
      });

      layer.eachLayer(l => {
        // Mapea por FID persistente
        if (fid) docMap.set(fid, item.id);
        l.options.customMetadata = { autor: autor };
        l.bindPopup(generarTablaPopup(item.comentario, autor, item.fecha, geoJSON.properties));
        l.addTo(grupo);
      });
    });

    gruposPorAutor[autor] = grupo;
    grupo.addTo(map);
    layerControl.addOverlay(grupo, label);
  }

  document.getElementById('status').textContent = `📡 ÁREA: ${proyectoID.toUpperCase()} | Total: ${snap.size}`;
});

// ============================================================================
// 5) UTILIDADES (TABLA Y BOTONES)
// ============================================================================
function generarTablaPopup(titulo, autor, fecha, props = {}) {
  let html = `<div style="min-width:230px"><h4 style="margin:0;color:#27ae60">${titulo}</h4>`;
  html += `<small style="color:gray">👤 ${autor} | 📅 ${fecha || '-'}</small><hr><table style="width:100%;font-size:11px">`;
  for (const k in props) {
    if (['name', 'Name', 'description', 'styleUrl', 'styleHash', '__fid'].includes(k) || !props[k]) continue;
    const val = props[k];
    const disp = (typeof val === 'string' && val.startsWith('http')) ? `${val}Link 🔗</a>` : val;
    html += `<tr style="border-bottom:1px solid #eee"><td><b>${k.toUpperCase()}</b></td><td>${disp}</td></tr>`;
  }
  return html + `</table></div>`;
}

document.getElementById('saveBtn').onclick = async () => {
  const layers = localDrafts.getLayers();
  if (!layers.length) return;

  const btn = document.getElementById('saveBtn');
  btn.disabled = true;

  for (const layer of layers) {
    const gj = layer.toGeoJSON();
    const fid = ensureFID(gj);

    // Si ya existe en nube, no subir de nuevo
    if (docMap.has(fid)) continue;

    try {
      await addDoc(collection(db, `geometrias_${proyectoID}`), {
        feature: JSON.stringify(gj),
        autor: userEmail,
        comentario: layer.options.customMetadata?.comentario || "Sin nombre",
        archivo: layer.options.customMetadata?.archivo || "Web",
        fecha: new Date().toLocaleString('es-CL'),
        timestamp: serverTimestamp()
      });
    } catch (e) {
      console.error(e);
    }
  }

  // Vaciar borradores locales de una sola vez
  localDrafts.clearLayers();
  actualizarBoton();
};

function actualizarBoton() {
  const n = localDrafts.getLayers().length;
  const btn = document.getElementById('saveBtn');
  btn.disabled = n === 0;
  btn.textContent = n ? `💾 Guardar Cambios (${n})` : `💾 Guardar Cambios`;
}

// ============================================================================
// 6) AUTH
// ============================================================================
signInAnonymously(auth);
onAuthStateChanged(auth, (u) => {
  if (u) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
});
