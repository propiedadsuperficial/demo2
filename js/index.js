import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// ============================================================================
// 1. CAPTURA DE PARÁMETROS URL (LÍNEA RECUPERADA)
// ============================================================================
const urlParams = new URLSearchParams(window.location.search);
const proyectoID = urlParams.get('area') || 'general';
const latInicial = parseFloat(urlParams.get('lat')) || -27.366;
const lngInicial = parseFloat(urlParams.get('lng')) || -70.332;
const zoomInicial = parseInt(urlParams.get('zoom')) || 14;

// ============================================================================
// 2. CONFIGURACIÓN FIREBASE E IDENTIDAD
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

let userEmail = localStorage.getItem('pucobre_user') || prompt("Ingrese correo Pucobre:");
if (userEmail && userEmail.includes('@')) {
    localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
} else {
    alert("Acceso denegado."); throw new Error("Sin auth");
}

// ============================================================================
// 3. INICIALIZACIÓN DEL MAPA (CON PARÁMETROS DINÁMICOS)
// ============================================================================
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri — Pucobre'
}).addTo(map);

const localDrafts = L.featureGroup().addTo(map); 
const docMap = new Map(); 
const gruposPorAutor = {}; 
let selectedLayer = null; // Puntero de selección Cyan

// TOC Flotante a la derecha (Como en tus capturas)
let layerControl = L.control.layers(null, null, { collapsed: false, position: 'topright' }).addTo(map);

// ============================================================================
// 4. LÓGICA DE SELECCIÓN (PUNTERO CYAN)
// ============================================================================
function seleccionarGeometria(e) {
    const layer = e.target;
    
    // Restaurar color del anterior
    if (selectedLayer) {
        const esMio = selectedLayer.options.customMetadata?.autor === userEmail;
        selectedLayer.setStyle({ color: esMio ? '#27ae60' : '#3498db', weight: 2 });
    }

    // Aplicar CYAN al seleccionado
    selectedLayer = layer;
    layer.setStyle({ color: '#00ffff', weight: 4, fillOpacity: 0.4 });
    
    // Evitar que el click se propague al mapa
    L.DomEvent.stopPropagation(e);
}

// ============================================================================
// 5. HERRAMIENTAS DE EDICIÓN Y DIBUJO
// ============================================================================
const drawControl = new L.Control.Draw({
    edit: { featureGroup: localDrafts, remove: true },
    draw: { marker: true, polyline: true, polygon: true, rectangle: true, circle: false, circlemarker: false }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    layer.options.customMetadata = { comentario: prompt("Descripción del objeto:") || "Nuevo", autor: userEmail };
    layer.on('click', seleccionarGeometria);
    localDrafts.addLayer(layer);
    actualizarBoton();
});

map.on(L.Draw.Event.EDITED, () => actualizarBoton());

map.on(L.Draw.Event.DELETED, async (e) => {
    e.layers.eachLayer(async (layer) => {
        const dbId = docMap.get(layer._leaflet_id);
        const autor = layer.options.customMetadata?.autor;
        if (dbId && autor === userEmail) {
            await deleteDoc(doc(db, `geometrias_${proyectoID}`, dbId));
        } else if (dbId) {
            alert("No tienes permiso para borrar elementos ajenos.");
            location.reload(); 
        }
    });
    actualizarBoton();
});

// ============================================================================
// 6. SINCRONIZACIÓN FIREBASE
// ============================================================================
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
    // Limpieza de TOC
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
            const label = (autor === userEmail) ? `⭐ MIS CAPAS (${snap.size})` : `👤 ${autor}`;
            layerControl.addOverlay(gruposPorAutor[autor], label);
        }

        const geoJSON = JSON.parse(data.feature);
        const lg = L.geoJSON(geoJSON, {
            style: { color: autor === userEmail ? '#27ae60' : '#3498db', weight: 2, fillOpacity: 0.2 }
        });

        lg.eachLayer(l => {
            docMap.set(l._leaflet_id, docSnap.id);
            l.options.customMetadata = { autor: autor, dbId: docSnap.id };
            l.on('click', seleccionarGeometria);
            l.bindPopup(`<b>${data.comentario}</b><br>Autor: ${autor}`);
            l.addTo(gruposPorAutor[autor]);
            if (autor === userEmail) l.addTo(localDrafts); 
        });
    });
    
    // Actualizar indicador de área en el toolbar
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.innerHTML = `📍 ÁREA: ${proyectoID.toUpperCase()} | ☁️ Nube: ${snap.size}`;
});

// ============================================================================
// 7. GUARDAR CAMBIOS (NUEVOS Y EDITADOS)
// ============================================================================
document.getElementById('saveBtn').onclick = async () => {
    const layers = localDrafts.getLayers();
    document.getElementById('saveBtn').disabled = true;

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
            await updateDoc(doc(db, `geometrias_${proyectoID}`, dbId), payload);
        } else {
            await addDoc(collection(db, `geometrias_${proyectoID}`), payload);
        }
    }
    actualizarBoton();
};

function actualizarBoton() {
    const n = localDrafts.getLayers().length;
    const btn = document.getElementById('saveBtn');
    if (btn) {
        btn.disabled = n === 0;
        btn.innerHTML = `💾 Guardar Cambios (${n})`;
    }
}

// Carga KML (Con auto-reparación xsi de ArcMap)
document.getElementById('kmlInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = (event) => {
        let content = event.target.result;
        if (content.includes('xsi')) {
             content = content.replace(/<Document(\s+)/i, '<Document xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"$1');
        }
        const layer = omnivore.kml.parse(content);
        layer.on('ready', () => {
            layer.eachLayer(l => {
                l.options.customMetadata = { autor: userEmail, comentario: file.name };
                l.on('click', seleccionarGeometria);
                localDrafts.addLayer(l);
            });
            map.fitBounds(localDrafts.getBounds());
            actualizarBoton();
        });
    };
    reader.readAsText(file);
});

signInAnonymously(auth);
onAuthStateChanged(auth, (u) => { 
    if(u) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`; 
});
