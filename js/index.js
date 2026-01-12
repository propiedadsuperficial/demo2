// js/index.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// Configuración de Firebase corregida
const firebaseConfig = {
  apiKey: "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
  authDomain: "gis-pucobre.firebaseapp.com",
  projectId: "gis-pucobre",
  storageBucket: "gis-pucobre.firebasestorage.app",
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8014a0faa86f5027"
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

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 2. Inicialización del Mapa
const map = L.map('map').setView([-27.366, -70.332], 14);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri — World Imagery'
}).addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

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

// 4. Captura de Dibujo Manual
map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  const nota = prompt(`Ingrese nota técnica:`);
  if (nota !== null) {
    layer.options.customMetadata = { comentario: nota || "Sin comentario" };
    localDrafts.addLayer(layer);
    actualizarBoton();
  }
});

function actualizarBoton() {
  const total = localDrafts.getLayers().length;
  const btn = document.getElementById('saveBtn');
  btn.disabled = total === 0;
  btn.innerHTML = total > 0 ? `💾 Guardar (${total})` : `💾 Guardar Cambios`;
}

// 5. Carga de KML Simplificada
document.getElementById('kmlInput').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    const kmlLayer = omnivore.kml.parse(event.target.result);
    kmlLayer.on('ready', function() {
      this.eachLayer(layer => {
        if (layer.setStyle) layer.setStyle({ color: '#f1c40f', weight: 4 });
        layer.options.customMetadata = { comentario: "KML: " + file.name };
        localDrafts.addLayer(layer);
      });
      map.fitBounds(localDrafts.getBounds());
      actualizarBoton();
    });
  };
  reader.readAsText(file);
});

// 6. Guardado en Firebase
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
      console.error("Error al guardar:", err);
    }
  }
  btn.disabled = false;
  actualizarBoton();
};

// 7. Sincronización Nube
onSnapshot(collection(db, "geometrias"), (snap) => {
  snap.docChanges().forEach(change => {
    if (change.type === "added") {
      const data = change.doc.data();
      const feat = JSON.parse(data.feature);
      L.geoJSON(feat, {
        style: { color: '#3498db', weight: 3, fillOpacity: 0.2 }
      }).bindPopup(`<b>${data.comentario}</b><br><small>${data.autor}</small>`).addTo(cloudLayers);
    }
  });
  document.getElementById('status').textContent = `📡 Nube: ${snap.size}`;
});

signInAnonymously(auth);
onAuthStateChanged(auth, (user) => {
  if (user) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
});
