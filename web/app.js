/* Album Viewer — your albums as a row of spines on a wall display. Spotify, a local library, or the demo shelf. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {   // settings saved before the rename (under "spine:") are still read
  get(k, d) {
    try { const v = localStorage.getItem("albumviewer:" + k) ?? localStorage.getItem("spine:" + k); return v === null ? d : JSON.parse(v); }
    catch { return d; }
  },
  set(k, v) { try { localStorage.setItem("albumviewer:" + k, JSON.stringify(v)); } catch {} },
};

const S = {
  albums: [],
  byId: new Map(),
  els: new Map(),          // album id -> spine element
  list: [],                // albums currently on the row, in order
  source: store.get("source", "all"),
  sort: store.get("sort", "artist"),
  search: "",
  status: null,
  openId: null,            // album pulled open on the shelf
  sheet: null,             // album shown in the details sheet
  details: new Map(),      // id -> album with track_list
  H: 300,                  // screen height in px
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
  const t = $("#toast"); t.textContent = msg; reveal(t, true);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => reveal(t, false), ms);
}
const fmt = s => { if (!s && s !== 0) return ""; s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const icon = name => `<svg><use href="#i-${name}"/></svg>`;
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

/* ======================================================== motion
   The curves and the album-opening duration live in style.css. Scripted motion (scrolling the row,
   the cover flying into the album sheet, neighbours sliding while arranging) reads them from there,
   so it moves in step with the CSS. */

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const cssVal = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const cssMs = name => parseFloat(cssVal(name)) || 0;

function bezier(x1, y1, x2, y2) {   // CSS cubic-bezier() as a function of progress 0..1
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = t => ((ax * t + bx) * t + cx) * t, Y = t => ((ay * t + by) * t + cy) * t;
  const dX = t => (3 * ax * t + 2 * bx) * t + cx;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {   // Newton, then bisection if it stalls
      const e = X(t) - x;
      if (Math.abs(e) < 1e-5) return Y(t);
      const d = dX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1; t = x;
    while (hi - lo > 1e-5) { if (X(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return Y(t);
  };
}
const easeCache = new Map();
function cssEase(name) {
  const v = cssVal(name);
  if (!easeCache.has(v)) easeCache.set(v, bezier(...(v.match(/-?[\d.]+/g) || [0, 0, 1, 1]).map(Number)));
  return easeCache.get(v);
}

/* Show or hide an element that starts [hidden], animated by CSS transitions keyed on .in.
   Interruptible: showing it again while it is leaving reverses from wherever it is. */
function reveal(el, show, exitMs = 160) {
  clearTimeout(el._hideT);
  if (show) {
    if (el.hidden) { el.hidden = false; void el.offsetWidth; }
    el.classList.add("in");
  } else if (!el.hidden) {
    el.classList.remove("in");
    el._hideT = setTimeout(() => (el.hidden = true), reduceMotion.matches ? 0 : exitMs);
  }
}

/* The shelf runs left to right, or top to bottom on phones (S.vertical). These read and write
   positions along whichever way it runs, so the rest of the code doesn't care. */
const ROW = document.getElementById("row");
const ax = {
  pos: () => (S.vertical ? ROW.scrollTop : ROW.scrollLeft),
  set: v => { if (S.vertical) ROW.scrollTop = v; else ROW.scrollLeft = v; },
  view: () => (S.vertical ? ROW.clientHeight : ROW.clientWidth),
  total: () => (S.vertical ? ROW.scrollHeight : ROW.scrollWidth),
  start: el => (S.vertical ? el.offsetTop : el.offsetLeft),
  rStart: r => (S.vertical ? r.top : r.left),
  rSize: r => (S.vertical ? r.height : r.width),
  rEnd: r => (S.vertical ? r.bottom : r.right),
  client: e => (S.vertical ? e.clientY : e.clientX),
  shift: d => (S.vertical ? `0 ${d}px` : `${d}px 0`),
};
// A short tick under the finger. Browsers allow it only after the person has touched the page.
const haptic = (ms = 8) => { try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(ms); } catch {} };

/* FLIP: run `mutate` (which moves elements in the layout), then slide each of `els` from where it
   was to where it now is. Uses `translate`, so a `transform` set by CSS (the lifted spine) is kept. */
function flip(els, mutate, ms = 200) {
  if (reduceMotion.matches) return mutate();
  const before = els.map(el => ax.rStart(el.getBoundingClientRect()));
  mutate();
  for (const el of els) for (const an of el.getAnimations()) if (an.id === "flip") an.cancel();
  const after = els.map(el => ax.rStart(el.getBoundingClientRect()));
  const easing = cssVal("--ease-out");
  els.forEach((el, i) => {
    const d = before[i] - after[i];
    if (Math.abs(d) > 0.5) el.animate([{ translate: ax.shift(d) }, { translate: "0 0" }], { duration: ms, easing, id: "flip" });
  });
}

/* ======================================================== arranging */

const artistKey = s => (s || "").replace(/^the\s+/i, "").trim();
/* Who an album is by, for sorting and the A-Z rail. A playlist goes by its own name: the shelf
   doesn't show who made it. */
const byName = a => a.kind === "playlist" ? a.title : a.artist;
const cmp = (a, b) => (a || "").localeCompare(b || "", undefined, { sensitivity: "base", numeric: true });

function hueKey(hex) {
  const n = parseInt((hex || "#333333").slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 0.08) return 1000 + (1 - l); // greys after colours, light to dark
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60 + 360) % 360) + (1 - l) * 0.5;
}

const SORTS = {
  artist: (a, b) => cmp(artistKey(byName(a)), artistKey(byName(b))) || cmp(a.year, b.year) || cmp(a.title, b.title),
  decade: (a, b) => cmp(a.year || "9999", b.year || "9999") || cmp(artistKey(byName(a)), artistKey(byName(b))),
  added: (a, b) => (b.added_at || 0) - (a.added_at || 0),
  title: (a, b) => cmp(a.title, b.title),
  color: (a, b) => hueKey(a.color) - hueKey(b.color),
  manual: (a, b) => (a.pos ?? 1e9) - (b.pos ?? 1e9) || SORTS.artist(a, b),
};

const inSource = a => S.source === "all" || (S.source === "playlist" ? a.kind === "playlist" :
  S.source === "local" ? a.source === "local" || a.source === "device" : a.source === S.source);
function visibleAlbums() {
  const q = S.search.trim().toLowerCase();
  return S.albums.filter(a => inSource(a) &&
    (!q || a.title.toLowerCase().includes(q) || (a.kind !== "playlist" && a.artist.toLowerCase().includes(q)))).sort(SORTS[S.sort]);
}

function indexKey(a) {
  if (S.sort === "artist" || S.sort === "title") {
    const c = (S.sort === "artist" ? artistKey(byName(a)) : a.title.replace(/^the\s+/i, "")).normalize("NFKD")[0]?.toUpperCase() || "#";
    return /[A-Z]/.test(c) ? c : "#";
  }
  if (S.sort === "decade") return a.year ? `${a.year.slice(0, 3)}0s` : "Undated";
  return null;
}

/* ======================================================== the display */

function layout() {
  const screen = $("#screen"), device = $("#device"), room = $("#room");
  const shape = store.get("shape", "bar");
  const aspect = shape === "wide" ? 3.2 : 5.33;
  // Phones: the shelf turns 90 degrees and fills the screen; an open album is a square as wide as it.
  S.vertical = matchMedia("(max-width: 600px)").matches;
  document.body.classList.toggle("vertical", S.vertical);
  if (S.vertical) {
    screen.style.height = "";
    S.H = Math.round(screen.clientWidth) || 300;
    document.documentElement.style.setProperty("--screen-h", S.H + "px");
    return;
  }
  if (document.body.classList.contains("wallmode")) {
    // Edge to edge. A stretched-bar display fills naturally; on a tablet the bar is letterboxed
    // unless the shape is "fill".
    const vw = room.clientWidth || innerWidth, vh = room.clientHeight || innerHeight;
    S.H = Math.round(shape === "fill" ? vh : Math.min(vh, vw / aspect));
  } else {
    const pad = parseFloat(getComputedStyle(device).paddingTop) * 2 || 0;
    const width = device.clientWidth - pad;
    const avail = room.clientHeight - 140 - pad;
    const want = shape === "fill" ? avail : width / aspect;
    const floor = Math.min(220, Math.max(130, width * 0.6));   // phones: keep spines wide enough to read
    S.H = Math.round(Math.max(floor, Math.min(want, avail)));
  }
  screen.style.height = S.H + "px";
  document.documentElement.style.setProperty("--screen-h", S.H + "px");
}

function spineWidth(a) {
  const n = a.tracks || 10;
  const f = n <= 6 ? 0.8 : n <= 16 ? 1 : n <= 24 ? 1.4 : 1.8;
  const jitter = 0.92 + (hash(a.id) % 100) / 100 * 0.16;
  return Math.max(9, Math.round(S.H / 12.5 * f * jitter));
}

function makeSpine(a) {
  const w = spineWidth(a), h = hash(a.id + a.title);
  const el = document.createElement("button");
  el.className = "spine" + (h % 3 === 0 ? " band" : "") + (h % 5 === 1 ? " serif" : "") +
    (a.hidden ? " hiddenalb" : "") + (w < 13 ? " tiny" : "") + (a.kind === "playlist" ? " playlist" : "");
  const fs = S.vertical ? clamp(w * 0.42, 9, 15) : clamp(w * 0.37, 7, 13);   // text runs along the spine
  el.style.cssText = `--w:${w}px;--c:${a.color};--t:${a.text_color};--fs:${fs.toFixed(1)}px`;
  el.dataset.id = a.id;
  el.dataset.w = w;
  el.setAttribute("role", "listitem");
  const list = a.kind === "playlist";
  el.setAttribute("aria-label", list ? `${a.title}, playlist` : `${a.artist}, ${a.title}`);
  el.title = list ? a.title : `${a.artist} — ${a.title}${a.year ? ` (${a.year})` : ""}`;
  el.innerHTML = `<span class="lbl">${list ? "" : `<b>${esc(a.artist)}</b>`}<span>${esc(a.title)}</span></span><i class="mark"></i>`;
  return el;
}

function addCover(el, a) {
  if (el.querySelector(".cover")) return;
  el.insertAdjacentHTML("beforeend",
    (a.art ? `<img class="cover" alt="" draggable="false" src="${esc(a.art)}">`
           : `<span class="cover nocover"><b>${esc(a.title)}</b><span>${esc(a.artist)}</span></span>`) +
    `<span class="pill"><span class="eq"><i></i><i></i><i></i></span><span class="pl">Now playing</span></span>` +
    `<span class="putback" title="Put back">${icon("close")}</span>`);
  updatePill();
}

function render() {
  Ghost.hide(true);
  layout();
  document.body.classList.toggle("notext", !store.get("spineNames", true));
  const row = $("#row");
  const list = visibleAlbums();
  const prevScroll = ax.pos();
  S.list = list;
  S.els.clear();
  row.classList.add("instant");
  row.innerHTML = "";
  const frag = document.createDocumentFragment();
  const fresh = S.fresh; S.fresh = null;   // albums that just arrived from a sync, scan or demo load
  let k = 0;
  for (const a of list) {
    const el = makeSpine(a);
    if (fresh?.has(a.id)) { el.classList.add("arrive"); el.style.setProperty("--d", Math.min(k++ * 18, 360) + "ms"); }
    if (a.id === S.openId) {
      el.classList.add("open"); addCover(el, a);
      if (Player.mode && Player.albumId() === a.id) { addVinyl(el, a); el.classList.add("out"); setSpin(el.querySelector(".vinyl .label"), Player.playing(), true); }
    }
    S.els.set(a.id, el);
    frag.appendChild(el);
  }
  row.appendChild(frag);
  $("#empty").hidden = S.albums.length > 0 || !S.loaded;
  renderIndex();
  if (S.openId && S.els.has(S.openId)) centerOn(S.openId, false);
  else ax.set(prevScroll);
  requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove("instant")));
  updatePill();
  updateHint();
}

function renderIndex() {
  const nav = $("#index");
  nav.innerHTML = "";
  nav.classList.remove("thumb");
  S.keyAt = null; S.thumb = null;
  const firsts = new Map();
  if (S.list.length >= 8) for (const a of S.list) { const k = indexKey(a); if (k !== null && !firsts.has(k)) firsts.set(k, a.id); }
  if (firsts.size < 2) {
    // No letters in this order (manual, recently added, colour). On a phone the rail becomes a
    // handle you drag instead, with a bubble saying where you are.
    if (S.vertical && S.list.length >= 12 && ax.total() > ax.view() * 1.5) {
      nav.classList.add("thumb");
      nav.innerHTML = '<i class="rail-thumb"></i>';
      S.thumb = nav.firstChild;
      placeThumb();
    }
    return;
  }
  S.keyAt = new Map(S.list.map(a => [a.id, indexKey(a)]));
  for (const [k, id] of firsts) {
    const b = document.createElement("button");
    // The phone rail is narrow: decades read '70s there.
    b.textContent = S.vertical && /^\d{4}s$/.test(k) ? "’" + k.slice(2) : k;
    b.dataset.key = k; b.dataset.id = id;
    b.onclick = () => jumpTo(id, true);
    nav.appendChild(b);
  }
  if (S.vertical) {   // fit the rail to the room: one row per letter, never taller than it can be
    const room = $("#room");
    nav.style.setProperty("--ih", Math.max(12, Math.min(24, Math.floor((room.clientHeight - 32) / firsts.size))) + "px");
  }
  markIndex();
}

function jumpTo(id, animate) {
  const el = S.els.get(id);
  if (el) scrollRowTo(clamp(ax.start(el) - 1, 0, ax.total() - ax.view()), animate);
}

/* The spine in the middle of the view. */
function spineAtMiddle() {
  const kids = ROW.children, mid = ax.pos() + ax.view() / 2;
  let lo = 0, hi = kids.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ax.start(kids[m]) <= mid) lo = m; else hi = m - 1; }
  return kids[lo] || null;
}

let idxRaf = 0;
function markIndex() {
  idxRaf = 0;
  Lift.follow();
  if (S.thumb) return void placeThumb();
  if (!S.keyAt) return;
  const key = S.keyAt.get(spineAtMiddle()?.dataset.id);
  $$("#index button").forEach(b => b.classList.toggle("on", b.dataset.key === key));
}

