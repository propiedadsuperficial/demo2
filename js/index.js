// js/index.js - VERSIÓN ULTRA-COMPATIBLE (KML + GEOJSON)
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
        polygon: true, polyline: true, rectangle: true, circle: false, marker: true, circlemarker: false
    }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, function(event) {
    const layer = event.layer;
    layer.options.customMetadata = { 
        comentario: prompt("Descripción del elemento:") || "Dibujo manual"
    };
    localDrafts.addLayer(layer);
    actualizarBoton();
});

// ============================================================================
// 4. CARGA DE ARCHIVOS (KML O GEOJSON)
// ============================================================================
document.getElementById('kmlInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const statusEl = document.getElementById('status');
    const fileName = file.name.toLowerCase();
    const reader = new FileReader();

    statusEl.textContent = `📂 Procesando ${file.name}...`;

    reader.onload = async function(event) {
        try {
            const rawContent = event.target.result;
            let layerToProcess = null;

            // --- CASO A: GEOJSON ---
            if (fileName.endsWith('.geojson') || fileName.endsWith('.json')) {
                const geoData = JSON.parse(rawContent);
                layerToProcess = L.geoJSON(geoData);
                await unificarYProcesar(layerToProcess, file.name);
            } 
            // --- CASO B: KML ---
            else if (fileName.endsWith('.kml')) {
                const parser = new DOMParser();
                let kmlDOM = parser.parseFromString(rawContent, 'text/xml');
                
                // Parche de reparación xsi para ArcMap
                let parseError = kmlDOM.querySelector('parsererror');
                if (parseError && parseError.textContent.includes('xsi')) {
                    console.warn("🛠️ Reparando namespace de ArcMap...");
                    const fixedRaw = rawContent.replace(/<Document(\s+)/i, '<Document xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"$1');
                    kmlDOM = parser.parseFromString(fixedRaw, 'text/xml');
                }

                const kmlLayer = omnivore.kml.parse(kmlDOM);
                kmlLayer.on('ready', () => unificarYProcesar(kmlLayer, file.name));
            } else {
                statusEl.textContent = "❌ Formato no soportado (use .kml o .geojson)";
            }
        } catch (err) {
            statusEl.textContent = "❌ Error crítico al leer archivo";
            console.error(err);
        }
    };

    reader.readAsText(file);
    e.target.value = ''; 
});

