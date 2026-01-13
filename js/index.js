// js/index.js - GIS PUCOBRE - VERSIÓN OPTIMIZADA
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// ============================================================================
// 0. CONFIGURACIÓN Y PARÁMETROS URL
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

// Autenticación de usuario
let userEmail = localStorage.getItem('pucobre_user') || prompt("Correo corporativo:");
if (userEmail && userEmail.includes('@')) {
    localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
} else {
    alert("Acceso denegado."); 
    throw new Error("Sin auth");
}

// ============================================================================
// 1. INICIALIZACIÓN DEL MAPA
// ============================================================================
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri — Pucobre',
    maxZoom: 19
}).addTo(map);

const localDrafts = L.featureGroup().addTo(map);
const docMap = new Map();
const gruposPorAutor = {};
let selectedLayer = null;

const layerControl = L.control.layers(null, null, { 
    collapsed: false, 
    position: 'topright' 
}).addTo(map);

// ============================================================================
// 2. FUNCIÓN DE SELECCIÓN (RESALTADO CYAN)
// ============================================================================
function seleccionarGeometria(e) {
    const layer = e.target;
    
    // Desmarcar capa anterior
    if (selectedLayer) {
        const esMio = selectedLayer.options.customMetadata?.autor === userEmail;
        selectedLayer.setStyle({ 
            color: esMio ? '#27ae60' : '#3498db', 
            weight: 2,
            fillOpacity: 0.15 
        });
    }
    
    // Marcar nueva capa
    selectedLayer = layer;
    layer.setStyle({ 
        color: '#00ffff', 
        weight: 4, 
        fillOpacity: 0.4 
    });
    
    L.DomEvent.stopPropagation(e);
}

// ============================================================================
// 3. HERRAMIENTAS DE DIBUJO Y EDICIÓN
// ============================================================================
const drawControl = new L.Control.Draw({
    edit: { 
        featureGroup: localDrafts, 
        remove: true 
    },
    draw: { 
        circle: false, 
        circlemarker: false 
    }
});
map.addControl(drawControl);

// Crear nueva geometría
map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    const nombre = prompt("Nombre/Descripción:");
    
    if (nombre) {
        layer.options.customMetadata = { 
            comentario: nombre, 
            autor: userEmail 
        };
        layer.on('click', seleccionarGeometria);
        localDrafts.addLayer(layer);
        actualizarBoton();
    }
});

// Editar geometría existente
map.on(L.Draw.Event.EDITED, () => {
    actualizarBoton();
});

// Borrar geometría con validación
map.on(L.Draw.Event.DELETED, async (e) => {
    e.layers.eachLayer(async (layer) => {
        const dbId = docMap.get(layer._leaflet_id);
        const autor = layer.options.customMetadata?.autor;
        
        if (dbId && autor === userEmail) {
            try {
                await deleteDoc(doc(db, `geometrias_${proyectoID}`, dbId));
            } catch (err) {
                console.error('Error al borrar:', err);
                alert('Error al eliminar de Firebase');
            }
        } else if (dbId) {
            alert("⛔ No puedes borrar capas de otros autores.");
            location.reload();
        }
    });
    actualizarBoton();
});

// ============================================================================
// 4. SINCRONIZACIÓN CON FIREBASE
// ============================================================================
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
    // Limpiar capas existentes
    for (let autor in gruposPorAutor) {
        map.removeLayer(gruposPorAutor[autor]);
        layerControl.removeLayer(gruposPorAutor[autor]);
        delete gruposPorAutor[autor];
    }
    
    // Reconstruir capas desde Firebase
    snap.forEach(d => {
        const data = d.data();
        const autor = data.autor;
        
        // Crear grupo por autor si no existe
        if (!gruposPorAutor[autor]) {
            gruposPorAutor[autor] = L.featureGroup().addTo(map);
            const label = (autor === userEmail) 
                ? `⭐ MIS CAPAS (${snap.size})` 
                : `👤 ${autor}`;
            layerControl.addOverlay(gruposPorAutor[autor], label);
        }
        
        // Parsear y agregar geometría
        const geoJSON = JSON.parse(data.feature);
        const lg = L.geoJSON(geoJSON, {
            style: { 
                color: autor === userEmail ? '#27ae60' : '#3498db', 
                weight: 2, 
                fillOpacity: 0.15 
            }
        });
        
        lg.eachLayer(l => {
            docMap.set(l._leaflet_id, d.id);
            l.options.customMetadata = { autor: autor, dbId: d.id };
            l.on('click', seleccionarGeometria);
            l.bindPopup(`
                <div style="min-width:200px">
                    <h4 style="margin:0 0 8px 0;color:#27ae60">${data.comentario}</h4>
                    <hr style="margin:8px 0;border:none;border-top:1px solid #ddd">
                    <div style="font-size:12px;color:#666">
                        <strong>👤 Autor:</strong> ${autor}<br>
                        <strong>📅 Fecha:</strong> ${data.fecha || 'N/A'}
                    </div>
                </div>
            `);
            l.addTo(gruposPorAutor[autor]);
            
            // Agregar a localDrafts solo si es del usuario actual
            if (autor === userEmail) {
                l.addTo(localDrafts);
            }
        });
    });
    
    // Actualizar status
    document.getElementById('status').textContent = 
        `📍 ÁREA: ${proyectoID.toUpperCase()} | ☁️ Total: ${snap.size} capas`;
});

