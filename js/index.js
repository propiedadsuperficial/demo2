// js/index.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyB3kW9ep7iOKDp87i2-er5-CuZKerA4puY",
  authDomain: "gis-pucobre.firebaseapp.com",
  projectId: "gis-pucobre",
  storageBucket: "gis-pucobre.appspot.com",
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8614a0faa86f5027"
};

// 1. Manejo de Identidad
let userEmail = localStorage.getItem('pucobre_user');
if (!userEmail) {
  userEmail = prompt("Sesión GIS Pucobre. Ingrese su correo corporativo:");
  if (!userEmail || !userEmail.includes('@')) {
    window.location.reload();
  } else {
    localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
  }
}

const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// 2. Inicialización del Mapa
const map = L.map('map').setView([-27.366, -70.332], 14);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri'
}).addTo(map);

const cloudLayers  = L.featureGroup().addTo(map);
const localDrafts  = L.featureGroup().addTo(map);

// 3. Controles de Dibujo
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

// 4. Captura de Dibujo
map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  const nota  = prompt(`Ingrese nota técnica para este ${e.layerType}:`);
  if (nota !== null) {
    layer.options.customMetadata = { comentario: nota || "Sin comentario" };
    localDrafts.addLayer(layer);
    actualizarBoton();
  }
});

// --- NUEVA FUNCIÓN: CARGA DE KML ---
// --- FUNCIÓN DE CARGA KML CORREGIDA ---
document.getElementById('kmlInput').onchange = function(e) {
  const file = e.target.files[0];
  if (!file) return;

  // Validación de peso (100 KB)
  if (file.size > 102400) {
    alert("El archivo supera el límite de 100KB.");
    return;
  }

  const reader = new FileReader();
  reader.onload = function(event) {
    const kmlText = event.target.result;
    
    try {
      // 1. Convertir el texto KML a una capa de Leaflet usando omnivore
      const kmlLayer = omnivore.kml.parse(kmlText);
      
      kmlLayer.on('ready', function() {
        // 2. Extraer cada elemento y pasarlo a localDrafts para que sea editable y guardable
        kmlLayer.eachLayer(layer => {
          // Mantener el estilo visual de "borrador" (Amarillo)
          if (layer.setStyle) {
            layer.setStyle({ color: '#f1c40f', weight: 5, fillOpacity: 0.4 });
          }
          
          // Asignar comentario automático
          layer.options.customMetadata = { 
            comentario: "Importado: " + file.name 
          };
          
          localDrafts.addLayer(layer);
        });

        // 3. Zoom automático a lo cargado
        if (localDrafts.getLayers().length > 0) {
          map.fitBounds(localDrafts.getBounds());
        }
        
        actualizarBoton();
        document.getElementById('status').textContent = `✅ KML cargado: ${file.name}`;
      });

      kmlLayer.on('error', function(err) {
        console.error("Error de omnivore:", err);
        alert("No se pudo procesar el KML. Asegúrese de que sea un archivo .kml válido.");
      });

    } catch (err) {
      console.error("Error al leer el archivo:", err);
      alert("Error crítico al procesar el archivo.");
    }
  };
  
  reader.readAsText(file);
};

function actualizarBoton() {
  const total = localDrafts.getLayers().length;
  const btn   = document.getElementById('saveBtn');
  btn.disabled = total === 0;
  btn.innerHTML = total > 0 ? `💾 Guardar (${total})` : `💾 Guardar Cambios`;
}

// 5. Guardado en Firebase
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
        comentario: layer.options.customMetadata?.comentario || "Importado",
        fecha: new Date().toLocaleString('es-CL'),
        timestamp: serverTimestamp()
      });
      localDrafts.removeLayer(layer);
    } catch (err) {
      console.error("Error al guardar:", err);
    }
  }

  btn.disabled  = false;
  btn.innerHTML = "💾 Guardar Cambios";
  actualizarBoton();
};

// 6. Carga en Tiempo Real
const cloudIndex = new Map();
onSnapshot(collection(db, "geometrias"), (snap) => {
  snap.docChanges().forEach(change => {
    const id = change.doc.id;
    const data = change.doc.data();
    let feat = typeof data.feature === 'string' ? JSON.parse(data.feature) : data.feature;

    if (change.type === "added" || change.type === "modified") {
      if (cloudIndex.has(id)) cloudLayers.removeLayer(cloudIndex.get(id));
      
      const layer = L.geoJSON(feat, {
        style: { color: '#3498db', weight: 3, fillOpacity: 0.2 },
        pointToLayer: (_, latlng) => L.marker(latlng)
      }).bindPopup(`<strong>Nota:</strong> ${data.comentario}<br><small>Por: ${data.autor}</small>`);
      
      layer.addTo(cloudLayers);
      cloudIndex.set(id, layer);
    }
  });
  document.getElementById('status').textContent = `📡 Nube: ${snap.size}`;
});

signInAnonymously(auth);
onAuthStateChanged(auth, (user) => {
  if (user) document.getElementById('userInfo').innerHTML = `<span class="badge-user">👤 ${userEmail}</span>`;
});
