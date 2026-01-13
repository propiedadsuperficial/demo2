// js/index.js - VERSIÓN GIS PROFESIONAL (SELECCIÓN + EDICIÓN + BORRADO)
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

// Manejo de Identidad
let userEmail = localStorage.getItem('pucobre_user');
if (!userEmail || !userEmail.includes('@')) {
    userEmail = prompt("Ingrese correo corporativo:");
    if (userEmail && userEmail.includes('@')) {
        localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
    } else {
        alert("Acceso denegado."); throw new Error("Sin auth");
    }
}

// ============================================================================
// 1. INICIALIZACIÓN DEL MAPA
// ============================================================================
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri — Pucobre', maxZoom: 19
}).addTo(map);

const localDrafts = L.featureGroup().addTo(map); // Capas editables (propias)
const docMap = new Map(); // Leaflet ID -> Firebase ID
const gruposPorAutor = {}; // Para el TOC flotante
let selectedLayer = null; // Puntero de selección

// Control de Capas (TOC) - Flotante a la derecha
let layerControl = L.control.layers(null, null, { collapsed: false, position: 'topright' }).addTo(map);

// ============================================================================
// 2. HERRAMIENTAS DE DIBUJO Y EDICIÓN
// ============================================================================
const drawControl = new L.Control.Draw({
    edit: { 
        featureGroup: localDrafts, 
        remove: true 
    },
    draw: { marker: true, polyline: true, polygon: true, rectangle: true, circle: false, circlemarker: false }
});
map.addControl(drawControl);

// Evento: Selección (Puntero Cyan)
function seleccionarGeometria(e) {
    const layer = e.target;
    // Restaurar estilo de la anterior selección
    if (selectedLayer) {
        const esMio = selectedLayer.options.customMetadata?.autor === userEmail;
        selectedLayer.setStyle({ color: esMio ? '#27ae60' : '#3498db', weight: 2, fillOpacity: 0.2 });
    }
    // Aplicar Cyan a la nueva selección
    selectedLayer = layer;
    layer.setStyle({ color: '#00ffff', weight: 4, fillOpacity: 0.4 });
    L.DomEvent.stopPropagation(e);
}

// Evento: Nuevo Dibujo
map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    layer.options.customMetadata = { comentario: prompt("Nombre/Descripción:") || "Nuevo dibujo", autor: userEmail };
    layer.on('click', seleccionarGeometria);
    localDrafts.addLayer(layer);
    actualizarBoton();
});

// Evento: Edición de Vértices finalizada
map.on(L.Draw.Event.EDITED, () => {
    actualizarBoton();
});

// Evento: Borrado (Validación por Autor)
map.on(L.Draw.Event.DELETED, async (e) => {
    const layers = e.layers;
    let borrados = 0;
    layers.eachLayer(async (layer) => {
        const dbId = docMap.get(layer._leaflet_id);
        const autor = layer.options.customMetadata?.autor;
        if (dbId) {
            if (autor === userEmail) {
                try {
                    await deleteDoc(doc(db, `geometrias_${proyectoID}`, dbId));
                    borrados++;
                } catch (err) { console.error("Error al borrar:", err); }
            } else {
                alert(`No tienes permiso para borrar elementos de: ${autor}`);
                location.reload(); 
            }
        }
    });
    actualizarBoton();
});

// ============================================================================
// 3. SINCRONIZACIÓN FIREBASE Y TOC
// ============================================================================
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
    // Limpiar TOC actual
    for (let a in gruposPorAutor) {
        map.removeLayer(gruposPorAutor[a]);
        layerControl.removeLayer(gruposPorAutor[a]);
        delete gruposPorAutor[a];
    }

    snap.forEach(docSnap => {
        const data = docSnap.data();
        const autor = data.autor;
        
        if (!gruposPorAutor[autor]) {
            gruposPorAutor[autor] = L.featureGroup().addTo(map);
            const label = (autor === userEmail) ? `<b>⭐ MIS CAPAS (${snap.size})</b>` : `👤 ${autor}`;
            layerControl.addOverlay(gruposPorAutor[autor], label);
        }

        try {
            const geoJSON = JSON.parse(data.feature);
            const layerGroup = L.geoJSON(geoJSON, {
                style: { color: autor === userEmail ? '#27ae60' : '#3498db', weight: 2, fillOpacity: 0.2 }
            });

            layerGroup.eachLayer(l => {
                docMap.set(l._leaflet_id, docSnap.id);
                l.options.customMetadata = { autor: autor, dbId: docSnap.id, comentario: data.comentario };
                l.on('click', seleccionarGeometria);
                l.bindPopup(generarTablaPopup(data.comentario, autor, data.fecha, geoJSON.properties));
                
                l.addTo(gruposPorAutor[autor]);
                if (autor === userEmail) l.addTo(localDrafts);
            });
        } catch (e) { console.error("Error parseando feature:", e); }
    });
    document.getElementById('status').textContent = `📡 ÁREA: ${proyectoID.toUpperCase()} | Total: ${snap.size}`;
});