/* The handle's length shows how much of the stack is in view, its place how far down you are. */
function placeThumb() {
  const t = S.thumb, track = rail.clientHeight, total = ax.total(), view = ax.view(), max = total - view;
  const h = Math.round(clamp(track * view / Math.max(1, total), 40, track * 0.5));
  if (t.offsetHeight !== h) t.style.height = h + "px";
  const y = (max > 0 ? clamp(ax.pos() / max, 0, 1) : 0) * (track - h);
  t.style.transform = `translateY(${y.toFixed(1)}px)`;
  return { y, h, track };
}

function updateHint() {
  let t = "";
  if (!S.albums.length) t = "";
  else if (!S.list.length) t = S.search ? `Nothing on the shelf matches “${S.search}”` : "Nothing on the shelf from this source yet";
  else if (S.sort === "manual") t = "Hold a spine, then drag it to a new place";
  else if (S.openId) t = "Tap the cover for tracks · tap another spine to play it";
  else t = "Tap a spine to play it";
  $("#hint").textContent = t;
}

/* ---------------- opening an album on the shelf */

function setOpen(id, animate = true) {
  if (S.openId === id) { if (id) centerOn(id, animate); return; }
  const prev = S.openId && S.els.get(S.openId);
  if (prev) {
    prev.classList.remove("open", "out");
    setSpin(prev.querySelector(".vinyl .label"), false);
    setTimeout(() => { if (!prev.classList.contains("open")) prev.querySelectorAll(".cover,.pill,.vinyl,.putback").forEach(n => n.remove()); }, 700);
  }
  S.openId = id;
  const el = id && S.els.get(id);
  if (el) {
    addCover(el, S.byId.get(id));
    el.classList.remove("lift");
    void el.offsetWidth;
    el.classList.add("open");
    el._openedAt = performance.now();
    centerOn(id, animate);
  }
  setGlow();
  updatePill();
  updateHint();
}

/* Where the row should scroll to so an album sits in the middle, using the widths it will have
   once the open/close transitions finish. */
function centerOn(id, animate) {
  const row = $("#row");
  let x = 0, target = null;
  const out = S.H * (parseFloat(getComputedStyle(document.body).getPropertyValue("--out")) || 1.62);
  for (const el of row.children) {
    const w = el.dataset.id === id || el.classList.contains("open") ? (el.classList.contains("out") ? out : S.H) : +el.dataset.w;
    if (el.dataset.id === id) target = x + w / 2;
    x += w;
  }
  if (target === null) return;
  const left = clamp(target - ax.view() / 2, 0, Math.max(0, x - ax.view()));
  // Same duration and curve as the CSS width transition: every spine's width moves by the same
  // fraction each frame, so the album travels smoothly to the middle instead of drifting past it.
  scrollRowTo(left, animate, { dur: cssMs("--open-dur"), ease: cssEase("--ease-open") });
}

let scrollAnim = 0, scrollTarget = null;
function stopScrollAnim() { cancelAnimationFrame(scrollAnim); scrollAnim = 0; scrollTarget = null; }
function scrollRowTo(left, animate, { dur, ease } = {}) {
  stopScrollAnim();
  const from = ax.pos(), dist = Math.abs(left - from);
  if (!animate || reduceMotion.matches || dur === 0) { ax.set(left); return; }
  if (dist < 1) return;
  dur ??= clamp(220 + Math.sqrt(dist) * 9, 240, 640);   // longer trips take a little longer, never sluggish
  ease ??= cssEase("--ease-out");
  scrollTarget = left;
  let t0 = null;
  const step = now => {
    t0 ??= now;   // start on the same frame as the CSS transitions
    const t = Math.min(1, (now - t0) / dur);
    ax.set(from + (left - from) * ease(t));
    if (t < 1) scrollAnim = requestAnimationFrame(step);
    else { scrollAnim = 0; scrollTarget = null; }
  };
  scrollAnim = requestAnimationFrame(step);
}

function updatePill() {
  const el = S.openId && S.els.get(S.openId);
  if (!el) return;
  syncVinyl(el);
  const pill = el.querySelector(".pill");
  if (!pill) return;
  const isPlayingAlbum = Player.albumId() === S.openId;
  const playing = isPlayingAlbum && Player.playing();
  pill.classList.toggle("paused", !playing);
  pill.querySelector(".pl").textContent = playing ? "Now playing" : isPlayingAlbum ? "Paused" : "Tap for tracks";
  pill.querySelector(".eq").hidden = !isPlayingAlbum;
}

/* The record in the open album's sleeve. When that album is the one playing, the slot widens and
   the record slides out into it, a moment after the album has opened, then spins while it plays. */
function addVinyl(el, a) {
  if (el.querySelector(".vinyl")) return;
  const v = document.createElement("span");
  v.className = "vinyl";
  v.innerHTML = `<span class="label" style="--lc:${esc(a?.color || "#3a3632")}">${a?.art ? `<img alt="" draggable="false" src="${esc(a.art)}">` : ""}</span><span class="sheen"></span>`;
  const cover = el.querySelector(".cover");
  if (cover) cover.before(v); else el.appendChild(v);
}
let outT = 0;
function syncVinyl(el) {
  const mine = !!Player.mode && Player.albumId() === el.dataset.id;
  if (mine !== el.classList.contains("out")) {
    clearTimeout(outT);
    const go = () => {
      if (S.els.get(S.openId) !== el || !el.classList.contains("open")) return;
      const now = !!Player.mode && Player.albumId() === el.dataset.id;
      if (now === el.classList.contains("out")) return;
      if (now) { addVinyl(el, S.byId.get(el.dataset.id)); void el.offsetWidth; }
      el.classList.toggle("out", now);
      centerOn(el.dataset.id, true);
      setSpin(el.querySelector(".vinyl .label"), now && Player.playing());
    };
    const wait = mine && !reduceMotion.matches ? (el._openedAt || 0) + cssMs("--open-dur") * 0.6 - performance.now() : 0;
    if (wait > 0) outT = setTimeout(go, wait); else go();
    return;
  }
  if (mine) setSpin(el.querySelector(".vinyl .label"), Player.playing());
}

/* Spin a record's label like a turntable: it speeds up over half a second when the music starts and
   coasts to a stop when it pauses, rather than freezing mid-turn. 33⅓ rpm is 1.8 s a turn. */
function setSpin(el, on, instant = false) {
  if (!el) return;
  if (reduceMotion.matches) on = false;
  let s = el._spin;
  if (!s) {
    if (!on) return;
    const anim = el.animate([{ transform: "rotate(0turn)" }, { transform: "rotate(1turn)" }], { duration: 1800, iterations: Infinity });
    anim.pause();
    s = el._spin = { anim, rate: 0, target: 0, raf: 0 };
  }
  const target = on ? 1 : 0;
  if (s.target === target && !instant && (s.raf || s.rate === target)) return;
  s.target = target;
  cancelAnimationFrame(s.raf); s.raf = 0;
  const apply = () => {
    if (s.rate <= 0) return s.anim.pause();
    s.anim.playbackRate = s.rate;   // the angle is kept; only the speed changes
    if (s.anim.playState !== "running") s.anim.play();
  };
  if (instant) { s.rate = target; return apply(); }
  let last = performance.now();
  const step = now => {
    const dt = Math.min(50, now - last); last = now;
    s.rate = target > s.rate ? Math.min(target, s.rate + dt / 500) : Math.max(target, s.rate - dt / 1100);
    apply();
    s.raf = s.rate === target ? 0 : requestAnimationFrame(step);
  };
  s.raf = requestAnimationFrame(step);
}

/* Lift: the spine under the cursor rises out of the shelf and its neighbours follow a little, like
   flicking through records in a crate. On a touch screen, the spine under your finger lifts. */
const Lift = {
  els: [], at: null, x: 0, y: 0, mouse: false,
  set(center, wave = true) {
    if (reduceMotion.matches || document.body.classList.contains("arranging")) center = null;
    if (S.vertical) {   // phones: the stack stays clipped to the screen's rounded corners, so a copy lifts instead
      for (const el of this.els) el.classList.remove("lift");
      this.els = [];
      Ghost.show(center && !center.classList.contains("open") ? center : null);
      this.at = center;
      return;
    }
    const next = new Map();
    if (center && !center.classList.contains("open")) {
      next.set(center, 1);
      let a = center.previousElementSibling, b = center.nextElementSibling;
      for (const v of wave ? [0.42, 0.14] : []) {
        if (a) { next.set(a, v); a = a.previousElementSibling; }
        if (b) { next.set(b, v); b = b.nextElementSibling; }
      }
    }
    for (const el of this.els) if (!next.has(el)) el.classList.remove("lift");
    for (const [el, v] of next) { el.style.setProperty("--lift", v); el.classList.add("lift"); }
    this.els = [...next.keys()];
    this.at = center;
  },
  clear() { if (this.els.length || Ghost.el) this.set(null); this.at = null; },
  // The shelf moved under a still cursor: lift whatever is under it now.
  follow() {
    if (!this.mouse) return;
    const el = Drag.moved ? null : document.elementFromPoint(this.x, this.y)?.closest("#row .spine") || null;
    if (el !== this.at) this.set(el);
  },
};

/* Phones: a copy of the lifted strip, laid over it and a little wider, reaching out to the left over
   the frame with a shadow, as the wall shelf's spines rise over theirs. The stack itself keeps its
   rounded corners, which is why the strip can't simply grow out of it. */
