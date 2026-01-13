// js/index.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
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
let userEmail = localStorage.getItem('pucobre_user');
if (!userEmail || !userEmail.includes('@')) {
    userEmail = prompt("Ingrese correo corporativo:");
    if (userEmail && userEmail.includes('@')) {
        localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
    } else {
        alert("Correo inválido. Recargue la página.");
        throw new Error("Sin autenticación");
    }
}

// 2. Mapa
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri — Pucobre',
  maxZoom: 19
}).addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

// 3. Herramientas de Dibujo (opcional pero útil)
const drawControl = new L.Control.Draw({
    edit: { featureGroup: localDrafts },
    draw: {
        polygon: true,
        polyline: true,
        rectangle: true,
        circle: false,
        marker: true,
        circlemarker: false
    }
});
map.addControl(drawControl);

// Capturar geometrías dibujadas
map.on(L.Draw.Event.CREATED, function(event) {
    const layer = event.layer;
    layer.options.customMetadata = { 
        comentario: prompt("Descripción del elemento:") || "Dibujo manual"
    };
    localDrafts.addLayer(layer);
    actualizarBoton();
});

// 4. Botón Cargar KML (Mejorado)
document.getElementById('kmlInput').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('status');
  statusEl.textContent = `📂 Procesando ${file.name}...`;

  const reader = new FileReader();
// Dentro del reader.onload de tu index.js actual
reader.onload = function(event) {
    try {
        // Usamos un contenedor temporal para validar los datos
        const kmlRaw = event.target.result;
        const kmlLayer = omnivore.kml.parse(kmlRaw);

        // Timeout de seguridad: Si en 5 segundos no carga, avisar al usuario
        const timeout = setTimeout(() => {
            if (statusEl.textContent.includes("Procesando")) {
                statusEl.textContent = "⚠️ El KML es muy complejo o grande, intentando renderizar...";
            }
        }, 5000);

        kmlLayer.on('ready', function() {
            clearTimeout(timeout);
            let count = 0;
            
            this.eachLayer(layer => {
                // FORZAMOS ESTILO: Vital para MultiGeometry
                if (layer.setStyle) {
                    layer.setStyle({
                        color: '#f39c12',
                        weight: 3,
                        fillOpacity: 0.4
                    });
                }
                
                // Limpiamos descripciones pesadas para evitar lentitud en el mapa
                if (layer.feature && layer.feature.properties) {
                    layer.options.customMetadata = { 
                        comentario: `KML: ${file.name} - ${layer.feature.properties.name || 'Sin nombre'}` 
                    };
                }

                localDrafts.addLayer(layer);
                count++;
            });

            if (count > 0) {
                map.fitBounds(localDrafts.getBounds());
                statusEl.textContent = `✅ ${count} elementos cargados de ${file.name}`;
            } else {
                statusEl.textContent = "❌ No se encontraron geometrías compatibles.";
            }
            actualizarBoton();
        });

        kmlLayer.on('error', function(e) {
            clearTimeout(timeout);
            console.error("Error detallado de Omnivore:", e);
            statusEl.textContent = "❌ Error técnico al leer el contenido del KML.";
        });

    } catch (err) {
        statusEl.textContent = "❌ Error crítico al procesar el archivo.";
        console.error(err);
    }
};

  reader.onerror = function() {
    statusEl.textContent = `❌ No se pudo leer el archivo`;
  };

  reader.readAsText(file);
  
  // Reset input para permitir cargar el mismo archivo otra vez
  e.target.value = '';
});

// 5. Guardar Todo en la Nube
document.getElementById('saveBtn').onclick = async () => {
  const btn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');
  const layers = localDrafts.getLayers();
  
  if (layers.length === 0) return;

  btn.disabled = true;
  btn.innerHTML = "⌛ Guardando...";
  statusEl.textContent = "💾 Subiendo a Firebase...";

  let exitosos = 0;
  let errores = 0;

  for (const layer of layers) {
    try {
      const geoJSON = layer.toGeoJSON();
      const gjString = JSON.stringify(geoJSON);
      
      // Guardado dinámico por proyecto
      await addDoc(collection(db, `geometrias_${proyectoID}`), {
        feature: gjString,
        autor: userEmail,
        comentario: layer.options.customMetadata?.comentario || "Sin descripción",
        archivo: layer.options.customMetadata?.archivo || null,
        fecha: new Date().toLocaleString('es-CL'),
        timestamp: serverTimestamp()
      });
      
      localDrafts.removeLayer(layer);
      exitosos++;
    } catch (err) {
      console.error("Error al guardar:", err);
      errores++;
    }
  }

  // Feedback visual
  if (exitosos > 0) {
    statusEl.textContent = `✅ ${exitosos} elemento${exitosos > 1 ? 's' : ''} guardado${exitosos > 1 ? 's' : ''} en la nube`;
  }
  if (errores > 0) {
    statusEl.textContent += ` | ❌ ${errores} error${errores > 1 ? 'es' : ''}`;
  }

  actualizarBoton();
};

function actualizarBoton() {
  const total = localDrafts.getLayers().length;
  const btn = document.getElementById('saveBtn');
  btn.disabled = total === 0;
  btn.innerHTML = total > 0 ? `💾 Guardar (${total})` : `💾 Guardar Cambios`;
}

// 6. Sincronización Automática (colaboración en tiempo real)
const docMap = new Map(); // Para rastrear qué layer corresponde a qué documento

onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
  cloudLayers.clearLayers();
  docMap.clear();
  
  snap.forEach(doc => {
    const data = doc.data();
    try {
      const geoJSONLayer = L.geoJSON(JSON.parse(data.feature), {
        style: { 
          color: '#3498db', 
          weight: 2, 
          fillOpacity: 0.2,
          dashArray: '5, 5' // Líneas punteadas para diferenciar de borradores
        }
      });
      
      // Popup con información del autor
      const popupContent = `
        <div style="min-width:200px">
          <b>${data.comentario}</b><br>
          <small>
            👤 ${data.autor}<br>
            📅 ${data.fecha}<br>
            ${data.archivo ? `📁 ${data.archivo}` : ''}
          </small>
        </div>
      `;
      
      geoJSONLayer.bindPopup(popupContent);
      geoJSONLayer.addTo(cloudLayers);
      
      // Guardar referencia para futuras eliminaciones
      docMap.set(geoJSONLayer._leaflet_id, doc.id);
      
    } catch (err) {
      console.error("Error al renderizar geometría:", err);
    }
  });
  
  const statusEl = document.getElementById('status');
  statusEl.textContent = `📡 ${proyectoID.toUpperCase()} | ${snap.size} elemento${snap.size !== 1 ? 's' : ''} en nube`;
});

// 7. Autenticación
signInAnonymously(auth);
onAuthStateChanged(auth, (user) => { 
  if (user) {
    document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
  }
});

// 8. Inicialización
actualizarBoton();
console.log(`🗺️ Proyecto cargado: ${proyectoID} | Centro: [${latInicial}, ${lngInicial}] | Zoom: ${zoomInicial}`);
