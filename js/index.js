
// js/index.js — Versión estable con pendientes por FID + guardado idempotente
// Mantiene: parámetros URL, Leaflet/Draw/Omnivore, TOC por autor y prompt de título.

(() => {
  // Evitar doble inicialización si el archivo se carga 2 veces
  if (window.__GIS_APP_INIT__) {
    console.warn('index.js ya inicializado, se omite segunda carga.');
    return;
  }
  window.__GIS_APP_INIT__ = true;

  // ============================================================================
  // 0) CONFIG + PARÁMETROS URL (se conservan tal cual)
  // ============================================================================
  const urlParams  = new URLSearchParams(window.location.search);
  const proyectoID = urlParams.get('area') ?? 'general';
  const latInicial = parseFloat(urlParams.get('lat'))  ?? -27.366;
  const lngInicial = parseFloat(urlParams.get('lng'))  ?? -70.332;
  const zoomInicial= parseInt(urlParams.get('zoom'))   ?? 14;

  const firebaseConfig = {
    apiKey: "AIzaSyB3kW9ep7iOKDp87T2-er5-CuZKerA4puY",
    authDomain: "gis-pucobre.firebaseapp.com",
    projectId: "gis-pucobre",
    storageBucket: "gis-pucobre.firebasestorage.app",
    messagingSenderId: "654550355942",
    appId: "1:654550355942:web:06a8bd8014a0faa86f5027"
  };

  // Firebase
  const app  = initializeApp(firebaseConfig);
  const db   = getFirestore(app);
  const auth = getAuth(app);

  // ============================================================================
  // Persistencia offline multi-tab (fallback a single-tab)
  // ============================================================================
  enableMultiTabIndexedDbPersistence(db).catch((err) => {
    enableIndexedDbPersistence(db).catch((err2) => {
      console.warn('Sin persistencia offline:', err?.code || err, ' / ', err2?.code || err2);
    });
  });

  // ============================================================================
  // Identidad simple (normalizada)
  // ============================================================================
  let userEmail = localStorage.getItem('pucobre_user');
  if (!userEmail || !userEmail.includes('@')) {
    const typed = prompt("Ingrese correo corporativo:") || '';
    const normalized = typed.toLowerCase().trim();
    if (normalized && normalized.includes('@')) {
      localStorage.setItem('pucobre_user', normalized);
      userEmail = normalized;
    } else {
      alert("Acceso denegado.");
      throw new Error("Sin auth");
    }
  } else {
    userEmail = userEmail.toLowerCase().trim();
    localStorage.setItem('pucobre_user', userEmail); // re-graba normalizado
  }

  // ============================================================================
  // 0.1) Utilidades de FID persistente
  // ============================================================================
  const newFID = () => (crypto?.randomUUID?.() ?? (Date.now() + '-' + Math.random().toString(36).slice(2)));
  function ensureFID(geojson) {
    if (!geojson.properties) geojson.properties = {};
    if (!geojson.properties.__fid) geojson.properties.__fid = newFID();
    return geojson.properties.__fid;
  }
  function getFIDFromLayer(layer) {
    return layer?.feature?.properties?.__fid;
  }
  // Anti-hijack: fuerza nuevo FID si ya existe en nube
  function forceNewFIDIfHijack(gj) {
    const fid = gj?.properties?.__fid;
    if (fid && docMap.has(fid)) {
      gj.properties.__fid = newFID();
    }
  }

  // ============================================================================
  // 0.2) Sanitización HTML para prevenir XSS
  // ============================================================================
  function escapeHTML(s = '') {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // ============================================================================
  // 1) MAPA y TOC
  // ============================================================================
  const map = L.map('map').setView([latInicial, lngInicial], zoomInicial);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri — Pucobre', maxZoom: 19
  }).addTo(map);
  window.map = map; // depuración

  // Grupo visual de borradores (capas en edición)
  const localDrafts = L.featureGroup().addTo(map);

  // Mapa de referencias (FID -> idFirestore) y autores reales
  const docMap = new Map();
  const ownerByFid = new Map(); // fid -> autor real del servidor

  // TOC por autor
  const gruposPorAutor = {};
  const layerControl = L.control.layers(null, null, { collapsed: false }).addTo(map);

  // Estado
  let isSaving = false;

  // ============================================================================
  // 1.1) Pendientes por FID (contador robusto)
  // ============================================================================
  const pending = new Map(); // fid -> { layer, meta }

  function actualizarBoton() {
    const n = pending.size;
    const btn = document.getElementById('saveBtn');
    if (!btn) return;
    btn.disabled = n === 0;
    btn.textContent = n ? `💾 Guardar Cambios (${n})` : `💾 Guardar Cambios`;
  }

  function markDirty(layer, extraMeta = {}) {
    // Marcar dirty solo para borradores locales
    if (!layer?.options?._isDraft) return;

    // 1) GeoJSON y FID estable
    const gj = layer.toGeoJSON();
    const fid = ensureFID(gj);

    // 2) Persistir el FID dentro del layer para llamadas futuras
    if (!layer.feature) layer.feature = gj;
    if (!layer.feature.properties) layer.feature.properties = {};
    layer.feature.properties.__fid = fid;

    // 3) Metadatos + set idempotente en el Map
    layer.options.customMetadata = { ...(layer.options.customMetadata || {}), ...extraMeta };
    pending.set(fid, { layer, meta: layer.options.customMetadata });

    actualizarBoton();
    return fid;
  }

  // ============================================================================
  // 2) Dibujo y borrado (sobre borradores locales)
  // ============================================================================
  const drawControl = new L.Control.Draw({
    edit: { featureGroup: localDrafts, remove: true },
    draw: { circle: false, circlemarker: false }
  });
  map.addControl(drawControl);

  // Crear nuevo dibujo (inyecta FID, aplica estilo y lo marca como pendiente)
  map.on(L.Draw.Event.CREATED, (e) => {
    const original = e.layer;
    const gj = original.toGeoJSON();

    ensureFID(gj);
    forceNewFIDIfHijack(gj); // Anti-hijack
    const layer = L.geoJSON(gj).getLayers()[0];

    const comentario = prompt("Nombre/Descripción:") ?? "Dibujo manual";
    layer.options.customMetadata = { comentario, autor: userEmail, archivo: "Web" };
    layer.options._isDraft = true; // marcar como borrador

    // Estilo con línea punteada para distinguir borradores
    if (layer instanceof L.Path) {
      layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2, dashArray: '5,3' });
    }

    // Visual: mostrar en borradores
    localDrafts.addLayer(layer);

    // Lógico: 1 pendiente por FID (deduplicado)
    markDirty(layer);
  });

  // Capturar ediciones de borradores existentes
  map.on(L.Draw.Event.EDITED, (e) => {
    e.layers.eachLayer((layer) => {
      markDirty(layer);
    });
  });

  // Borrado de borradores locales (y, si corresponde, también de nube)
  map.on(L.Draw.Event.DELETED, async (e) => {
    const layers = e.layers;
    let borrados = 0;
    const tasks = [];

    layers.eachLayer((layer) => {
      // 1) Quitar de pendientes si estaba sin guardar
      const fid = getFIDFromLayer(layer);
      if (fid && pending.has(fid)) {
        pending.delete(fid);
      }

      // 2) Si existe en nube, validar autor REAL antes de borrar
      const dbId = fid ? docMap.get(fid) : undefined;
      const owner = fid ? ownerByFid.get(fid) : undefined;

      if (dbId) {
        if (owner === userEmail) {
          tasks.push(
            deleteDoc(doc(db, `geometrias_${proyectoID}`, dbId))
              .then(() => borrados++)
              .catch(err => console.error("Error Firebase:", err))
          );
        } else {
          alert(`No tienes permiso. Autor real: ${owner ?? 'desconocido'}`);
          // Re-agregar la capa en vez de recargar la página
          try { localDrafts.addLayer(layer); } catch {}
        }
      }
    });

    if (tasks.length) await Promise.allSettled(tasks);
    if (borrados > 0) document.getElementById('status').textContent = `🗑️ ${borrados} eliminados`;

    // Actualiza contador tras posibles deletes de pendientes
    actualizarBoton();
  });

  // ============================================================================
  // 3) Carga KML / GeoJSON (cada feature agregada suma 1 pendiente por FID)
  // ============================================================================
  const kmlInput = document.getElementById('kmlInput');
  if (kmlInput) {
    kmlInput.addEventListener('change', function (e) {
      const file = e.target.files[0];
      if (!file) return;
      const fileName = file.name.toLowerCase();
      const reader = new FileReader();
      const statusEl = document.getElementById('status');
      if (statusEl) statusEl.textContent = `📂 Leyendo ${file.name}...`;

      reader.onload = async (event) => {
        try {
          const content = event.target.result;
          let layerToProcess;

          if (fileName.endsWith('.kml')) {
            const parser = new DOMParser();
            let kmlDOM = parser.parseFromString(content, 'text/xml');

            // Fix robusto para KML sin namespace xsi
            let docEl = kmlDOM.documentElement;
            if (!docEl) {
              if (statusEl) statusEl.textContent = `❌ KML inválido (sin raíz XML)`;
              return;
            }
            if (!docEl.getAttribute('xmlns:xsi')) {
              docEl.setAttribute('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance');
            }
            // Si hubo parsererror, re-serializa y re-parsea una vez
            if (kmlDOM.querySelector('parsererror')) {
              kmlDOM = parser.parseFromString(new XMLSerializer().serializeToString(kmlDOM), 'text/xml');
              docEl = kmlDOM.documentElement;
              if (!docEl || kmlDOM.querySelector('parsererror')) {
                if (statusEl) statusEl.textContent = `❌ Error al parsear ${file.name}`;
                return;
              }
            }

            layerToProcess = omnivore.kml.parse(kmlDOM);
            layerToProcess.on('ready', () => unificarYProcesar(layerToProcess, file.name));
          } else {
            layerToProcess = L.geoJSON(JSON.parse(content));
            unificarYProcesar(layerToProcess, file.name);
          }
        } catch (err) {
          console.error(err);
          if (statusEl) statusEl.textContent = `❌ Error al procesar ${file.name}`;
        }
      };
      reader.readAsText(file);
      e.target.value = ''; // permitir recargar el mismo archivo
    });
  }

  async function unificarYProcesar(layerGroup, fileName) {
    const all = [];
    layerGroup.eachLayer(l => all.push(l));

    for (let i = 0; i < all.length; i++) {
      const base = all[i];
      const gj = base.toGeoJSON();

      // Anti-hijack en import: forzar nuevo FID si colisiona
      if (gj.properties?.__fid && docMap.has(gj.properties.__fid)) {
        gj.properties.__fid = newFID();
      } else {
        ensureFID(gj);
      }

      const layer = L.geoJSON(gj).getLayers()[0];

      const props = gj.properties ?? {};
      const name  = props.name ?? props.Name ?? `Elemento ${i + 1}`;

      layer.options.customMetadata = { comentario: name, archivo: fileName, autor: userEmail };
      layer.options._isDraft = true; // marcar como borrador
      layer.bindPopup(generarTablaPopup(name, userEmail, "Recién cargado", props));

      // Estilo con línea punteada para distinguir borradores
      if (layer instanceof L.Path) {
        layer.setStyle({ color: '#27ae60', weight: 2, fillOpacity: 0.2, dashArray: '5,3' });
      }

      // Visual
      localDrafts.addLayer(layer);
      // Lógico
      markDirty(layer, { comentario: name, archivo: fileName, autor: userEmail });
    }

    if (localDrafts.getLayers().length) {
      try { map.fitBounds(localDrafts.getBounds(), { padding: [20, 20] }); } catch { /* puntos aislados */ }
    }
    actualizarBoton();
  }

  // ============================================================================
  // 4) SINCRONIZACIÓN (TOC por autor)
  // ============================================================================
  onSnapshot(collection(db, `geometrias_${proyectoID}`), (snap) => {
    // Limpiar TOC y capas de nube
    for (const a in gruposPorAutor) {
      try { map.removeLayer(gruposPorAutor[a]); } catch {}
      try { layerControl.removeLayer(gruposPorAutor[a]); } catch {}
      delete gruposPorAutor[a];
    }

    docMap.clear();
    ownerByFid.clear(); // Limpiar índice de autores reales

    // Agrupar por autor
    const dataByAutor = {};
    snap.forEach(d => {
      const data = d.data();
      (dataByAutor[data.autor] ??= []).push({ id: d.id, ...data });
    });

    for (const autor in dataByAutor) {
      const grupo = L.featureGroup();
      const esMio = (autor === userEmail);
      const label = esMio
        ? `<b>⭐ MIS CAPAS (${dataByAutor[autor].length})</b>`
        : `👤 ${autor} (${dataByAutor[autor].length})`;

      dataByAutor[autor].forEach(item => {
        try {
          const geoJSON = JSON.parse(item.feature);
          const fid = ensureFID(geoJSON); // asegura FID (compat si faltara)

          // Registrar autor real del servidor
          ownerByFid.set(fid, autor);
          docMap.set(fid, item.id);

          // Calcular fecha desde serverTimestamp si existe
          const fechaLabel = item.timestamp?.toDate
            ? item.timestamp.toDate().toLocaleString('es-CL')
            : (item.fecha ?? '-');

          const layer = L.geoJSON(geoJSON, {
            style: { color: esMio ? '#27ae60' : '#3498db', weight: 2, fillOpacity: 0.15 }
          });

          layer.eachLayer(l => {
            l.options.customMetadata = { autor: autor };
            l.bindPopup(generarTablaPopup(item.comentario, autor, fechaLabel, geoJSON.properties));
            l.addTo(grupo);
          });
        } catch (err) {
          console.warn('Feature inválida en doc', item.id, err);
        }
      });

      gruposPorAutor[autor] = grupo;
      grupo.addTo(map);
      layerControl.addOverlay(grupo, label);
    }

    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = `📡 ÁREA: ${proyectoID.toUpperCase()}  —  Total: ${snap.size}`;
  });

  // ============================================================================
  // 5) UI helpers
  // ============================================================================
  function generarTablaPopup(titulo, autor, fecha, props = {}) {
    let html = `<div style="min-width:230px"><h4 style="margin:0;color:#27ae60">${escapeHTML(titulo)}</h4>`;
    html += `<small style="color:gray">👤 ${escapeHTML(autor)}  📅 ${escapeHTML(fecha ?? '-')}</small><hr><table style="width:100%;font-size:11px">`;
    for (const k in props) {
      if (['name','Name','description','styleUrl','styleHash','__fid'].includes(k) || !props[k]) continue;
      const val = props[k];
      const disp = (typeof val === 'string' && val.startsWith('http'))
        ? `${escapeHTML(val)}${escapeHTML(val)}</a>`
        : `${escapeHTML(String(val))}`;
      html += `<tr style="border-bottom:1px solid #eee"><td><b>${escapeHTML(k.toUpperCase())}</b></td><td>${disp}</td></tr>`;
    }
    return html + `</table></div>`;
  }

  // Guardar (idempotente por FID) — recorre pendientes únicos y limpia estado local
  const saveBtn = document.getElementById('saveBtn');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (pending.size === 0 || isSaving) return;

      const btn = saveBtn;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Guardando...';
      isSaving = true;

      try {
        const ops = [];
        for (const [fid, entry] of pending.entries()) {
          const layer = entry.layer;
          const meta  = entry.meta || {};
          const gj    = layer.toGeoJSON();

          // Asegurar FID estable por si acaso
          const fid2 = ensureFID(gj);
          if (!layer.feature) layer.feature = gj;
          if (!layer.feature.properties) layer.feature.properties = {};
          layer.feature.properties.__fid = fid2;

          const ref = doc(db, `geometrias_${proyectoID}`, fid2);
          const payload = {
            feature: JSON.stringify(gj),
            autor: userEmail,
            comentario: meta.comentario ?? "Sin nombre",
            archivo: meta.archivo ?? "Web",
            area: proyectoID, // útil para auditoría/filtrado
            fecha: new Date().toLocaleString('es-CL'),
            timestamp: serverTimestamp()
          };
          ops.push(setDoc(ref, payload, { merge: true })); // idempotente
        }

        await Promise.all(ops);

        // Limpieza visual y de estado local
        localDrafts.clearLayers();
        pending.clear();
        actualizarBoton();

        const statusEl = document.getElementById('status');
        if (statusEl) statusEl.textContent = `✅ Cambios guardados (${ops.length})`;
      } catch (e) {
        console.error('Error al guardar:', e);
        alert(e?.message ?? 'Error al guardar');
      } finally {
        isSaving = false;
        btn.disabled = false;
        btn.textContent = originalText;
      }
    };
  }

  // ============================================================================
  // 6) AUTH anónima (como tenías), y mostrar usuario
  // ============================================================================
  signInAnonymously(auth);
  onAuthStateChanged(auth, (u) => {
    const userInfo = document.getElementById('userInfo');
    if (u && userInfo) userInfo.innerHTML = `👤 ${userEmail}`;
  });

  // ============================================================================
  // 7) Inicialización y protección contra pérdida de datos
  // ============================================================================
  actualizarBoton();
  window.addEventListener('beforeunload', (e) => {
    if (pending.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();