const Ghost = {
  el: null, src: null, leaving: [],
  show(src) {
    if (src === this.src) return;
    this.hide();
    if (!src) return;
    const r = src.getBoundingClientRect(), box = $("#screen").getBoundingClientRect();
    if (r.top < box.top - 1 || r.bottom > box.bottom + 1) return;   // only a strip wholly in view
    const reach = Math.round(Math.max(0, Math.min(S.H * 0.06, 18, r.left - 4)));   // out over the frame, not off the screen
    const g = src.cloneNode(true);
    g.classList.remove("lift", "arrive");
    g.classList.add("ghost");
    g.setAttribute("aria-hidden", "true"); g.removeAttribute("title"); g.tabIndex = -1;
    Object.assign(g.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    g.dataset.left = r.left; g.dataset.width = r.width;
    document.body.appendChild(g);
    void g.offsetWidth;
    g.classList.add("up");
    g.style.left = r.left - reach + "px"; g.style.width = r.width + reach + "px";
    this.el = g; this.src = src;
  },
  hide(now = false) {
    const g = this.el;
    this.el = this.src = null;
    if (now) { this.leaving.forEach(x => x.remove()); this.leaving = []; g?.remove(); return; }
    if (!g) return;
    g.classList.remove("up");
    g.style.left = g.dataset.left + "px"; g.style.width = g.dataset.width + "px";
    this.leaving.push(g);
    setTimeout(() => { g.remove(); this.leaving = this.leaving.filter(x => x !== g); }, 180);
  },
};

/* Cross-fade two glow layers: the new colour is painted once on the hidden layer, then only
   opacity animates, which the compositor handles without repainting. */
function setGlow() {
  const a = S.byId.get(Player.albumId() || S.openId);
  const color = a && store.get("glow", true) ? a.color : "";
  const layers = $$(".glow");
  const cur = layers.find(l => l.classList.contains("on"));
  if ((cur?.dataset.c || "") === color) return;
  cur?.classList.remove("on");
  if (!color) return;
  const next = layers.find(l => l !== cur) || layers[0];
  next.style.setProperty("--glow", color);
  next.dataset.c = color;
  next.classList.add("on");
}

/* ---------------- loading */

/* The last shelf this device saw, kept so the app opens on it instantly (and works offline);
   the server's fresh copy replaces it moments later. Cleared on sign-out. */
const DATA_CACHE = "albumviewer-data";
const dataCache = {
  async get(url) { try { const r = await (await caches.open(DATA_CACHE)).match(url); return r ? await r.json() : null; } catch { return null; } },
  async put(url, json) { try { await (await caches.open(DATA_CACHE)).put(url, new Response(json, { headers: { "Content-Type": "application/json" } })); } catch {} },
  clear() {
    if (typeof caches === "undefined") return Promise.resolve();
    return Promise.all([DATA_CACHE, "albumviewer-art"].map(n => caches.delete(n).catch(() => {})));
  },
};

function applyAlbums(list, animateNew) {
  S.serverAlbums = list;
  list = list.concat(Device.shelf());
  if (animateNew) S.fresh = new Set(list.filter(a => !S.byId.has(a.id)).map(a => a.id));
  S.albums = list;
  S.byId = new Map(list.map(a => [a.id, a]));
  S.loaded = true;
  const hasDemo = list.some(a => a.source === "demo"), hasLists = list.some(a => a.kind === "playlist");
  const hasYt = list.some(a => a.source === "youtube");
  $('#sourceSeg [data-source="demo"]').hidden = !hasDemo;
  $('#sourceSeg [data-source="playlist"]').hidden = !hasLists;
  $('#sourceSeg [data-source="youtube"]').hidden = !hasYt;
  if ((S.source === "demo" && !hasDemo) || (S.source === "playlist" && !hasLists) || (S.source === "youtube" && !hasYt)) setSource("all");
  render();
}

async function loadAlbums() {
  const url = `/api/albums?include_hidden=${store.get("showHidden", false)}`;
  if (!S.loaded) {
    const cached = await dataCache.get(url);
    if (cached?.length) { S.json = JSON.stringify(cached); applyAlbums(cached, false); }
  }
  const list = await api(url);
  const json = JSON.stringify(list);
  dataCache.put(url, json);
  if (S.loaded && json === S.json) return;   // unchanged: don't redraw (no flicker, no lost scroll)
  S.json = json;
  applyAlbums(list, S.loaded);
}

async function detail(id, fresh = false) {
  if (id.startsWith("dev_")) {
    const d = Device.detail(id);
    if (!d) throw new Error("That album isn't in your music folder any more");
    return d;
  }
  if (!fresh && S.details.has(id)) return S.details.get(id);
  const a = await api(`/api/albums/${encodeURIComponent(id)}`);
  S.details.set(id, a);
  return a;
}

/* ======================================================== touching the row */

const row = $("#row");

row.addEventListener("click", e => {
  Ghost.hide(true);   // a tap opens the album: its lifted copy goes at once
  if (Drag.suppressClick) { Drag.suppressClick = false; return; }
  const el = e.target.closest(".spine");
  if (!el) return;
  const id = el.dataset.id;
  if (e.target.closest(".putback")) { haptic(8); putBack(id); return; }
  if (e.target.closest(".vinyl")) { haptic(6); Player.toggle(); return; }   // touch the record to pause it
  if (id === S.openId) openSheet(id, el.querySelector(".cover"));
  else tapToPlay(id);
});

async function tapToPlay(id) {
  haptic(10);
  setOpen(id);
  try { await Player.playAlbum(await detail(id)); }
  catch (err) { toast(err.message); }
}

/* lift: the mouse lifts the spine it is over (and its neighbours); a finger, the one it is on */
row.addEventListener("pointermove", e => {
  if (e.pointerType !== "mouse") return;
  Lift.mouse = true; Lift.x = e.clientX; Lift.y = e.clientY;
  const el = Drag.moved || Arrange.picked ? null : e.target.closest(".spine");
  if (el !== Lift.at) Lift.set(el);
});
row.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") { Lift.mouse = false; Lift.clear(); } });
row.addEventListener("touchstart", e => {
  const el = e.touches.length === 1 ? e.target.closest(".spine") : null;
  Lift.mouse = false;
  Lift.set(el, false);
}, { passive: true });
row.addEventListener("touchend", () => Lift.clear(), { passive: true });
row.addEventListener("touchcancel", () => Lift.clear(), { passive: true });

/* mouse: drag to scroll with a little momentum (touch screens scroll natively) */
const Drag = { active: false, moved: false, startX: 0, startScroll: 0, lastX: 0, lastT: 0, v: 0, suppressClick: false };
let glideRaf = 0;
function glide(v) {
  cancelAnimationFrame(glideRaf);
  let last = performance.now();
  const step = now => {
    const dt = now - last; last = now;
    ax.set(ax.pos() + v * dt);
    v *= Math.pow(0.94, dt / 16);
    if (Math.abs(v) > 0.02) glideRaf = requestAnimationFrame(step);
  };
  glideRaf = requestAnimationFrame(step);
}

row.addEventListener("pointerdown", e => {
  stopScrollAnim(); cancelAnimationFrame(glideRaf);
  Arrange.down(e);
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  const c = ax.client(e);
  Object.assign(Drag, { active: true, moved: false, startX: c, startScroll: ax.pos(), lastX: c, lastT: e.timeStamp, v: 0 });
});
addEventListener("pointermove", e => {
  if (Arrange.move(e)) return;
  if (!Drag.active) return;
  const c = ax.client(e), dx = c - Drag.startX;
  if (!Drag.moved && Math.abs(dx) > 5) { Drag.moved = true; row.classList.add("dragging"); }
  if (!Drag.moved) return;
  ax.set(Drag.startScroll - dx);
  const dt = e.timeStamp - Drag.lastT;
  if (dt > 0) Drag.v = 0.7 * ((Drag.lastX - c) / dt) + 0.3 * Drag.v;
  Drag.lastX = c; Drag.lastT = e.timeStamp;
});
addEventListener("pointerup", e => {
  if (Arrange.up(e)) return;
  if (!Drag.active) return;
  Drag.active = false;
  if (Drag.moved) {
    row.classList.remove("dragging");
    Drag.suppressClick = true;
    setTimeout(() => (Drag.suppressClick = false), 50);
    if (e.timeStamp - Drag.lastT < 80) glide(clamp(Drag.v, -4, 4));
  }
});
addEventListener("pointercancel", e => { Arrange.cancel(e); Drag.active = false; row.classList.remove("dragging"); });

row.addEventListener("wheel", e => {
  if (S.vertical || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;   // a vertical stack scrolls natively
  e.preventDefault();
  stopScrollAnim(); cancelAnimationFrame(glideRaf);
  row.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 32 : 1);
}, { passive: false });

row.addEventListener("scroll", () => {
  if (Ghost.el) { Ghost.hide(); Lift.at = null; }   // the strip moves on; the copy doesn't follow it
  if (!idxRaf) idxRaf = requestAnimationFrame(markIndex);
}, { passive: true });
row.addEventListener("contextmenu", e => { if (S.sort === "manual") e.preventDefault(); });
row.addEventListener("keydown", e => {
  const fwd = S.vertical ? "ArrowDown" : "ArrowRight", back = S.vertical ? "ArrowUp" : "ArrowLeft";
  if (e.key === fwd || e.key === back) {
    e.preventDefault();
    // Held or repeated keys add up from where the last press was heading, and stay quick.
    const base = scrollTarget ?? ax.pos();
    const to = clamp(base + (e.key === fwd ? 1 : -1) * ax.view() * 0.4, 0, ax.total() - ax.view());
    scrollRowTo(to, true, { dur: 220 });
  }
});

/* Phones: the A-Z rail on the right. Touch it and slide: the stack jumps letter by letter under
   your thumb, with a tick for each letter and a large one showing where you are. In an order
   without letters the rail is a handle: drag it and the bubble shows the artist's initial, the
   month the album arrived, or its colour. */
const Scrub = { on: false, key: null, grab: 0 };
const rail = $("#index"), bubble = $("#scrubBubble");
function showBubble(y, { text = "", wide = false, swatch = null }) {
  bubble.textContent = text;
  bubble.classList.toggle("wide", wide);
  bubble.classList.toggle("swatch", !!swatch);
  if (swatch) bubble.style.setProperty("--sw", swatch);
  bubble.style.top = (y - $("#room").getBoundingClientRect().top) + "px";
  bubble.classList.add("on");
}
function bubbleFor(a) {
  if (S.sort === "color") return { swatch: a.color };
  if (S.sort === "added" && a.added_at) return { text: new Date(a.added_at * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" }), wide: true };
  const c = artistKey(a.artist).normalize("NFKD")[0]?.toUpperCase() || "#";
  return { text: /[A-Z]/.test(c) ? c : "#" };
}
function scrubAt(e) {
  const b = [...rail.children].find(x => { const r = x.getBoundingClientRect(); return e.clientY >= r.top && e.clientY < r.bottom; });
  if (!b || b.dataset.key === Scrub.key) return;
  Scrub.key = b.dataset.key;
  jumpTo(b.dataset.id, false);
  markIndex();
  haptic(4);
  const r = b.getBoundingClientRect();
  showBubble(r.top + r.height / 2, { text: b.textContent });
}
function scrubThumb(e) {
  const r = rail.getBoundingClientRect(), h = S.thumb.offsetHeight;
  const f = clamp((e.clientY - r.top - Scrub.grab) / Math.max(1, r.height - h), 0, 1);
  ax.set(f * (ax.total() - ax.view()));
  const { y } = placeThumb();
  const a = S.byId.get(spineAtMiddle()?.dataset.id);
  if (!a) return;
  const b = bubbleFor(a), key = b.swatch || b.text;
  if (key !== Scrub.key) { if (Scrub.key !== null) haptic(3); Scrub.key = key; }
  showBubble(r.top + y + h / 2, b);
}
function endScrub() { Scrub.on = false; Scrub.key = null; rail.classList.remove("scrubbing"); bubble.classList.remove("on"); }
rail.addEventListener("pointerdown", e => {
  if (!S.vertical || (!S.thumb && !e.target.closest("button"))) return;
  e.preventDefault();
  stopScrollAnim();
  Scrub.on = true;
  try { rail.setPointerCapture(e.pointerId); } catch {}
  rail.classList.add("scrubbing");
  if (S.thumb) {   // hold the handle where you took it; a touch elsewhere brings it under your finger
    const t = S.thumb.getBoundingClientRect();
    Scrub.grab = e.clientY >= t.top && e.clientY <= t.bottom ? e.clientY - t.top : t.height / 2;
    scrubThumb(e);
  } else scrubAt(e);
});
rail.addEventListener("pointermove", e => { if (Scrub.on) (S.thumb ? scrubThumb : scrubAt)(e); });
rail.addEventListener("pointerup", endScrub);
rail.addEventListener("pointercancel", endScrub);
rail.addEventListener("click", e => { if (S.vertical && e.detail > 0) e.stopPropagation(); }, true);   // the press already jumped (keyboard clicks still work)

/* manual order: hold a spine, then drag it along the row */
const Arrange = {
  timer: 0, el: null, picked: false, sx: 0, sy: 0, x: 0, edgeRaf: 0,
  down(e) {
    clearTimeout(this.timer);
    if (S.sort !== "manual") return;
    const el = e.target.closest(".spine");
    if (!el) return;
    this.el = el; this.sx = e.clientX; this.sy = e.clientY; this.x = ax.client(e);
    this.timer = setTimeout(() => this.pick(e.pointerId), e.pointerType === "mouse" ? 260 : 380);
  },
  pick(pointerId) {
    this.timer = 0;
    this.picked = true;
    Lift.clear();
    Drag.active = false; row.classList.remove("dragging");
    this.el.classList.add("picked");
    document.body.classList.add("arranging");
    try { row.setPointerCapture(pointerId); } catch {}
    haptic(12);
    this.edge();
  },
  move(e) {
    if (this.timer && Math.hypot(e.clientX - this.sx, e.clientY - this.sy) > 6) { clearTimeout(this.timer); this.timer = 0; }
    if (!this.picked) return false;
    this.x = ax.client(e);
    this.place();
    return true;
  },
  place() {
    const all = [...row.children], kids = all.filter(k => k !== this.el);
    let before = null;
    for (const k of kids) { const r = k.getBoundingClientRect(); if (this.x < ax.rStart(r) + ax.rSize(r) / 2) { before = k; break; } }
    if (before ? this.el.nextElementSibling === before : row.lastElementChild === this.el) return;
    // Only the spines between the old and new slot move: slide them aside rather than jump.
    const i = all.indexOf(this.el), j = before ? all.indexOf(before) : all.length;
    const moved = i < j ? all.slice(i, j) : all.slice(j, i + 1);
    flip(moved, () => row.insertBefore(this.el, before), 180);
  },
  edge() { // scroll while the picked spine is held near either end
    if (!this.picked) return;
    const r = row.getBoundingClientRect(), zone = Math.min(80, ax.rSize(r) * 0.12);
    const v = this.x < ax.rStart(r) + zone ? -1 : this.x > ax.rEnd(r) - zone ? 1 : 0;
    if (v) { ax.set(ax.pos() + v * 9); this.place(); }
    this.edgeRaf = requestAnimationFrame(() => this.edge());
  },
  up() {
    clearTimeout(this.timer); this.timer = 0;
    if (!this.picked) return false;
    this.drop();
    Drag.suppressClick = true;
    setTimeout(() => (Drag.suppressClick = false), 50);
    return true;
  },
  cancel() { clearTimeout(this.timer); this.timer = 0; if (this.picked) this.drop(); },
  drop() {
    this.picked = false;
    cancelAnimationFrame(this.edgeRaf);
    this.el.classList.remove("picked");
    document.body.classList.remove("arranging");
    saveOrder();
  },
};
row.addEventListener("touchmove", e => { if (Arrange.picked) e.preventDefault(); }, { passive: false });

async function saveOrder() {
  const shown = [...row.children].map(el => el.dataset.id);
  const shownSet = new Set(shown);
  const full = S.albums.slice().sort(SORTS.manual).map(a => a.id);
  let k = 0;
  const ids = full.map(id => (shownSet.has(id) ? shown[k++] : id));
  ids.forEach((id, i) => { const a = S.byId.get(id); if (a) a.pos = i; });
  S.list = shown.map(id => S.byId.get(id));
  S.orderIds = ids;
  renderIndex();
  try { await api("/api/order", { method: "PUT", body: { ids } }); }
  catch (err) { toast("Couldn't save the order: " + err.message); }
}

/* ======================================================== album details */

/* The cover image flying between the shelf (or the mini player) and the album sheet. */
let flight = null;
function cancelFlight() {
  if (!flight) return;
  flight.anim.cancel(); flight.img.remove();
  if (flight.hide) flight.hide.style.visibility = "";
  flight = null;
}
function fly(src, from, to, { dur, easing, hide }) {
  cancelFlight();
  const img = new Image();
  img.className = "flyer"; img.alt = ""; img.src = src;
  Object.assign(img.style, { left: to.left + "px", top: to.top + "px", width: to.width + "px", height: to.height + "px" });
  document.body.appendChild(img);
  const scale = from.width / to.width;
  const anim = img.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scale})` },
    { transform: "none" },
  ], { duration: dur, easing, fill: "forwards" });
  if (hide) hide.style.visibility = "hidden";   // the source lifts off rather than being copied
  const f = flight = { img, anim, hide };
  return anim.finished.then(() => true, () => false).then(ok => {
    if (flight === f) { img.remove(); if (hide) hide.style.visibility = ""; flight = null; }
    return ok;
  });
}
/* A cover worth flying from or to: square, fully on screen, and not clipped by the display. */
function flyRect(el) {
  if (!el?.isConnected || reduceMotion.matches) return null;
  const spine = el.closest(".spine");
  if (spine && !spine.classList.contains("open")) return null;
  const r = el.getBoundingClientRect();
  const box = el.closest("#screen")?.getBoundingClientRect() ?? { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const inside = r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  return r.width > 8 && Math.abs(r.width - r.height) < 2 && inside ? r : null;
}

let sheetFrom = null;   // the cover the album sheet opened from
async function openSheet(id, fromEl) {
  let a;
  try { a = await detail(id); } catch (err) { return toast(err.message); }
  S.sheet = a;
  $("#aCover").src = a.art || "";
  $("#aCover").style.background = a.color;
  $("#aTitle").textContent = a.title;
  $("#aArtist").textContent = a.kind === "playlist" ? (a.tracks ? `${a.tracks} songs` : "") : a.artist + (a.year ? ` · ${a.year}` : "");
  $("#aSource").textContent = a.source === "youtube" ? ytSource(a) : a.kind === "playlist" ? "Spotify playlist" :
    { spotify: "Spotify", demo: "Demo shelf · 30-second previews", device: "On this computer" }[a.source] ||
    "Music folder" + (a.art_status === "missing" ? " · no cover found" : "");
  $("#aOpenYt").hidden = !a.open_url;
  $("#aHide").textContent = a.hidden ? "Show on shelf" : "Hide from shelf";
  $("#aFixArt").hidden = a.source !== "local";
  $("#aMenu").hidden = true; $("#artForm").hidden = true;
  renderSheetState();
  const sheet = $("#albumSheet");
  const from = a.art ? flyRect(fromEl) : null;
  sheetFrom = fromEl || null;
  cancelFlight();
  sheet.classList.toggle("flying", !!from);
  reveal(sheet, true);
  if (!from) return;
  const landed = await fly(a.art, from, $("#aCover").getBoundingClientRect(),
    { dur: cssMs("--open-dur") * 0.9, easing: cssVal("--ease-open"), hide: fromEl });
  if (landed && sheet.classList.contains("in")) sheet.classList.remove("flying");
}

/* Close the album sheet, flying the cover back to where it came from if that is still on screen. */
function closeAlbum() {
  const sheet = $("#albumSheet");
  if (sheet.hidden || !sheet.classList.contains("in")) return;
  const a = S.sheet;
  const back = sheetFrom?.isConnected ? sheetFrom : S.els.get(a?.id)?.querySelector(".cover");
  const to = a?.art ? flyRect(back) : null;
  if (to) {
    const start = (flight ? flight.img : $("#aCover")).getBoundingClientRect();   // mid-flight: turn around
    sheet.classList.add("flying");
    fly(a.art, start, to, { dur: 300, easing: cssVal("--ease-out"), hide: back });
  } else {
    cancelFlight();
    sheet.classList.remove("flying");
  }
  reveal(sheet, false);
}

function renderSheetState() {
  const a = S.sheet;
  if (!a) return;
  const mine = Player.albumId() === a.id;
  const playing = mine && Player.playing();
  $("#aPlay").innerHTML = icon(playing ? "pause" : "play") + `<span>${playing ? "Pause" : mine ? "Resume" : "Play"}</span>`;
  $("#aPutBack").hidden = S.openId !== a.id;
  const multiDisc = new Set(a.track_list.map(t => t.disc_no || 1)).size > 1;
  if (a.kind === "playlist" && a.tracks_shared === false) {
    $("#aTracks").innerHTML = `<li class="note">Spotify shares the tracks of a playlist only with its owner and collaborators. Press Play to hear it.</li>`;
    return;
  }
  $("#aTracks").innerHTML = a.track_list.map((t, i) =>
    `<li data-i="${i}" class="${Player.isTrack(t.id) ? "now" : ""}${t.embeddable === false ? " off" : ""}"><span class="n">${multiDisc ? (t.disc_no || 1) + "." : ""}${t.track_no || i + 1}</span>` +
    `<span class="tt">${esc(t.title)}${t.artist && t.artist !== a.artist ? ` <span style="color:var(--muted)">· ${esc(t.artist)}</span>` : ""}` +
    `${t.embeddable === false ? ' <span class="only">plays on YouTube</span>' : ""}</span>` +
    `<span class="d">${fmt(t.duration)}</span></li>`).join("");
}

/* YouTube: what it is, and where it plays in YouTube Music (the app, on a phone that has it) */
function ytSource(a) {
  return a.id.startsWith("yl_") ? "Liked music · YouTube" : a.id.startsWith("yv_") ? "YouTube" :
    a.kind === "playlist" ? "YouTube playlist" : "YouTube Music album";
}
function ytTrackUrl(a, t) {
  const list = (a.open_url || "").match(/[?&]list=([\w-]+)/)?.[1];
  return `https://music.youtube.com/watch?v=${encodeURIComponent(t.uri)}${list ? `&list=${list}` : ""}`;
}
$("#aOpenYt").onclick = () => { if (S.sheet?.open_url) window.open(S.sheet.open_url, "_blank", "noopener"); };

$("#aTracks").addEventListener("click", e => {
  const li = e.target.closest("li[data-i]"); if (!li) return;
  const t = S.sheet.track_list[+li.dataset.i];
  if (S.sheet.source === "youtube" && t?.embeddable === false) { window.open(ytTrackUrl(S.sheet, t), "_blank", "noopener"); return; }
  setOpen(S.sheet.id);
  Player.playAlbum(S.sheet, +li.dataset.i).then(renderSheetState);
});
$("#aPlay").onclick = () => {
  if (Player.albumId() === S.sheet.id) { Player.toggle(); setTimeout(renderSheetState, 50); return; }
  setOpen(S.sheet.id);
  Player.playAlbum(S.sheet).then(renderSheetState);
};
$("#aShuffle").onclick = () => { setOpen(S.sheet.id); Player.playAlbum(S.sheet, null, true).then(renderSheetState); };
/* Put an open album back on the shelf: the record goes back in its sleeve, so if it's the album
   playing, the music stops too. */
function putBack(id) {
  if (Player.albumId() === id) Player.stop();
  if (S.openId === id) setOpen(null);
}
$("#aPutBack").onclick = () => {
  putBack(S.sheet.id);   // first, so the cover doesn't fly back onto a closing spine
  closeSheets();
};
$("#aMore").onclick = () => ($("#aMenu").hidden = !$("#aMenu").hidden);
$("#aHide").onclick = async () => {
  const a = S.sheet;
  await api(`/api/albums/${encodeURIComponent(a.id)}`, { method: "PATCH", body: { hidden: !a.hidden } });
  S.details.delete(a.id);
  if (S.openId === a.id && !a.hidden) setOpen(null);
  closeSheets();
  if (a.source === "device") {   // the server keeps only the fact that it's hidden
    const h = new Set(S.me?.device_hidden || []);
    if (a.hidden) h.delete(a.id); else h.add(a.id);
    if (S.me) S.me.device_hidden = [...h];
    applyAlbums(S.serverAlbums || [], false);
  } else loadAlbums();
};
$("#aFixArt").onclick = () => {
  const f = $("#artForm"); f.hidden = false; $("#aMenu").hidden = true;
  f.artist.value = S.sheet.artist; f.album.value = S.sheet.title; f.song.value = S.sheet.track_list[0]?.title || "";
  $("#artMsg").textContent = "";
};
async function artUpdated(a) {
  S.details.set(a.id, { ...S.sheet, ...a });
  S.sheet = S.details.get(a.id);
  $("#aCover").src = a.art;
  const was = S.openId; S.openId = null;
  await loadAlbums();
  if (was) setOpen(was, false);
}
$("#artForm").onsubmit = async e => {
  e.preventDefault();
  const f = e.target; $("#artMsg").textContent = "Searching…";
  try {
    const a = await api(`/api/albums/${encodeURIComponent(S.sheet.id)}/art/search`, { method: "POST", body: { artist: f.artist.value, album: f.album.value, song: f.song.value } });
    $("#artMsg").textContent = "Found it."; artUpdated(a);
  } catch (err) { $("#artMsg").textContent = err.message; }
};
$("#artFile").onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append("file", file);
  try {
    const a = await api(`/api/albums/${encodeURIComponent(S.sheet.id)}/art`, { method: "POST", body: fd });
    $("#artMsg").textContent = "Updated."; artUpdated(a);
  } catch (err) { $("#artMsg").textContent = err.message; }
};

