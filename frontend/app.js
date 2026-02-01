const API = {
  health: "/api/health",
  trackers: "/api/trackers",
  search: "/api/search",
  add: "/api/add",
  list: "/api/list",
  links: "/api/links",
  delete: "/api/delete",
  downloadLinks: "/api/download-links",
  settings: "/api/settings",
  pause: "/api/pause",
  resume: "/api/resume",
};

const el = (id) => document.getElementById(id);

const state = {
  trackers: [],
  results: [],
  downloads: [],
  links: {
    jackett: "",
    qbittorrent: ""
  },
};

/* ===========================
   TOAST
=========================== */
function toast(msg) {
  const t = el("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2400);
}

/* ===========================
   FORMAT BYTES
=========================== */
function fmtBytes(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

/* ===========================
   API HELPERS
=========================== */
async function apiGet(url) {
  const r = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    try {
      const json = JSON.parse(txt);
      throw new Error(json.error || json.message || txt);
    } catch (e) {
      if (e.message && !e.message.includes("{")) {
        throw e; // Ya es un error con mensaje limpio
      }
      throw new Error(`${r.status} ${r.statusText}`);
    }
  }
  return r.json();
}

/* ===========================
   HEALTH
=========================== */
async function refreshHealth() {
  const txt = el("healthText");
  try {
    const data = await apiGet(API.health);
    txt.textContent = data?.ok ? "Backend OK" : "Backend";
  } catch {
    txt.textContent = "Conectando…";
  }
}

/* ===========================
   TRACKERS
=========================== */
async function refreshTrackers() {
  try {
    const data = await apiGet(API.trackers);
    state.trackers = Array.isArray(data.trackers) ? data.trackers : [];
    renderTrackers();
  } catch (e) {
    state.trackers = [];
    renderTrackers();
    toast("No se pudieron cargar trackers: " + e.message);
  }
}

function renderTrackers() {
  const wrap = el("trackers");
  wrap.innerHTML = "";

  if (!state.trackers.length) {
    wrap.innerHTML = `<div class="empty">No hay trackers.</div>`;
    return;
  }

  for (const t of state.trackers) {
    const label = document.createElement("label");
    label.className = "tracker";
    label.innerHTML = `
      <input type="checkbox" name="tracker" value="${escapeHtml(t.id)}">
      <div>
        <div class="name">${escapeHtml(t.name || t.id)}</div>
        <div class="meta">${escapeHtml(t.description || "")}</div>
      </div>
    `;
    wrap.appendChild(label);
  }
}

function selectedTrackerIds() {
  return [...document.querySelectorAll('input[name="tracker"]:checked')].map(
    (i) => i.value
  );
}

/* ===========================
   SEARCH
=========================== */
async function doSearch() {
  const q = el("q").value.trim();
  const trackers = selectedTrackerIds();
  if (!q) return toast("Escribe algo para buscar");
  if (!trackers.length) return toast("Selecciona trackers");

  el("results-loading")?.classList.remove("hidden");

  try {
    const sort = el("sort")?.value || "relevance";
    const limit = el("limit")?.value || "50";
    const onlySeeded = el("onlySeeded")?.value || "no";

    const params = new URLSearchParams({
      q,
      trackers: trackers.join(","),
      sort,
      limit,
      onlySeeded,
    });
    const data = await apiGet(`${API.search}?${params}`);
    state.results = Array.isArray(data.results) ? data.results : [];
    renderResults();
    toast(`Resultados: ${state.results.length}`);
  } catch (e) {
    state.results = [];
    renderResults();
    toast("Error buscando: " + e.message);
  } finally {
    el("results-loading")?.classList.add("hidden");
  }
}

/* ===========================
   RESULTS
=========================== */
function renderResults() {
  const body = el("resultsBody");
  body.innerHTML = "";

  if (!state.results.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">Sin resultados</td></tr>`;
    return;
  }

  for (const r of state.results) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${escapeHtml(r.title ?? "—")}</td>
      <td>${fmtBytes(r.sizeBytes)}</td>
      <td>${r.seeders ?? "—"}</td>
      <td>${escapeHtml(r.tracker ?? r.trackerId ?? "—")}</td>
      <td>
        <button class="btn btn-sm">Enviar</button>
      </td>
    `;

    // Enviar torrent a qBittorrent
    tr.querySelector("button").onclick = async () => {
      try {
        toast("⏳ Procesando y enviando a qBittorrent...");
        // Asegurar que sizeBytes esté en el raw
        const payload = { 
          raw: { 
            ...r.raw, 
            sizeBytes: r.sizeBytes,
            title: r.title 
          } 
        };
        const result = await apiPost(API.add, payload);
        toast("✅ Torrent añadido a qBittorrent");
        await refreshDownloads();
      } catch (e) {
        toast("❌ Error: " + e.message);
      }
    };

    body.appendChild(tr);
  }
}

/* ===========================
   DOWNLOADS
=========================== */
async function refreshDownloads() {
  try {
    const data = await apiGet(API.list);
    state.downloads = Array.isArray(data.items) ? data.items : [];
    renderDownloads();
  } catch (e) {
    toast("No se pudo cargar descargas: " + e.message);
  }
}

function renderDownloads() {
  const wrap = el("downloads");
  wrap.innerHTML = "";

  if (!state.downloads.length) {
    wrap.innerHTML = `<div class="empty">Sin descargas</div>`;
    updateDownloadStats();
    return;
  }

  for (const d of state.downloads) {
    const p = typeof d.progress === "number" ? Math.max(0, Math.min(100, d.progress * 100)) : 0;
    const isCompleted = p >= 100;
    const isSeeding = d.state && (d.state.includes("uploading") || d.state.includes("stalled") && isCompleted);
    const isPaused = d.state && (d.state.includes("paused") || d.state.includes("Paused") || d.state.includes("stopped"));

    const name = d.name || "Sin nombre";
    const size = typeof d.size === "number" ? fmtBytes(d.size) : "—";
    const state_text = translateState(d.state) || "—";
    const dlspeed = d.dlspeed ? fmtBytes(d.dlspeed) + "/s" : "—";
    const upspeed = d.upspeed ? fmtBytes(d.upspeed) + "/s" : "—";
    
    // Calcular tiempo de seed restante
    let seedTimeInfo = "";
    if (isSeeding && d.seeding_time !== undefined) {
      const seedingHours = Math.floor(d.seeding_time / 3600);
      seedTimeInfo = `🌱 Sedeando (${seedingHours}h)`;
      
      // Si hay configuración de tiempo máximo de seed, mostrar tiempo restante
      // Por ahora solo mostramos el tiempo que lleva sedeando
    }

    const div = document.createElement("div");
    div.className = "dl";
    
    let progressBar = "";
    if (!isCompleted) {
      progressBar = `
        <div class="progress">
          <div style="width:${p}%"></div>
        </div>
      `;
    }
    
    div.innerHTML = `
      <div class="dl-top">
        <div>
          <div class="dl-title">${escapeHtml(name)}</div>
          <div class="dl-sub">
            Tamaño: ${escapeHtml(size)} — Estado: ${escapeHtml(state_text)} — 
            ${isCompleted ? `↑ ${escapeHtml(upspeed)}` : `↓ ${escapeHtml(dlspeed)}`}
            ${seedTimeInfo ? ` — ${seedTimeInfo}` : ""}
          </div>
        </div>
        <div class="dl-actions">
          ${isSeeding && !isPaused ? 
            `<button class="btn-pause" data-id="${d.id}" title="Pausar seed">⏸️</button>` : 
            isPaused ?
            `<button class="btn-resume" data-id="${d.id}" title="Reanudar">▶️</button>` :
            ''
          }
          <button class="btn-delete" data-id="${d.id}" title="Eliminar torrent">🗑️</button>
        </div>
      </div>
      ${progressBar}
    `;
    wrap.appendChild(div);
    
    // Agregar eventos
    const pauseBtn = div.querySelector(".btn-pause");
    const resumeBtn = div.querySelector(".btn-resume");
    const deleteBtn = div.querySelector(".btn-delete");
    
    if (pauseBtn) pauseBtn.onclick = () => pauseTorrent(d.id);
    if (resumeBtn) resumeBtn.onclick = () => resumeTorrent(d.id);
    deleteBtn.onclick = () => deleteDownload(d.id);
  }
  
  updateDownloadStats();
}

function updateDownloadStats() {
  const totalCount = state.downloads.length;
  const totalSize = state.downloads.reduce((sum, d) => sum + (d.size || 0), 0);
  
  const statsTotal = el("statsTotal");
  const statsSize = el("statsSize");
  
  if (statsTotal) statsTotal.textContent = `Total: ${totalCount}`;
  if (statsSize) statsSize.textContent = `Espacio: ${fmtBytes(totalSize)}`;
}

async function deleteDownload(hash) {
  const deleteFiles = confirm("¿Quieres eliminar también los archivos descargados?");
  
  try {
    const res = await fetch(API.delete, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: hash, deleteFiles }),
      credentials: "include",
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error al eliminar");
    
    toast("Torrent eliminado");
    await refreshDownloads();
  } catch (err) {
    console.error("Error eliminando torrent:", err);
    toast("Error eliminando torrent: " + err.message);
  }
}

async function pauseTorrent(hash) {
  try {
    const res = await fetch(API.pause, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: hash }),
      credentials: "include",
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error al pausar");
    
    toast("Torrent pausado");
    // Pequeño delay para que qBittorrent actualice el estado
    await new Promise(resolve => setTimeout(resolve, 1000));
    await refreshDownloads();
  } catch (err) {
    console.error("Error pausando torrent:", err);
    toast("Error pausando torrent: " + err.message);
  }
}

async function resumeTorrent(hash) {
  try {
    const res = await fetch(API.resume, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: hash }),
      credentials: "include",
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error al reanudar");
    
    toast("Torrent reanudado");
    // Pequeño delay para que qBittorrent actualice el estado
    await new Promise(resolve => setTimeout(resolve, 1000));
    await refreshDownloads();
  } catch (err) {
    console.error("Error reanudando torrent:", err);
    toast("Error reanudando torrent: " + err.message);
  }
}

/* ===========================
   UTILS
=========================== */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[m]));
}

function translateState(state) {
  const translations = {
    'downloading': 'Descargando',
    'uploading': 'Sedeando',
    'stalledUP': 'Activo',
    'stalledDL': 'Descargando (sin peers)',
    'stoppedUP': 'Completado',
    'stoppedDL': 'Detenido',
    'pausedUP': 'Pausado',
    'pausedDL': 'Pausado',
    'queuedUP': 'En cola',
    'queuedDL': 'En cola',
    'checkingUP': 'Verificando',
    'checkingDL': 'Verificando',
    'checkingResumeData': 'Verificando',
    'allocating': 'Reservando espacio',
    'metaDL': 'Descargando metadatos',
    'forcedUP': 'Forzando seed',
    'forcedDL': 'Forzando descarga',
    'missingFiles': 'Archivos faltantes',
    'error': 'Error',
  };
  
  return translations[state] || state;
}

/* ===========================
   LOAD LINKS
   Construye URLs dinámicamente según el hostname desde donde se accede
=========================== */
async function loadLinks() {
  try {
    // Detecta el hostname/IP desde donde se accede
    const hostname = window.location.hostname;
    
    // Construye las URLs con el mismo hostname
    state.links.jackett = `http://${hostname}:9117`;
    state.links.qbittorrent = `http://${hostname}:8080`;
    
    // Actualiza los href de los enlaces dinámicamente
    const jackettLink = el("linkJackett");
    const qbittorrentLink = el("linkQbittorrent");
    
    if (jackettLink) jackettLink.href = state.links.jackett;
    if (qbittorrentLink) qbittorrentLink.href = state.links.qbittorrent;
  } catch (err) {
    console.warn("No se pudieron cargar los links:", err.message);
  }
}

