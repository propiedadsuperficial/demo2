// js/index.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// 1. Configuración de Firebase
const firebaseConfig = {
  apiKey: "AIzaSyB3kW9ep7iOKDp87i2-er5-CuZKerA4puY",
  authDomain: "gis-pucobre.firebaseapp.com",
  projectId: "gis-pucobre",
  storageBucket: "gis-pucobre.appspot.com",
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8614a0faa86f5027"
};

// 2. Manejo de Identidad Persistente
let userEmail = localStorage.getItem('pucobre_user');
if (!userEmail) {
  userEmail = prompt("Sesión GIS Pucobre. Ingrese su correo corporativo:");
  if (!userEmail || !userEmail.includes('@')) {
    window.location.reload();
  } else {
    localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
  }
}

// Inicializar Firebase
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// 3. Inicialización del Mapa
const map = L.map('map').setView([-27.366, -70.332], 14);
L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: '© Esri — World Imagery | © Leaflet' }
).addTo(map);

const cloudLayers  = L.featureGroup().addTo(map); // Capas desde Firebase
const localDrafts  = L.featureGroup().addTo(map); // Capas locales (dibujo/KML)

// 4. Controles de Dibujo
const drawControl = new L.Control.Draw({
  edit: { featureGroup: localDrafts },
  draw: {
    circle: false, circlemarker: false,
    polyline: { shapeOptions: { color: '#f1c40f', weight: 5 } },
    polygon: { shapeOptions: { color: '#f1c40f', fillOpacity: 0.4 } },
    marker: true
  }
});
map.addControl(drawControl);

// 5. Captura de Dibujo Manual
map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  const nota  = prompt(`Ingrese nota técnica para este ${e.layerType}:`);
  if (nota !== null) {
    layer.options.customMetadata = { comentario: nota || "Sin comentario" };
    localDrafts.addLayer(layer);
    actualizarBoton();
  }
});

// --- NUEVA FUNCIÓN: CARGA Y VISUALIZACIÓN DE KML ---
document.getElementById('kmlInput').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  // Validación de peso (Máximo 100kb según solicitud)
  if (file.size > 102400) {
    alert("El archivo excede los 100KB.");
    return;
  }

  const reader = new FileReader();
  reader.onload = function(event) {
    const kmlText = event.target.result;
    
    // omnivore.kml.parse convierte el texto KML a GeoJSON de Leaflet
    const kmlLayer = omnivore.kml.parse(kmlText);
    
    kmlLayer.on('ready', function() {
      kmlLayer.eachLayer(layer => {
        // Estilo de borrador para los elementos del KML
        if (layer.setStyle) {
          layer.setStyle({ color: '#f1c40f', weight: 4, fillOpacity: 0.3 });
        }
        // Metadata para el guardado posterior
        layer.options.customMetadata = { comentario: "Importado: " + file.name };
        localDrafts.addLayer(layer);
      });

      // Zoom a los elementos cargados
      if (localDrafts.getLayers().length > 0) {
        map.fitBounds(localDrafts.getBounds());
      }
      
      actualizarBoton();
      document.getElementById('status').textContent = `✅ KML cargado: ${file.name}`;
    });

    kmlLayer.on('error', function() {
      alert("Error al procesar el archivo KML. Verifique el formato.");
    });
  };
  
  reader.readAsText(file);
});

// 6. Función para actualizar estado del botón de guardado
function actualizarBoton() {
  const total = localDrafts.getLayers().length;
  const btn   = document.getElementById('saveBtn');
  btn.disabled = total === 0;
  btn.innerHTML = total > 0 ? `💾 Guardar (${total})` : `💾 Guardar Cambios`;
}

// 7. Función de Guardado en Firebase
document.getElementById('saveBtn').onclick = async () => {
  const btn     = document.getElementById('saveBtn');
  const status  = document.getElementById('status');
  const layers  = localDrafts.getLayers();

  btn.disabled  = true;
  btn.innerHTML = "⌛ Sincronizando...";

  for (const layer of layers) {
    try {
      const gjString = JSON.stringify(layer.toGeoJSON());
      await addDoc(collection(db, "geometrias"), {
        feature: gjString,
        autor: userEmail,
        comentario: layer.options.customMetadata?.comentario || "Sin nota",
        fecha: new Date().toLocaleString('es-CL'),
        timestamp: serverTimestamp()
      });
      localDrafts.removeLayer(layer);
    } catch (err) {
      console.error("Error al guardar:", err);
      status.textContent = `⚠️ Error: ${err.message}`;
    }
  }

  btn.disabled  = false;
  btn.innerHTML = "💾 Guardar Cambios";
  actualizarBoton();
};

// 8. Carga de Datos en Tiempo Real (Firebase a Mapa)
const cloudIndex = new Map();

onSnapshot(collection(db, "geometrias"), (snap) => {
  snap.docChanges().forEach(change => {
    const id   = change.doc.id;
    const data = change.doc.data();

    let feat = data.feature;
    if (typeof feat === 'string') {
      try { feat = JSON.parse(feat); } catch (e) { return; }
    }

    if (change.type === "added" || change.type === "modified") {
      // Remover si ya existe para actualizar
      if (cloudIndex.has(id)) {
        cloudLayers.removeLayer(cloudIndex.get(id));
      }

      const layer = L.geoJSON(feat, {
        style: { color: '#3498db', weight: 3, fillOpacity: 0.2 },
        pointToLayer: (_, latlng) => L.marker(latlng)
      }).bindPopup(
        `<div style="font-family: sans-serif;">
           <strong>Nota Técnica:</strong><br>${data.comentario}<br>
           <hr style="margin: 5px 0;">
           <small>Responsable: ${data.autor}</small>
         </div>`
      );
      
      layer.addTo(cloudLayers);
      cloudIndex.set(id, layer);

    } else if (change.type === "removed") {
      const layer = cloudIndex.get(id);
      if (layer) {
        cloudLayers.removeLayer(layer);
        cloudIndex.delete(id);
      }
    }
  });

  document.getElementById('status').textContent = `📡 Conectado | Nube: ${snap.size}`;
});

// 9. Autenticación Anónima
signInAnonymously(auth).catch((e) => {
  document.getElementById('status').textContent = `⚠️ Error Auth: ${e.message}`;
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    document.getElementById('userInfo').innerHTML = `<span class="badge-user">👤 ${userEmail}</span>`;
  }
});