/* ======================================================== YouTube
   YouTube and YouTube Music play in YouTube's own player (its IFrame Player API). YouTube's rules
   say that player must be on screen whenever it plays, at least 200×200 pixels, with nothing over
   it. So it has a window of its own: in the full-screen player it sits on the stage, where the
   record goes, and rises and falls with it; with that put away it floats above the bar. Closing the
   window pauses the music. The window never moves within the page (an iframe that does reloads):
   it's only placed over things. */

const YT_HOST = "https://www.youtube.com", YT_KIDS = "https://www.youtube-nocookie.com";
const Yt = {
  win: $("#ytWin"), player: null, host: null, vid: null, state: -1, shown: false, raf: 0, n: 0, tickT: 0,

  api() {   // YouTube's script, loaded the first time something plays
    if (window.YT?.Player) return Promise.resolve();
    return this.apiP ||= new Promise((resolve, reject) => {
      const before = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { before?.(); resolve(); };
      const s = document.createElement("script");
      s.src = YT_HOST + "/iframe_api";
      s.onerror = () => { this.apiP = null; s.remove(); reject(new Error("YouTube's player didn't load. Check the connection, then try again.")); };
      document.head.appendChild(s);
    });
  },
  /* Videos made for kids play from youtube-nocookie.com, with tracking off as YouTube asks; the rest
     from youtube.com, so they play as whoever is signed in to YouTube in this browser. */
  hostFor(t) { return t.kids ? YT_KIDS : YT_HOST; },
  async make(t, n) {
    await this.api();
    if (n !== this.n) return null;   // something else was picked meanwhile
    this.destroy();
    this.host = this.hostFor(t); this.vid = t.uri;
    const f = document.createElement("iframe");
    f.title = "YouTube video player";
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.referrerPolicy = "strict-origin-when-cross-origin";   // YouTube's player has to know which site it's on
    const q = new URLSearchParams({ enablejsapi: 1, playsinline: 1, rel: 0, controls: 0, autoplay: 1, origin: location.origin, widget_referrer: location.origin });
    f.src = `${this.host}/embed/${encodeURIComponent(t.uri)}?${q}`;
    $("#ytFrame").replaceChildren(f);
    const p = await new Promise((resolve, reject) => {
      const player = new YT.Player(f, { events: {
        onReady: () => resolve(player),
        onStateChange: e => { if (this.player === player) this.changed(e.data); },
        onError: e => { if (this.player === player) this.failed(e.data); },
      } });
      this.player = player;
      setTimeout(() => reject(new Error("YouTube's player didn't start. Try again.")), 20000);
    });
    return n === this.n ? p : null;
  },
  destroy() {
    try { this.player?.destroy(); } catch {}
    this.player = null; this.host = null; this.vid = null; this.state = -1;
    $("#ytFrame").replaceChildren();
  },
  async play(t) {
    const n = ++this.n;
    this.show();   // on screen before it starts: YouTube's rule
    $("#ytName").textContent = t.title;
    if (this.player && this.host === this.hostFor(t)) { this.vid = t.uri; this.player.loadVideoById(t.uri); }
    else await this.make(t, n);
    this.ticking();
  },
  pause() { try { this.player?.pauseVideo(); } catch {} },
  resume() {
    this.show();
    try { this.player?.playVideo(); } catch {}
  },
  /* what YouTube's player says it's doing (its events don't always arrive, e.g. in a hidden tab) */
  apiState() { try { const s = this.player?.getPlayerState?.(); return typeof s === "number" ? s : null; } catch { return null; } },
  playing() { const s = this.apiState() ?? this.state; return s === 1 || s === 3; },
  time() { try { return this.player?.getCurrentTime?.() || 0; } catch { return 0; } },
  duration() { try { return this.player?.getDuration?.() || 0; } catch { return 0; } },
  seek(s) { try { this.player?.seekTo(s, true); } catch {} },

  changed(s) {   // -1 not started, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (s === this.state) return;   // heard twice: from the event and from ticking()
    this.state = s;
    if (Player.mode !== "youtube") return;
    if (s === 0) return Player.ended();
    Player.ui({ playing: this.playing(), ...(s === 1 ? { dur: this.duration() || Player.cur.dur } : {}) });
    updatePill(); renderSheetState();
  },
  failed(code) {   // 2 bad id, 5 can't play in this browser, 100 gone or private, 101/150 owner doesn't allow it here
    if (Player.mode !== "youtube") return;
    toast(code === 101 || code === 150 ? "That one plays only on YouTube, skipping" : code === 100 ? "That one isn't on YouTube any more, skipping" : "YouTube couldn't play that one, skipping");
    setTimeout(() => Player.next(), 900);
  },
  /* The bar and the full-screen player follow the video's clock. */
  ticking() {
    clearInterval(this.tickT);
    this.tickT = setInterval(() => {
      if (Player.mode !== "youtube") return clearInterval(this.tickT);
      const s = this.apiState();
      if (s !== null && s !== this.state) this.changed(s);   // an event that went missing
      if (this.playing() && !document.hidden) Player.ui({ pos: this.time(), dur: this.duration() || Player.cur.dur });
    }, 250);
  },

  /* ---- where the window is */
  show() {
    if (!this.shown) { this.shown = true; this.win.hidden = false; np.classList.add("yt"); }   // the stage makes room for it
    this.place();
  },
  hide() {
    this.pause();
    this.shown = false;
    cancelAnimationFrame(this.raf);
    this.win.hidden = true; this.win.classList.remove("docked"); this.win.style.cssText = "";
    document.body.classList.remove("yt-mini");
    np.classList.remove("yt");   // the cover is back on the stage
  },
  /* On the stage while the full-screen player is up with nothing over it; else floating. */
  place() {
    if (!this.shown) return;
    const dock = NP.isOpen && !$$(".sheet").some(s => s.classList.contains("in"));
    if (dock && !this.win.classList.contains("docked")) this.dock();
    else if (!dock && (this.win.classList.contains("docked") || !document.body.classList.contains("yt-mini"))) this.float();
  },
  rect() { const r = this.win.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; },
  set(r) { Object.assign(this.win.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px", right: "auto", bottom: "auto" }); },
  /* Move with whatever it's over, easing in from where it was. Without `done`, it keeps following
     (the full-screen player rising, being dragged down, scrolled, resized). */
  run(target, dur, ease, done) {
    cancelAnimationFrame(this.raf);
    const from = this.rect(), t0 = performance.now();
    const step = now => {
      const k = dur > 0 ? Math.min(1, (now - t0) / dur) : 1, e = ease(k), to = target();
      this.set(k < 1 ? { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, w: from.w + (to.w - from.w) * e, h: from.h + (to.h - from.h) * e } : to);
      if (k < 1 || !done) this.raf = requestAnimationFrame(step); else done();
    };
    step(t0);   // placed at once, not a frame later
  },
  dock() {
    this.win.classList.add("docked"); document.body.classList.remove("yt-mini");
    this.run(() => { const r = $("#npStage").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; },
      reduceMotion.matches ? 0 : 460, cssEase("--ease-open"));
  },
  /* just above the bar, wherever the bar is (it wraps onto two lines on phones) */
  clearBar() {
    const bar = $("#player");
    document.documentElement.style.setProperty("--yt-bottom", `${bar.hidden ? 16 : Math.max(16, innerHeight - bar.getBoundingClientRect().top + 12)}px`);
  },
  float() {
    this.clearBar();
    const keep = this.win.style.cssText, docked = this.win.classList.contains("docked");
    this.win.style.cssText = ""; this.win.classList.remove("docked");
    const to = this.rect();   // where CSS floats it
    if (!docked) { document.body.classList.add("yt-mini"); return; }
    this.win.style.cssText = keep;
    document.body.classList.add("yt-mini");
    this.run(() => to, reduceMotion.matches ? 0 : 280, cssEase("--ease-out"), () => { this.win.style.cssText = ""; });
  },
};
$("#ytClose").onclick = () => { Yt.hide(); Player.ui({ playing: false }); updatePill(); renderSheetState(); };
$("#ytOpen").onclick = () => NP.open();
$("#ytWin .yt-bar").addEventListener("click", e => { if (!e.target.closest("button")) NP.open(); });
// A sheet opening over the full-screen player sends the video to its corner, so nothing covers it.
{
  const watch = new MutationObserver(() => Yt.place());
  $$(".sheet").forEach(s => watch.observe(s, { attributes: true, attributeFilter: ["class"] }));
}
addEventListener("resize", () => { if (Yt.shown && !Yt.win.classList.contains("docked")) Yt.float(); });
new ResizeObserver(() => Yt.clearBar()).observe($("#player"));

/* ======================================================== player */

const audio = $("#audio");
const shuffled = list => { const q = list.slice(); for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; } return q; };

const Player = {
  mode: null,          // 'browser' (local files, demo previews) | 'youtube' (YouTube's player) | 'spotify'
  album: null,
  order: [],           // the album's tracks, in album order
  queue: [], index: 0, // the same tracks in the order they play (shuffled or not)
  shuffle: store.get("shuffle", false),
  repeat: store.get("repeat", "off"),   // off | all | one, for playback on this screen
  sp: null,            // last Spotify state
  spAt: 0,             // when it arrived, so the position can move on between polls
  pollT: null, tickT: null,
  cur: {},             // what is showing: title, artist, art, playing, device, pos, dur

  queued() { return this.mode === "browser" || this.mode === "youtube"; },   // this screen plays its own queue
  albumId() { return this.queued() ? this.album?.id : this.sp?.album_id; },
  playing() { return this.mode === "browser" ? !audio.paused : this.mode === "youtube" ? Yt.playing() : !!this.sp?.is_playing; },
  isTrack(id) { return this.queued() && this.queue[this.index]?.id === id; },
  shuffleOn() { return this.mode === "spotify" ? !!this.sp?.shuffle : this.shuffle; },
  repeatMode() { return this.mode === "spotify" ? ({ context: "all", track: "one" }[this.sp?.repeat] || "off") : this.repeat; },
  canSeek() { return this.mode === "browser" ? audio.duration > 0 : !!this.mode && this.cur.dur > 0; },
  position() { return this.mode === "youtube" ? Yt.time() : audio.currentTime; },

  /* `index` is the track to start on. Leave it out to play the album from the top, or from a
     random track when shuffle is on. */
  async playAlbum(album, index = null, shuffle = false) {
    // a Spotify playlist whose tracks Spotify won't list still plays
    if (!album.track_list?.length && album.source !== "spotify") { toast("This album has no playable tracks"); return; }
    if (album.source === "spotify") return this.playSpotify(album, index ?? 0, shuffle);
    const yt = album.source === "youtube";
    // YouTube: the videos whose owners let them play outside YouTube
    const playable = yt ? album.track_list.filter(t => t.embeddable !== false) : album.track_list;
    if (!playable.length) { toast("These play only on YouTube. Open them in YouTube Music.", 5000); return; }
    if (this.mode === "spotify" && this.sp?.is_playing) api("/api/spotify/control", { method: "POST", body: { action: "pause" } }).catch(() => {});
    this.stopPolling();
    if (yt) audio.pause(); else if (this.mode === "youtube") Yt.hide();
    if (shuffle && !this.shuffle) { this.shuffle = true; store.set("shuffle", true); }
    const want = index !== null ? album.track_list[index] : null;
    this.mode = yt ? "youtube" : "browser"; this.album = album;
    this.order = playable.slice();
    const at = want && this.order.includes(want) ? this.order.indexOf(want) : null;
    if (this.shuffle) {
      const first = (at !== null && this.order[at]) || this.order[Math.floor(Math.random() * this.order.length)];
      this.queue = [first, ...shuffled(this.order.filter(t => t !== first))];
      this.index = 0;
    } else {
      this.queue = this.order.slice();
      this.index = clamp(at ?? 0, 0, this.queue.length - 1);
    }
    this.load(true);
  },

  load(autoplay) {
    const t = this.queue[this.index]; if (!t) return;
    if (this.mode === "youtube") {
      this.ui({ title: t.title, artist: t.artist || this.album.artist, art: this.album.art, playing: true, pos: 0, dur: t.duration });
      Yt.play(t).catch(err => toast(err.message, 5000));   // after the bar is up, so it floats clear of it
      Speakers.paint();
      setGlow(); updatePill(); renderSheetState(); NP.modes(); NP.queue();
      return;
    }
    audio.loop = this.repeat === "one";
    const start = () => { if (autoplay) audio.play().catch(err => { if (err.name !== "AbortError") toast("Tap play to start (" + err.message + ")"); }); };
    if (this.album.source === "device") {   // read from this computer's disk as it plays
      Device.url(t).then(url => {
        if (this.queue[this.index] !== t) return URL.revokeObjectURL(url);
        if (this._fileUrl) URL.revokeObjectURL(this._fileUrl);
        this._fileUrl = url; audio.src = url; start();
      }).catch(err => toast(err.message));
    } else {
      audio.src = this.album.source === "demo" ? t.uri : `/api/local/stream/${encodeURIComponent(t.id)}`;
      start();
    }
    this.ui({ title: t.title, artist: t.artist || this.album.artist, art: this.album.art, playing: true, pos: 0, dur: t.duration });
    Speakers.paint();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || this.album.artist, album: this.album.title,
        artwork: this.album.art ? [{ src: new URL(this.album.art, location.href).href, sizes: "800x800", type: "image/jpeg" }] : [] });
    }
    setGlow(); updatePill(); renderSheetState(); NP.modes(); NP.queue();
  },

  /* Spotify plays on this screen unless a speaker was picked (see Speakers). */
  async playSpotify(album, index, shuffle) {
    Sdk.wake();   // in the tap itself, so the browser lets this page make sound
    if (this.mode === "browser") audio.pause();
    if (this.mode === "youtube") Yt.hide();
    this.mode = "spotify"; this.album = album;
    let offset = index;
    if (shuffle) offset = Math.floor(Math.random() * Math.max(1, album.track_list.length || album.tracks || 1));
    const play = device_id => api("/api/spotify/play", { method: "POST", body: { uri: album.uri, offset, device_id } }).then(() => device_id);
    try {
      let device_id;
      try { device_id = await play(await Speakers.target()); }
      catch (err) {   // the speaker picked earlier has gone: play where it would have otherwise
        if (!Speakers.chosen) throw err;
        Speakers.chosen = null;
        device_id = await play(await Speakers.target());
      }
      const d = Speakers.devices.find(x => x.id === device_id);
      this.sp = { ...(this.sp || {}), album_id: album.id, is_playing: true, progress_ms: 0,
        device_id, device: device_id === Sdk.deviceId ? "Album Viewer" : d?.name, device_type: d?.type };
      this.spAt = performance.now();
      const t = album.track_list[offset];
      this.ui({ title: t?.title || album.title, artist: album.artist, art: album.art, playing: true, pos: 0, dur: t?.duration || 0 });
      Speakers.paint();
      this.startPolling();
      setGlow(); updatePill(); NP.modes(); NP.queue();
    } catch (err) {
      if (/device|speaker/i.test(err.message)) Speakers.open({ retry: [album, index] });
      toast(err.message, 5000);
    }
  },

  toggle() {
    if (this.mode === "browser") { audio.paused ? audio.play() : audio.pause(); }
    else if (this.mode === "youtube") {
      const was = Yt.playing();
      if (was) Yt.pause(); else Yt.resume();   // in the tap itself, so the browser lets it make sound
      this.ui({ playing: !was }); updatePill();
    }
    else if (this.mode === "spotify") {
      const action = this.sp?.is_playing ? "pause" : "resume";
      if (this.sp) {   // hold the position where it is while paused
        this.sp.progress_ms = (this.cur.pos || 0) * 1000; this.spAt = performance.now();
        this.sp.is_playing = !this.sp.is_playing;
      }
      this.ui({ playing: this.sp?.is_playing }); updatePill();
      this.spotify(action);
    }
  },
  stop() {
    if (this.mode === "browser") { audio.pause(); }
    else if (this.mode === "youtube") { Yt.hide(); }
    else if (this.mode === "spotify" && this.sp?.is_playing) { this.sp.is_playing = false; api("/api/spotify/control", { method: "POST", body: { action: "pause" } }).catch(() => {}); }
    this.stopPolling();
    this.mode = null; this.album = null; this.sp = null;
    NP.close();
    $("#player").hidden = true;
    setGlow(); render();
  },
  next() {
    if (this.queued()) {
      if (this.index < this.queue.length - 1) this.index++;
      else if (this.repeat === "all") this.index = 0;
      else return;
      this.load(true);
    } else if (this.mode === "spotify") this.spotify("next");
  },
  /* the track came to its end: the next one, the same again, or stop at the end of the album */
  ended() {
    if (this.mode === "youtube" && this.repeat === "one") { Yt.seek(0); Yt.resume(); return; }
    if (this.index < this.queue.length - 1 || this.repeat === "all") this.next();
    else { this.ui({ playing: false }); updatePill(); renderSheetState(); }
  },
  prev() {
    if (this.queued()) {
      if (this.position() > 4 || (this.index === 0 && this.repeat !== "all")) { if (this.mode === "youtube") Yt.seek(0); else audio.currentTime = 0; }
      else { this.index = (this.index || this.queue.length) - 1; this.load(true); }
    } else if (this.mode === "spotify") this.spotify("previous");
  },
  jumpTo(i) { if (this.queued() && this.queue[i]) { this.index = i; this.load(true); } },
  /* f: how far into the track, 0 to 1 */
  seek(f) {
    if (this.mode === "browser" && audio.duration) { audio.currentTime = f * audio.duration; mediaState(); }
    else if (this.mode === "youtube" && this.cur.dur) { const pos = f * this.cur.dur; Yt.seek(pos); this.ui({ pos }); }
    else if (this.mode === "spotify" && this.cur.dur) {
      const pos = f * this.cur.dur;
      if (this.sp) { this.sp.progress_ms = pos * 1000; this.spAt = performance.now(); }
      this.ui({ pos });
      this.spotify("seek", Math.round(pos * 1000));
    }
  },
  toggleShuffle() {
    if (this.mode === "spotify") {
      const on = !this.sp?.shuffle;
      if (this.sp) this.sp.shuffle = on;
      NP.modes();
      return this.spotify("shuffle", on);
    }
    this.shuffle = !this.shuffle; store.set("shuffle", this.shuffle);
    if (this.queued()) {   // the track playing carries on; what comes after it changes
      const cur = this.queue[this.index];
      this.queue = this.shuffle ? [cur, ...shuffled(this.order.filter(t => t !== cur))] : this.order.slice();
      this.index = Math.max(0, this.queue.indexOf(cur));
    }
    NP.modes(); NP.queue();
  },
  cycleRepeat() {   // off, then the whole album, then this track
    const next = { off: "all", all: "one", one: "off" }[this.repeatMode()];
    if (this.mode === "spotify") {
      const v = { off: "off", all: "context", one: "track" }[next];
      if (this.sp) this.sp.repeat = v;
      NP.modes();
      return this.spotify("repeat", v);
    }
    this.repeat = next; store.set("repeat", next);
    audio.loop = this.mode === "browser" && next === "one";
    NP.modes(); NP.queue();
  },
  spotify(action, value) {
    return api("/api/spotify/control", { method: "POST", body: { action, value } }).catch(e => toast(e.message)).finally(() => this.pollSoon());
  },

  ui(o) {
    for (const k in o) if (o[k] !== undefined) this.cur[k] = o[k];
    const { title, artist, art, playing, pos, dur } = o;
    if ($("#player").hidden) { $("#player").hidden = false; requestAnimationFrame(render); }
    if (title !== undefined) $("#pTitle").textContent = title;
    if (artist !== undefined) $("#pArtist").textContent = artist;
    if (art !== undefined) $("#pCover").src = art || "";
    if (playing !== undefined) {
      $("#pToggle").innerHTML = icon(playing ? "pause" : "play");
      $("#pBar").classList.toggle("on", !!playing);   // the line wiggles while it plays
    }
    if (dur !== undefined) $("#pDur").textContent = fmt(dur || 0);
    if (pos !== undefined) {
      $("#pPos").textContent = fmt(pos);
      const d = dur ?? this._dur ?? 0, f = d ? Math.min(1, pos / d) : 0, bar = $("#pBar");
      bar.classList.toggle("jump", f < (this._f ?? 0) || f - (this._f ?? 0) > 0.06);   // glide forward, snap otherwise
      bar.style.setProperty("--f", f.toFixed(4));
      this._f = f;
    }
    if (dur !== undefined) this._dur = dur;
    NP.sync(o);
  },

  startPolling() {
    this.stopPolling(); this.poll();
    this.pollT = setInterval(() => this.poll(), 3000);
    this.tickT = setInterval(() => this.tick(), 250);
  },
  stopPolling() { clearInterval(this.pollT); clearInterval(this.tickT); this.pollT = this.tickT = null; },
  pollSoon() { setTimeout(() => this.poll(), 600); },
  // Between polls, Spotify's position moves on by the clock, so the bar doesn't stop and start.
  tick() {
    const s = this.sp;
    if (this.mode !== "spotify" || !s?.is_playing || !this.cur.dur || document.hidden) return;
    this.ui({ pos: Math.min(this.cur.dur, (s.progress_ms || 0) / 1000 + (performance.now() - this.spAt) / 1000) });
  },
  async poll() {
    if (this.mode !== "spotify" || document.hidden) return;
    try {
      const s = await api("/api/spotify/state");
      if (!s || !s.track) return;
      const changedAlbum = s.album_id !== this.sp?.album_id;
      this.sp = s; this.spAt = performance.now();
      this.ui({ title: s.track, artist: s.artist, art: s.image, playing: s.is_playing,
        pos: (s.progress_ms || 0) / 1000, dur: (s.duration_ms || 0) / 1000 });
      Speakers.paint();
      if (changedAlbum && S.byId.has(s.album_id)) setOpen(s.album_id);
      setGlow(); updatePill(); NP.modes();
    } catch {}
  },
};