// ============================================================================
// 5. GUARDAR/ACTUALIZAR EN FIREBASE
// ============================================================================
document.getElementById('saveBtn').onclick = async () => {
    const layers = localDrafts.getLayers();
    if (layers.length === 0) return;
    
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.innerHTML = '⏳ Guardando...';
    
    try {
        for (const layer of layers) {
            const dbId = docMap.get(layer._leaflet_id);
            const payload = {
                feature: JSON.stringify(layer.toGeoJSON()),
                autor: userEmail,
                comentario: layer.options.customMetadata?.comentario || "Sin nombre",
                fecha: new Date().toLocaleString('es-CL'),
                timestamp: serverTimestamp()
            };
            
            if (dbId) {
                // Actualizar existente
                await updateDoc(doc(db, `geometrias_${proyectoID}`, dbId), payload);
            } else {
                // Crear nuevo
                await addDoc(collection(db, `geometrias_${proyectoID}`), payload);
            }
        }
        
        document.getElementById('status').textContent = '✅ Guardado exitoso';
        setTimeout(() => actualizarBoton(), 1500);
        
    } catch (error) {
        console.error('Error al guardar:', error);
        alert('❌ Error al guardar en Firebase');
        btn.disabled = false;
        actualizarBoton();
    }
};

function actualizarBoton() {
    const n = localDrafts.getLayers().length;
    const btn = document.getElementById('saveBtn');
    btn.disabled = n === 0;
    btn.innerHTML = n > 0 ? `💾 Guardar Cambios (${n})` : `💾 Guardar Cambios`;
}

// ============================================================================
// 6. CARGA DE KML / GEOJSON
// ============================================================================
document.getElementById('kmlInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    document.getElementById('status').textContent = `📂 Cargando ${file.name}...`;
    const reader = new FileReader();
    
    reader.onload = (event) => {
        try {
            const content = event.target.result;
            const fileName = file.name.toLowerCase();
            
            if (fileName.endsWith('.kml')) {
                // Procesar KML con reparación de namespace
                let kmlContent = content;
                if (kmlContent.includes('xsi:')) {
                    kmlContent = kmlContent.replace(
                        /<Document(\s+)/i, 
                        '<Document xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"$1'
                    );
                }
                
                const layer = omnivore.kml.parse(kmlContent);
                layer.on('ready', () => {
                    procesarCapasImportadas(layer, file.name);
                });
                
            } else if (fileName.endsWith('.geojson') || fileName.endsWith('.json')) {
                // Procesar GeoJSON
                const geoData = JSON.parse(content);
                const layer = L.geoJSON(geoData);
                procesarCapasImportadas(layer, file.name);
            }
            
        } catch (error) {
            console.error('Error al cargar archivo:', error);
            alert('❌ Error al procesar el archivo. Verifica el formato.');
            document.getElementById('status').textContent = '❌ Error en carga';
        }
    };
    
    reader.readAsText(file);
    e.target.value = ''; // Limpiar input
});

function procesarCapasImportadas(layerGroup, fileName) {
    let contador = 0;
    
    layerGroup.eachLayer(l => {
        const props = l.feature?.properties || {};
        const nombre = props.name || props.Name || props.description || `Capa ${++contador}`;
        
        l.options.customMetadata = { 
            comentario: nombre, 
            autor: userEmail,
            archivo: fileName
        };
        
        l.on('click', seleccionarGeometria);
        
        // Aplicar estilo
        if (l instanceof L.Path) {
            l.setStyle({ 
                color: '#27ae60', 
                weight: 2, 
                fillOpacity: 0.2 
            });
        }
        
        localDrafts.addLayer(l);
    });
    
    // Ajustar vista al contenido
    if (localDrafts.getLayers().length > 0) {
        map.fitBounds(localDrafts.getBounds());
    }
    
    document.getElementById('status').textContent = `✅ ${contador} capas importadas`;
    actualizarBoton();
}

// ============================================================================
// 7. AUTENTICACIÓN FIREBASE
// ============================================================================
signInAnonymously(auth);
onAuthStateChanged(auth, (user) => { 
    if (user) {
        document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
    }
});
