// js/index.js - VERSIÓN CORREGIDA Y AUDITADA
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// ============================================================================
// 0. PARÁMETROS DE PROYECTO
// ============================================================================
const urlParams = new URLSearchParams(window.location.search);
const proyectoID = urlParams.get('area') || 'general';
const latInicial = parseFloat(urlParams.get('lat')) || -27.366;
const lngInicial = parseFloat(urlParams.get('lng')) || -70.332;
const zoomInicial = parseInt(urlParams.get('zoom')) || 14;

// ============================================================================
// 1. CONFIGURACIÓN FIREBASE
// ============================================================================
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

// ============================================================================
// MANEJO DE IDENTIDAD
// ============================================================================
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

// ============================================================================
// 2. INICIALIZACIÓN DEL MAPA
// ============================================================================
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri — Pucobre',
  maxZoom: 19
}).addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

// ============================================================================
// 3. HERRAMIENTAS DE DIBUJO
// ============================================================================
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

// ============================================================================
// 4. CARGA DE ARCHIVOS KML - VERSIÓN CORREGIDA
// ============================================================================
let currentKmlLoad = null; // Control de carga actual

document.getElementById('kmlInput').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('status');
  
  // ✅ FIX 1: Validar extensión del archivo
  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith('.kml') && !fileName.endsWith('.kmz')) {
    statusEl.textContent = "❌ Solo se aceptan archivos .kml o .kmz";
    e.target.value = '';
    return;
  }

  // ✅ FIX 2: Validar tamaño (límite 15MB)
  const maxSize = 15 * 1024 * 1024;
  if (file.size > maxSize) {
    statusEl.textContent = `❌ Archivo muy grande (${(file.size / 1024 / 1024).toFixed(1)}MB). Máximo: 15MB`;
    e.target.value = '';
    return;
  }

  statusEl.textContent = `📂 Procesando ${file.name} (${(file.size / 1024).toFixed(0)}KB)...`;
  
  const reader = new FileReader();
  
  reader.onload = function(event) {
    try {
      const kmlRaw = event.target.result;
      
      // ✅ FIX 3: Validar que sea XML válido
      if (!kmlRaw.includes('<kml') && !kmlRaw.includes('<KML')) {
        statusEl.textContent = "❌ El archivo no contiene formato KML válido";
        return;
      }

      // ✅ FIX 4: Parsear con DOMParser para mejor manejo de errores
      const parser = new DOMParser();
      const kmlDOM = parser.parseFromString(kmlRaw, 'text/xml');
      
      // Verificar errores de parseo XML
      const parseError = kmlDOM.querySelector('parsererror');
      if (parseError) {
        statusEl.textContent = "❌ KML corrupto o malformado";
        console.error('Error de parseo XML:', parseError.textContent);
        return;
      }

      // ✅ FIX 5: Usar omnivore correctamente con DOMParser
      let kmlLayer;
      try {
        kmlLayer = omnivore.kml.parse(kmlDOM);
      } catch (omnivoreError) {
        // Fallback: intentar con el string directo
        console.warn('Fallback a parse directo:', omnivoreError);
        kmlLayer = L.geoJSON(); // Layer vacío
        const kmlBlob = new Blob([kmlRaw], { type: 'application/vnd.google-earth.kml+xml' });
        const kmlUrl = URL.createObjectURL(kmlBlob);
        kmlLayer = omnivore.kml(kmlUrl);
      }

      // Control de carga
      currentKmlLoad = { 
        layer: kmlLayer, 
        cancelled: false,
        fileName: file.name
      };

      let loadTimeout;

      // ============================================================================
      // EVENTO: KML CARGADO EXITOSAMENTE
      // ============================================================================
      kmlLayer.on('ready', function() {
        clearTimeout(loadTimeout);
        
        if (currentKmlLoad?.cancelled) {
          statusEl.textContent = "⚠️ Carga cancelada por el usuario";
          return;
        }

        const allLayers = [];
        let totalFeatures = 0;
        
        // Recolectar todas las capas
        this.eachLayer(layer => {
          totalFeatures++;
          allLayers.push(layer);
        });

        if (totalFeatures === 0) {
          statusEl.textContent = "❌ No se encontraron geometrías válidas en el KML";
          return;
        }

        console.log(`📊 KML parseado: ${totalFeatures} features encontrados`);
        statusEl.textContent = `⏳ Procesando ${totalFeatures} elementos...`;

        // ✅ FIX 6: Procesar en chunks para evitar bloqueo del UI
        const chunkSize = 50;
        let processedCount = 0;

        const processChunk = (startIndex) => {
          const endIndex = Math.min(startIndex + chunkSize, allLayers.length);
          
          for (let i = startIndex; i < endIndex; i++) {
            if (currentKmlLoad?.cancelled) break;
            
            const layer = allLayers[i];
            
            // ✅ FIX 7: Manejar diferentes tipos de geometrías
            if (layer instanceof L.Marker) {
              // Marcadores: mantener icono por defecto de Leaflet
              layer.setIcon(L.icon({
                iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
                iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
                shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
              }));
            } else if (layer.setStyle) {
              // ✅ FIX 8: Preservar estilos del KML si existen
              const props = layer.feature?.properties || {};
              const style = {
                color: props.stroke || '#f39c12',
                weight: props['stroke-width'] || 3,
                fillColor: props.fill || '#f39c12',
                fillOpacity: parseFloat(props['fill-opacity']) || 0.4,
                opacity: parseFloat(props['stroke-opacity']) || 1
              };
              layer.setStyle(style);
            }

            // Metadata personalizada
            const featureName = layer.feature?.properties?.name || 
                               layer.feature?.properties?.Name || 
                               `Elemento ${i + 1}`;
            
            layer.options.customMetadata = {
              comentario: `KML: ${featureName}`,
              archivo: file.name
            };

            // Agregar popup con información
            if (featureName !== `Elemento ${i + 1}`) {
              layer.bindPopup(`<b>${featureName}</b><br><small>Desde: ${file.name}</small>`);
            }

            localDrafts.addLayer(layer);
            processedCount++;
          }

          // Actualizar progreso
          const progress = Math.round((processedCount / totalFeatures) * 100);
          statusEl.textContent = `⏳ Cargando ${processedCount}/${totalFeatures} (${progress}%)`;

          // Continuar con el siguiente chunk o finalizar
          if (endIndex < allLayers.length && !currentKmlLoad?.cancelled) {
            setTimeout(() => processChunk(endIndex), 10);
          } else {
            finalizarCarga(processedCount, totalFeatures);
          }
        };

        // Iniciar procesamiento
        processChunk(0);
      });

      // ============================================================================
      // EVENTO: ERROR EN CARGA DE KML
      // ============================================================================
      kmlLayer.on('error', function(e) {
        clearTimeout(loadTimeout);
        const errorMsg = e.error?.message || e.message || 'Error desconocido';
        statusEl.textContent = `❌ Error al cargar KML: ${errorMsg}`;
        console.error('Error detallado de Omnivore:', e);
        
        // Mostrar sugerencias según el tipo de error
        if (errorMsg.includes('parse') || errorMsg.includes('XML')) {
          console.warn('Sugerencia: El archivo puede tener XML malformado');
        }
      });

      // ✅ FIX 9: Timeout mejorado con mensaje progresivo
      loadTimeout = setTimeout(() => {
        if (currentKmlLoad && !currentKmlLoad.cancelled) {
          statusEl.textContent = "⏱️ El archivo es grande, sigue procesando... (puede tomar 1-2 min)";
        }
      }, 8000);

    } catch (err) {
      statusEl.textContent = "❌ Error crítico al procesar el archivo";
      console.error('Error en reader.onload:', err);
    }
  };

  reader.onerror = function() {
    statusEl.textContent = "❌ No se pudo leer el archivo del disco";
  };

  reader.readAsText(file);
  e.target.value = ''; // Reset para permitir cargar el mismo archivo
});