audio.addEventListener("ended", () => {   // "repeat this track" loops the audio itself and never ends
  if (Player.mode === "browser") Player.ended();
});
/* Lock screen and notification: the playing state and a position bar you can drag there. */
function mediaState() {
  const ms = navigator.mediaSession;
  if (!ms || Player.mode !== "browser") return;
  ms.playbackState = audio.paused ? "paused" : "playing";
  if (ms.setPositionState && isFinite(audio.duration) && audio.duration > 0) {
    try { ms.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, audio.duration) }); } catch {}
  }
}
audio.addEventListener("play", () => { if (Player.mode === "browser") { Player.ui({ playing: true }); updatePill(); mediaState(); } });
audio.addEventListener("pause", () => { if (Player.mode === "browser") { Player.ui({ playing: false }); updatePill(); mediaState(); } });
audio.addEventListener("loadedmetadata", mediaState);
audio.addEventListener("seeked", mediaState);
audio.addEventListener("timeupdate", () => Player.mode === "browser" && audio.duration && Player.ui({ pos: audio.currentTime, dur: audio.duration }));
audio.addEventListener("error", () => { if (Player.mode === "browser" && audio.src) { toast("Couldn't play this track in the browser, skipping"); setTimeout(() => Player.next(), 800); } });
$(".p-progress").addEventListener("click", e => {
  if (!Player.canSeek()) return;
  const r = e.currentTarget.getBoundingClientRect();
  Player.seek(clamp((e.clientX - r.left) / r.width, 0, 1));
});
$("#pToggle").onclick = () => Player.toggle();
$("#pNext").onclick = () => Player.next();
$("#pPrev").onclick = () => Player.prev();
$("#pDevice").onclick = () => Speakers.open();
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };   // older browsers lack some actions
  const seekBy = s => { if (Player.mode === "browser" && audio.duration) { audio.currentTime = clamp(audio.currentTime + s, 0, audio.duration); mediaState(); } };
  on("play", () => Player.toggle());
  on("pause", () => Player.toggle());
  on("nexttrack", () => Player.next());
  on("previoustrack", () => Player.prev());
  on("seekto", d => { if (Player.mode === "browser" && audio.duration) { audio.currentTime = clamp(d.seekTime, 0, audio.duration); mediaState(); } });
  on("seekbackward", d => seekBy(-(d.seekOffset || 10)));
  on("seekforward", d => seekBy(d.seekOffset || 10));
}

