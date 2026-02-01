const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const QBITTORRENT_URL = process.env.QBITTORRENT_URL || "http://qbittorrent:8080";
const QBITTORRENT_USER = process.env.QBITTORRENT_USER || "admin";
const QBITTORRENT_PASSWORD = process.env.QBITTORRENT_PASSWORD || "adminadmin";

let sessionCookie = null;

/* =========================
   LOGIN
   Obtiene cookie de sesión
========================= */
async function login() {
  try {
    const res = await fetch(`${QBITTORRENT_URL}/api/v2/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `username=${encodeURIComponent(QBITTORRENT_USER)}&password=${encodeURIComponent(QBITTORRENT_PASSWORD)}`,
    });

    if (!res.ok) {
      throw new Error(`Login failed: ${res.status}`);
    }

    const text = await res.text();
    if (text === "Fails.") {
      throw new Error("Credenciales incorrectas de qBittorrent");
    }

    const cookies = res.headers.get("set-cookie");
    if (cookies) {
      const match = cookies.match(/SID=([^;]+)/);
      if (match) {
        sessionCookie = match[1];
      }
    }

    return true;
  } catch (err) {
    console.error("Error en login qBittorrent:", err.message);
    throw err;
  }
}

/* =========================
   API REQUEST
   Hace petición autenticada
========================= */
async function apiRequest(endpoint, options = {}) {
  if (!sessionCookie) {
    await login();
  }

  const headers = {
    Cookie: `SID=${sessionCookie}`,
    ...options.headers,
  };

  let res = await fetch(`${QBITTORRENT_URL}${endpoint}`, {
    ...options,
    headers,
  });

  // Si no está autenticado, hacer login y reintentar
  if (res.status === 403) {
    await login();
    headers.Cookie = `SID=${sessionCookie}`;
    res = await fetch(`${QBITTORRENT_URL}${endpoint}`, {
      ...options,
      headers,
    });
  }

  return res;
}

/* =========================
   ADD TORRENT
   Añade un torrent a qBittorrent
========================= */
async function addTorrent(payload) {
  const raw = payload?.raw;
  if (!raw) throw new Error("Payload sin raw");

  const FormData = require("form-data");
  const form = new FormData();

  // Configurar la categoría basada en el título del torrent
  const category = (raw.title || "otros").replace(/[^a-z0-9]/gi, "_").substring(0, 50);
  form.append("category", category);
  form.append("savepath", `/downloads/${category}`);

  /* 1️⃣ MAGNET */
  if (raw.magnet) {
    form.append("urls", raw.magnet);
  } 
  /* 2️⃣ TORRENT FILE */
  else {
    const torrentUrl = raw.enclosure?.url || raw.torrentUrl || raw.link;
    if (!torrentUrl) {
      throw new Error("No hay magnet ni torrentUrl");
    }

    // Descargar el .torrent
    const torrentRes = await fetch(torrentUrl);
    if (!torrentRes.ok) {
      throw new Error("No se pudo descargar el .torrent desde Jackett");
    }

    const buffer = await torrentRes.buffer();
    const filename = (raw.title || "torrent").replace(/[^a-z0-9]/gi, "_") + ".torrent";
    
    form.append("torrents", buffer, {
      filename,
      contentType: "application/x-bittorrent",
    });
  }

  const res = await apiRequest("/api/v2/torrents/add", {
    method: "POST",
    body: form,
    headers: form.getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error añadiendo torrent: ${res.status} - ${text}`);
  }

  const text = await res.text();
  
  // qBittorrent devuelve "Ok." si todo va bien
  if (text === "Ok.") {
    return { 
      success: true, 
      message: "Torrent añadido a qBittorrent",
      category 
    };
  } else {
    throw new Error(`Respuesta inesperada de qBittorrent: ${text}`);
  }
}

/* =========================
   LIST TORRENTS
   Lista todos los torrents
========================= */
async function listTorrents() {
  const res = await apiRequest("/api/v2/torrents/info");
  
  if (!res.ok) {
    throw new Error(`Error listando torrents: ${res.status}`);
  }

  const torrents = await res.json();
  
  // Formatear la respuesta para que sea compatible con el frontend
  return torrents.map(t => ({
    id: t.hash,
    name: t.name,
    size: t.size,
    progress: t.progress,
    state: t.state,
    dlspeed: t.dlspeed,
    upspeed: t.upspeed,
    eta: t.eta,
    category: t.category,
    save_path: t.save_path,
    added_on: t.added_on,
    completion_on: t.completion_on,
    num_seeds: t.num_seeds,
    num_leechs: t.num_leechs,
    seeding_time: t.seeding_time, // Tiempo que lleva sedeando (en segundos)
    ratio: t.ratio,
  }));
}

/* =========================
   PAUSE/RESUME TORRENT
   Pausa o reanuda un torrent
========================= */
async function pauseTorrent(hash) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("hashes", hash);

  const res = await apiRequest("/api/v2/torrents/stop", {
    method: "POST",
    body: form,
    headers: form.getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error pausando torrent: ${res.status} - ${text}`);
  }

  return { success: true, message: "Torrent pausado" };
}

async function resumeTorrent(hash) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("hashes", hash);

  const res = await apiRequest("/api/v2/torrents/start", {
    method: "POST",
    body: form,
    headers: form.getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error reanudando torrent: ${res.status} - ${text}`);
  }

  return { success: true, message: "Torrent reanudado" };
}

/* =========================
   DELETE TORRENT
   Elimina un torrent
========================= */
async function deleteTorrent(hash, deleteFiles = false) {
  const FormData = require("form-data");
  const form = new FormData();
  
  form.append("hashes", hash);
  form.append("deleteFiles", deleteFiles ? "true" : "false");

  const res = await apiRequest("/api/v2/torrents/delete", {
    method: "POST",
    body: form,
    headers: form.getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error eliminando torrent: ${res.status} - ${text}`);
  }

  return { success: true, message: "Torrent eliminado" };
}

/* =========================
   GET PREFERENCES
   Obtiene configuración de qBittorrent
========================= */
async function getPreferences() {
  const res = await apiRequest("/api/v2/app/preferences");
  
  if (!res.ok) {
    throw new Error(`Error obteniendo preferencias: ${res.status}`);
  }

  const prefs = await res.json();
  
  // Devolver configuraciones relevantes
  return {
    max_seeding_time: prefs.max_seeding_time || -1, // -1 = ilimitado
    max_seeding_time_enabled: prefs.max_seeding_time_enabled || false,
  };
}

/* =========================
   SET PREFERENCES
   Configura límites de seedeo en qBittorrent
========================= */
async function setPreferences(settings) {
  const FormData = require("form-data");
  const form = new FormData();
  
  // Configurar tiempo máximo de seedeo (en minutos)
  if (settings.max_seeding_time !== undefined) {
    form.append("max_seeding_time", settings.max_seeding_time);
    form.append("max_seeding_time_enabled", settings.max_seeding_time > 0);
  }

  const res = await apiRequest("/api/v2/app/setPreferences", {
    method: "POST",
    body: `json=${encodeURIComponent(JSON.stringify({
      max_seeding_time: settings.max_seeding_time || -1,
      max_seeding_time_enabled: settings.max_seeding_time > 0
    }))}`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error configurando preferencias: ${res.status} - ${text}`);
  }

  return { success: true, message: "Configuración actualizada" };
}

/* =========================
   EXPORTS
========================= */
module.exports = {
  login,
  addTorrent,
  listTorrents,
  deleteTorrent,
  getPreferences,
  setPreferences,
  pauseTorrent,
  resumeTorrent,
};