// ============================================================================
// FUNCIÓN: Finalizar carga de KML
// ============================================================================
function finalizarCarga(procesados, totales) {
  const statusEl = document.getElementById('status');
  
  if (procesados > 0) {
    try {
      // Ajustar vista del mapa a las nuevas geometrías
      const bounds = localDrafts.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50] });
      }
      
      statusEl.textContent = `✅ ${procesados} elemento${procesados !== 1 ? 's' : ''} cargado${procesados !== 1 ? 's' : ''} desde ${currentKmlLoad.fileName}`;
      actualizarBoton();
      
      // Log de éxito
      console.log(`✅ KML cargado: ${procesados}/${totales} features`);
    } catch (err) {
      console.error('Error al ajustar vista:', err);
      statusEl.textContent = `✅ ${procesados} elementos cargados (error al centrar mapa)`;
    }
  } else {
    statusEl.textContent = "⚠️ No se pudieron procesar los elementos del KML";
  }
  
  currentKmlLoad = null;
}

// ============================================================================
// 5. GUARDAR TODO EN LA NUBE
// ============================================================================
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
      
      // Validar que no sea demasiado grande
      if (gjString.length > 1000000) { // 1MB
        console.warn('Geometría muy grande, omitida:', gjString.length, 'chars');
        errores++;
        continue;
      }
      
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
      console.error("Error al guardar geometría:", err);
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

// ============================================================================
// 6. SINCRONIZACIÓN AUTOMÁTICA (Colaboración en Tiempo Real)
// ============================================================================
const docMap = new Map();

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
          dashArray: '5, 5'
        }
      });
      
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
      docMap.set(geoJSONLayer._leaflet_id, doc.id);
      
    } catch (err) {
      console.error("Error al renderizar geometría desde nube:", err);
    }
  });
  
  const statusEl = document.getElementById('status');
  statusEl.textContent = `📡 ${proyectoID.toUpperCase()} | ${snap.size} elemento${snap.size !== 1 ? 's' : ''} en nube`;
});

// ============================================================================
// 7. AUTENTICACIÓN
// ============================================================================
signInAnonymously(auth);
onAuthStateChanged(auth, (user) => { 
  if (user) {
    document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
  }
});

// ============================================================================
// 8. INICIALIZACIÓN
// ============================================================================
actualizarBoton();
console.log(`🗺️ Sistema GIS iniciado`);
console.log(`📍 Proyecto: ${proyectoID}`);
console.log(`🎯 Centro: [${latInicial}, ${lngInicial}] | Zoom: ${zoomInicial}`);
console.log(`👤 Usuario: ${userEmail}`);