/* ======================================================== now playing
   The full-screen player. Tap the bar (or swipe it up) to open it; the chevron, a swipe down,
   Escape or Back put it away. The cover sits in front of its record, which slides out of the
   sleeve once the screen is up and turns while the music plays. */

const np = $("#nowPlaying"), npBar = $("#npBar");
const NP = {
  isOpen: false, seeking: false, f: 0, skipPop: false, outT: 0,

  open() {
    if (!Player.mode || this.isOpen) return;
    this.isOpen = true;
    this.render();
    reveal(np, true);
    Yt.place();   // YouTube's video rides up with it, onto the stage
    for (const s of ["#topbar", "#room", "#player"]) $(s).inert = true;   // nothing behind it takes focus
    clearTimeout(this.outT);
    this.outT = setTimeout(() => { np.classList.add("out"); this.spin(); }, reduceMotion.matches ? 0 : 220);
    if (!history.state?.np) history.pushState({ np: 1 }, "");   // so Back closes it
    $("#npClose").focus({ preventScroll: true });
  },
  close(fromHistory = false) {
    if (!this.isOpen) return;
    this.isOpen = false;
    clearTimeout(this.outT);
    np.classList.remove("dragging");
    np.style.transform = "";
    reveal(np, false, 300);
    Yt.place();   // and back to its corner
    for (const s of ["#topbar", "#room", "#player"]) $(s).inert = false;
    this.outT = setTimeout(() => { np.classList.remove("out"); this.spin(true); }, 300);
    if (!fromHistory && history.state?.np) { this.skipPop = true; history.back(); }
  },

  render() {
    const c = Player.cur;
    this.sync({ ...c, art: c.art || "" });
    this.modes(); this.queue(); Speakers.paint();
  },
  sync(o) {
    if (o.title !== undefined) $("#npTitle").textContent = o.title;
    if (o.artist !== undefined) $("#npArtist").textContent = o.artist;
    if (o.art !== undefined) this.cover(o.art);
    if (o.playing !== undefined) { $("#npToggle").innerHTML = icon(o.playing ? "pause" : "play"); npBar.classList.toggle("on", !!o.playing); this.spin(); }
    if (o.dur !== undefined) $("#npDur").textContent = fmt(o.dur || 0);
    if (o.pos !== undefined && !this.seeking) this.setPos(o.pos, o.dur ?? Player.cur.dur);
    if (o.pos !== undefined || o.dur !== undefined) npBar.classList.toggle("fixed", !Player.canSeek());
  },
  cover(art) {
    const a = S.byId.get(Player.albumId()) || Player.album;
    np.style.setProperty("--np-c", a?.color || "#2a2622");
    $("#npVinyl .label").style.setProperty("--lc", a?.color || "#3a3632");
    $("#npFrom").textContent = a?.title || Player.sp?.album || "";
    for (const img of [$("#npCover"), $("#npLabel")]) {
      if (art) { if (img.getAttribute("src") !== art) img.src = art; img.style.visibility = ""; }
      else { img.removeAttribute("src"); img.style.visibility = img.id === "npLabel" ? "hidden" : ""; }
    }
  },
  setPos(pos, dur) {
    const f = dur ? clamp(pos / dur, 0, 1) : 0;
    npBar.classList.toggle("jump", f < this.f || f - this.f > 0.05);   // glide forward, snap otherwise
    npBar.style.setProperty("--f", f.toFixed(4));
    this.f = f;
    $("#npPos").textContent = fmt(pos);
  },
  /* The label turns, and so does the faint grain in the grooves: that's what shows above the sleeve. */
  spin(stop = false) {
    const on = !stop && this.isOpen && np.classList.contains("out") && Player.playing();
    for (const el of $$("#npVinyl .label, #npVinyl .grain")) setSpin(el, on, stop);
  },
  modes() {
    const sh = $("#npShuffle"), rp = $("#npRepeat"), on = Player.shuffleOn(), rep = Player.repeatMode();
    sh.classList.toggle("on", on); sh.setAttribute("aria-pressed", on);
    sh.title = on ? "Shuffle is on" : "Shuffle";
    rp.classList.toggle("on", rep !== "off"); rp.classList.toggle("one", rep === "one");
    rp.title = { off: "Repeat", all: "Repeating the album", one: "Repeating this track" }[rep];
  },
  queue() {   // Up next: what plays after this track, from this screen's queue
    if (!this.isOpen) return;
    const q = Player.queue, i = Player.index;
    let items = [];
    if (Player.queued()) {
      items = q.slice(i + 1).map((t, k) => [t, i + 1 + k]);
      if (Player.repeat === "all") items = items.concat(q.slice(0, i).map((t, k) => [t, k]));
    }
    $("#npNextWrap").hidden = !items.length;
    $("#npQueue").innerHTML = items.slice(0, 60).map(([t, k]) =>
      `<li data-i="${k}"><span class="n">${t.track_no || k + 1}</span><span class="tt">${esc(t.title)}</span><span class="d">${fmt(t.duration)}</span></li>`).join("");
  },
};

/* the seek bar: drag along it; the track moves when you let go */
const seekAt = e => { const r = npBar.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
function previewSeek(f) {
  npBar.style.setProperty("--f", f.toFixed(4));
  $("#npPos").textContent = fmt(f * (Player.cur.dur || 0));
}
npBar.addEventListener("pointerdown", e => {
  if (!Player.canSeek() || e.button > 0) return;
  e.preventDefault();
  NP.seeking = true;
  try { npBar.setPointerCapture(e.pointerId); } catch {}
  npBar.classList.add("seeking");
  previewSeek(seekAt(e));
});
npBar.addEventListener("pointermove", e => { if (NP.seeking) previewSeek(seekAt(e)); });
npBar.addEventListener("pointerup", e => {
  if (!NP.seeking) return;
  NP.seeking = false; npBar.classList.remove("seeking");
  NP.f = seekAt(e);
  Player.seek(NP.f);
});
npBar.addEventListener("pointercancel", () => {
  if (!NP.seeking) return;
  NP.seeking = false; npBar.classList.remove("seeking");
  NP.setPos(Player.cur.pos || 0, Player.cur.dur);
});

/* swipe down to put it away: it follows the finger, then goes or springs back */
const Pull = { y0: null, x0: 0, dy: 0, on: false, top: true, lastY: 0, lastT: 0, v: 0 };
np.addEventListener("touchstart", e => {
  Pull.y0 = null;
  if (e.touches.length !== 1 || e.target.closest(".np-bar")) return;
  let top = true;   // only from the top of whatever scrolls; further down, the swipe scrolls instead
  for (let el = e.target; el && el !== np; el = el.parentElement) if (el.scrollTop > 0) { top = false; break; }
  const t = e.touches[0];
  Object.assign(Pull, { y0: t.clientY, x0: t.clientX, dy: 0, on: false, top, lastY: t.clientY, lastT: e.timeStamp, v: 0 });
}, { passive: true });
np.addEventListener("touchmove", e => {
  if (Pull.y0 === null) return;
  const t = e.touches[0], dy = t.clientY - Pull.y0, dx = t.clientX - Pull.x0;
  if (!Pull.on) {
    if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
    if (!Pull.top || dy <= 0 || Math.abs(dx) > dy) { Pull.y0 = null; return; }   // a scroll, or sideways
    Pull.on = true; np.classList.add("dragging");
  }
  e.preventDefault();
  const dt = e.timeStamp - Pull.lastT;
  if (dt > 0) Pull.v = 0.7 * ((t.clientY - Pull.lastY) / dt) + 0.3 * Pull.v;
  Pull.lastY = t.clientY; Pull.lastT = e.timeStamp;
  Pull.dy = Math.max(0, dy);
  np.style.transform = `translateY(${Pull.dy}px)`;
}, { passive: false });
function endPull() {
  const was = Pull.on;
  Pull.y0 = null; Pull.on = false;
  if (!was) return;
  np.classList.remove("dragging");
  np.style.transform = "";
  if (Pull.dy > Math.min(150, innerHeight * 0.22) || Pull.v > 0.11) NP.close();   // otherwise it springs back up
}
np.addEventListener("touchend", endPull);
np.addEventListener("touchcancel", endPull);

$("#npClose").onclick = () => NP.close();
$("#npToggle").onclick = () => Player.toggle();
$("#npNext").onclick = () => Player.next();
$("#npPrev").onclick = () => Player.prev();
$("#npShuffle").onclick = () => { haptic(6); Player.toggleShuffle(); };
$("#npRepeat").onclick = () => { haptic(6); Player.cycleRepeat(); };
$("#npDevice").onclick = () => Speakers.open();
$("#npTracks").onclick = () => { const id = Player.albumId(); if (id && S.byId.has(id)) openSheet(id, $("#npCover")); };
$("#npQueue").addEventListener("click", e => { const li = e.target.closest("li"); if (li) Player.jumpTo(+li.dataset.i); });
addEventListener("popstate", () => {
  if (NP.skipPop) { NP.skipPop = false; return; }
  if (!NP.isOpen) return;
  if ($$(".sheet").some(s => s.classList.contains("in"))) { closeSheets(); history.pushState({ np: 1 }, ""); return; }   // Back closes the top layer first
  NP.close(true);
});

/* the bar at the bottom: tap it, or swipe it up, for the full player */
$("#player").addEventListener("click", e => {
  peek();
  // the path as it was when the tap landed: the play button redraws its icon while handling it
  if (!e.composedPath().some(el => el.matches?.("button, .p-progress"))) NP.open();
});
let barY = null;
$("#player").addEventListener("touchstart", e => { barY = e.touches.length === 1 && !e.target.closest(".p-progress") ? e.touches[0].clientY : null; }, { passive: true });
$("#player").addEventListener("touchmove", e => { if (barY !== null && barY - e.touches[0].clientY > 24) { barY = null; NP.open(); } }, { passive: true });

/* ======================================================== speakers
   Music plays on the screen you're using. Your own music plays in this page, and so does Spotify
   (Sdk, below; it needs Premium), or else this phone's Spotify app. The speaker button on the
   player shows where it's playing and moves Spotify to any of your Spotify speakers. A speaker you
   pick is used until the page is reloaded; then it's this screen again. */

const UA = navigator.userAgent;
const IPAD = /Macintosh/.test(UA) && navigator.maxTouchPoints > 1;   // iPadOS Safari says it's a Mac
const HERE = /iPad|Tablet/i.test(UA) || IPAD || (/Android/i.test(UA) && !/Mobile/i.test(UA)) ? { name: "This tablet", icon: "phone", type: "Tablet" }
  : /Android|iPhone|iPod|Mobile/i.test(UA) ? { name: "This phone", icon: "phone", type: "Smartphone" }
  : { name: "This computer", icon: "computer", type: "Computer" };
const iconFor = type => ({ Computer: "computer", Smartphone: "phone", Tablet: "phone", TV: "tv", CastVideo: "tv", GameConsole: "tv", STB: "tv" }[type] || "speaker");

/* Spotify in this browser: Spotify's Web Playback SDK makes this page a Spotify speaker, in desktop
   and phone browsers alike. It needs Spotify Premium; without it, Spotify plays on another speaker. */
const Sdk = {
  player: null, deviceId: null, loading: null, failed: false,
  supported: typeof window.MediaKeys === "function",   // the SDK plays through the browser's media keys (EME)
  enabled() { return this.supported && !this.failed && store.get("sdk", true); },
  load() {
    if (!this.enabled() || this.loading) return this.loading;
    this.loading = new Promise(resolve => {
      const give = id => { if (!id) this.loading = null; resolve(id); };   // a failed start can be tried again
      const start = () => {
        this.player = new Spotify.Player({
          name: "Album Viewer",
          getOAuthToken: cb => api("/api/spotify/token").then(r => cb(r.access_token)).catch(() => {}),
          volume: 0.8,
        });
        this.player.addListener("ready", ({ device_id }) => { this.deviceId = device_id; give(device_id); });
        this.player.addListener("not_ready", () => { this.deviceId = null; });
        // Without Premium (or in a browser it can't run in) Spotify plays on another speaker instead.
        this.player.addListener("initialization_error", () => { this.failed = true; give(null); });
        this.player.addListener("account_error", () => { this.failed = true; store.set("sdk", false); give(null); });
        this.player.addListener("authentication_error", () => give(null));
        this.player.connect();
        setTimeout(() => give(this.deviceId), 8000);
      };
      if (window.Spotify?.Player) return start();
      window.onSpotifyWebPlaybackSDKReady = start;
      const s = document.createElement("script"); s.src = "https://sdk.scdn.co/spotify-player.js"; document.head.appendChild(s);
    });
    return this.loading;
  },
  stop() { try { this.player?.disconnect(); } catch {} this.player = null; this.deviceId = null; this.loading = null; },
  wake() { try { this.player?.activateElement?.(); } catch {} },
  async device() { return this.enabled() ? (await this.load()) || null : null; },
};

const Speakers = {
  chosen: null,   // { id, name }: a Spotify speaker picked during this visit ("sdk" is this browser)
  devices: [],    // Spotify's speakers, as last fetched
  retry: null,    // [album, index]: what to play once a speaker is picked
  sink: null,     // { label }: another output for this page's own music, where the browser lets a page pick one

  async fetch() {
    try { this.devices = (await api("/api/spotify/devices")).filter(d => d.id && !d.is_restricted); }
    catch { this.devices = []; }
    return this.devices;
  },
  /* Where Spotify should play: the speaker picked during this visit; else this screen (this browser,
     or this phone's Spotify app if it's the only phone online); else wherever Spotify is already
     playing. undefined lets the server wake the first speaker it finds. */
  async target() {
    if (this.chosen?.id === "sdk") { const id = await Sdk.device(); if (id) return id; this.chosen = null; }
    if (this.chosen) return this.chosen.id;
    const sdk = await Sdk.device();
    if (sdk) return sdk;
    const devs = await this.fetch();
    return this.mine()?.id || devs.find(d => d.is_active)?.id;
  },
  /* On a phone or tablet, its own Spotify app: the one speaker of its kind that's online. */
  mine() {
    if (HERE.type === "Computer") return null;
    const same = this.devices.filter(d => d.type === HERE.type);
    return same.length === 1 ? same[0] : null;
  },
  /* What the speaker button says: this screen, or the Spotify speaker it's playing on. */
  now() {
    if (Player.mode === "spotify") {
      const s = Player.sp || {};
      if (s.device_id && s.device_id === Sdk.deviceId) return { name: HERE.name, icon: HERE.icon, remote: false };
      if (s.device_id && s.device_id === this.mine()?.id) return { name: `Spotify app on ${HERE.name.toLowerCase()}`, icon: HERE.icon, remote: false };
      if (!s.device) return { name: "Spotify", icon: "speaker", remote: false };   // until Spotify says
      return { name: s.device, icon: iconFor(s.device_type), remote: true };
    }
    if (Player.mode === "youtube") return { name: HERE.name, icon: HERE.icon, remote: false };   // in YouTube's player, here
    return { name: this.sink?.label || HERE.name, icon: this.sink ? "speaker" : HERE.icon, remote: false };
  },
  paint() {
    const d = this.now();
    for (const [btn, label] of [[$("#pDevice"), $("#pDeviceName")], [$("#npDevice"), $("#npDeviceName")]]) {
      label.textContent = d.remote ? `Playing on ${d.name}` : d.name;
      btn.querySelector("use").setAttribute("href", "#i-" + d.icon);
      btn.classList.toggle("remote", d.remote);
    }
  },

  close() { reveal($("#deviceSheet"), false, 260); },
  async open({ retry } = {}) {
    this.retry = retry || null;
    const spotify = Player.mode === "spotify" || !!retry;
    $("#devRefresh").hidden = !spotify;
    $("#devPick").hidden = spotify || !navigator.mediaDevices?.selectAudioOutput;
    $("#devRefresh").parentElement.hidden = $("#devRefresh").hidden && $("#devPick").hidden;
    reveal($("#deviceSheet"), true);
    if (!spotify) return this.renderHere();
    $("#deviceList").innerHTML = '<div class="hint">Looking for speakers…</div>';
    $("#devHint").textContent = "";
    await this.fetch();
    this.renderSpotify();
  },
  row({ icon, name, sub, on }) {
    return `<button type="button" class="${on ? "on" : ""}"><svg class="ic"><use href="#i-${icon}"/></svg>` +
      `<span class="nm"><b>${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span>` +
      (on ? '<svg class="tick"><use href="#i-check"/></svg>' : "") + "</button>";
  },
  /* Your own music plays in this page, through whatever this device plays sound through. */
  renderHere() {
    const yt = Player.mode === "youtube";
    $("#deviceList").innerHTML = this.row({ icon: this.sink && !yt ? "speaker" : HERE.icon, name: (!yt && this.sink?.label) || HERE.name, sub: yt ? "Playing in YouTube's player, here" : "Playing here", on: true });
    $("#deviceList button").onclick = () => this.close();
    $("#devPick").hidden = $("#devPick").hidden || yt;
    if (yt) {
      $("#devHint").textContent = "YouTube plays in its own player on this screen. To play it on another device, open it in YouTube Music there.";
      return;
    }
    $("#devHint").textContent = (HERE.type === "Computer"
      ? "Your music plays through this computer's sound output, which you change in its sound settings."
      : `Your music plays on ${HERE.name.toLowerCase()}. To hear it on Bluetooth headphones or a speaker, connect them to it.`)
      + (S.status?.spotify?.connected ? " Spotify albums can play on any of your Spotify speakers." : "");
  },
  renderSpotify() {
    const list = $("#deviceList"), cur = Player.mode === "spotify" ? Player.sp?.device_id : null;
    const items = [];
    const here = HERE.name.toLowerCase();
    if (Sdk.enabled()) items.push({ id: "sdk", icon: HERE.icon, name: HERE.name, sub: "Plays here, in this browser", on: !!cur && cur === Sdk.deviceId, said: `Playing on ${here}` });
    const mine = this.mine();
    if (mine) items.push({ id: mine.id, icon: HERE.icon, name: `Spotify app on ${here}`, sub: mine.name, on: mine.id === cur, type: mine.type, said: `Playing in the Spotify app on ${here}` });
    const others = this.devices.filter(d => d.id !== Sdk.deviceId && d !== mine).sort((a, b) => (b.is_active - a.is_active) || cmp(a.name, b.name));
    for (const d of others) items.push({ id: d.id, icon: iconFor(d.type), name: d.name, sub: { Smartphone: "Phone", CastAudio: "Speaker", CastVideo: "TV" }[d.type] || d.type, on: d.id === cur, type: d.type });
    list.innerHTML = items.length ? items.map(it => this.row(it)).join("") : '<div class="hint">No Spotify speakers are on right now.</div>';
    [...list.querySelectorAll("button")].forEach((b, i) => { b.onclick = () => this.choose(items[i]); });
    $("#devHint").textContent = HERE.type === "Computer" || items.length
      ? "Don't see a speaker? Open Spotify on it, then refresh."
      : `To play on ${HERE.name.toLowerCase()}, open the Spotify app on it, then refresh.`;
  },
  async choose(d) {
    haptic(6);
    this.chosen = { id: d.id, name: d.name };
    this.close();
    if (this.retry) { const [album, index] = this.retry; this.retry = null; return Player.playSpotify(album, index); }
    if (Player.mode !== "spotify") return;
    const id = d.id === "sdk" ? await Sdk.device() : d.id;
    if (!id) { this.chosen = null; return toast("Spotify can't play in this browser (it needs Spotify Premium). Pick another speaker.", 5000); }
    try {
      await api("/api/spotify/transfer", { method: "POST", body: { device_id: id } });
      if (Player.sp) Object.assign(Player.sp, { device_id: id, device: d.name, device_type: d.type });
      this.paint();
      toast(d.said || `Playing on ${d.name}`);
    } catch (e) { toast(e.message); }
    Player.pollSoon();
  },
  /* This page's own music on another output, in browsers that let a page choose (Firefox). */
  async pickOutput() {
    try {
      const out = await navigator.mediaDevices.selectAudioOutput();
      await audio.setSinkId(out.deviceId);
      this.sink = { label: out.label || "Another speaker" };
      this.close();
      this.paint();
    } catch (e) { if (!["NotAllowedError", "AbortError"].includes(e.name)) toast(e.message); }
  },
};
$("#devRefresh").onclick = async () => { $("#deviceList").innerHTML = '<div class="hint">Looking for speakers…</div>'; await Speakers.fetch(); Speakers.renderSpotify(); };
$("#devPick").onclick = () => Speakers.pickOutput();

/* Phones: drag the speaker drawer down to put it away. It follows the finger; let go far enough, or
   with a flick, and it goes, otherwise it settles back. Pulling it up meets more and more friction. */
{
  const panel = $("#deviceSheet .panel");
  let y0 = null, dy = 0, t0 = 0, id = null;
  panel.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch" || y0 !== null || panel.scrollTop > 0 || !matchMedia("(max-width: 860px)").matches) return;
    y0 = e.clientY; dy = 0; t0 = performance.now(); id = e.pointerId;
  });
  panel.addEventListener("pointermove", e => {
    if (y0 === null || e.pointerId !== id) return;   // one finger only
    const d = e.clientY - y0;
    if (!panel.classList.contains("dragging")) {
      if (Math.abs(d) < 6) return;
      panel.classList.add("dragging");
      try { panel.setPointerCapture(id); } catch {}
    }
    dy = d > 0 ? d : -Math.pow(-d, 0.7);   // friction going up, not a wall
    panel.style.transform = `translateY(${dy}px)`;
  });
  const end = e => {
    if (y0 === null || e.pointerId !== id) return;
    const dragged = panel.classList.contains("dragging"), v = dy / Math.max(1, performance.now() - t0);
    y0 = null; panel.classList.remove("dragging"); panel.style.transform = "";
    if (dragged && dy > 0 && (dy > panel.offsetHeight * 0.3 || v > 0.11)) Speakers.close();
  };
  panel.addEventListener("pointerup", end);
  panel.addEventListener("pointercancel", end);
}

