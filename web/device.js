/* Album Viewer: music on this computer. Nothing is uploaded: the browser reads a folder you choose
   (Chrome and Edge keep it between visits) or files you open for this visit, groups the tracks into
   albums from their tags (or their folders), and plays them from the disk.

   Loaded on demand by app.js with import("/device.js"). */

const AUDIO = /\.(mp3|m4a|mp4|aac|flac|ogg|oga|opus|wav)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const COVER_NAMES = /^(cover|folder|front|album|albumart)\b/i;

export const canKeepFolder = () => typeof window.showDirectoryPicker === "function";

/* ---------------------------------------------------------------- a little IndexedDB */

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("albumviewer-device", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("kv", mode), s = t.objectStore("kv"), req = fn(s);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const get = key => kv("readonly", s => s.get(key));
const put = (key, value) => kv("readwrite", s => s.put(value, key));
const del = key => kv("readwrite", s => s.delete(key));

/* ---------------------------------------------------------------- the folder */

let root = null;            // the chosen folder's handle
let loose = new Map();      // files opened for this visit only, by path

/** The folder chosen on an earlier visit, its albums as last scanned, and whether the browser still
 *  lets us read it without asking ("granted"), or must ask first ("prompt"). */
export async function restore() {
  if (!canKeepFolder()) return null;
  try {
    const handle = await get("folder");
    if (!handle) return null;
    root = handle;
    const index = await get("index");
    return { folder: handle.name, permission: await handle.queryPermission({ mode: "read" }), ...(index || { albums: [], details: {} }) };
  } catch { return null; }
}

/** Ask again for a folder chosen before (needs a click). */
export async function reconnect() {
  return !!root && (await root.requestPermission({ mode: "read" })) === "granted";
}

export async function chooseFolder(onProgress) {
  const handle = await window.showDirectoryPicker({ id: "albumviewer-music", mode: "read" });
  root = handle;
  await put("folder", handle);
  return scanFolder(onProgress);
}

export async function forget() {
  root = null; loose = new Map();
  await del("folder"); await del("index");
}

async function* walk(dir, path = "") {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith(".")) continue;
    if (h.kind === "directory") yield* walk(h, path + name + "/");
    else yield { path: path + name, handle: h };
  }
}

export async function scanFolder(onProgress) {
  if (!root) throw new Error("No folder chosen");
  const entries = [];
  for await (const e of walk(root)) {
    if (AUDIO.test(e.path) || IMAGE.test(e.path)) entries.push({ path: e.path, getFile: () => e.handle.getFile() });
  }
  const index = await build(entries, onProgress);
  index.folder = root.name;
  await put("index", index);
  return index;
}

/** Files picked for this visit (browsers that can't keep a folder). */
export async function openFiles(fileList, onProgress) {
  loose = new Map();
  const entries = [];
  for (const f of fileList) {
    const path = f.webkitRelativePath || f.name;
    if (!AUDIO.test(path) && !IMAGE.test(path)) continue;
    loose.set(path, f);
    entries.push({ path, getFile: async () => f });
  }
  return build(entries, onProgress);
}

/** A playable address for a track: read from the disk now, not copied anywhere. */
export async function trackUrl(track) {
  let file = loose.get(track.path);
  if (!file) {
    if (!root) throw new Error("The music folder isn't connected");
    let dir = root;
    const parts = track.path.split("/");
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
  }
  return URL.createObjectURL(file);
}

/* ---------------------------------------------------------------- albums from files */

function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }
const folderOf = p => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const baseName = p => p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

