/* Spine — album-spine shelf for Spotify + a local library */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem("spine:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("spine:" + k, JSON.stringify(v)); } catch {} },
};

const S = {
  albums: [],
  source: store.get("source", "all"),
  sort: store.get("sort", "artist"),
  search: "",
  status: null,
  open: null,              // album shown in sheet
};

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, init);
  if (r.status === 401 && path.startsWith("/api/") && !path.startsWith("/api/spotify")) { location.href = "/login"; throw new Error("login"); }
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.detail) || r.statusText);
  return data;
}

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const fmt = s => { if (!s && s !== 0) return ""; s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ======================================================== shelf */

function hueKey(hex) {
  const n = parseInt((hex || "#333333").slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 0.08) return 1000 + (1 - l); // greys after colours, light to dark
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60 + 360) % 360) + (1 - l) * 0.5;
}

function visibleAlbums() {
  const q = S.search.trim().toLowerCase();
  let list = S.albums.filter(a => (S.source === "all" || a.source === S.source) &&
    (!q || a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)));
  const by = {
    artist: (a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: "base" }) || (a.year || "").localeCompare(b.year || "") || a.title.localeCompare(b.title),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    year: (a, b) => (b.year || "0").localeCompare(a.year || "0") || a.artist.localeCompare(b.artist),
    added: (a, b) => (b.added_at || 0) - (a.added_at || 0),
    color: (a, b) => hueKey(a.color) - hueKey(b.color),
  }[S.sort];
  return list.sort(by);
}

function spineWidth(a, h) {
  const n = a.tracks || 10;
  const base = Math.min(64, Math.max(30, 24 + n * 2.3));
  return Math.round(base * Math.max(0.7, h / 300));
}

function render() {
  const h = store.get("shelfH", Math.round(Math.min(340, Math.max(220, innerHeight * 0.36))));
  document.documentElement.style.setProperty("--shelf-h", h + "px");
  document.body.classList.toggle("notext", !store.get("spineNames", true));

  const list = visibleAlbums();
  const box = $("#shelves");
  box.innerHTML = "";
  $("#empty").hidden = S.albums.length > 0;
  if (!list.length) return;

  const avail = box.clientWidth - 20;
  const rows = [[]];
  let used = 0;
  for (const a of list) {
    const w = spineWidth(a, h);
    if (used + w + 2 > avail && rows[rows.length - 1].length) { rows.push([]); used = 0; }
    rows[rows.length - 1].push([a, w]); used += w + 2;
  }

  const widest = Math.max(...rows.map(r => r.reduce((t, [, w]) => t + w + 2, 0)));
  const inset = Math.max(0, Math.floor((avail - widest) / 2));
  const playingId = Player.albumId();
  const frag = document.createDocumentFragment();
  rows.forEach((row, i) => {
    const shelf = document.createElement("div");
    shelf.className = "shelf";
    shelf.style.paddingLeft = inset + 10 + "px";
    if (S.sort === "artist") {
      const first = row[0][0].artist[0]?.toUpperCase() || "", last = row[row.length - 1][0].artist[0]?.toUpperCase() || "";
      shelf.innerHTML = `<div class="shelf-label">${esc(first === last ? first : first + " – " + last)}</div>`;
    }
    for (const [a, w] of row) {
      const el = document.createElement("div");
      el.className = "spine" + (a.hidden ? " hiddenalb" : "") + (a.id === playingId ? " playing" : "");
      el.style.cssText = `width:${w}px;--c:${a.color};--t:${a.text_color}`;
      el.dataset.id = a.id;
      el.title = `${a.artist} — ${a.title}`;
      el.innerHTML =
        (a.art ? `<div class="chip" style="background-image:url('${a.art.replace(/'/g, "%27")}')"></div>` : "") +
        `<div class="txt"><b>${esc(a.artist)}</b><span>${esc(a.title)}</span></div>` +
        `<div class="src">${a.source === "spotify" ? "●" : ""}</div>`;
      shelf.appendChild(el);
    }
    frag.appendChild(shelf);
  });
  box.appendChild(frag);
}