/* ======================================================== settings + status */

/* who is signed in: their name and picture, and whether they run this server */
function renderAccount() {
  const me = S.me;
  if (!me) return;
  $("#meName").textContent = me.name || me.email || "Signed in";
  $("#meDetail").textContent = [me.email, me.google ? "Google" : me.spotify_id ? "Spotify" : "", me.admin ? "runs this server" : ""]
    .filter(Boolean).join(" · ");
  if (me.picture) $("#meAvatar").src = me.picture; else $("#meAvatar").removeAttribute("src");
}

function renderEmpty() {
  const admin = S.me?.admin, sp = S.status?.spotify, yt = S.status?.youtube;
  const services = [sp?.configured && "Spotify", yt?.configured && "YouTube"].filter(Boolean).join(" or ") || "Spotify";
  $("#emptyText").textContent = admin
    ? `Load the demo shelf, connect ${services}, or add music to the server's music folder.`
    : `Connect ${services} to see your albums and playlists here` + (sp && !sp.configured && !yt?.configured ? " (once the owner sets Spotify up)." : ".");
  $("#demoLoadBtn").hidden = !admin;
  $("#emptySpotify").hidden = !sp?.configured || sp.connected;
  $("#emptyYouTube").hidden = !yt?.configured || yt.connected;
  $("#emptyFolder").hidden = S.vertical;   // on a phone, the Android app plays the phone's own music
}
$("#emptySpotify").onclick = () => (location.href = "/auth/spotify/login");
$("#emptyYouTube").onclick = () => (location.href = "/auth/youtube/login");
$("#emptyFolder").onclick = () => Device.choose();

/* ======================================================== music on this computer
   Albums from a folder on this computer, read in the browser by device.js (Chrome and Edge keep the
   folder between visits; other browsers open files for one visit). Nothing is uploaded: the server
   only keeps which of them are hidden and their place in the manual order. */

const Device = {
  mod: null, albums: [], details: new Map(), folder: null, permission: null, scanning: null, artUrls: [],
  lib() { return (this.mod ??= import("/device.js")); },
  keeps() { return typeof window.showDirectoryPicker === "function"; },
  /* its albums as they go on the shelf: hidden ones left off (unless shown), with their manual places */
  shelf() {
    const hidden = new Set(S.me?.device_hidden || []), showHidden = store.get("showHidden", false);
    const pos = new Map((S.orderIds || []).map((id, i) => [id, i]));
    return this.albums.map(a => ({ ...a, hidden: hidden.has(a.id), pos: pos.get(a.id) })).filter(a => showHidden || !a.hidden);
  },
  detail(id) {
    const a = this.albums.find(x => x.id === id);
    return a && { ...a, track_list: this.details.get(id) || [] };
  },
  apply(index, folder) {
    this.artUrls.forEach(u => URL.revokeObjectURL(u));
    this.artUrls = [];
    this.albums = (index?.albums || []).map(({ artBlob, ...a }) => {
      const art = artBlob ? URL.createObjectURL(artBlob) : null;
      if (art) this.artUrls.push(art);
      return { ...a, art };
    });
    this.details = new Map(Object.entries(index?.details || {}));
    this.folder = folder ?? index?.folder ?? null;
    S.fresh = null;
    applyAlbums(S.serverAlbums || [], true);
    renderDevice();
  },
  progress(done, total) {
    this.scanning = { done, total };
    const t = $("#scanToast");
    t.textContent = `Reading your music folder… ${done} of ${total} tracks`;
    reveal(t, true);
    renderDevice();
  },
  async run(job) {
    try { this.scanning = { done: 0, total: 0 }; renderDevice(); await job(); }
    catch (err) { if (err.name !== "AbortError") toast(err.message); }
    finally { this.scanning = null; reveal($("#scanToast"), false); renderDevice(); }
  },
  async restore() {
    if (!this.keeps()) return;
    const m = await this.lib(), r = await m.restore();
    if (!r) return;
    this.permission = r.permission;
    this.apply(r, r.folder);
    // Refresh a scan more than a day old, if the browser still lets us read the folder.
    if (r.permission === "granted" && Date.now() - (r.scannedAt || 0) > 24 * 3600e3) this.rescan(false);
  },
  choose() {
    if (!this.keeps()) return $("#devFiles").click();
    return this.run(async () => {
      const m = await this.lib();
      const index = await m.chooseFolder((d, n) => this.progress(d, n));
      this.permission = "granted";
      this.apply(index);
      toast(`${index.albums.length} albums from “${index.folder}”`);
    });
  },
  rescan(interactive = true) {
    return this.run(async () => {
      const m = await this.lib();
      if (this.permission !== "granted") {
        if (!interactive || !(await m.reconnect())) return;
        this.permission = "granted";
      }
      this.apply(await m.scanFolder((d, n) => this.progress(d, n)));
    });
  },
  async forget() {
    if (!confirm("Take this computer's music off the shelf? The files stay where they are.")) return;
    if (Player.album?.source === "device") Player.stop();
    await (await this.lib()).forget();
    this.permission = null;
    this.apply(null, null);
  },
  openFiles(files) {
    return this.run(async () => {
      const index = await (await this.lib()).openFiles(files, (d, n) => this.progress(d, n));
      this.permission = "granted";
      this.apply(index, `${files.length} files`);
    });
  },
  async url(track) {
    const m = await this.lib();
    if (this.permission === "prompt") {   // the browser forgot: asking needs this click
      if (!(await m.reconnect())) throw new Error("Album Viewer needs your permission to read the music folder");
      this.permission = "granted";
    }
    return m.trackUrl(track);
  },
};
$("#devFiles").onchange = e => { if (e.target.files.length) Device.openFiles([...e.target.files]); e.target.value = ""; };
if ("webkitdirectory" in document.createElement("input")) $("#devFiles").setAttribute("webkitdirectory", "");

