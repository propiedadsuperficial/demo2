import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// 0. CONFIGURACIÓN
const urlParams = new URLSearchParams(window.location.search);
const proyectoID = urlParams.get('area') || 'general';
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

let userEmail = localStorage.getItem('pucobre_user') || prompt("Correo corporativo:");
if (userEmail && userEmail.includes('@')) {
    localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
} else {
    alert("Acceso denegado."); throw new Error("Sin auth");
}

// 1. MAPA
const map = L.map('map').setView([-27.366, -70.332], 14);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri — Pucobre'
}).addTo(map);

const localDrafts = L.featureGroup().addTo(map);
const docMap = new Map();
const gruposPorAutor = {};
let selectedLayer = null;

// TOC FLOTANTE A LA DERECHA
let layerControl = L.control.layers(null, null, { collapsed: false, position: 'topright' }).addTo(map);

// 2. PUNTERO DE SELECCIÓN (CYAN)
function seleccionarGeometria(e) {
    const layer = e.target;
    if (selectedLayer) {
        const esMioAnterior = selectedLayer.options.customMetadata?.autor === userEmail;
        selectedLayer.setStyle({ color: esMioAnterior ? '#27ae60' : '#3498db', weight: 2 });
    }
    selectedLayer = layer;
    layer.setStyle({ color: '#00ffff', weight: 4, fillOpacity: 0.4 });
    L.DomEvent.stopPropagation(e);
}

// 3. DIBUJO Y EDICIÓN
const drawControl = new L.Control.Draw({
    edit: { featureGroup: localDrafts, remove: true },
    draw: { marker: true, polyline: true, polygon: true, rectangle: true, circle: false, circlemarker: false }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    layer.options.customMetadata = { comentario: prompt("Nombre:") || "Nuevo", autor: userEmail };
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
            alert("No puedes borrar lo que no es tuyo.");
            location.reload();
        }
    });
    actualizarBoton();
});

// 4. NUBE
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
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
    document.getElementById('status').textContent = `Nube: ${snap.size} elementos`;
});

// 5. GUARDAR
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
        if (dbId) await updateDoc(doc(db, `geometrias_${proyectoID}`, dbId), payload);
        else await addDoc(collection(db, `geometrias_${proyectoID}`), payload);
    }
    actualizarBoton();
};

function actualizarBoton() {
    const n = localDrafts.getLayers().length;
    const btn = document.getElementById('saveBtn');
    btn.disabled = n === 0;
    btn.innerHTML = `💾 Guardar Cambios (${n})`;
}

// Carga KML (simplificada)
document.getElementById('kmlInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = (event) => {
        const layer = omnivore.kml.parse(event.target.result);
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
onAuthStateChanged(auth, (u) => { if(u) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`; });