// ============================================================================
// 4. CARGA DE ARCHIVOS (REPARACIÓN KML + GEOJSON)
// ============================================================================
document.getElementById('kmlInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fileName = file.name.toLowerCase();
    const reader = new FileReader();

    reader.onload = async (event) => {
        const content = event.target.result;
        let layerToProcess;
        if (fileName.endsWith('.kml')) {
            const parser = new DOMParser();
            let kmlDOM = parser.parseFromString(content, 'text/xml');
            // Parche xsi ArcMap
            if (kmlDOM.querySelector('parsererror')?.textContent.includes('xsi')) {
                const fixed = content.replace(/<Document(\s+)/i, '<Document xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"$1');
                kmlDOM = parser.parseFromString(fixed, 'text/xml');
            }
            layerToProcess = omnivore.kml.parse(kmlDOM);
            layerToProcess.on('ready', () => unificarYProcesar(layerToProcess, file.name));
        } else {
            layerToProcess = L.geoJSON(JSON.parse(content));
            unificarYProcesar(layerToProcess, file.name);
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

function unificarYProcesar(lg, fn) {
    lg.eachLayer(l => {
        const props = l.feature?.properties || {};
        const name = props.name || props.Name || "Importado";
        l.options.customMetadata = { comentario: name, archivo: fn, autor: userEmail };
        l.on('click', seleccionarGeometria);
        l.addTo(localDrafts);
    });
    map.fitBounds(localDrafts.getBounds());
    actualizarBoton();
}

// ============================================================================
// 5. GUARDAR / ACTUALIZAR EN NUBE
// ============================================================================
document.getElementById('saveBtn').onclick = async () => {
    const layers = localDrafts.getLayers();
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;

    for (const layer of layers) {
        const dbId = docMap.get(layer._leaflet_id);
        const dataPayload = {
            feature: JSON.stringify(layer.toGeoJSON()),
            autor: userEmail,
            comentario: layer.options.customMetadata?.comentario || "Sin nombre",
            fecha: new Date().toLocaleString('es-CL'),
            timestamp: serverTimestamp()
        };

        try {
            if (dbId) {
                // ACTUALIZAR EXISTENTE
                await updateDoc(doc(db, `geometrias_${proyectoID}`, dbId), dataPayload);
            } else {
                // CREAR NUEVO
                await addDoc(collection(db, `geometrias_${proyectoID}`), dataPayload);
            }
        } catch (e) { console.error("Error guardando:", e); }
    }
    actualizarBoton();
};

// ============================================================================
// UTILIDADES
// ============================================================================
function generarTablaPopup(titulo, autor, fecha, props) {
    let html = `<div style="min-width:200px"><b>${titulo}</b><br><small>👤 ${autor}</small><hr><table style="width:100%; font-size:11px">`;
    for (let k in props) {
        if (['name','Name','styleUrl','styleHash'].includes(k) || !props[k]) continue;
        html += `<tr><td><b>${k.toUpperCase()}</b></td><td>${props[k]}</td></tr>`;
    }
    return html + `</table></div>`;
}

function actualizarBoton() {
    const n = localDrafts.getLayers().length;
    const btn = document.getElementById('saveBtn');
    btn.disabled = n === 0;
    btn.innerHTML = `💾 Guardar Cambios (${n})`;
}

signInAnonymously(auth);
onAuthStateChanged(auth, (u) => { if(u) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`; });
