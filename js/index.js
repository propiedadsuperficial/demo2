import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

// Configuración Firebase
const firebaseConfig = {
    apiKey: "AIzaSyB3kW9ep7iOKDp87i2-er5-CuZKerA4puY",
    authDomain: "gis-pucobre.firebaseapp.com",
    projectId: "gis-pucobre",
    storageBucket: "gis-pucobre.appspot.com",
    messagingSenderId: "654550355942",
    appId: "1:654550355942:web:06a8bd8614a0faa86f5027"
};

// Validación de Usuario
let userEmail = localStorage.getItem('pucobre_user');
if (!userEmail) {
    userEmail = prompt("Sesión GIS Pucobre. Ingrese su correo:");
    if (!userEmail || !userEmail.includes('@')) {
        window.location.reload();
    } else {
        localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
    }
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Inicializar Mapa
const map = L.map('map').setView([-27.366, -70.332], 14);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

// Herramientas de Dibujo
const drawControl = new L.Control.Draw({
    edit: { featureGroup: localDrafts },
    draw: { 
        circle: false, circlemarker: false,
        polyline: { shapeOptions: { color: '#f1c40f', weight: 5 } },
        polygon: { shapeOptions: { color: '#f1c40f', fillOpacity: 0.4 } },
        marker: true 
    }
});
map.addControl(drawControl);

// Evento: Al terminar de dibujar
map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    const nota = prompt(`Ingrese comentario para este ${e.layerType}:`);
    if (nota !== null) {
        layer.options.comentario = nota || "Sin comentario"; // Guardar nota en la capa
        localDrafts.addLayer(layer);
        actualizarBoton();
    }
});

function actualizarBoton() {
    const cant = localDrafts.getLayers().length;
    const btn = document.getElementById('saveBtn');
    btn.disabled = cant === 0;
    btn.innerHTML = cant > 0 ? `💾 Guardar (${cant})` : `💾 Guardar Cambios`;
}

// Guardar en la Nube (Polígonos, Líneas y Puntos)
document.getElementById('saveBtn').onclick = async () => {
    const layers = localDrafts.getLayers();
    document.getElementById('saveBtn').disabled = true;

    for (const layer of layers) {
        await addDoc(collection(db, "geometrias"), {
            feature: layer.toGeoJSON(),
            autor: userEmail,
            comentario: layer.options.comentario,
            fecha: new Date().toLocaleString('es-CL'),
            timestamp: serverTimestamp()
        });
        localDrafts.removeLayer(layer);
    }
    actualizarBoton();
    alert("Sincronización terminada.");
};

// Cargar desde Nube
onSnapshot(collection(db, "geometrias"), (snap) => {
    cloudLayers.clearLayers();
    snap.forEach(d => {
        const data = d.data();
        L.geoJSON(data.feature, {
            style: { color: '#3498db', weight: 3 }
        }).bindPopup(`<b>Nota:</b> ${data.comentario}<br><small>Por: ${data.autor}</small>`).addTo(cloudLayers);
    });
    document.getElementById('status').innerHTML = `📡 Nube: ${snap.size} objetos`;
});

// Auth
signInAnonymously(auth);
onAuthStateChanged(auth, (u) => {
    if(u) document.getElementById('userInfo').innerHTML = `<span class="badge-user">👤 ${userEmail}</span>`;
});
