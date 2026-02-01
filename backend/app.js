const express = require("express");
const cors = require("cors");
const parseTorrent = require("parse-torrent");
const fs = require("fs");
const path = require("path");

const jackett = require("./jackettClient");
const qbittorrent = require("./qbittorrentClient");

const app = express();
const PORT = 3000;

// Configuración persistente
const CONFIG_FILE = path.join(__dirname, "config.json");
let appConfig = {
  autoDeleteHours: 0,
  spaceLimitEnabled: false,
  spaceLimitGB: 50
};

// Cargar configuración al inicio
try {
  if (fs.existsSync(CONFIG_FILE)) {
    appConfig = { ...appConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  }
} catch (err) {
  console.warn("No se pudo cargar config.json:", err.message);
}

// Guardar configuración
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
  } catch (err) {
    console.error("Error guardando config.json:", err.message);
  }
}

// Calcular tamaño de carpeta recursivamente
function getFolderSize(folderPath) {
  let totalSize = 0;
  try {
    if (!fs.existsSync(folderPath)) return 0;
    const items = fs.readdirSync(folderPath);
    for (const item of items) {
      const itemPath = path.join(folderPath, item);
      const stats = fs.statSync(itemPath);
      if (stats.isDirectory()) {
        totalSize += getFolderSize(itemPath);
      } else {
        totalSize += stats.size;
      }
    }
  } catch (err) {
    console.error("Error calculando tamaño:", err.message);
  }
  return totalSize;
}

// Obtener torrents completados ordenados por fecha
async function getCompletedTorrents() {
  const torrents = await qbittorrent.listTorrents();
  console.log(`🔍 Total torrents: ${torrents.length}`);
  
  const completed = torrents.filter(t => {
    const isCompleted = t.progress === 1;
    const isSeeding = t.state && (t.state.includes("up") || t.state === "pausedUP");
    console.log(`  - ${t.name.substring(0, 40)}: progress=${t.progress}, state=${t.state}, isCompleted=${isCompleted}, isSeeding=${isSeeding}`);
    return isCompleted || isSeeding; // Incluir completados o en seed
  });
  
  console.log(`✅ Torrents elegibles para borrar: ${completed.length}`);
  return completed.sort((a, b) => (a.added_on || 0) - (b.added_on || 0)); // Más antiguos primero
}

// Verificar y aplicar límite de espacio periódicamente
async function checkSpaceLimit() {
  try {
    const torrents = await qbittorrent.listTorrents();
    const currentTime = Math.floor(Date.now() / 1000); // Timestamp actual en segundos

    // 1. Auto-borrar torrents completados después de X horas
    if (appConfig.autoDeleteHours > 0) {
      const maxSecondsCompleted = appConfig.autoDeleteHours * 3600;
      
      for (const torrent of torrents) {
        // Si el torrent está completado (progress = 1)
        if (torrent.progress === 1 && torrent.completion_on > 0) {
          const secondsSinceCompletion = currentTime - torrent.completion_on;
          
          if (secondsSinceCompletion >= maxSecondsCompleted) {
            const hoursSince = (secondsSinceCompletion / 3600).toFixed(1);
            console.log(`🕒 Auto-borrando torrent completado hace ${hoursSince}h: ${torrent.name}`);
            await qbittorrent.deleteTorrent(torrent.id, true);
          }
        }
      }
    }

    // 2. Verificar límite de espacio (solo si está activado)
    if (!appConfig.spaceLimitEnabled) return;

    const downloadsPath = "/downloads";
    const usedSpaceBytes = getFolderSize(downloadsPath);
    const usedSpaceGB = usedSpaceBytes / (1024 ** 3);
    const limitGB = appConfig.spaceLimitGB;

    // Verificar torrents individuales que excedan el límite
    for (const torrent of torrents) {
      if (torrent.size > 0) {
        const torrentSizeGB = torrent.size / (1024 ** 3);
        
        if (torrentSizeGB > limitGB) {
          console.log(`❌ Torrent excede límite: ${torrent.name} (${torrentSizeGB.toFixed(2)} GB > ${limitGB} GB) - Borrando`);
          await qbittorrent.deleteTorrent(torrent.id, true);
        }
      }
    }

    // Verificar si el espacio total usado excede el límite
    if (usedSpaceGB > limitGB) {
      const spaceToFree = usedSpaceGB - limitGB;
      console.log(`⚠️ Espacio usado ${usedSpaceGB.toFixed(2)} GB > ${limitGB} GB. Liberando: ${spaceToFree.toFixed(2)} GB`);
      
      const completedTorrents = await getCompletedTorrents();
      let freedSpace = 0;

      for (const torrent of completedTorrents) {
        if (freedSpace >= spaceToFree) break;
        
        const torrentSizeGB = torrent.size / (1024 ** 3);
        console.log(`🗑️ Borrando torrent antiguo: ${torrent.name} (${torrentSizeGB.toFixed(2)} GB)`);
        await qbittorrent.deleteTorrent(torrent.id, true);
        freedSpace += torrentSizeGB;
      }

      console.log(`✅ Espacio liberado: ${freedSpace.toFixed(2)} GB`);
    }
  } catch (err) {
    console.error("Error en checkSpaceLimit:", err.message);
  }
}

