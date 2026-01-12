import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// --- PARÁMETROS DE URL ---
const params = new URLSearchParams(window.location.search);
const proyectoID = params.get('area') || 'general';
const lat = parseFloat(params.get('lat')) || -27.366;
const lng = parseFloat(params.get('lng')) || -70.332;
const zoom = parseInt(params.get('zoom')) || 14;

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
if (!userEmail) {
  userEmail = prompt("Sesión GIS Pucobre. Ingrese su correo corporativo:");
  if (userEmail && userEmail.includes('@')) {
    localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
  } else {
    window.location.reload();
  }
}

// Inicialización del Mapa con datos de URL
const map = L.map('map').setView([lat, lng], zoom);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri'
}).addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

// Controles de Dibujo
const drawControl = new L.Control.Draw({
  edit: { featureGroup: localDrafts },
  draw: { circle: false, circlemarker: false, marker: true,
    polyline: { shapeOptions: { color: '#f1c40f', weight: 5 } },
    polygon: { shapeOptions: { color: '#f1c40f', fillOpacity: 0.4 } }
  }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
  const nota = prompt(`Ingrese nota técnica:`);
  if (nota !== null) {
    e.layer.options.customMetadata = { comentario: nota || "Sin comentario" };
    localDrafts.addLayer(e.layer);
    actualizarBoton();
  }
});

function actualizarBoton() {
  const total = localDrafts.getLayers().length;
  document.getElementById('saveBtn').disabled = total === 0;
  document.getElementById('saveBtn').innerHTML = total > 0 ? `💾 Guardar (${total})` : `💾 Guardar Cambios`;
}

// Carga KML
document.getElementById('kmlInput').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    const kmlLayer = omnivore.kml.parse(event.target.result);
    kmlLayer.on('ready', function() {
      this.eachLayer(layer => {
        layer.options.customMetadata = { comentario: "KML: " + file.name };
        localDrafts.addLayer(layer);
      });
      map.fitBounds(localDrafts.getBounds());
      actualizarBoton();
    });
  };
  reader.readAsText(file);
});

// Guardado Dinámico
document.getElementById('saveBtn').onclick = async () => {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  for (const layer of localDrafts.getLayers()) {
    try {
      await addDoc(collection(db, `geometrias_${proyectoID}`), {
        feature: JSON.stringify(layer.toGeoJSON()),
        autor: userEmail,
        comentario: layer.options.customMetadata?.comentario || "Importado",
        fecha: new Date().toLocaleString('es-CL'),
        timestamp: serverTimestamp()
      });
      localDrafts.removeLayer(layer);
    } catch (err) { console.error("Error:", err); }
  }
  actualizarBoton();
};

// Sincronización Dinámica
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
  cloudLayers.clearLayers();
  snap.forEach(doc => {
    const data = doc.data();
    L.geoJSON(JSON.parse(data.feature), {
      style: { color: '#3498db', weight: 3, fillOpacity: 0.2 }
    }).bindPopup(`<b>${data.comentario}</b><br><small>${data.autor}</small>`).addTo(cloudLayers);
  });
  document.getElementById('status').textContent = `📡 Proyecto: ${proyectoID.toUpperCase()} | Nube: ${snap.size}`;
});

signInAnonymously(auth);
onAuthStateChanged(auth, (user) => {
  if (user) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
});
