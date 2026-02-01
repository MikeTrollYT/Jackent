const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const JACKETT_URL = process.env.JACKETT_URL;
const JACKETT_API_KEY = process.env.JACKETT_API_KEY;

/* ======================================================
   Helpers: XML -> extracción "best effort"
====================================================== */

function pickFirst(match) {
  return match && match[1] != null ? match[1] : null;
}

// Intenta extraer CDATA o normal: <tag><![CDATA[x]]></tag> o <tag>x</tag>
function getTag(block, tag) {
  return (
    pickFirst(block.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`, "i"))) ||
    pickFirst(block.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`, "i")))
  );
}

// Extrae atributos torznab: <torznab:attr name="seeders" value="1" />
function getTorznabAttrs(block) {
  const out = {};
  const attrs = [...block.matchAll(/<torznab:attr\s+[^>]*name="([^"]+)"\s+value="([^"]*)"\s*\/>/gi)];
  for (const m of attrs) out[m[1]] = m[2];
  return out;
}

function getEnclosure(block) {
  const m = block.match(/<enclosure[^>]+url="([^"]+)"[^>]*?(?:type="([^"]+)")?[^>]*\/>/i);
  if (!m) return null;
  return {
    url: m[1] || null,
    type: m[2] || null,
  };
}

function getAllCategories(block) {
  // puede haber múltiples <category>...</category>
  const cats = [...block.matchAll(/<category>(.*?)<\/category>/gi)].map(m => m[1]).filter(Boolean);
  return cats.length ? cats : [];
}

function bestMagnet(block) {
  // Preferimos magnet en <link> o magneturl
  return (
    pickFirst(block.match(/<link>(magnet:\?[^<]+)<\/link>/i)) ||
    pickFirst(block.match(/name="magneturl"\s+value="(magnet:\?[^"]+)"/i))
  );
}

function bestTorrentUrl(block, magnet) {
  // Preferimos enclosure.url (torrent real). Si no hay, como fallback el <link> http(s)
  return (
    pickFirst(block.match(/<enclosure[^>]+url="([^"]+)"/i)) ||
    (!magnet ? pickFirst(block.match(/<link>(https?:\/\/[^<]+)<\/link>/i)) : null)
  );
}

/* ======================================================
   INDEXADORES CONFIGURADOS
====================================================== */
async function getIndexers() {
  if (!JACKETT_URL || !JACKETT_API_KEY) {
    throw new Error("Variables de entorno de Jackett no definidas");
  }

  const url =
    `${JACKETT_URL}/api/v2.0/indexers/all/results/torznab/api` +
    `?apikey=${JACKETT_API_KEY}&t=indexers&configured=true`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jackett HTTP ${res.status}`);

  const xml = await res.text();

  const blocks = [
    ...xml.matchAll(/<indexer\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/indexer>/gi),
  ];

  return blocks.map((m) => {
    const id = m[1];
    const inner = m[2];

    const name =
      (inner.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) ||
        inner.match(/<title>(.*?)<\/title>/i) ||
        [])[1];

    const description =
      (inner.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/i) ||
        inner.match(/<description>(.*?)<\/description>/i) ||
        [])[1];

    return {
      id,
      name: name || id,
      description: description || "",
    };
  });
}

/* ======================================================
   BÚSQUEDA TORZNAB
   - Mantiene campos actuales (para la web)
   - AÑADE raw con "todo" el item parseado (best-effort)
====================================================== */
async function search({ query, trackers }) {
  if (!query || !Array.isArray(trackers) || trackers.length === 0) return [];

  const results = [];

  for (const tracker of trackers) {
    const url =
      `${JACKETT_URL}/api/v2.0/indexers/${tracker}/results/torznab/api` +
      `?apikey=${JACKETT_API_KEY}&t=search&q=${encodeURIComponent(query)}`;

    let xml;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      xml = await res.text();
    } catch {
      continue;
    }

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];

    for (const it of items) {
      const block = it[1];

      // Título (imprescindible)
      const title = getTag(block, "title");
      if (!title) continue;

      // GUID
      const guid = getTag(block, "guid");

      // pubDate / comments / description / link
      const pubDate = getTag(block, "pubDate");
      const comments = getTag(block, "comments");
      const description = getTag(block, "description");
      const link = getTag(block, "link");

      // Tamaño
      const size =
        pickFirst(block.match(/<size>(\d+)<\/size>/i)) ||
        pickFirst(block.match(/name="size"\s+value="(\d+)"/i));

      // Torznab attrs
      const torznabAttrs = getTorznabAttrs(block);
      const seedersRaw = torznabAttrs.seeders || null;
      const seeders = seedersRaw != null ? Number(seedersRaw) : null;

      // enclosure / magnet / torrentUrl
      const enclosure = getEnclosure(block);
      const magnet = bestMagnet(block) || null;
      const torrentUrl = bestTorrentUrl(block, magnet) || null;

      // categorías (pueden repetirse)
      const categories = getAllCategories(block);
      const categoryAttrs = Object.keys(torznabAttrs)
        .filter(k => k === "category")
        .map(() => torznabAttrs.category)
        .filter(Boolean);

      // "raw" con el máximo de info útil SIN romper la web
      const raw = {
        // principales
        title,
        guid,
        link,
        comments,
        pubDate,
        description,

        // binario / descarga
        magnet,
        enclosure,          // {url,type} o null
        torrentUrl,         // mismo valor que devolvemos arriba

        // métricas
        size: size ? Number(size) : null,
        seeders,
        peers: torznabAttrs.peers != null ? Number(torznabAttrs.peers) : null,

        // extras torznab
        torznab: {
          attrs: torznabAttrs,
        },

        // categorías
        categories,
        categoryAttr: categoryAttrs,
      };

      results.push({
        id: `${tracker}-${results.length}`,
        tracker,
        trackerId: tracker,

        // lo que ya usa tu frontend:
        title,
        guid,
        sizeBytes: size ? Number(size) : null,
        seeders,
        magnet,
        torrentUrl,

        // NUEVO: “todo” el item parseado (para que puedas usarlo luego)
        raw,
      });
    }
  }

  return results;
}

module.exports = {
  getIndexers,
  search,
};
