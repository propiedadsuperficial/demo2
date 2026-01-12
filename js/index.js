// js/index.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// --- 0. PARÁMETROS DE PROYECTO ---
const urlParams = new URLSearchParams(window.location.search);
const proyectoID = urlParams.get('area') || 'general';
const latInicial = parseFloat(urlParams.get('lat')) || -27.366;
const lngInicial = parseFloat(urlParams.get('lng')) || -70.332;
const zoomInicial = parseInt(urlParams.get('zoom')) || 14;

// 1. Configuración Firebase
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
let userEmail = localStorage.getItem('pucobre_user') || prompt("Ingrese correo corporativo:");
if (userEmail && userEmail.includes('@')) {
    localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
} else {
    window.location.reload();
}

// 2. Mapa
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri — Pucobre'
}).addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

// 3. Botón Cargar KML (Optimizado para colaboración)
document.getElementById('kmlInput').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    // Usamos omnivore para procesar el KML
    const kmlLayer = omnivore.kml.parse(event.target.result);
    kmlLayer.on('ready', function() {
      this.eachLayer(layer => {
        // Estilo visual distintivo para lo que se está cargando
        if (layer.setStyle) layer.setStyle({ color: '#f1c40f', weight: 4, fillOpacity: 0.3 });
        
        // Etiquetamos el origen para que otros sepan de qué archivo vino
        layer.options.customMetadata = { comentario: "ARCHIVO: " + file.name };
        localDrafts.addLayer(layer);
      });
      // Ajustar vista a los nuevos datos
      map.fitBounds(localDrafts.getBounds());
      actualizarBoton();
    });
  };
  reader.readAsText(file);
});

// 4. Guardar Todo en la Nube
document.getElementById('saveBtn').onclick = async () => {
  const btn = document.getElementById('saveBtn');
  const layers = localDrafts.getLayers();
  btn.disabled = true;
  btn.innerHTML = "⌛ Guardando...";

  for (const layer of layers) {
    try {
      const gjString = JSON.stringify(layer.toGeoJSON());
      // Guardado dinámico por proyecto
      await addDoc(collection(db, `geometrias_${proyectoID}`), {
        feature: gjString,
        autor: userEmail,
        comentario: layer.options.customMetadata?.comentario || "Carga KML",
        fecha: new Date().toLocaleString('es-CL'),
        timestamp: serverTimestamp()
      });
      localDrafts.removeLayer(layer);
    } catch (err) {
      console.error("Error:", err);
    }
  }
  actualizarBoton();
};

function actualizarBoton() {
  const total = localDrafts.getLayers().length;
  const btn = document.getElementById('saveBtn');
  btn.disabled = total === 0;
  btn.innerHTML = total > 0 ? `💾 Guardar en Nube (${total})` : `💾 Guardar Cambios`;
}

// 5. Sincronización Automática (La base de la colaboración)
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
  cloudLayers.clearLayers();
  snap.forEach(doc => {
    const data = doc.data();
    L.geoJSON(JSON.parse(data.feature), {
      style: { color: '#3498db', weight: 3, fillOpacity: 0.2 }
    }).bindPopup(`<b>${data.comentario}</b><br><small>Subido por: ${data.autor}</small>`).addTo(cloudLayers);
  });
  document.getElementById('status').textContent = `📡 PROYECTO: ${proyectoID.toUpperCase()} | Elementos: ${snap.size}`;
});

signInAnonymously(auth);
onAuthStateChanged(auth, (u) => { if(u) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`; });
