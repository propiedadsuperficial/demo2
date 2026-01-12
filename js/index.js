"Hola. Estoy desarrollando un GIS con Leaflet y Firebase. Tengo un problema: el sistema no visualiza los archivos KML al cargarlos, aunque el archivo es pequeño (menos de 100kb).

Mi configuración actual:

Uso leaflet-omnivore para parsear el KML.

Uso FileReader.readAsText para obtener el contenido.

El index.html ya tiene cargadas las librerías de Leaflet, Draw y Omnivore.

El problema: Al seleccionar el archivo, no se dispara el evento ready de omnivore o no se añaden las capas al featureGroup de localDrafts. No hay errores de consola claros sobre el KML, pero el mapa no hace zoom ni muestra los vértices.

Tu tarea: Analiza mi código index.js adjunto y dime:

¿Está bien implementada la función omnivore.kml.parse(kmlText)?

¿Hay algún conflicto entre las capas de dibujo y las de omnivore?

Genera el código corregido de la función de carga para que fuerce la visualización inmediata y haga un console.log de cada capa detectada."  index.js: // js/index.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
  authDomain: "gis-pucobre.firebaseapp.com",
  projectId: "gis-pucobre",
  storageBucket: "gis-pucobre.firebasestorage.app",
  messagingSenderId: "654550355942",
  appId: "1:654550355942:web:06a8bd8014a0faa86f5027",
  measurementId: "G-2CSXPQN2SC"
};

// 1. Manejo de Identidad
let userEmail = localStorage.getItem('pucobre_user') || prompt("Sesión GIS Pucobre. Ingrese su correo corporativo:")?.toLowerCase().trim();
if (!userEmail || !userEmail.includes('@')) window.location.reload();
localStorage.setItem('pucobre_user', userEmail);

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 2. Mapa e Inicialización
const map = L.map('map').setView([-27.366, -70.332], 14);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').addTo(map);

const cloudLayers = L.featureGroup().addTo(map);
const localDrafts = L.featureGroup().addTo(map);

// 3. Lógica para Cargar KML (FileReader + Omnivore)
document.getElementById('kmlInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const kmlText = event.target.result;
        
        // Usamos omnivore para parsear el texto directamente
        const runLayer = omnivore.kml.parse(kmlText);
        
        runLayer.on('ready', function() {
            this.eachLayer(layer => {
                // Aplicamos estilo de borrador (amarillo)
                if (layer.setStyle) layer.setStyle({ color: '#f1c40f', weight: 5 });
                layer.options.customMetadata = { comentario: `KML: ${file.name}` };
                localDrafts.addLayer(layer);
            });
            map.fitBounds(localDrafts.getBounds());
            actualizarBoton();
            document.getElementById('status').textContent = `✅ KML Listo: ${file.name}`;
        });
    };
    reader.readAsText(file);
});

// 4. Controles de Dibujo
const drawControl = new L.Control.Draw({
    edit: { featureGroup: localDrafts },
    draw: { circle: false, circlemarker: false, marker: true }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    const nota = prompt("Ingrese nota técnica:");
    if (nota !== null) {
        layer.options.customMetadata = { comentario: nota || "Sin comentario" };
        localDrafts.addLayer(layer);
        actualizarBoton();
    }
});

function actualizarBoton() {
    const total = localDrafts.getLayers().length;
    const btn = document.getElementById('saveBtn');
    btn.disabled = total === 0;
    btn.innerHTML = `💾 Guardar (${total})`;
}

// 5. Guardado en Firebase
document.getElementById('saveBtn').onclick = async () => {
    const btn = document.getElementById('saveBtn');
    const layers = localDrafts.getLayers();
    btn.disabled = true;

    for (const layer of layers) {
        try {
            const gjString = JSON.stringify(layer.toGeoJSON());
            await addDoc(collection(db, "geometrias"), {
                feature: gjString,
                autor: userEmail,
                comentario: layer.options.customMetadata?.comentario || "Importado",
                fecha: new Date().toLocaleString('es-CL'),
                timestamp: serverTimestamp()
            });
            localDrafts.removeLayer(layer);
        } catch (err) {
            console.error(err);
        }
    }
    btn.disabled = false;
    actualizarBoton();
};

// 6. Sincronización en Tiempo Real
onSnapshot(collection(db, "geometrias"), (snap) => {
    snap.docChanges().forEach(change => {
        const data = change.doc.data();
        if (change.type === "added") {
            const feat = typeof data.feature === 'string' ? JSON.parse(data.feature) : data.feature;
            L.geoJSON(feat, {
                style: { color: '#3498db', weight: 3 }
            }).bindPopup(`<b>${data.comentario}</b><br>${data.autor}`).addTo(cloudLayers);
        }
    });
    document.getElementById('status').textContent = `📡 Nube: ${snap.size}`;
});

signInAnonymously(auth);
onAuthStateChanged(auth, (user) => {
    if (user) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`;
});