// ============================================================================
// FUNCIÓN: UNIFICAR PROCESAMIENTO (Chunks + Estilos + Metadata)
// ============================================================================
async function unificarYProcesar(layerGroup, fileName) {
    const statusEl = document.getElementById('status');
    const allLayers = [];
    layerGroup.eachLayer(l => allLayers.push(l));

    const total = allLayers.length;
    let processed = 0;
    const chunkSize = 50;

    const processNextBatch = (start) => {
        const end = Math.min(start + chunkSize, total);
        
        for (let i = start; i < end; i++) {
            const layer = allLayers[i];
            const props = layer.feature?.properties || {};
            
// ... dentro de la función unificarYProcesar ...

            // 1. Extraer nombre/comentario principal
            const name = props.name || props.Name || props.ID || `Elemento ${i+1}`;
            
            // 2. GENERAR TABLA DE INFORMACIÓN TABULAR (Balloon)
            let tablaHTML = `<div style="min-width:250px;">
                                <h3 style="margin:0 0 10px 0; color:#2c3e50; border-bottom:2px solid #27ae60;">${name}</h3>
                                <table style="width:100%; border-collapse: collapse; font-size:12px;">`;
            
            for (const key in props) {
                // Saltamos propiedades que no queremos mostrar (metadatos internos)
                const skipKeys = ['name', 'Name', 'description', 'styleUrl', 'styleHash', 'id'];
                if (skipKeys.includes(key) || !props[key]) continue;
            
                // Formatear el nombre de la columna (ej: "NOM_LAYER" -> "Nom Layer")
                const label = key.replace(/_/g, ' ').toUpperCase();
                const value = props[key];
            
                // Si el valor es un link (como los de SharePoint de Pucobre)
                const displayValue = (typeof value === 'string' && value.startsWith('http')) 
                    ? `<a href="${value}" target="_blank" style="color:#2980b9; font-weight:bold;">Ver Documento 🔗</a>`
                    : value;
            
                tablaHTML += `<tr style="border-bottom: 1px solid #eee;">
                                <td style="padding:4px; font-weight:bold; color:#7f8c8d;">${label}</td>
                                <td style="padding:4px; color:#2c3e50;">${displayValue}</td>
                              </tr>`;
            }
            
            tablaHTML += `</table></div>`;
            
            // 3. Vincular el popup y asignar metadata
            layer.bindPopup(tablaHTML);
            
            layer.options.customMetadata = {
                comentario: `Predio: ${name}`,
                archivo: fileName
            };

            // 4. Metadata para Firebase
            layer.options.customMetadata = {
                comentario: `Importado: ${name}`,
                archivo: fileName
            };

            layer.bindPopup(`<b>${name}</b><br><small>Archivo: ${fileName}</small>`);
            localDrafts.addLayer(layer);
            processed++;
        }

        statusEl.textContent = `⏳ Cargando: ${Math.round((processed/total)*100)}%`;

        if (end < total) {
            setTimeout(() => processNextBatch(end), 10);
        } else {
            statusEl.textContent = `✅ ${total} elementos cargados de ${fileName}`;
            const bounds = localDrafts.getBounds();
            if (bounds.isValid()) map.fitBounds(bounds);
            actualizarBoton();
        }
    };

    processNextBatch(0);
}

// ============================================================================
// 5. GUARDAR EN FIREBASE
// ============================================================================
document.getElementById('saveBtn').onclick = async () => {
    const btn = document.getElementById('saveBtn');
    const statusEl = document.getElementById('status');
    const layers = localDrafts.getLayers();
    
    if (layers.length === 0) return;

    btn.disabled = true;
    statusEl.textContent = "💾 Guardando en nube...";

    let exitosos = 0;

    for (const layer of layers) {
        try {
            const geoJSON = layer.toGeoJSON();
            await addDoc(collection(db, `geometrias_${proyectoID}`), {
                feature: JSON.stringify(geoJSON),
                autor: userEmail,
                comentario: layer.options.customMetadata?.comentario || "Sin descripción",
                archivo: layer.options.customMetadata?.archivo || null,
                fecha: new Date().toLocaleString('es-CL'),
                timestamp: serverTimestamp()
            });
            localDrafts.removeLayer(layer);
            exitosos++;
        } catch (err) { console.error(err); }
    }

    statusEl.textContent = `✅ ${exitosos} elementos guardados correctamente`;
    actualizarBoton();
};

function actualizarBoton() {
    const total = localDrafts.getLayers().length;
    const btn = document.getElementById('saveBtn');
    btn.disabled = total === 0;
    btn.innerHTML = total > 0 ? `💾 Guardar (${total})` : `💾 Guardar Cambios`;
}

// ============================================================================
// 6. SINCRONIZACIÓN (NUBE -> MAPA)
// ============================================================================
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
    cloudLayers.clearLayers();
    snap.forEach(doc => {
        const data = doc.data();
        try {
            const layer = L.geoJSON(JSON.parse(data.feature), {
                style: { color: '#3498db', weight: 2, fillOpacity: 0.1 }
            });
            layer.bindPopup(`<b>${data.comentario}</b><br><small>👤 ${data.autor}</small>`);
            layer.addTo(cloudLayers);
        } catch (e) { console.error(e); }
    });
    document.getElementById('status').textContent = `📡 Nube: ${snap.size} elementos activos`;
});

// ============================================================================
// 7. INICIO
// ============================================================================
signInAnonymously(auth);
onAuthStateChanged(auth, (user) => { 
    if (user) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
});
actualizarBoton();
