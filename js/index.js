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

// 1. Manejo de Identidad (Persistente)
let userEmail = localStorage.getItem('pucobre_user');
if (!userEmail) {
    userEmail = prompt("Sesión GIS Pucobre. Ingrese su correo corporativo:");
    if (!userEmail || !userEmail.includes('@')) {
        window.location.reload();
    } else {
        localStorage.setItem('pucobre_user', userEmail.toLowerCase().trim());
    }
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 2. Inicialización del Mapa
const map = L.map('map').setView([-27.366, -70.332], 14);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

// 3. Controles de Dibujo (Habilitados para Polígonos y Líneas)
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

// 4. Captura de Dibujo y Comentario Técnico
map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    const nota = prompt(`Ingrese nota técnica para este ${e.layerType}:`);
    
    if (nota !== null) {
        // Almacenamos la nota dentro del objeto layer
        layer.options.customMetadata = { comentario: nota || "Sin comentario" };
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

// 5. Función de Guardado Universal (Soporta todas las formas)
document.getElementById('saveBtn').onclick = async () => {
    const btn = document.getElementById('saveBtn');
    const layers = localDrafts.getLayers();
    btn.disabled = true;
    btn.innerHTML = "⌛ Sincronizando...";

    for (const layer of layers) {
        try {
            await addDoc(collection(db, "geometrias"), {
                feature: layer.toGeoJSON(), // Captura puntos, líneas y polígonos
                autor: userEmail,
                comentario: layer.options.customMetadata?.comentario || "Sin nota",
                fecha: new Date().toLocaleString('es-CL'),
                timestamp: serverTimestamp()
            });
            localDrafts.removeLayer(layer);
        } catch (err) {
            console.error("Error al guardar:", err);
        }
    }
    actualizarBoton();
};

// 6. Carga de Datos en Tiempo Real
onSnapshot(collection(db, "geometrias"), (snap) => {
    cloudLayers.clearLayers();
    snap.forEach(docSnap => {
        const data = docSnap.data();
        L.geoJSON(data.feature, {
            style: { color: '#3498db', weight: 3, fillOpacity: 0.2 },
            pointToLayer: (f, latlng) => L.marker(latlng)
        }).bindPopup(`
            <div style="font-family: sans-serif;">
                <strong>Nota Técnica:</strong><br>${data.comentario}<br>
                <hr style="margin: 5px 0;">
                <small>Responsable: ${data.autor}</small>
            </div>
        `).addTo(cloudLayers);
    });
    document.getElementById('status').innerHTML = `📡 Conectado | Nube: ${snap.size}`;
});

// 7. Autenticación para evitar error de permisos
signInAnonymously(auth);
onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('userInfo').innerHTML = `<span class="badge-user">👤 ${userEmail}</span>`;
    }
});