async function build(entries, onProgress = () => {}) {
  const images = new Map();   // folder -> cover image entry
  for (const e of entries) {
    if (!IMAGE.test(e.path)) continue;
    const f = folderOf(e.path), better = COVER_NAMES.test(baseName(e.path));
    if (!images.has(f) || (better && !COVER_NAMES.test(baseName(images.get(f).path)))) images.set(f, e);
  }
  const groups = new Map();
  const audio = entries.filter(e => AUDIO.test(e.path));
  let done = 0;
  for (const e of audio) {
    let file, tags = {};
    try { file = await e.getFile(); tags = await readTags(file); } catch {}
    const folder = folderOf(e.path), parts = folder.split("/").filter(Boolean);
    const fromName = baseName(e.path).match(/^(?:(\d{1,2})[-.]?)?(\d{1,3})?[\s._-]*(?:-\s*)?(.*)$/) || [];
    const album = tags.album || parts[parts.length - 1] || "Unknown Album";
    const artist = tags.albumArtist || tags.artist || parts[parts.length - 2] || "Unknown Artist";
    const key = `${artist.toLowerCase()}|${album.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { album, artist, folder, tracks: [], pic: null, year: null, modified: 0 });
    const g = groups.get(key);
    g.tracks.push({
      id: "devt_" + fnv(e.path), path: e.path,
      title: tags.title || fromName[3] || baseName(e.path),
      artist: tags.artist || artist,
      track_no: tags.track || (fromName[2] ? +fromName[2] : fromName[1] ? +fromName[1] : null),
      disc_no: tags.disc || 1, duration: null,
    });
    g.pic ||= tags.picture || null;
    g.year ||= tags.year || null;
    g.modified = Math.max(g.modified, file?.lastModified || 0);
    if (++done % 25 === 0 || done === audio.length) onProgress(done, audio.length);
  }
  const albums = [], details = {};
  for (const g of groups.values()) {
    let art = g.pic;
    if (!art && images.has(g.folder)) { try { art = await images.get(g.folder).getFile(); } catch {} }
    const id = "dev_" + fnv(`${g.artist}|${g.album}`.toLowerCase());
    const [color, text] = art ? await colorsOf(art) : placeholder(id);
    g.tracks.sort((a, b) => (a.disc_no - b.disc_no) || ((a.track_no ?? 999) - (b.track_no ?? 999)) || a.path.localeCompare(b.path));
    const a = { id, source: "device", kind: "album", title: g.album, artist: g.artist, year: g.year, color, text_color: text,
                artBlob: art || null, tracks: g.tracks.length, added_at: g.modified / 1000 || null };
    albums.push(a);
    details[id] = g.tracks;
  }
  return { albums, details, scannedAt: Date.now() };
}

/* ---------------------------------------------------------------- colours */

async function colorsOf(blob) {
  try {
    const bmp = await createImageBitmap(blob, { resizeWidth: 24, resizeHeight: 24 });
    const c = new OffscreenCanvas(24, 24).getContext("2d");
    c.drawImage(bmp, 0, 0);
    const d = c.getImageData(0, 0, 24, 24).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const w = 1 + (mx - mn) / 32;   // colourful pixels count for more than greys
      r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
    }
    r /= n; g /= n; b /= n;
    const hex = "#" + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
    return [hex, (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#141414" : "#f4f1ea"];
  } catch { return placeholder(String(blob.size)); }
}

function placeholder(seed) {   // a muted colour of its own, as hex (the colour sort reads hex)
  let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360, s = 0.28, l = 0.26, k = n => (n + hue / 30) % 12;
  const f = n => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return ["#" + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join(""), "#f4f1ea"];
}

/* ---------------------------------------------------------------- tags: ID3, MP4, FLAC */

async function readTags(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const str = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (str(head, 0, 3) === "ID3") return id3(file, head);
  if (str(head, 0, 4) === "fLaC") return flac(file);
  if (str(head, 4, 4) === "ftyp") return mp4(file);
  return {};
}

const syncsafe = (b, i) => (b[i] & 127) << 21 | (b[i + 1] & 127) << 14 | (b[i + 2] & 127) << 7 | (b[i + 3] & 127);
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const num = s => { const m = /^\s*(\d+)/.exec(s || ""); return m ? +m[1] : null; };
const clean = s => (s || "").replace(/\0+$/g, "").split("\0")[0].trim();

function decodeText(enc, bytes) {
  const label = ["latin1", "utf-16", "utf-16be", "utf-8"][enc] || "latin1";
  try { return clean(new TextDecoder(label).decode(bytes)); } catch { return ""; }
}

async function id3(file, head) {
  const v = head[3], flags = head[5], size = syncsafe(head, 6);
  let b = new Uint8Array(await file.slice(0, 10 + size).arrayBuffer());
  if (flags & 0x80 && v < 4) {   // unsynchronised: FF 00 stands for FF
    const out = []; for (let i = 0; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xff && b[i + 1] === 0) i++; }
    b = Uint8Array.from(out);
  }
  let p = 10;
  if (flags & 0x40 && v >= 3) p += v === 4 ? syncsafe(b, 10) : be32(b, 10) + 4;
  const idLen = v === 2 ? 3 : 4, hdr = v === 2 ? 6 : 10, t = {};
  const names = v === 2 ? { TT2: "title", TP1: "artist", TP2: "albumArtist", TAL: "album", TRK: "track", TPA: "disc", TYE: "year" }
                         : { TIT2: "title", TPE1: "artist", TPE2: "albumArtist", TALB: "album", TRCK: "track", TPOS: "disc", TYER: "year", TDRC: "year" };
  while (p + hdr <= b.length) {
    const id = String.fromCharCode(...b.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const len = v === 2 ? (b[p + 3] << 16 | b[p + 4] << 8 | b[p + 5]) : v === 4 ? syncsafe(b, p + 4) : be32(b, p + 4);
    const data = b.subarray(p + hdr, p + hdr + len);
    if (names[id] && data.length) t[names[id]] = decodeText(data[0], data.subarray(1));
    if ((id === "APIC" || id === "PIC") && !t.picture && data.length > 4) t.picture = id3Picture(data, v);
    p += hdr + len;
  }
  return { ...t, track: num(t.track), disc: num(t.disc), year: num(t.year) ? String(num(t.year)) : null };
}

function id3Picture(d, v) {
  const enc = d[0];
  let i = 1, mime;
  if (v === 2) { const fmt = String.fromCharCode(d[1], d[2], d[3]); mime = fmt === "PNG" ? "image/png" : "image/jpeg"; i = 4; }
  else { const end = d.indexOf(0, 1); mime = String.fromCharCode(...d.subarray(1, end)) || "image/jpeg"; i = end + 1; }
  i++;   // picture type
  if (enc === 1 || enc === 2) { while (i + 1 < d.length && !(d[i] === 0 && d[i + 1] === 0)) i += 2; i += 2; }
  else { while (i < d.length && d[i] !== 0) i++; i++; }
  if (!mime.includes("/")) mime = "image/" + mime.toLowerCase().replace("jpg", "jpeg");
  return new Blob([d.subarray(i)], { type: mime });
}

async function flac(file) {
  const t = {};
  let p = 4;
  for (let n = 0; n < 64; n++) {
    const h = new Uint8Array(await file.slice(p, p + 4).arrayBuffer());
    if (h.length < 4) break;
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = h[1] << 16 | h[2] << 8 | h[3];
    if (type === 4 || (type === 6 && !t.picture)) {
      const d = new Uint8Array(await file.slice(p + 4, p + 4 + len).arrayBuffer());
      if (type === 4) {   // Vorbis comments, little-endian
        let i = 4 + le32(d, 0);
        const count = le32(d, i); i += 4;
        const dec = new TextDecoder("utf-8");
        for (let k = 0; k < count && i < d.length; k++) {
          const l = le32(d, i); i += 4;
          const [key, ...rest] = dec.decode(d.subarray(i, i + l)).split("="); i += l;
          const val = rest.join("="), K = key.toUpperCase();
          const map = { TITLE: "title", ARTIST: "artist", ALBUMARTIST: "albumArtist", "ALBUM ARTIST": "albumArtist", ALBUM: "album", TRACKNUMBER: "track", DISCNUMBER: "disc", DATE: "year" };
          if (map[K] && !t[map[K]]) t[map[K]] = val.trim();
        }
      } else {            // PICTURE, big-endian
        let i = 4;
        const ml = be32(d, i); i += 4;
        const mime = String.fromCharCode(...d.subarray(i, i + ml)); i += ml;
        const dl = be32(d, i); i += 4 + dl + 16;
        const size = be32(d, i); i += 4;
        t.picture = new Blob([d.subarray(i, i + size)], { type: mime || "image/jpeg" });
      }
    }
    p += 4 + len;
    if (last) break;
  }
  return { ...t, track: num(t.track), disc: num(t.disc), year: num(t.year) ? String(num(t.year)) : null };
}

async function mp4(file) {
  // Find the top-level 'moov' atom (often at the start, sometimes after the audio), then its tags.
  let p = 0, moov = null;
  for (let n = 0; n < 64 && p < file.size; n++) {
    const h = new Uint8Array(await file.slice(p, p + 16).arrayBuffer());
    if (h.length < 8) break;
    let size = be32(h, 0), head = 8;
    const type = String.fromCharCode(...h.subarray(4, 8));
    if (size === 1) { size = be32(h, 8) * 2 ** 32 + be32(h, 12); head = 16; }
    else if (size === 0) size = file.size - p;
    if (size < head) break;
    if (type === "moov") { moov = new Uint8Array(await file.slice(p + head, p + size).arrayBuffer()); break; }
    p += size;
  }
  if (!moov) return {};
  const child = (b, name, from = 0, to = b.length) => {
    for (let i = from; i + 8 <= to;) {
      const size = be32(b, i), type = String.fromCharCode(...b.subarray(i + 4, i + 8));
      if (size < 8) return null;
      if (type === name) return [i + 8, i + size];
      i += size;
    }
    return null;
  };
  const udta = child(moov, "udta"), meta = udta && child(moov, "meta", ...udta);
  const ilst = meta && child(moov, "ilst", meta[0] + 4, meta[1]);   // 'meta' has 4 bytes of version and flags first
  if (!ilst) return {};
  const t = {}, dec = new TextDecoder("utf-8");
  const names = { "©nam": "title", "©ART": "artist", "aART": "albumArtist", "©alb": "album", "©day": "year" };
  for (let i = ilst[0]; i + 8 <= ilst[1];) {
    const size = be32(moov, i);
    if (size < 8) break;
    const key = String.fromCharCode(moov[i + 4]) === "\xa9" ? "©" + String.fromCharCode(...moov.subarray(i + 5, i + 8))
                                                              : String.fromCharCode(...moov.subarray(i + 4, i + 8));
    const data = child(moov, "data", i + 8, i + size);
    if (data) {
      const payload = moov.subarray(data[0] + 8, data[1]), kind = be32(moov, data[0]) & 0xffffff;
      if (names[key]) t[names[key]] = clean(dec.decode(payload));
      else if (key === "trkn" && payload.length >= 4) t.track = payload[3] || null;
      else if (key === "disk" && payload.length >= 4) t.disc = payload[3] || null;
      else if (key === "covr" && !t.picture) t.picture = new Blob([payload], { type: kind === 14 ? "image/png" : "image/jpeg" });
    }
    i += size;
  }
  return { ...t, year: num(t.year) ? String(num(t.year)) : null };
}