// Verificar límite cada 10 segundos
setInterval(checkSpaceLimit, 10000);

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json({ limit: "5mb" }));

/* =========================
   HEALTH
   Comprueba Jackett + qBittorrent
========================= */
app.get("/health", async (req, res) => {
  try {
    await jackett.getIndexers();
    await qbittorrent.login();
    res.json({ ok: true });
  } catch (err) {
    console.error("Health error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =========================
   LINKS
   Devuelve URLs de acceso a paneles externos
========================= */
app.get("/links", (req, res) => {
  res.json({
    jackett: "http://localhost:9117",
    qbittorrent: "http://localhost:8080"
  });
});

/* =========================
   TRACKERS
========================= */
app.get("/trackers", async (req, res) => {
  try {
    const trackers = await jackett.getIndexers();
    res.json({ trackers });
  } catch (err) {
    console.error("Error en /trackers:", err.message);
    res.status(500).json({ trackers: [], error: err.message });
  }
});

/* =========================
   SEARCH
   🔑 NO FILTRAMOS NADA
========================= */
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const trackers = (req.query.trackers || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const sort = (req.query.sort || "relevance").toLowerCase();
    const limit = Number(req.query.limit) || null;
    const onlySeeded = (req.query.onlySeeded || "no").toLowerCase();

    if (!q || !trackers.length) {
      return res.json({ results: [] });
    }

    let results = await jackett.search({
      query: q,
      trackers,
    });

    // Aplicar filtro: solo con seeders
    if (onlySeeded === "yes") {
      results = results.filter((r) => typeof r.seeders === "number" && r.seeders > 0);
    }

    // Orden
    if (sort === "seeders") {
      results.sort((a, b) => (Number(b.seeders) || 0) - (Number(a.seeders) || 0));
    } else if (sort === "size") {
      results.sort((a, b) => (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0));
    } else if (sort === "date") {
      // try to use raw.pubDate or raw.uploadDate; fallbacks handled
      const toTs = (r) => {
        try {
          const s = r.raw?.pubDate || r.raw?.uploadDate || r.raw?.time || null;
          if (!s) return 0;
          const t = Date.parse(s);
          return Number.isNaN(t) ? 0 : t;
        } catch (e) {
          return 0;
        }
      };
      results.sort((a, b) => toTs(b) - toTs(a));
    }

    // Limitar
    if (limit && Number.isFinite(limit) && limit > 0) {
      results = results.slice(0, limit);
    }

    res.json({ results });
  } catch (err) {
    console.error("Error en /search:", err.message);
    res.status(500).json({ results: [], error: err.message });
  }
});

/* =========================
   DOWNLOAD TORRENT
   Devuelve el .torrent para que el cliente (navegador) lo suba
========================= */
app.post("/download-torrent", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || !payload.raw) {
      return res.status(400).json({ error: "Payload inválido (falta raw)" });
    }

    const raw = payload.raw;
    const torrentUrl = raw.enclosure?.url || raw.torrentUrl || raw.link;

    if (!torrentUrl) {
      return res.status(400).json({ error: "No hay URL de descarga" });
    }

    // Descargar el .torrent desde Jackett
    const torrentRes = await fetch(torrentUrl);
    if (!torrentRes.ok) {
      return res.status(400).json({ error: "No se pudo descargar el .torrent desde Jackett" });
    }

    const arr = await torrentRes.arrayBuffer();
    const buffer = Buffer.from(arr);
    const filename = (raw.title || "torrent").replace(/[^a-z0-9]/gi, "_") + ".torrent";

    res.setHeader("Content-Type", "application/x-bittorrent");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("Error en /download-torrent:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   EXTRACT MAGNET FROM TORRENT
   Backend descarga .torrent, extrae magnet, devuelve al cliente
========================= */
app.post("/extract-magnet", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || !payload.raw) {
      return res.status(400).json({ error: "Payload inválido (falta raw)" });
    }

    const raw = payload.raw;
    const torrentUrl = raw.enclosure?.url || raw.torrentUrl || raw.link;

    if (!torrentUrl) {
      return res.status(400).json({ error: "No hay URL de descarga" });
    }

    // Descargar el .torrent desde Jackett
    const torrentRes = await fetch(torrentUrl);
    if (!torrentRes.ok) {
      return res.status(400).json({ error: "No se pudo descargar el .torrent desde Jackett" });
    }

    const arr = await torrentRes.arrayBuffer();
    const buffer = Buffer.from(arr);

    // Parsear el torrent para extraer info y generar magnet
    const torrentInfo = await parseTorrent(buffer);
    
    // Construir el magnet manualmente desde el hash de info
    const infoHash = torrentInfo.infoHash.toString();
    const name = torrentInfo.name || raw.title || "torrent";
    const trackers = (torrentInfo.announce || []).join("&tr=");
    const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trackers ? "&tr=" + trackers : ""}`;

    console.log("Extracted magnet:", magnet);
    res.json({ magnet, infoHash, name });
  } catch (err) {
    console.error("Error en /extract-magnet:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   ADD → qBittorrent
========================= */
app.post("/add", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || !payload.raw) {
      return res.status(400).json({ error: "Payload inválido (falta raw)" });
    }

    console.log("📦 Payload recibido:", JSON.stringify({ 
      hasMagnet: !!payload.raw.magnet, 
      hasSize: !!payload.raw.sizeBytes,
      sizeBytes: payload.raw.sizeBytes,
      title: payload.raw.title?.substring(0, 50)
    }));

    // Verificar límite de espacio si está activado usando sizeBytes de Jackett
    if (appConfig.spaceLimitEnabled) {
      const downloadsPath = "/downloads";
      const usedSpaceBytes = getFolderSize(downloadsPath);
      const usedSpaceGB = usedSpaceBytes / (1024 ** 3);
      const torrentSizeBytes = payload.raw.sizeBytes || 0;
      const torrentSizeGB = torrentSizeBytes / (1024 ** 3);
      const limitGB = appConfig.spaceLimitGB;

      console.log(`💾 Validación: Límite=${limitGB} GB | Usado=${usedSpaceGB.toFixed(2)} GB | Torrent=${torrentSizeGB.toFixed(2)} GB | spaceLimitEnabled=${appConfig.spaceLimitEnabled}`);

      // Si el torrent es más grande que el límite total, rechazar
      if (torrentSizeGB > limitGB) {
        console.log(`❌ RECHAZADO ANTES DE AÑADIR: ${torrentSizeGB.toFixed(2)} GB > ${limitGB} GB`);
        return res.status(400).json({ 
          error: `El torrent (${torrentSizeGB.toFixed(2)} GB) supera el límite configurado (${limitGB} GB). Aumenta el límite en Configuración.`
        });
      }

      // Si no hay suficiente espacio, borrar torrents antiguos ANTES de añadir
      const neededSpace = usedSpaceGB + torrentSizeGB;
      if (neededSpace > limitGB) {
        const spaceToFree = neededSpace - limitGB;
        console.log(`⚠️ Espacio insuficiente. Necesario: ${neededSpace.toFixed(2)} GB > ${limitGB} GB. Liberando: ${spaceToFree.toFixed(2)} GB`);
        
        const completedTorrents = await getCompletedTorrents();
        let freedSpace = 0;

        for (const torrent of completedTorrents) {
          if (freedSpace >= spaceToFree) break;
          
          const torrentSizeGB = torrent.size / (1024 ** 3);
          console.log(`🗑️ Borrando: ${torrent.name} (${torrentSizeGB.toFixed(2)} GB)`);
          await qbittorrent.deleteTorrent(torrent.id, true);
          freedSpace += torrentSizeGB;
        }

        console.log(`✅ Espacio liberado: ${freedSpace.toFixed(2)} GB`);
      }
    }

    const result = await qbittorrent.addTorrent(payload);
    res.json(result);
  } catch (err) {
    console.error("Error en /add:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   LIST (qBittorrent)
========================= */
app.get("/list", async (req, res) => {
  try {
    const items = await qbittorrent.listTorrents();
    res.json({ items });
  } catch (err) {
    console.error("Error en /list:", err.message);
    res.status(500).json({ items: [], error: err.message });
  }
});

/* =========================
   DELETE TORRENT
========================= */
app.post("/delete", async (req, res) => {
  try {
    const hash = req.body?.id;
    const deleteFiles = req.body?.deleteFiles || false;
    if (!hash) {
      return res.status(400).json({ error: "ID requerido" });
    }
    const result = await qbittorrent.deleteTorrent(hash, deleteFiles);
    res.json({ success: true, result });
  } catch (err) {
    console.error("Error en /delete:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   PAUSE/RESUME TORRENT
========================= */
app.post("/pause", async (req, res) => {
  try {
    const hash = req.body?.id;
    if (!hash) {
      return res.status(400).json({ error: "ID requerido" });
    }
    const result = await qbittorrent.pauseTorrent(hash);
    res.json({ success: true, result });
  } catch (err) {
    console.error("Error en /pause:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/resume", async (req, res) => {
  try {
    const hash = req.body?.id;
    if (!hash) {
      return res.status(400).json({ error: "ID requerido" });
    }
    const result = await qbittorrent.resumeTorrent(hash);
    res.json({ success: true, result });
  } catch (err) {
    console.error("Error en /resume:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   GET SETTINGS
   Obtiene configuración actual de qBittorrent
========================= */
app.get("/settings", async (req, res) => {
  try {
    const prefs = await qbittorrent.getPreferences();
    const downloadsPath = "/downloads";
    const usedSpaceBytes = getFolderSize(downloadsPath);
    const usedSpaceGB = (usedSpaceBytes / (1024 ** 3)).toFixed(2);
    
    res.json({ 
      seedTimeHours: prefs.max_seeding_time > 0 ? Math.round(prefs.max_seeding_time / 60) : 24,
      autoDeleteHours: appConfig.autoDeleteHours,
      spaceLimitEnabled: appConfig.spaceLimitEnabled,
      spaceLimitGB: appConfig.spaceLimitGB,
      usedSpaceGB: parseFloat(usedSpaceGB)
    });
  } catch (err) {
    console.error("Error en /settings:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   UPDATE SETTINGS
   Actualiza configuración de qBittorrent
========================= */
app.post("/settings", async (req, res) => {
  try {
    const { seedTimeHours, autoDeleteHours, spaceLimitEnabled, spaceLimitGB } = req.body;
    
    // Convertir horas a minutos para qBittorrent
    const seedTimeMinutes = seedTimeHours > 0 ? seedTimeHours * 60 : -1;
    
    await qbittorrent.setPreferences({
      max_seeding_time: seedTimeMinutes
    });
    
    // Guardar configuración de la app
    appConfig.autoDeleteHours = typeof autoDeleteHours === 'number' ? autoDeleteHours : 0;
    appConfig.spaceLimitEnabled = spaceLimitEnabled === true;
    appConfig.spaceLimitGB = typeof spaceLimitGB === 'number' ? spaceLimitGB : 50;
    
    console.log('Guardando configuración:', appConfig);
    saveConfig();
    console.log('Configuración guardada en:', CONFIG_FILE);
    
    res.json({ 
      success: true, 
      message: "Configuración actualizada",
      seedTimeHours,
      autoDeleteHours,
      spaceLimitEnabled,
      spaceLimitGB
    });
  } catch (err) {
    console.error("Error en /settings:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`✅ Backend escuchando en el puerto ${PORT}`);
});
