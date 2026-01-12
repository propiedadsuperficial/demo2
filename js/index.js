
// js/index.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
  authDomain: "gis-pucobre.firebaseapp.com",
  projectId: "gis-pucobre",
  storageBucket: "gis-pucobre.firebasestorage.app",
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8014a0faa86f5027",
  measurementId: "G-2CSXPQN2SC"
};

// 1. Identidad
let userEmail = localStorage.getItem('pucobre_user') || prompt("Sesión GIS Pucobre. Ingrese su correo corporativo:")?.toLowerCase().trim();
if (!userEmail || !userEmail.includes('@')) window.location.reload();
localStorage.setItem('pucobre_user', userEmail);

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 2. Mapa
const map = L.map('map').setView([-27.366, -70.332], 14);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

// Icono borrador para puntos
const draftIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

// ==============================
// 3. Loader KML/KMZ con diagnósticos
// ==============================

document.getElementById('kmlInput').addEventListener('change', async function (e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('status');

  // Diagnóstico de dependencias
  console.log('[DEP] toGeoJSON disponible:', !!(window.toGeoJSON && toGeoJSON.kml));
  console.log('[DEP] omnivore disponible:', !!(window.omnivore && omnivore.kml && omnivore.kml.parse));
  console.log('[DEP] JSZip disponible:', !!window.JSZip);

  try {
    const name = (file.name || '').toLowerCase();

    if (name.endsWith('.kmz')) {
      if (!window.JSZip) {
        statusEl.textContent = '❌ Falta JSZip para leer KMZ';
        return;
      }

      // KMZ: leer como ArrayBuffer y descomprimir
      const arrayBuf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(arrayBuf);
      const kmlEntry = zip.file(/\.kml$/i)[0];

      if (!kmlEntry) {
        statusEl.textContent = '❌ KMZ sin KML interno';
        return;
      }

      const kmlText = await kmlEntry.async('text');
      await procesarKmlTexto(kmlText, file, statusEl);

    } else if (name.endsWith('.kml')) {
      // KML simple
      const kmlText = await file.text();
      await procesarKmlTexto(kmlText, file, statusEl);

    } else {
      statusEl.textContent = '⚠️ Formato no soportado. Use .kml o .kmz';
    }

  } catch (err) {
    console.error('❌ Error general en carga:', err);
    statusEl.textContent = `❌ Error procesando archivo: ${file.name}`;
  }
});

async function procesarKmlTexto(kmlText, file, statusEl) {
  try {
    // XML
    const xml = new DOMParser().parseFromString(kmlText, 'text/xml');
    const parseError = xml.getElementsByTagName('parsererror')[0];
    if (parseError) {
      console.error('❌ Error al parsear XML KML:', parseError.textContent);
      statusEl.textContent = `❌ Error al parsear KML: ${file.name}`;
      return;
    }

    // Intento 1: omnivore (si está)
    let layerFromOmnivore = null;
    if (window.omnivore?.kml?.parse) {
      try {
        layerFromOmnivore = omnivore.kml.parse(xml);
      } catch (omniErr) {
        console.warn('⚠️ Falla omnivore.kml.parse, se usa toGeoJSON:', omniErr);
      }
    }

    // Intento 2: toGeoJSON
    let geojson = null;
    if (window.toGeoJSON?.kml) {
      geojson = toGeoJSON.kml(xml);
    }

    // Evaluar resultados
    const featuresCount = geojson?.features?.length || 0;
    console.log('[KML] toGeoJSON.features:', featuresCount);

    const agregadas = [];

    // Si omnivore produjo capas, agrégalas y loguea
    if (layerFromOmnivore) {
      layerFromOmnivore.eachLayer(layer => {
        prepararYLlevarALocalDrafts(layer, file, agregadas, 'Omnivore');
      });
    }

    // Si toGeoJSON tiene features, crear capa y agregar individualmente
    if (featuresCount > 0) {
      const gjLayer = L.geoJSON(geojson, {
        style: (feature) => {
          const type = feature?.geometry?.type || '';
          if (type.includes('LineString') || type.includes('Polygon')) {
            return { color: '#f1c40f', weight: 5 };
          }
          return { color: '#f1c40f', weight: 3 };
        },
        pointToLayer: (feature, latlng) => {
          const name = feature?.properties?.name || 'Punto KML';
          return L.marker(latlng, { icon: draftIcon, opacity: 0.95 }).bindPopup(`<b>${name}</b>`);
        },
        onEachFeature: (feature, layer) => {
          prepararYLlevarALocalDrafts(layer, file, agregadas, 'toGeoJSON', feature);
        }
      });

      // No añadimos gjLayer entero al mapa; ya agregamos cada layer a localDrafts
    }

    // Fit bounds si hay capas agregadas
    if (agregadas.length > 0) {
      try {
        map.fitBounds(localDrafts.getBounds(), { padding: [20, 20] });
      } catch (boundsErr) {
        console.warn('⚠️ No se pudieron calcular bounds:', boundsErr);
      }
      actualizarBoton();
      statusEl.textContent = `✅ ${file.name} listo (${agregadas.length} capas)`;
    } else {
      statusEl.textContent = `⚠️ ${file.name}: sin geometrías visibles`;
    }

  } catch (err) {
    console.error('❌ Error procesando KML:', err);
    statusEl.textContent = `❌ Error procesando KML: ${file.name}`;
  }
}