async function loadAlbums() {
  S.albums = await api(`/api/albums?include_hidden=${store.get("showHidden", false)}`);
  render();
}

$("#shelves").addEventListener("click", e => {
  const el = e.target.closest(".spine");
  if (!el) return;
  el.classList.add("lift");
  setTimeout(() => el.classList.remove("lift"), 260);
  openAlbum(el.dataset.id);
});

/* ======================================================== album sheet */

async function openAlbum(id) {
  const a = await api(`/api/albums/${id}`);
  S.open = a;
  $("#aCover").src = a.art || "";
  $("#aCover").style.background = a.color;
  $("#aTitle").textContent = a.title;
  $("#aArtist").textContent = a.artist + (a.year ? ` · ${a.year}` : "");
  $("#aSource").textContent = a.source === "spotify" ? "Spotify" : "Local library" + (a.art_status === "missing" ? " · no cover found" : "");
  $("#aHide").textContent = a.hidden ? "Show on shelf" : "Hide from shelf";
  $("#aMenu").hidden = true; $("#artForm").hidden = true;
  const multiDisc = new Set(a.track_list.map(t => t.disc_no || 1)).size > 1;
  $("#aTracks").innerHTML = a.track_list.map((t, i) =>
    `<li data-i="${i}" class="${Player.isTrack(t.id) ? "now" : ""}"><span class="n">${multiDisc ? (t.disc_no || 1) + "." : ""}${t.track_no || i + 1}</span>` +
    `<span class="tt">${esc(t.title)}${t.artist && t.artist !== a.artist ? ` <span style="color:var(--muted)">· ${esc(t.artist)}</span>` : ""}</span>` +
    `<span class="d">${fmt(t.duration)}</span></li>`).join("");
  $("#albumSheet").hidden = false;
}

$("#aTracks").addEventListener("click", e => {
  const li = e.target.closest("li"); if (!li) return;
  Player.playAlbum(S.open, +li.dataset.i);
});
$("#aPlay").onclick = () => Player.playAlbum(S.open, 0);
$("#aShuffle").onclick = () => Player.playAlbum(S.open, 0, true);
$("#aMore").onclick = () => ($("#aMenu").hidden = !$("#aMenu").hidden);
$("#aHide").onclick = async () => {
  await api(`/api/albums/${S.open.id}`, { method: "PATCH", body: { hidden: !S.open.hidden } });
  closeSheets(); loadAlbums();
};
$("#aFixArt").onclick = () => {
  const f = $("#artForm"); f.hidden = false; $("#aMenu").hidden = true;
  f.artist.value = S.open.artist; f.album.value = S.open.title; f.song.value = S.open.track_list[0]?.title || "";
  $("#artMsg").textContent = "";
};
$("#artForm").onsubmit = async e => {
  e.preventDefault();
  const f = e.target; $("#artMsg").textContent = "Searching…";
  try {
    const a = await api(`/api/albums/${S.open.id}/art/search`, { method: "POST", body: { artist: f.artist.value, album: f.album.value, song: f.song.value } });
    $("#artMsg").textContent = "Found it."; $("#aCover").src = a.art; loadAlbums();
  } catch (err) { $("#artMsg").textContent = err.message; }
};
$("#artFile").onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append("file", file);
  try {
    const a = await api(`/api/albums/${S.open.id}/art`, { method: "POST", body: fd });
    $("#aCover").src = a.art; $("#artMsg").textContent = "Updated."; loadAlbums();
  } catch (err) { $("#artMsg").textContent = err.message; }
};

/* ======================================================== player */

const audio = $("#audio");