function renderDevice() {
  const st = $("#devStatus"), btns = $("#devButtons");
  if (!st) return;
  const n = Device.albums.length, sc = Device.scanning;
  btns.innerHTML = "";
  const add = (label, fn, primary) => {
    const b = document.createElement("button");
    b.className = primary ? "primary" : "ghost"; b.textContent = label; b.onclick = fn; b.disabled = !!sc;
    btns.appendChild(b);
  };
  if (sc) st.textContent = sc.total ? `Reading… ${sc.done} of ${sc.total} tracks` : "Looking through the folder…";
  else if (Device.folder) st.textContent = `${n} album${n === 1 ? "" : "s"} from “${Device.folder}”` +
    (Device.permission === "prompt" ? ". Your browser will ask again before it plays them." : ". Nothing is uploaded.");
  else st.textContent = Device.keeps()
    ? "Play the music in a folder on this computer. Nothing is uploaded; your browser keeps the folder for next time."
    : "Open a music folder to play it here. This browser can't keep it for next time, so open it again on your next visit.";
  if (Device.folder && Device.keeps()) {
    add("Rescan", () => Device.rescan());
    add("Choose another folder", () => Device.choose());
    add("Forget", () => Device.forget());
  } else add(Device.keeps() ? "Choose a folder" : "Open a folder", () => Device.choose(), true);
}

function openSettings() {
  reveal($("#settingsSheet"), true);
  renderAccount();
  renderDevice();
  $("#showHidden").checked = store.get("showHidden", false);
  $("#spineNames").checked = store.get("spineNames", true);
  $("#glowToggle").checked = store.get("glow", true);
  $("#sdkToggle").checked = Sdk.supported && store.get("sdk", true);
  $("#shape").value = store.get("shape", "bar");
  refreshStatus();
}
window.openSettings = openSettings;

function renderStatus(st) {
  const sp = st.spotify, lib = st.library || {}, demo = st.demo;
  const spBtns = $("#spButtons"); spBtns.innerHTML = "";
  $("#spAdd").hidden = !sp.connected; $("#sdkRow").hidden = !sp.connected || !Sdk.supported;
  $("#spFriends").hidden = !(st.admin && sp.configured);   // Spotify lets in only the people the admin adds
  if (!sp.configured) {
    $("#spStatus").innerHTML = st.admin
      ? `Not set up. Create an app at developer.spotify.com, add the redirect URI <code>${esc(sp.redirect_uri)}</code>, then set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET and restart.`
      : "Spotify isn't set up on this server yet.";
  } else if (!sp.connected) {
    $("#spStatus").textContent = "Not connected. Your saved albums and playlists come onto your shelf.";
    spBtns.innerHTML = `<button class="primary" onclick="location.href='/auth/spotify/login'">Connect Spotify</button>`;
  } else {
    const mine = S.albums.filter(a => a.source === "spotify"), lists = mine.filter(a => a.kind === "playlist").length;
    $("#spStatus").textContent = sp.syncing ? `Syncing… ${sp.albums} albums and playlists` :
      `Connected · ${mine.length - lists} albums · ${lists} playlists` + (sp.error ? ` · last sync error: ${sp.error}` : "");
    spBtns.innerHTML = `<button class="ghost" id="spSync">Sync again</button><button class="ghost" id="spOff">Disconnect</button>`;
    $("#spSync").onclick = () => api("/api/spotify/sync", { method: "POST" }).then(watchStatus);
    $("#spOff").onclick = async () => { if (confirm("Disconnect Spotify and take its albums and playlists off your shelf?")) { await api("/api/spotify/disconnect", { method: "POST" }); loadAlbums(); refreshStatus(); } };
  }
  renderYouTube(st.youtube || {});
  // The server's music folder and the demo shelf are looked after by whoever runs the server.
  $("#libSec").hidden = !st.admin; $("#demoSec").hidden = !st.admin;
  if (st.admin) $("#libStatus").textContent = lib.error ? lib.error :
    lib.scanning ? `${lib.phase}… ${lib.phase === "finding artwork" ? `${lib.art_done}/${lib.art_total}` : `${lib.files} files`}` :
    `${lib.albums} albums from ${lib.files} files in ${st.music_dir}` + (lib.last_scan ? ` · scanned ${new Date(lib.last_scan * 1000).toLocaleString()}` : "");

  const dBtns = $("#demoButtons");
  if (demo.loading) { $("#demoStatus").textContent = `Loading… ${demo.albums} of ${demo.total} albums`; dBtns.innerHTML = ""; }
  else if (demo.albums) {
    $("#demoStatus").textContent = `${demo.albums} albums from the iTunes catalogue. Each track plays a 30-second preview on this screen.`;
    dBtns.innerHTML = `<button class="ghost" id="demoRemove">Remove demo shelf</button>`;
    $("#demoRemove").onclick = async () => {
      if (Player.album?.source === "demo") Player.stop();
      if (S.byId.get(S.openId)?.source === "demo") S.openId = null;
      await api("/api/demo", { method: "DELETE" }); await loadAlbums(); refreshStatus();
    };
  } else {
    $("#demoStatus").textContent = (demo.error ? `Last attempt failed: ${demo.error}. ` : "") +
      `Fills the shelf with ${demo.total} well-known albums and their 30-second previews, so you can try Album Viewer without an account.`;
    dBtns.innerHTML = `<button class="ghost" id="demoLoad2">Load demo shelf</button>`;
    $("#demoLoad2").onclick = loadDemo;
  }

  const yt = st.youtube || {};
  const busy = lib.scanning || sp.syncing || demo.loading || yt.syncing;
  const t = $("#scanToast");
  reveal(t, busy);
  if (busy) t.textContent = demo.loading ? `Demo shelf: ${demo.albums} of ${demo.total} albums` :
    lib.scanning ? `Library: ${lib.phase}${lib.art_total ? ` ${lib.art_done}/${lib.art_total}` : ""}` :
    sp.syncing ? `Spotify: syncing ${sp.albums} albums` : `YouTube: bringing in ${yt.albums} playlists`;
}

/* YouTube in Settings: connect it, and add albums, playlists and songs by search or link. */
function renderYouTube(yt) {
  $("#ytSec").hidden = !yt.configured;
  if (!yt.configured) return;
  const btns = $("#ytButtons"); btns.innerHTML = "";
  $("#ytAdd").hidden = !yt.connected;
  $("#ytWarn").hidden = !!yt.connected;
  $("#ytHost").textContent = location.host;
  if (!yt.connected) {
    $("#ytStatus").textContent = "Not connected. Your YouTube playlists, including the ones you made in YouTube Music, and your liked music come onto your shelf.";
    btns.innerHTML = `<button class="primary" id="ytOn">Connect YouTube</button>`;
    $("#ytOn").onclick = () => (location.href = "/auth/youtube/login");
    return;
  }
  const mine = S.albums.filter(a => a.source === "youtube").length;
  $("#ytStatus").textContent = yt.syncing ? `Bringing in your playlists… ${yt.albums}` :
    `Connected${yt.channel ? ` as ${yt.channel}` : ""} · ${mine} on your shelf` + (yt.error ? ` · last sync: ${yt.error}` : "");
  btns.innerHTML = `<button class="ghost" id="ytSync">Sync again</button><button class="ghost" id="ytOff">Disconnect</button>`;
  $("#ytSync").onclick = () => api("/api/youtube/sync", { method: "POST" }).then(watchStatus);
  $("#ytOff").onclick = async () => {
    if (!confirm("Disconnect YouTube? Album Viewer gives back its access to your YouTube and takes everything from YouTube off your shelf.")) return;
    if (Player.mode === "youtube") Player.stop();
    await api("/api/youtube/disconnect", { method: "POST" });
    loadAlbums(); refreshStatus();
  };
}

const ytLink = q => /youtu\.?be|youtube\.com|[?&](list|v)=/i.test(q) || /^[\w-]{11}$/.test(q);
let ytFound = [];
$("#ytForm").onsubmit = async e => {
  e.preventDefault();
  const q = $("#ytQuery").value.trim(), out = $("#ytResults");
  if (!q) return;
  if (ytLink(q)) {   // a link: straight onto the shelf
    try { const a = await api("/api/youtube/add", { method: "POST", body: { link: q } }); $("#ytQuery").value = ""; out.innerHTML = ""; toast(`Added ${a.title}`); loadAlbums(); }
    catch (err) { toast(err.message, 5000); }
    return;
  }
  out.innerHTML = '<li class="hint">Looking on YouTube…</li>';
  try { ytFound = await api(`/api/youtube/search?q=${encodeURIComponent(q)}`); }
  catch (err) { out.innerHTML = ""; return toast(err.message, 5000); }
  const kinds = { album: "Album", playlist: "Playlist", song: "Song" };
  out.innerHTML = ytFound.length ? ytFound.map((r, i) =>
    `<li><img alt="" src="${esc(r.art || "")}"${r.art ? "" : " hidden"}><span class="nm"><b>${esc(r.title)}</b><small>${kinds[r.kind]} · ${esc(r.artist)}</small></span>` +
    `<button class="ghost" type="button" data-i="${i}">Add</button></li>`).join("") : '<li class="hint">Nothing found. Try the artist and album name, or paste a link.</li>';
};
$("#ytResults").addEventListener("click", async e => {
  const b = e.target.closest("button[data-i]"); if (!b) return;
  const r = ytFound[+b.dataset.i];
  b.disabled = true;
  try { await api("/api/youtube/add", { method: "POST", body: { id: r.id, kind: r.kind } }); b.textContent = "Added"; loadAlbums(); }
  catch (err) { b.disabled = false; toast(err.message, 5000); }
});

async function refreshStatus() {
  try { S.status = await api("/api/status"); renderStatus(S.status); renderEmpty(); return S.status; } catch { return null; }
}

let watchT = null;
function watchStatus() {
  if (watchT) return;
  let wasBusy = true, ticks = 0;
  watchT = setInterval(async () => {
    const st = await refreshStatus(); if (!st) return;
    const busy = st.library?.scanning || st.spotify.syncing || st.demo.loading || st.youtube?.syncing;
    if (++ticks % 3 === 0 && busy) loadAlbums();   // show progress on the shelf while loading
    if (!busy && wasBusy) { clearInterval(watchT); watchT = null; loadAlbums(); }
    wasBusy = busy;
  }, 1500);
}

async function loadDemo() {
  try { await api("/api/demo/load", { method: "POST" }); toast("Loading the demo shelf…"); watchStatus(); refreshStatus(); }
  catch (e) { toast(e.message); }
}
$("#demoLoadBtn").onclick = loadDemo;

$("#settingsBtn").onclick = openSettings;
// Signing out also forgets this device's saved shelf and covers.
$('form[action="/logout"]')?.addEventListener("submit", async e => { e.preventDefault(); await dataCache.clear(); e.target.submit(); });
$("#rescanBtn").onclick = () => api("/api/library/rescan", { method: "POST" }).then(watchStatus);
$("#refetchBtn").onclick = () => { if (confirm("Look up artwork again for every local album? Albums with embedded or folder art keep it.")) api("/api/library/rescan?force_art=true", { method: "POST" }).then(watchStatus); };
$("#spAddBtn").onclick = async () => {
  try { const a = await api("/api/spotify/add", { method: "POST", body: { link: $("#spLink").value } }); $("#spLink").value = ""; toast(`Added ${a.title}`); loadAlbums(); }
  catch (e) { toast(e.message); }
};
$("#sdkToggle").onchange = e => {
  store.set("sdk", e.target.checked); Sdk.failed = false;
  if (e.target.checked) Sdk.load(); else { Sdk.stop(); if (Speakers.chosen?.id === "sdk") Speakers.chosen = null; }
};
$("#showHidden").onchange = e => { store.set("showHidden", e.target.checked); loadAlbums().then(() => applyAlbums(S.serverAlbums || [], false)); };
$("#spineNames").onchange = e => { store.set("spineNames", e.target.checked); render(); };
$("#glowToggle").onchange = e => { store.set("glow", e.target.checked); setGlow(); };
$("#shape").onchange = e => { store.set("shape", e.target.value); render(); };

/* ======================================================== top bar */

function setSource(src) {
  S.source = src; store.set("source", src);
  $$("#sourceSeg button").forEach(x => x.classList.toggle("on", x.dataset.source === src));
}
$$("#sourceSeg button").forEach(b => { b.onclick = () => { setSource(b.dataset.source); render(); }; });
setSource(S.source);
$("#sort").value = S.sort;
$("#sort").onchange = e => { S.sort = e.target.value; store.set("sort", S.sort); render(); };
let searchT;
$("#search").oninput = e => { clearTimeout(searchT); searchT = setTimeout(() => { S.search = e.target.value; render(); }, 120); };

function closeSheets() { $$(".sheet").forEach(s => (s.id === "albumSheet" ? closeAlbum() : s.id === "deviceSheet" ? Speakers.close() : reveal(s, false))); }
document.addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheets(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if ($$(".sheet").some(s => s.classList.contains("in"))) closeSheets(); else NP.close(); }
  if (e.key === " " && !e.target.matches("input,select,textarea,button")) { e.preventDefault(); Player.toggle(); }
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
$("#room").addEventListener("click", e => { if (!e.target.closest(".spine")) peek(); });
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.body.classList.contains("wallmode")) setWall(false); });
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden) {
    if (document.body.classList.contains("wallmode") && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
    if (Player.mode === "spotify") Player.poll();
  }
});

let lastSize = "";
new ResizeObserver(() => {
  const size = `${$("#room").clientWidth}x${$("#room").clientHeight}`;
  if (size !== lastSize) { lastSize = size; render(); }
}).observe($("#room"));

/* ======================================================== boot */

(async function boot() {
  if (history.state?.np) history.replaceState(null, "");   // a reload starts with the player put away
  const params = new URLSearchParams(location.search);
  if (params.get("spotify") === "connected") toast("Spotify connected — syncing your albums");
  if (params.get("spotify_error")) toast("Spotify: " + params.get("spotify_error"), 6000);
  if (params.get("youtube") === "connected") toast("YouTube connected — bringing in your playlists");
  if (params.get("youtube_error")) toast("YouTube: " + params.get("youtube_error"), 6000);
  if (params.toString()) history.replaceState(null, "", "/");

  const me = api("/api/me").then(me => { S.me = me; renderAccount(); renderEmpty(); }).catch(() => {});
  const order = api("/api/order").then(o => { S.orderIds = o.ids; }).catch(() => {});
  await loadAlbums();
  Promise.all([me, order]).then(() => Device.restore()).catch(() => {});   // this computer's music, if a folder was chosen
  const st = await refreshStatus();
  if (st && (st.library?.scanning || st.spotify.syncing || st.demo.loading || st.youtube?.syncing || params.get("spotify") || params.get("youtube"))) watchStatus();
  if (st?.spotify.connected) {
    if (Sdk.enabled()) Sdk.load();
    try {   // pick up whatever is already playing on Spotify
      const s = await api("/api/spotify/state");
      if (s && s.track) { Player.mode = "spotify"; Player.startPolling(); }
    } catch {}
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