/* ===========================
   SETTINGS
=========================== */
async function openSettings() {
  try {
    const modal = el("settingsModal");
    const data = await apiGet(API.settings);
    
    console.log("Configuración recibida del backend:", data);
    
    el("seedTimeHours").value = data.seedTimeHours || 24;
    el("autoDeleteHours").value = data.autoDeleteHours || 0;
    el("spaceLimitEnabled").checked = data.spaceLimitEnabled || false;
    el("spaceLimitGB").value = data.spaceLimitGB || 50;
    el("spaceLimitGB").disabled = !data.spaceLimitEnabled;
    
    // Actualizar hint de espacio usado
    const usedSpace = data.usedSpaceGB || 0;
    const limitSpace = data.spaceLimitGB || 50;
    el("spaceUsageHint").textContent = `Espacio usado: ${usedSpace.toFixed(2)} GB / ${limitSpace} GB`;
    
    // Listener para habilitar/deshabilitar input con efecto visual
    el("spaceLimitEnabled").onchange = (e) => {
      const input = el("spaceLimitGB");
      input.disabled = !e.target.checked;
      input.style.opacity = e.target.checked ? "1" : "0.5";
    };
    
    // Aplicar estilo inicial
    el("spaceLimitGB").style.opacity = data.spaceLimitEnabled ? "1" : "0.5";
    
    modal.classList.remove("hidden");
  } catch (err) {
    toast("Error cargando configuración: " + err.message);
  }
}