const Player = {
  mode: null,          // 'local' | 'spotify'
  album: null,
  queue: [], index: 0,
  sp: null,            // last spotify state
  pollT: null,

  albumId() { return this.mode === "local" ? this.album?.id : this.sp?.album_id; },
  isTrack(id) { return this.mode === "local" && this.queue[this.index]?.id === id; },

  async playAlbum(album, index = 0, shuffle = false) {
    if (album.source === "spotify") return this.playSpotify(album, index, shuffle);
    if (this.mode === "spotify" && this.sp?.is_playing) api("/api/spotify/control", { method: "POST", body: { action: "pause" } }).catch(() => {});
    this.stopPolling();
    this.mode = "local"; this.album = album;
    let q = album.track_list.slice();
    if (shuffle) { for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; } index = 0; }
    this.queue = q; this.index = index;
    this.loadLocal(true);
    closeSheets();
  },

  loadLocal(autoplay) {
    const t = this.queue[this.index]; if (!t) return;
    audio.src = `/api/local/stream/${t.id}`;
    if (autoplay) audio.play().catch(err => toast("Tap play to start (" + err.message + ")"));
    this.ui({ title: t.title, artist: t.artist || this.album.artist, art: this.album.art, playing: true, device: "This screen" });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || this.album.artist, album: this.album.title,
        artwork: this.album.art ? [{ src: new URL(this.album.art, location.href).href, sizes: "1000x1000", type: "image/jpeg" }] : [] });
    }
    render();
  },

  async playSpotify(album, index, shuffle) {
    if (this.mode === "local") audio.pause();
    this.mode = "spotify"; this.album = album;
    const device_id = await Sdk.deviceForPlay();
    let offset = index;
    if (shuffle) offset = Math.floor(Math.random() * Math.max(1, album.track_list.length));
    try {
      await api("/api/spotify/play", { method: "POST", body: { uri: album.uri, offset, device_id } });
      closeSheets();
      this.ui({ title: album.track_list[offset]?.title || album.title, artist: album.artist, art: album.art, playing: true });
      this.startPolling();
    } catch (err) {
      if (/device/i.test(err.message)) openDevices(album, index);
      toast(err.message, 5000);
    }
  },

  toggle() {
    if (this.mode === "local") { audio.paused ? audio.play() : audio.pause(); }
    else if (this.mode === "spotify") {
      const action = this.sp?.is_playing ? "pause" : "resume";
      if (this.sp) this.sp.is_playing = !this.sp.is_playing;
      this.ui({ playing: this.sp?.is_playing });
      api("/api/spotify/control", { method: "POST", body: { action } }).catch(e => toast(e.message)).finally(() => this.pollSoon());
    }
  },
  next() {
    if (this.mode === "local") { if (this.index < this.queue.length - 1) { this.index++; this.loadLocal(true); } }
    else if (this.mode === "spotify") api("/api/spotify/control", { method: "POST", body: { action: "next" } }).catch(e => toast(e.message)).finally(() => this.pollSoon());
  },
  prev() {
    if (this.mode === "local") {
      if (audio.currentTime > 4 || this.index === 0) audio.currentTime = 0; else { this.index--; this.loadLocal(true); }
    } else if (this.mode === "spotify") api("/api/spotify/control", { method: "POST", body: { action: "previous" } }).catch(e => toast(e.message)).finally(() => this.pollSoon());
  },

  ui({ title, artist, art, playing, device, progress }) {
    $("#player").hidden = false;
    if (title !== undefined) $("#pTitle").textContent = title;
    if (artist !== undefined) $("#pArtist").textContent = artist;
    if (art !== undefined) $("#pCover").src = art || "";
    if (playing !== undefined) $("#pToggle").textContent = playing ? "⏸" : "▶";
    if (device !== undefined) $("#pDeviceName").textContent = device || "";
    if (progress !== undefined) $("#pBar").style.width = Math.min(100, progress * 100) + "%";
  },

  startPolling() { this.stopPolling(); this.poll(); this.pollT = setInterval(() => this.poll(), 3000); },
  stopPolling() { clearInterval(this.pollT); this.pollT = null; },
  pollSoon() { setTimeout(() => this.poll(), 600); },
  async poll() {
    if (this.mode !== "spotify" || document.hidden) return;
    try {
      const s = await api("/api/spotify/state");
      if (!s || !s.track) return;
      const changedAlbum = s.album_id !== this.sp?.album_id;
      this.sp = s;
      this.ui({ title: s.track, artist: s.artist, art: s.image, playing: s.is_playing, device: s.device,
        progress: s.duration_ms ? s.progress_ms / s.duration_ms : 0 });
      if (changedAlbum) render();
    } catch {}
  },
};

