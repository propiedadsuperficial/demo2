// js/index.js - VERSIÓN "GIS PROFESIONAL" (TOC + TABULAR + BORRADO POR AUTOR)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';
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
// 1. INICIALIZACIÓN DE MAPA Y TOC
// ============================================================================
const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri — Pucobre', maxZoom: 19
}).addTo(map);

// Grupos de capas
const localDrafts = L.featureGroup().addTo(map); // Capas en edición (propias)
const docMap = new Map(); // Vincula ID Leaflet -> ID Firebase
const gruposPorAutor = {}; // TOC Dinámico

// Control de Capas (TOC) - Estilo GIS Profesional
let layerControl = L.control.layers(null, null, { collapsed: false }).addTo(map);

// ============================================================================
// 2. HERRAMIENTAS DE DIBUJO Y BORRADO
// ============================================================================
const drawControl = new L.Control.Draw({
    edit: { featureGroup: localDrafts, remove: true },
    draw: { circle: false, circlemarker: false }
});
map.addControl(drawControl);

// Crear nuevo dibujo
map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    layer.options.customMetadata = { comentario: prompt("Nombre/Descripción:") || "Dibujo manual" };
    localDrafts.addLayer(layer);
    actualizarBoton();
});

// Borrado con validación de Autor
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
                } catch (err) { console.error("Error Firebase:", err); }
            } else {
                alert(`No tienes permiso. Autor: ${autor}`);
                location.reload(); // Revertir visualmente
            }
        }
    });
    if(borrados > 0) document.getElementById('status').textContent = `🗑️ ${borrados} eliminados`;
});

// ============================================================================
// 3. PROCESAMIENTO KML / GEOJSON
// ============================================================================
document.getElementById('kmlInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fileName = file.name.toLowerCase();
    const reader = new FileReader();
    document.getElementById('status').textContent = `📂 Leyendo ${file.name}...`;

    reader.onload = async (event) => {
        try {
            const content = event.target.result;
            let layerToProcess;

            if (fileName.endsWith('.kml')) {
                const parser = new DOMParser();
                let kmlDOM = parser.parseFromString(content, 'text/xml');
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
        } catch (err) { console.error(err); }
    };
    reader.readAsText(file);
    e.target.value = '';
});

async function unificarYProcesar(layerGroup, fileName) {
    const all = [];
    layerGroup.eachLayer(l => all.push(l));
    
    for (let i = 0; i < all.length; i++) {
        const layer = all[i];
        const props = layer.feature?.properties || {};
        const name = props.name || props.Name || `Elemento ${i+1}`;
        
        layer.options.customMetadata = { comentario: name, archivo: fileName, autor: userEmail };
        layer.bindPopup(generarTablaPopup(name, userEmail, "Recién cargado", props));
        
        if (layer instanceof L.Path) layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2 });
        localDrafts.addLayer(layer);
    }
    map.fitBounds(localDrafts.getBounds());
    actualizarBoton();
}

// ============================================================================
// 4. SINCRONIZACIÓN Y TOC PROFESIONAL
// ============================================================================
onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
    // Limpiar TOC y capas de nube
    for (let a in gruposPorAutor) {
        map.removeLayer(gruposPorAutor[a]);
        layerControl.removeLayer(gruposPorAutor[a]);
        delete gruposPorAutor[a];
    }

    const dataByAutor = {};
    snap.forEach(d => {
        const data = d.data();
        if (!dataByAutor[data.autor]) dataByAutor[data.autor] = [];
        dataByAutor[data.autor].push({ id: d.id, ...data });
    });

    for (const autor in dataByAutor) {
        const grupo = L.featureGroup();
        const esMio = (autor === userEmail);
        const label = esMio ? `<b>⭐ MIS CAPAS (${dataByAutor[autor].length})</b>` : `👤 ${autor} (${dataByAutor[autor].length})`;

        dataByAutor[autor].forEach(item => {
            const geoJSON = JSON.parse(item.feature);
            const layer = L.geoJSON(geoJSON, {
                style: { color: esMio ? '#27ae60' : '#3498db', weight: 2, fillOpacity: 0.15 }
            });

            layer.eachLayer(l => {
                docMap.set(l._leaflet_id, item.id);
                l.options.customMetadata = { autor: autor };
                l.bindPopup(generarTablaPopup(item.comentario, autor, item.fecha, geoJSON.properties));
                l.addTo(grupo);
            });
        });

        gruposPorAutor[autor] = grupo;
        grupo.addTo(map);
        layerControl.addOverlay(grupo, label);
    }
    document.getElementById('status').textContent = `📡 ÁREA: ${proyectoID.toUpperCase()} | Total: ${snap.size}`;
});

// ============================================================================
// 5. UTILIDADES (TABLA Y BOTONES)
// ============================================================================
function generarTablaPopup(titulo, autor, fecha, props) {
    let html = `<div style="min-width:230px"><h4 style="margin:0;color:#27ae60">${titulo}</h4>`;
    html += `<small style="color:gray">👤 ${autor} | 📅 ${fecha}</small><hr><table style="width:100%;font-size:11px">`;
    for (let k in props) {
        if (['name','Name','description','styleUrl','styleHash'].includes(k) || !props[k]) continue;
        const val = props[k];
        const disp = (typeof val === 'string' && val.startsWith('http')) ? `<a href="${val}" target="_blank">Link 🔗</a>` : val;
        html += `<tr style="border-bottom:1px solid #eee"><td><b>${k.toUpperCase()}</b></td><td>${disp}</td></tr>`;
    }
    return html + `</table></div>`;
}

document.getElementById('saveBtn').onclick = async () => {
    const layers = localDrafts.getLayers();
    if (layers.length === 0) return;
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;

    for (const layer of layers) {
        if (docMap.has(layer._leaflet_id)) continue; // Evitar duplicar si ya existe en nube
        try {
            await addDoc(collection(db, `geometrias_${proyectoID}`), {
                feature: JSON.stringify(layer.toGeoJSON()),
                autor: userEmail,
                comentario: layer.options.customMetadata?.comentario || "Sin nombre",
                archivo: layer.options.customMetadata?.archivo || "Web",
                fecha: new Date().toLocaleString('es-CL'),
                timestamp: serverTimestamp()
            });
            localDrafts.removeLayer(layer);
        } catch (e) { console.error(e); }
    }
    actualizarBoton();
};

function actualizarBoton() {
    // Contamos solo lo que está en el grupo de borradores locales
    const n = localDrafts.getLayers().length;
    const btn = document.getElementById('saveBtn');
    
    btn.disabled = n === 0;
    // Si hay 0, mostramos texto estándar; si hay más, mostramos la cuenta
    btn.innerHTML = n > 0 ? `💾 Guardar ${n} nuevos` : `💾 Guardar Cambios`;
}

// Inicio Auth
signInAnonymously(auth);
onAuthStateChanged(auth, (u) => { if(u) document.getElementById('userInfo').innerHTML = `👤 ${userEmail}`; });