function closeSettings() {
  el("settingsModal").classList.add("hidden");
}

async function saveSettings() {
  try {
    const seedTimeHours = parseInt(el("seedTimeHours").value) || 24;
    const autoDeleteHours = parseInt(el("autoDeleteHours").value) || 0;
    const spaceLimitEnabled = el("spaceLimitEnabled").checked;
    const spaceLimitGB = parseInt(el("spaceLimitGB").value) || 50;
    
    await apiPost(API.settings, {
      seedTimeHours,
      autoDeleteHours,
      spaceLimitEnabled,
      spaceLimitGB
    });
    
    toast("Configuración guardada correctamente");
    closeSettings();
  } catch (err) {
    toast("Error guardando configuración: " + err.message);
  }
}

/* ===========================
   INIT
=========================== */
function wireUI() {
  el("btnReloadTrackers").onclick = refreshTrackers;
  el("btnSearch").onclick = doSearch;
  el("btnClearResults").onclick = () => {
    state.results = [];
    renderResults();
  };
  el("btnSelectAll").onclick = () => {
    document.querySelectorAll('input[name="tracker"]').forEach(i => (i.checked = true));
  };
  el("btnSelectNone").onclick = () => {
    document.querySelectorAll('input[name="tracker"]').forEach(i => (i.checked = false));
  };
  el("btnRefreshDownloads").onclick = refreshDownloads;
  el("btnSettings")?.addEventListener("click", openSettings);
  el("closeSettings")?.addEventListener("click", closeSettings);
  el("cancelSettings")?.addEventListener("click", closeSettings);
  el("saveSettings")?.addEventListener("click", saveSettings);
  
  // Auto refresh handled by interval started in init
  el("q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
}

(async function init() {
  wireUI();
  await loadLinks();
  await refreshHealth();
  await refreshTrackers();
  await refreshDownloads();
  // Start auto-refresh loop
  setInterval(() => {
    const auto = el("autoRefresh");
    if (auto && auto.checked) {
      refreshDownloads().catch(() => {});
    }
  }, 15000);
})();