audio.addEventListener("ended", () => Player.next());
audio.addEventListener("play", () => Player.mode === "local" && Player.ui({ playing: true }));
audio.addEventListener("pause", () => Player.mode === "local" && Player.ui({ playing: false }));
audio.addEventListener("timeupdate", () => Player.mode === "local" && audio.duration && Player.ui({ progress: audio.currentTime / audio.duration }));
audio.addEventListener("error", () => { if (Player.mode === "local") { toast("Couldn't play this file in the browser, skipping"); setTimeout(() => Player.next(), 800); } });
$(".p-progress").addEventListener("click", e => {
  if (Player.mode !== "local" || !audio.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
});
$("#pToggle").onclick = () => Player.toggle();
$("#pNext").onclick = () => Player.next();
$("#pPrev").onclick = () => Player.prev();
$("#pCover").onclick = () => { const id = Player.albumId(); if (id) openAlbum(id).catch(() => {}); };
$("#pDevice").onclick = () => S.status?.spotify?.connected ? openDevices() : toast("Local music plays on this screen. Connect Spotify in Settings to pick other speakers.");
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => Player.toggle());
  navigator.mediaSession.setActionHandler("pause", () => Player.toggle());
  navigator.mediaSession.setActionHandler("nexttrack", () => Player.next());
  navigator.mediaSession.setActionHandler("previoustrack", () => Player.prev());
}

/* ======================================================== Spotify Web Playback SDK (optional) */

const Sdk = {
  player: null, deviceId: null, loading: null,
  enabled() { return store.get("sdk", false); },
  load() {
    if (!this.enabled() || this.loading) return this.loading;
    this.loading = new Promise(resolve => {
      window.onSpotifyWebPlaybackSDKReady = () => {
        this.player = new Spotify.Player({
          name: "Spine",
          getOAuthToken: cb => api("/api/spotify/token").then(r => cb(r.access_token)).catch(() => {}),
          volume: 0.8,
        });
        this.player.addListener("ready", ({ device_id }) => { this.deviceId = device_id; resolve(device_id); });
        this.player.addListener("not_ready", () => { this.deviceId = null; });
        this.player.addListener("initialization_error", ({ message }) => { toast("Spotify player: " + message); resolve(null); });
        this.player.addListener("authentication_error", ({ message }) => { toast("Spotify auth: " + message); resolve(null); });
        this.player.addListener("account_error", () => { toast("Playing in the browser needs Spotify Premium"); resolve(null); });
        this.player.connect();
        setTimeout(() => resolve(this.deviceId), 8000);
      };
      const s = document.createElement("script"); s.src = "https://sdk.scdn.co/spotify-player.js"; document.head.appendChild(s);
    });
    return this.loading;
  },
  async deviceForPlay() {
    const chosen = store.get("device", null);
    if (chosen && chosen !== "sdk") return chosen;
    if (this.enabled()) {
      try { this.player?.activateElement?.(); } catch {}
      return (await this.load()) || undefined;
    }
    return undefined; // server uses the active device, or the first one available
  },
};