function prepararYLlevarALocalDrafts(layer, file, agregadas, origen, featureOpt) {
  // Estilo borrador para paths
  if (layer instanceof L.Polygon || layer instanceof L.Polyline) {
    layer.setStyle?.({ color: '#f1c40f', weight: 5 });
  }

  // Metadata
  layer.options.customMetadata = { comentario: `${origen}: ${file.name}` };

  // Agregar al grupo editable
  localDrafts.addLayer(layer);
  agregadas.push(layer);

  // Loguear detalle
  const feature = featureOpt || layer.feature || {};
  const tipo = feature?.geometry?.type ||
    (layer instanceof L.Marker ? 'Point' : layer.constructor?.name);

  let coordsCount = 0;
  try {
    if (tipo === 'Point') coordsCount = 1;
    else if (tipo?.includes('LineString')) coordsCount = feature.geometry.coordinates?.length || 0;
    else if (tipo?.includes('Polygon')) coordsCount = (feature.geometry.coordinates?.[0]?.length) || 0;
  } catch {}

  console.log(`[${origen}] Capa/feature:`, {
    archivo: file.name,
    tipo,
    props: feature?.properties || {},
    bounds: layer.getBounds ? layer.getBounds().toBBoxString() : undefined,
    coordsCount
  });
}

// 4. Dibujo
const drawControl = new L.Control.Draw({
  edit: { featureGroup: localDrafts },
  draw: { circle: false, circlemarker: false, marker: true }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  const nota = prompt("Ingrese nota técnica:");
  if (nota !== null) {
    layer.options.customMetadata = { comentario: nota || "Sin comentario" };
    localDrafts.addLayer(layer);
    actualizarBoton();
  }
});

// 5. Guardado
function actualizarBoton() {
  const total = localDrafts.getLayers().length;
  const btn = document.getElementById('saveBtn');
  btn.disabled = total === 0;
  btn.innerHTML = `💾 Guardar (${total})`;
}

document.getElementById('saveBtn').onclick = async () => {
  const btn = document.getElementById('saveBtn');
  const layers = localDrafts.getLayers();
  btn.disabled = true;

  for (const layer of layers) {
    try {
      const gjString = JSON.stringify(layer.toGeoJSON());
      await addDoc(collection(db, "geometrias"), {
        feature: gjString,
        autor: userEmail,
        comentario: layer.options.customMetadata?.comentario || "Importado",
        fecha: new Date().toLocaleString('es-CL'),
        timestamp: serverTimestamp()
      });
      localDrafts.removeLayer(layer);
    } catch (err) {
      console.error(err);
    }
  }
  btn.disabled = false;
  actualizarBoton();
};

// 6. Nube
onSnapshot(collection(db, "geometrias"), (snap) => {
  snap.docChanges().forEach(change => {
    const data = change.doc.data();
    if (change.type === "added") {
      const feat = typeof data.feature === 'string'
        ? JSON.parse(data.feature)
        : data.feature;

      L.geoJSON(feat, {
        style: { color: '#3498db', weight: 3 }
      })
      .bindPopup(`<b>${data.comentario}</b><br>${data.autor}`)
      .addTo(cloudLayers);
    }
  });
  document.getElementById('status').textContent = `📡 Nube: ${snap.size}`;
});

// 7. Login
signInAnonymously(auth);
onAuthStateChanged(auth, (user) => {
  if (user) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
});
