import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

const firebaseConfig = {
    apiKey: "AIzaSyB3kW9ep7iOKDp87i2-er5-CuZKerA4puY",
    authDomain: "gis-pucobre.firebaseapp.com",
    projectId: "gis-pucobre",
    storageBucket: "gis-pucobre.appspot.com",
    messagingSenderId: "654550355942",
    appId: "1:654550355942:web:06a8bd8614a0faa86f5027"
};

// 1. Manejo de Usuario (Prompt Obligatorio)
let userEmail = localStorage.getItem('pucobre_user');
if (!userEmail) {
    userEmail = prompt("Sesión GIS Pucobre. Ingrese su correo:");
    if (!userEmail || !userEmail.includes('@')) window.location.reload();
    else localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 2. Configuración del Mapa
const map = L.map('map').setView([-27.366, -70.332], 14);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

// 3. Herramientas de Dibujo
const drawControl = new L.Control.Draw({
    edit: { featureGroup: localDrafts },
    draw: { 
        circle: false, circlemarker: false,
        polyline: { shapeOptions: { color: '#f1c40f', weight: 4 } },
        polygon: { shapeOptions: { color: '#f1c40f', fillOpacity: 0.3 } },
        marker: true 
    }
});
map.addControl(drawControl);

// 4. Captura de Dibujos y Comentarios Técnicos
map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    const nota = prompt(`Nota técnica para este ${e.layerType}:`);
    
    if (nota !== null) {
        // CORRECCIÓN: Guardamos la nota dentro de la capa para que no se pierda al procesar
        layer.options.customMetadata = {
            comentario: nota || "Sin comentario",
            tipo: e.layerType
        };
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

// 5. Guardado Masivo (Puntos, Líneas y Polígonos)
document.getElementById('saveBtn').onclick = async () => {
    const btn = document.getElementById('saveBtn');
    const layers = localDrafts.getLayers();
    btn.disabled = true;
    btn.innerHTML = "⌛ Sincronizando...";

    for (const layer of layers) {
        try {
            await addDoc(collection(db, "geometrias"), {
                feature: layer.toGeoJSON(), // Convierte cualquier forma a JSON
                autor: userEmail,
                comentario: layer.options.customMetadata.comentario,
                fecha: new Date().toLocaleString('es-CL'),
                timestamp: serverTimestamp()
            });
            localDrafts.removeLayer(layer);
        } catch (err) { console.error("Error:", err); }
    }
    actualizarBoton();
};

// 6. Lectura en Tiempo Real
onSnapshot(collection(db, "geometrias"), (snap) => {
    cloudLayers.clearLayers();
    snap.forEach(doc => {
        const data = doc.data();
        L.geoJSON(data.feature, {
            style: { color: '#3498db', weight: 3, fillOpacity: 0.2 },
            pointToLayer: (f, latlng) => L.marker(latlng)
        }).bindPopup(`
            <strong>Nota:</strong> ${data.comentario}<br>
            <hr>
            <small>Responsable: ${data.autor}</small>
        `).addTo(cloudLayers);
    });
    document.getElementById('status').innerHTML = `📡 Nube: ${snap.size} objetos`;
});

// Autenticación para evitar el "Permission Denied" de tus fotos
signInAnonymously(auth);
onAuthStateChanged(auth, (user) => {
    if(user) document.getElementById('userInfo').innerHTML = `<span class="badge-user">👤 ${userEmail}</span>`;
});
