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
  artist: (a, b) => cmp(artistKey(a.artist), artistKey(b.artist)) || cmp(a.year, b.year) || cmp(a.title, b.title),
  decade: (a, b) => cmp(a.year || "9999", b.year || "9999") || cmp(artistKey(a.artist), artistKey(b.artist)),
  added: (a, b) => (b.added_at || 0) - (a.added_at || 0),
  title: (a, b) => cmp(a.title, b.title),
  color: (a, b) => hueKey(a.color) - hueKey(b.color),
  manual: (a, b) => (a.pos ?? 1e9) - (b.pos ?? 1e9) || SORTS.artist(a, b),
};

function visibleAlbums() {
  const q = S.search.trim().toLowerCase();
  return S.albums.filter(a => (S.source === "all" || a.source === S.source) &&
    (!q || a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q))).sort(SORTS[S.sort]);
}

function indexKey(a) {
  if (S.sort === "artist" || S.sort === "title") {
    const c = (S.sort === "artist" ? artistKey(a.artist) : a.title.replace(/^the\s+/i, "")).normalize("NFKD")[0]?.toUpperCase() || "#";
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
    (a.hidden ? " hiddenalb" : "") + (w < 13 ? " tiny" : "");
  const fs = S.vertical ? clamp(w * 0.42, 9, 15) : clamp(w * 0.37, 7, 13);   // text runs along the spine
  el.style.cssText = `--w:${w}px;--c:${a.color};--t:${a.text_color};--fs:${fs.toFixed(1)}px`;
  el.dataset.id = a.id;
  el.dataset.w = w;
  el.setAttribute("role", "listitem");
  el.setAttribute("aria-label", `${a.artist}, ${a.title}`);
  el.title = `${a.artist} — ${a.title}${a.year ? ` (${a.year})` : ""}`;
  el.innerHTML = `<span class="lbl"><b>${esc(a.artist)}</b><span>${esc(a.title)}</span></span><i class="mark"></i>`;
  return el;
}

function addCover(el, a) {
  if (el.querySelector(".cover")) return;
  el.insertAdjacentHTML("beforeend",
    (a.art ? `<img class="cover" alt="" draggable="false" src="${esc(a.art)}">`
           : `<span class="cover nocover"><b>${esc(a.title)}</b><span>${esc(a.artist)}</span></span>`) +
    `<span class="pill"><span class="eq"><i></i><i></i><i></i></span><span class="pl">Now playing</span></span>`);
  updatePill();
}

function render() {
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
    setTimeout(() => { if (!prev.classList.contains("open")) prev.querySelectorAll(".cover,.pill,.vinyl").forEach(n => n.remove()); }, 700);
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
  clear() { if (this.els.length) this.set(null); this.at = null; },
  // The shelf moved under a still cursor: lift whatever is under it now.
  follow() {
    if (!this.mouse) return;
    const el = Drag.moved ? null : document.elementFromPoint(this.x, this.y)?.closest("#row .spine") || null;
    if (el !== this.at) this.set(el);
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
  if (animateNew) S.fresh = new Set(list.filter(a => !S.byId.has(a.id)).map(a => a.id));
  S.albums = list;
  S.byId = new Map(list.map(a => [a.id, a]));
  S.loaded = true;
  const hasDemo = list.some(a => a.source === "demo");
  $('#sourceSeg [data-source="demo"]').hidden = !hasDemo;
  if (S.source === "demo" && !hasDemo) setSource("all");
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
  if (!fresh && S.details.has(id)) return S.details.get(id);
  const a = await api(`/api/albums/${encodeURIComponent(id)}`);
  S.details.set(id, a);
  return a;
}

/* ======================================================== touching the row */

const row = $("#row");

row.addEventListener("click", e => {
  if (Drag.suppressClick) { Drag.suppressClick = false; return; }
  const el = e.target.closest(".spine");
  if (!el) return;
  const id = el.dataset.id;
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

row.addEventListener("scroll", () => { if (!idxRaf) idxRaf = requestAnimationFrame(markIndex); }, { passive: true });
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
  $("#aArtist").textContent = a.artist + (a.year ? ` · ${a.year}` : "");
  $("#aSource").textContent = { spotify: "Spotify", demo: "Demo shelf · 30-second previews" }[a.source] ||
    "Local library" + (a.art_status === "missing" ? " · no cover found" : "");
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
  $("#aTracks").innerHTML = a.track_list.map((t, i) =>
    `<li data-i="${i}" class="${Player.isTrack(t.id) ? "now" : ""}"><span class="n">${multiDisc ? (t.disc_no || 1) + "." : ""}${t.track_no || i + 1}</span>` +
    `<span class="tt">${esc(t.title)}${t.artist && t.artist !== a.artist ? ` <span style="color:var(--muted)">· ${esc(t.artist)}</span>` : ""}</span>` +
    `<span class="d">${fmt(t.duration)}</span></li>`).join("");
}

$("#aTracks").addEventListener("click", e => {
  const li = e.target.closest("li"); if (!li) return;
  setOpen(S.sheet.id);
  Player.playAlbum(S.sheet, +li.dataset.i).then(renderSheetState);
});
$("#aPlay").onclick = () => {
  if (Player.albumId() === S.sheet.id) { Player.toggle(); setTimeout(renderSheetState, 50); return; }
  setOpen(S.sheet.id);
  Player.playAlbum(S.sheet).then(renderSheetState);
};
$("#aShuffle").onclick = () => { setOpen(S.sheet.id); Player.playAlbum(S.sheet, null, true).then(renderSheetState); };
$("#aPutBack").onclick = () => {
  if (Player.albumId() === S.sheet.id) Player.stop();
  setOpen(null);   // first, so the cover doesn't fly back onto a closing spine
  closeSheets();
};
$("#aMore").onclick = () => ($("#aMenu").hidden = !$("#aMenu").hidden);
$("#aHide").onclick = async () => {
  await api(`/api/albums/${encodeURIComponent(S.sheet.id)}`, { method: "PATCH", body: { hidden: !S.sheet.hidden } });
  S.details.delete(S.sheet.id);
  if (S.openId === S.sheet.id && !S.sheet.hidden) setOpen(null);
  closeSheets(); loadAlbums();
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

/* ======================================================== player */

const audio = $("#audio");
const shuffled = list => { const q = list.slice(); for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; } return q; };

const Player = {
  mode: null,          // 'browser' (local files, demo previews) | 'spotify'
  album: null,
  order: [],           // the album's tracks, in album order
  queue: [], index: 0, // the same tracks in the order they play (shuffled or not)
  shuffle: store.get("shuffle", false),
  repeat: store.get("repeat", "off"),   // off | all | one, for playback on this screen
  sp: null,            // last Spotify state
  spAt: 0,             // when it arrived, so the position can move on between polls
  pollT: null, tickT: null,
  cur: {},             // what is showing: title, artist, art, playing, device, pos, dur

  albumId() { return this.mode === "browser" ? this.album?.id : this.sp?.album_id; },
  playing() { return this.mode === "browser" ? !audio.paused : !!this.sp?.is_playing; },
  isTrack(id) { return this.mode === "browser" && this.queue[this.index]?.id === id; },
  shuffleOn() { return this.mode === "spotify" ? !!this.sp?.shuffle : this.shuffle; },
  repeatMode() { return this.mode === "spotify" ? ({ context: "all", track: "one" }[this.sp?.repeat] || "off") : this.repeat; },
  canSeek() { return this.mode === "browser" ? audio.duration > 0 : this.mode === "spotify" && this.cur.dur > 0; },

  /* `index` is the track to start on. Leave it out to play the album from the top, or from a
     random track when shuffle is on. */
  async playAlbum(album, index = null, shuffle = false) {
    if (!album.track_list?.length) { toast("This album has no playable tracks"); return; }
    if (album.source === "spotify") return this.playSpotify(album, index ?? 0, shuffle);
    if (this.mode === "spotify" && this.sp?.is_playing) api("/api/spotify/control", { method: "POST", body: { action: "pause" } }).catch(() => {});
    this.stopPolling();
    if (shuffle && !this.shuffle) { this.shuffle = true; store.set("shuffle", true); }
    this.mode = "browser"; this.album = album;
    this.order = album.track_list.slice();
    if (this.shuffle) {
      const first = (index !== null && this.order[index]) || this.order[Math.floor(Math.random() * this.order.length)];
      this.queue = [first, ...shuffled(this.order.filter(t => t !== first))];
      this.index = 0;
    } else {
      this.queue = this.order.slice();
      this.index = clamp(index ?? 0, 0, this.queue.length - 1);
    }
    this.load(true);
  },

  load(autoplay) {
    const t = this.queue[this.index]; if (!t) return;
    audio.src = this.album.source === "demo" ? t.uri : `/api/local/stream/${encodeURIComponent(t.id)}`;
    audio.loop = this.repeat === "one";
    if (autoplay) audio.play().catch(err => { if (err.name !== "AbortError") toast("Tap play to start (" + err.message + ")"); });
    const device = this.album.source === "demo" ? "This screen · preview" : "This screen";
    this.ui({ title: t.title, artist: t.artist || this.album.artist, art: this.album.art, playing: true, device, pos: 0, dur: t.duration });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || this.album.artist, album: this.album.title,
        artwork: this.album.art ? [{ src: new URL(this.album.art, location.href).href, sizes: "800x800", type: "image/jpeg" }] : [] });
    }
    setGlow(); updatePill(); renderSheetState(); NP.modes(); NP.queue();
  },

  async playSpotify(album, index, shuffle) {
    if (this.mode === "browser") audio.pause();
    this.mode = "spotify"; this.album = album;
    const device_id = await Sdk.deviceForPlay();
    let offset = index;
    if (shuffle) offset = Math.floor(Math.random() * Math.max(1, album.track_list.length));
    try {
      await api("/api/spotify/play", { method: "POST", body: { uri: album.uri, offset, device_id } });
      this.sp = { ...(this.sp || {}), album_id: album.id, is_playing: true, progress_ms: 0 };
      this.spAt = performance.now();
      const t = album.track_list[offset];
      this.ui({ title: t?.title || album.title, artist: album.artist, art: album.art, playing: true, pos: 0, dur: t?.duration || 0 });
      this.startPolling();
      setGlow(); updatePill(); NP.modes(); NP.queue();
    } catch (err) {
      if (/device/i.test(err.message)) openDevices(album, index);
      toast(err.message, 5000);
    }
  },

  toggle() {
    if (this.mode === "browser") { audio.paused ? audio.play() : audio.pause(); }
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
    else if (this.mode === "spotify" && this.sp?.is_playing) { this.sp.is_playing = false; api("/api/spotify/control", { method: "POST", body: { action: "pause" } }).catch(() => {}); }
    this.stopPolling();
    this.mode = null; this.album = null; this.sp = null;
    NP.close();
    $("#player").hidden = true;
    setGlow(); render();
  },
  next() {
    if (this.mode === "browser") {
      if (this.index < this.queue.length - 1) this.index++;
      else if (this.repeat === "all") this.index = 0;
      else return;
      this.load(true);
    } else if (this.mode === "spotify") this.spotify("next");
  },
  prev() {
    if (this.mode === "browser") {
      if (audio.currentTime > 4 || (this.index === 0 && this.repeat !== "all")) audio.currentTime = 0;
      else { this.index = (this.index || this.queue.length) - 1; this.load(true); }
    } else if (this.mode === "spotify") this.spotify("previous");
  },
  jumpTo(i) { if (this.mode === "browser" && this.queue[i]) { this.index = i; this.load(true); } },
  /* f: how far into the track, 0 to 1 */
  seek(f) {
    if (this.mode === "browser" && audio.duration) { audio.currentTime = f * audio.duration; mediaState(); }
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
    if (this.mode === "browser") {   // the track playing carries on; what comes after it changes
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
    const { title, artist, art, playing, device, pos, dur } = o;
    if ($("#player").hidden) { $("#player").hidden = false; requestAnimationFrame(render); }
    if (title !== undefined) $("#pTitle").textContent = title;
    if (artist !== undefined) $("#pArtist").textContent = artist;
    if (art !== undefined) $("#pCover").src = art || "";
    if (playing !== undefined) { $("#pToggle").innerHTML = icon(playing ? "pause" : "play"); }
    if (device !== undefined) $("#pDeviceName").textContent = device || "";
    if (dur !== undefined) $("#pDur").textContent = fmt(dur || 0);
    if (pos !== undefined) {
      $("#pPos").textContent = fmt(pos);
      const d = dur ?? this._dur ?? 0, pct = d ? Math.min(100, (pos / d) * 100) : 0, bar = $("#pBar");
      bar.classList.toggle("jump", pct < (this._pct ?? 0) || pct - (this._pct ?? 0) > 6);   // glide forward, snap otherwise
      bar.style.width = pct + "%";
      this._pct = pct;
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
      this.ui({ title: s.track, artist: s.artist, art: s.image, playing: s.is_playing, device: s.device,
        pos: (s.progress_ms || 0) / 1000, dur: (s.duration_ms || 0) / 1000 });
      if (changedAlbum && S.byId.has(s.album_id)) setOpen(s.album_id);
      setGlow(); updatePill(); NP.modes();
    } catch {}
  },
};

audio.addEventListener("ended", () => {   // "repeat this track" loops the audio itself and never ends
  if (Player.mode !== "browser") return;
  if (Player.index < Player.queue.length - 1 || Player.repeat === "all") Player.next();
  else { Player.ui({ playing: false }); updatePill(); renderSheetState(); }
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
$("#pDevice").onclick = () => S.status?.spotify?.connected ? openDevices() : toast("Local music and demo previews play on this screen. Connect Spotify in Settings to pick other speakers.");
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
    for (const s of ["#topbar", "#room", "#player"]) $(s).inert = false;
    this.outT = setTimeout(() => { np.classList.remove("out"); setSpin($("#npVinyl .label"), false, true); }, 300);
    if (!fromHistory && history.state?.np) { this.skipPop = true; history.back(); }
  },

  render() {
    const c = Player.cur;
    this.sync({ ...c, art: c.art || "" });
    this.modes(); this.queue();
  },
  sync(o) {
    if (o.title !== undefined) $("#npTitle").textContent = o.title;
    if (o.artist !== undefined) $("#npArtist").textContent = o.artist;
    if (o.art !== undefined) this.cover(o.art);
    if (o.playing !== undefined) { $("#npToggle").innerHTML = icon(o.playing ? "pause" : "play"); this.spin(); }
    if (o.device !== undefined) $("#npDeviceName").textContent = o.device || "";
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
  spin() { setSpin($("#npVinyl .label"), this.isOpen && np.classList.contains("out") && Player.playing()); },
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
    if (Player.mode === "browser") {
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
  if (Pull.dy > Math.min(150, innerHeight * 0.22) || Pull.v > 0.5) NP.close();   // otherwise it springs back up
}
np.addEventListener("touchend", endPull);
np.addEventListener("touchcancel", endPull);

$("#npClose").onclick = () => NP.close();
$("#npToggle").onclick = () => Player.toggle();
$("#npNext").onclick = () => Player.next();
$("#npPrev").onclick = () => Player.prev();
$("#npShuffle").onclick = () => { haptic(6); Player.toggleShuffle(); };
$("#npRepeat").onclick = () => { haptic(6); Player.cycleRepeat(); };
$("#npDevice").onclick = () => $("#pDevice").onclick();
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
  if (!e.target.closest("button, .p-progress")) NP.open();
});
let barY = null;
$("#player").addEventListener("touchstart", e => { barY = e.touches.length === 1 && !e.target.closest(".p-progress") ? e.touches[0].clientY : null; }, { passive: true });
$("#player").addEventListener("touchmove", e => { if (barY !== null && barY - e.touches[0].clientY > 24) { barY = null; NP.open(); } }, { passive: true });

/* ======================================================== Spotify Web Playback SDK (optional) */

const Sdk = {
  player: null, deviceId: null, loading: null,
  enabled() { return store.get("sdk", false); },
  load() {
    if (!this.enabled() || this.loading) return this.loading;
    this.loading = new Promise(resolve => {
      window.onSpotifyWebPlaybackSDKReady = () => {
        this.player = new Spotify.Player({
          name: "Album Viewer",
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
  reveal($("#deviceSheet"), true);
  const list = $("#deviceList");
  list.innerHTML = '<div class="hint">Loading…</div>';
  let devs = [];
  try { devs = await api("/api/spotify/devices"); } catch (e) { list.innerHTML = `<div class="hint">${esc(e.message)}</div>`; return; }
  const chosen = store.get("device", null);
  const items = [];
  if (Sdk.enabled()) items.push({ id: "sdk", name: "This screen (browser)", type: "Album Viewer" });
  for (const d of devs) if (d.id !== Sdk.deviceId) items.push({ id: d.id, name: d.name, type: d.type, active: d.is_active });
  if (!items.length) { list.innerHTML = '<div class="hint">No Spotify devices are online.</div>'; return; }
  list.innerHTML = "";
  for (const d of items) {
    const b = document.createElement("button");
    b.className = (chosen === d.id || (!chosen && d.active)) ? "on" : "";
    b.innerHTML = `<span>${esc(d.name)}</span><span class="hint">${esc(d.type)}${d.active ? " · active" : ""}</span>`;
    b.onclick = async () => {
      store.set("device", d.id);
      reveal($("#deviceSheet"), false);
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
  reveal($("#settingsSheet"), true);
  $("#showHidden").checked = store.get("showHidden", false);
  $("#spineNames").checked = store.get("spineNames", true);
  $("#glowToggle").checked = store.get("glow", true);
  $("#sdkToggle").checked = Sdk.enabled();
  $("#shape").value = store.get("shape", "bar");
  refreshStatus();
}
window.openSettings = openSettings;

function renderStatus(st) {
  const sp = st.spotify, lib = st.library, demo = st.demo;
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
    spBtns.innerHTML = `<button class="ghost" id="spSync">Sync saved albums</button><button class="ghost" id="spOff">Disconnect</button>`;
    $("#spSync").onclick = () => api("/api/spotify/sync", { method: "POST" }).then(watchStatus);
    $("#spOff").onclick = async () => { if (confirm("Disconnect Spotify and remove its albums from the shelf?")) { await api("/api/spotify/disconnect", { method: "POST" }); loadAlbums(); refreshStatus(); } };
  }
  $("#libStatus").textContent = lib.error ? lib.error :
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

  const busy = lib.scanning || sp.syncing || demo.loading;
  const t = $("#scanToast");
  reveal(t, busy);
  if (busy) t.textContent = demo.loading ? `Demo shelf: ${demo.albums} of ${demo.total} albums` :
    lib.scanning ? `Library: ${lib.phase}${lib.art_total ? ` ${lib.art_done}/${lib.art_total}` : ""}` : `Spotify: syncing ${sp.albums} albums`;
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
    const busy = st.library.scanning || st.spotify.syncing || st.demo.loading;
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
$("#sdkToggle").onchange = e => { store.set("sdk", e.target.checked); if (e.target.checked) Sdk.load(); else store.set("device", null); };
$("#showHidden").onchange = e => { store.set("showHidden", e.target.checked); loadAlbums(); };
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

function closeSheets() { $$(".sheet").forEach(s => (s.id === "albumSheet" ? closeAlbum() : reveal(s, false))); }
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
  if (params.toString()) history.replaceState(null, "", "/");

  await loadAlbums();
  const st = await refreshStatus();
  if (st && (st.library.scanning || st.spotify.syncing || st.demo.loading || params.get("spotify"))) watchStatus();
  if (st?.spotify.connected) {
    if (Sdk.enabled()) Sdk.load();
    try {   // pick up whatever is already playing on Spotify
      const s = await api("/api/spotify/state");
      if (s && s.track) { Player.mode = "spotify"; Player.startPolling(); }
    } catch {}
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