async function openDevices(retryAlbum, retryIndex) {
  $("#deviceSheet").hidden = false;
  const list = $("#deviceList");
  list.innerHTML = '<div class="hint">Loading…</div>';
  let devs = [];
  try { devs = await api("/api/spotify/devices"); } catch (e) { list.innerHTML = `<div class="hint">${esc(e.message)}</div>`; return; }
  const chosen = store.get("device", null);
  const items = [];
  if (Sdk.enabled()) items.push({ id: "sdk", name: "This screen (browser)", type: "Spine" });
  for (const d of devs) if (d.id !== Sdk.deviceId) items.push({ id: d.id, name: d.name, type: d.type, active: d.is_active });
  if (!items.length) { list.innerHTML = '<div class="hint">No Spotify devices are online.</div>'; return; }
  list.innerHTML = "";
  for (const d of items) {
    const b = document.createElement("button");
    b.className = (chosen === d.id || (!chosen && d.active)) ? "on" : "";
    b.innerHTML = `<span>${esc(d.name)}</span><span class="hint">${esc(d.type)}${d.active ? " · active" : ""}</span>`;
    b.onclick = async () => {
      store.set("device", d.id);
      $("#deviceSheet").hidden = true;
      if (retryAlbum) return Player.playSpotify(retryAlbum, retryIndex || 0);
      if (Player.mode === "spotify") {
        const id = d.id === "sdk" ? await Sdk.load() : d.id;
        if (id) api("/api/spotify/transfer", { method: "POST", body: { device_id: id } }).then(() => Player.pollSoon()).catch(e => toast(e.message));
      }
      toast(`Playing on ${d.name}`);
    };
    list.appendChild(b);
  }
}
$("#devRefresh").onclick = () => openDevices();

/* ======================================================== settings + status */

function openSettings() {
  $("#settingsSheet").hidden = false;
  $("#showHidden").checked = store.get("showHidden", false);
  $("#spineNames").checked = store.get("spineNames", true);
  $("#sdkToggle").checked = Sdk.enabled();
  $("#shelfH").value = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--shelf-h")) || 300;
  refreshStatus();
}
window.openSettings = openSettings;

function renderStatus(st) {
  const sp = st.spotify, lib = st.library;
  const spBtns = $("#spButtons"); spBtns.innerHTML = "";
  $("#spAdd").hidden = !sp.connected; $("#sdkRow").hidden = !sp.connected;
  if (!sp.configured) {
    $("#spStatus").innerHTML = `Not configured. Create an app at developer.spotify.com, add the redirect URI <code>${esc(sp.redirect_uri)}</code>, then set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET and restart.`;
  } else if (!sp.connected) {
    $("#spStatus").textContent = "Not connected.";
    spBtns.innerHTML = `<button class="primary" onclick="location.href='/auth/spotify/login'">Connect Spotify</button>`;
  } else {
    $("#spStatus").textContent = sp.syncing ? `Syncing… ${sp.albums} albums` :
      `Connected · ${S.albums.filter(a => a.source === "spotify").length} albums` + (sp.error ? ` · last sync error: ${sp.error}` : "");
    spBtns.innerHTML = `<button id="spSync">Sync saved albums</button><button id="spOff">Disconnect</button>`;
    $("#spSync").onclick = () => api("/api/spotify/sync", { method: "POST" }).then(watchStatus);
    $("#spOff").onclick = async () => { if (confirm("Disconnect Spotify and remove its albums from the shelf?")) { await api("/api/spotify/disconnect", { method: "POST" }); loadAlbums(); refreshStatus(); } };
  }
  $("#libStatus").textContent = lib.error ? lib.error :
    lib.scanning ? `${lib.phase}… ${lib.phase === "finding artwork" ? `${lib.art_done}/${lib.art_total}` : `${lib.files} files`}` :
    `${lib.albums} albums from ${lib.files} files in ${st.music_dir}` + (lib.last_scan ? ` · scanned ${new Date(lib.last_scan * 1000).toLocaleString()}` : "");

  const busy = lib.scanning || sp.syncing;
  const t = $("#scanToast");
  t.hidden = !busy;
  if (busy) t.textContent = lib.scanning ? `Library: ${lib.phase}${lib.art_total ? ` ${lib.art_done}/${lib.art_total}` : ""}` : `Spotify: syncing ${sp.albums} albums`;
}

async function refreshStatus() {
  try { S.status = await api("/api/status"); renderStatus(S.status); return S.status; } catch { return null; }
}

let watchT = null;
function watchStatus() {
  if (watchT) return;
  let wasBusy = true, ticks = 0;
  watchT = setInterval(async () => {
    const st = await refreshStatus(); if (!st) return;
    const busy = st.library.scanning || st.spotify.syncing;
    if (++ticks % 5 === 0 && busy) loadAlbums();   // show progress on the shelf while scanning
    if (!busy && wasBusy) { clearInterval(watchT); watchT = null; loadAlbums(); }
    wasBusy = busy;
  }, 1500);
}

$("#settingsBtn").onclick = openSettings;
$("#rescanBtn").onclick = () => api("/api/library/rescan", { method: "POST" }).then(watchStatus);
$("#refetchBtn").onclick = () => { if (confirm("Look up artwork again for every local album? Albums with embedded or folder art keep it.")) api("/api/library/rescan?force_art=true", { method: "POST" }).then(watchStatus); };
$("#spAddBtn").onclick = async () => {
  try { const a = await api("/api/spotify/add", { method: "POST", body: { link: $("#spLink").value } }); $("#spLink").value = ""; toast(`Added ${a.title}`); loadAlbums(); }
  catch (e) { toast(e.message); }
};
$("#sdkToggle").onchange = e => { store.set("sdk", e.target.checked); if (e.target.checked) Sdk.load(); else store.set("device", null); };
$("#showHidden").onchange = e => { store.set("showHidden", e.target.checked); loadAlbums(); };
$("#spineNames").onchange = e => { store.set("spineNames", e.target.checked); render(); };
$("#shelfH").oninput = e => { store.set("shelfH", +e.target.value); render(); };

/* ======================================================== top bar */

$$("#sourceSeg button").forEach(b => {
  b.classList.toggle("on", b.dataset.source === S.source);
  b.onclick = () => { S.source = b.dataset.source; store.set("source", S.source); $$("#sourceSeg button").forEach(x => x.classList.toggle("on", x === b)); render(); };
});
$("#sort").value = S.sort;
$("#sort").onchange = e => { S.sort = e.target.value; store.set("sort", S.sort); render(); };
let searchT;
$("#search").oninput = e => { clearTimeout(searchT); searchT = setTimeout(() => { S.search = e.target.value; render(); }, 120); };

function closeSheets() { $$(".sheet").forEach(s => (s.hidden = true)); }
document.addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheets(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeSheets();
  if (e.key === " " && !e.target.matches("input,select,textarea")) { e.preventDefault(); Player.toggle(); }
});

/* ======================================================== wall mode (kiosk) */

let wakeLock = null, peekT;
async function setWall(on) {
  document.body.classList.toggle("wallmode", on);
  store.set("wall", on);
  if (on) {
    try { await document.documentElement.requestFullscreen?.({ navigationUI: "hide" }); } catch {}
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
    peek();
  } else {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    wakeLock?.release?.().catch?.(() => {}); wakeLock = null;
  }
  setTimeout(render, 300);
}
function peek() {
  if (!document.body.classList.contains("wallmode")) return;
  document.body.classList.add("peek");
  clearTimeout(peekT); peekT = setTimeout(() => document.body.classList.remove("peek"), 5000);
}
$("#wallBtn").onclick = () => setWall(!document.body.classList.contains("wallmode"));
$("#wall").addEventListener("click", e => { if (!e.target.closest(".spine")) peek(); });
$("#player").addEventListener("click", peek);
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.body.classList.contains("wallmode")) setWall(false); });
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden) {
    if (document.body.classList.contains("wallmode") && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
    if (Player.mode === "spotify") Player.poll();
  }
});

let resizeT;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(render, 150); });

/* ======================================================== boot */

(async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get("spotify") === "connected") toast("Spotify connected — syncing your albums");
  if (params.get("spotify_error")) toast("Spotify: " + params.get("spotify_error"), 6000);
  if (params.toString()) history.replaceState(null, "", "/");

  await loadAlbums();
  const st = await refreshStatus();
  if (st && (st.library.scanning || st.spotify.syncing || params.get("spotify"))) watchStatus();
  if (st?.spotify.connected) {
    if (Sdk.enabled()) Sdk.load();
    try {   // pick up whatever is already playing on Spotify
      const s = await api("/api/spotify/state");
      if (s && s.track) { Player.mode = "spotify"; Player.startPolling(); }
    } catch {}
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
