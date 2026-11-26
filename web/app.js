/* Spine — your albums as a row of spines on a wall display. Spotify, a local library, or the demo shelf. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem("spine:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("spine:" + k, JSON.stringify(v)); } catch {} },
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

/* FLIP: run `mutate` (which moves elements in the layout), then slide each of `els` from where it
   was to where it now is. Uses `translate`, so a `transform` set by CSS (the lifted spine) is kept. */
function flip(els, mutate, ms = 200) {
  if (reduceMotion.matches) return mutate();
  const before = els.map(el => el.getBoundingClientRect().left);
  mutate();
  for (const el of els) for (const an of el.getAnimations()) if (an.id === "flip") an.cancel();
  const after = els.map(el => el.getBoundingClientRect().left);
  const easing = cssVal("--ease-out");
  els.forEach((el, i) => {
    const dx = before[i] - after[i];
    if (Math.abs(dx) > 0.5) el.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], { duration: ms, easing, id: "flip" });
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
  el.style.cssText = `--w:${w}px;--c:${a.color};--t:${a.text_color};--fs:${clamp(w * 0.37, 7, 13).toFixed(1)}px`;
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
  const prevScroll = row.scrollLeft;
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
    if (a.id === S.openId) { el.classList.add("open"); addCover(el, a); }
    S.els.set(a.id, el);
    frag.appendChild(el);
  }
  row.appendChild(frag);
  $("#empty").hidden = S.albums.length > 0 || !S.loaded;
  renderIndex();
  if (S.openId && S.els.has(S.openId)) centerOn(S.openId, false);
  else row.scrollLeft = prevScroll;
  requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove("instant")));
  updatePill();
  updateHint();
}

function renderIndex() {
  const nav = $("#index");
  nav.innerHTML = "";
  S.keyAt = null;
  if (S.list.length < 8) return;
  const firsts = new Map();
  for (const a of S.list) { const k = indexKey(a); if (k !== null && !firsts.has(k)) firsts.set(k, a.id); }
  if (firsts.size < 2) return;
  S.keyAt = new Map(S.list.map(a => [a.id, indexKey(a)]));
  for (const [k, id] of firsts) {
    const b = document.createElement("button");
    b.textContent = k; b.dataset.key = k;
    b.onclick = () => {
      const el = S.els.get(id), row = $("#row");
      if (el) scrollRowTo(clamp(el.offsetLeft - 1, 0, row.scrollWidth - row.clientWidth), true);
    };
    nav.appendChild(b);
  }
  markIndex();
}

let idxRaf = 0;
function markIndex() {
  idxRaf = 0;
  if (!S.keyAt) return;
  const row = $("#row"), kids = row.children, mid = row.scrollLeft + row.clientWidth / 2;
  let lo = 0, hi = kids.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (kids[m].offsetLeft <= mid) lo = m; else hi = m - 1; }
  const key = kids[lo] && S.keyAt.get(kids[lo].dataset.id);
  $$("#index button").forEach(b => b.classList.toggle("on", b.dataset.key === key));
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
    prev.classList.remove("open");
    setTimeout(() => { if (!prev.classList.contains("open")) prev.querySelectorAll(".cover,.pill").forEach(n => n.remove()); }, 700);
  }
  S.openId = id;
  const el = id && S.els.get(id);
  if (el) {
    addCover(el, S.byId.get(id));
    void el.offsetWidth;
    el.classList.add("open");
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
  for (const el of row.children) {
    const w = el.dataset.id === id ? S.H : el.classList.contains("open") ? S.H : +el.dataset.w;
    if (el.dataset.id === id) target = x + w / 2;
    x += w;
  }
  if (target === null) return;
  const left = clamp(target - row.clientWidth / 2, 0, Math.max(0, x - row.clientWidth));
  // Same duration and curve as the CSS width transition: every spine's width moves by the same
  // fraction each frame, so the album travels smoothly to the middle instead of drifting past it.
  scrollRowTo(left, animate, { dur: cssMs("--open-dur"), ease: cssEase("--ease-open") });
}

let scrollAnim = 0, scrollTarget = null;
function stopScrollAnim() { cancelAnimationFrame(scrollAnim); scrollAnim = 0; scrollTarget = null; }
function scrollRowTo(left, animate, { dur, ease } = {}) {
  const row = $("#row");
  stopScrollAnim();
  const from = row.scrollLeft, dist = Math.abs(left - from);
  if (!animate || reduceMotion.matches || dur === 0) { row.scrollLeft = left; return; }
  if (dist < 1) return;
  dur ??= clamp(220 + Math.sqrt(dist) * 9, 240, 640);   // longer trips take a little longer, never sluggish
  ease ??= cssEase("--ease-out");
  scrollTarget = left;
  let t0 = null;
  const step = now => {
    t0 ??= now;   // start on the same frame as the CSS transitions
    const t = Math.min(1, (now - t0) / dur);
    row.scrollLeft = from + (left - from) * ease(t);
    if (t < 1) scrollAnim = requestAnimationFrame(step);
    else { scrollAnim = 0; scrollTarget = null; }
  };
  scrollAnim = requestAnimationFrame(step);
}

function updatePill() {
  const el = S.openId && S.els.get(S.openId);
  if (!el) return;
  const pill = el.querySelector(".pill");
  if (!pill) return;
  const isPlayingAlbum = Player.albumId() === S.openId;
  const playing = isPlayingAlbum && Player.playing();
  pill.classList.toggle("paused", !playing);
  pill.querySelector(".pl").textContent = playing ? "Now playing" : isPlayingAlbum ? "Paused" : "Tap for tracks";
  pill.querySelector(".eq").hidden = !isPlayingAlbum;
}

function setGlow() {
  const a = S.byId.get(Player.albumId() || S.openId);
  document.documentElement.style.setProperty("--glow", a && store.get("glow", true) ? a.color : "transparent");
}

/* ---------------- loading */

async function loadAlbums() {
  const list = await api(`/api/albums?include_hidden=${store.get("showHidden", false)}`);
  if (S.loaded) S.fresh = new Set(list.filter(a => !S.byId.has(a.id)).map(a => a.id));
  S.albums = list;
  S.byId = new Map(list.map(a => [a.id, a]));
  S.loaded = true;
  const hasDemo = list.some(a => a.source === "demo");
  $('#sourceSeg [data-source="demo"]').hidden = !hasDemo;
  if (S.source === "demo" && !hasDemo) setSource("all");
  render();
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
  if (id === S.openId) openSheet(id, el.querySelector(".cover"));
  else tapToPlay(id);
});

async function tapToPlay(id) {
  setOpen(id);
  try { await Player.playAlbum(await detail(id), 0); }
  catch (err) { toast(err.message); }
}

/* mouse: drag to scroll with a little momentum (touch screens scroll natively) */
const Drag = { active: false, moved: false, startX: 0, startScroll: 0, lastX: 0, lastT: 0, v: 0, suppressClick: false };
let glideRaf = 0;
function glide(v) {
  cancelAnimationFrame(glideRaf);
  let last = performance.now();
  const step = now => {
    const dt = now - last; last = now;
    row.scrollLeft += v * dt;
    v *= Math.pow(0.94, dt / 16);
    if (Math.abs(v) > 0.02) glideRaf = requestAnimationFrame(step);
  };
  glideRaf = requestAnimationFrame(step);
}

row.addEventListener("pointerdown", e => {
  stopScrollAnim(); cancelAnimationFrame(glideRaf);
  Arrange.down(e);
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  Object.assign(Drag, { active: true, moved: false, startX: e.clientX, startScroll: row.scrollLeft, lastX: e.clientX, lastT: e.timeStamp, v: 0 });
});
addEventListener("pointermove", e => {
  if (Arrange.move(e)) return;
  if (!Drag.active) return;
  const dx = e.clientX - Drag.startX;
  if (!Drag.moved && Math.abs(dx) > 5) { Drag.moved = true; row.classList.add("dragging"); }
  if (!Drag.moved) return;
  row.scrollLeft = Drag.startScroll - dx;
  const dt = e.timeStamp - Drag.lastT;
  if (dt > 0) Drag.v = 0.7 * ((Drag.lastX - e.clientX) / dt) + 0.3 * Drag.v;
  Drag.lastX = e.clientX; Drag.lastT = e.timeStamp;
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
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  stopScrollAnim(); cancelAnimationFrame(glideRaf);
  row.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 32 : 1);
}, { passive: false });

row.addEventListener("scroll", () => { if (!idxRaf) idxRaf = requestAnimationFrame(markIndex); }, { passive: true });
row.addEventListener("contextmenu", e => { if (S.sort === "manual") e.preventDefault(); });
row.addEventListener("keydown", e => {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    // Held or repeated keys add up from where the last press was heading, and stay quick.
    const base = scrollTarget ?? row.scrollLeft;
    const to = clamp(base + (e.key === "ArrowRight" ? 1 : -1) * row.clientWidth * 0.4, 0, row.scrollWidth - row.clientWidth);
    scrollRowTo(to, true, { dur: 220 });
  }
});

/* manual order: hold a spine, then drag it along the row */
const Arrange = {
  timer: 0, el: null, picked: false, startX: 0, x: 0, edgeRaf: 0,
  down(e) {
    clearTimeout(this.timer);
    if (S.sort !== "manual") return;
    const el = e.target.closest(".spine");
    if (!el) return;
    this.el = el; this.startX = this.x = e.clientX;
    this.timer = setTimeout(() => this.pick(e.pointerId), e.pointerType === "mouse" ? 260 : 380);
  },
  pick(pointerId) {
    this.timer = 0;
    this.picked = true;
    Drag.active = false; row.classList.remove("dragging");
    this.el.classList.add("picked");
    document.body.classList.add("arranging");
    try { row.setPointerCapture(pointerId); } catch {}
    navigator.vibrate?.(12);
    this.edge();
  },
  move(e) {
    if (this.timer && Math.abs(e.clientX - this.startX) > 6) { clearTimeout(this.timer); this.timer = 0; }
    if (!this.picked) return false;
    this.x = e.clientX;
    this.place();
    return true;
  },
  place() {
    const all = [...row.children], kids = all.filter(k => k !== this.el);
    let before = null;
    for (const k of kids) { const r = k.getBoundingClientRect(); if (this.x < r.left + r.width / 2) { before = k; break; } }
    if (before ? this.el.nextElementSibling === before : row.lastElementChild === this.el) return;
    // Only the spines between the old and new slot move: slide them aside rather than jump.
    const i = all.indexOf(this.el), j = before ? all.indexOf(before) : all.length;
    const moved = i < j ? all.slice(i, j) : all.slice(j, i + 1);
    flip(moved, () => row.insertBefore(this.el, before), 180);
  },
  edge() { // scroll while the picked spine is held near either end
    if (!this.picked) return;
    const r = row.getBoundingClientRect(), zone = Math.min(80, r.width * 0.12);
    const v = this.x < r.left + zone ? -1 : this.x > r.right - zone ? 1 : 0;
    if (v) { row.scrollLeft += v * 9; this.place(); }
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
  Player.playAlbum(S.sheet, 0).then(renderSheetState);
};
$("#aShuffle").onclick = () => { setOpen(S.sheet.id); Player.playAlbum(S.sheet, 0, true).then(renderSheetState); };
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

const Player = {
  mode: null,          // 'browser' (local files, demo previews) | 'spotify'
  album: null,
  queue: [], index: 0,
  sp: null,            // last Spotify state
  pollT: null,

  albumId() { return this.mode === "browser" ? this.album?.id : this.sp?.album_id; },
  playing() { return this.mode === "browser" ? !audio.paused : !!this.sp?.is_playing; },
  isTrack(id) { return this.mode === "browser" && this.queue[this.index]?.id === id; },

  async playAlbum(album, index = 0, shuffle = false) {
    if (!album.track_list?.length) { toast("This album has no playable tracks"); return; }
    if (album.source === "spotify") return this.playSpotify(album, index, shuffle);
    if (this.mode === "spotify" && this.sp?.is_playing) api("/api/spotify/control", { method: "POST", body: { action: "pause" } }).catch(() => {});
    this.stopPolling();
    this.mode = "browser"; this.album = album;
    let q = album.track_list.slice();
    if (shuffle) { for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; } index = 0; }
    this.queue = q; this.index = index;
    this.load(true);
  },

  load(autoplay) {
    const t = this.queue[this.index]; if (!t) return;
    audio.src = this.album.source === "demo" ? t.uri : `/api/local/stream/${encodeURIComponent(t.id)}`;
    if (autoplay) audio.play().catch(err => { if (err.name !== "AbortError") toast("Tap play to start (" + err.message + ")"); });
    const device = this.album.source === "demo" ? "This screen · preview" : "This screen";
    this.ui({ title: t.title, artist: t.artist || this.album.artist, art: this.album.art, playing: true, device, pos: 0, dur: t.duration });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || this.album.artist, album: this.album.title,
        artwork: this.album.art ? [{ src: new URL(this.album.art, location.href).href, sizes: "800x800", type: "image/jpeg" }] : [] });
    }
    setGlow(); updatePill(); renderSheetState();
  },

  async playSpotify(album, index, shuffle) {
    if (this.mode === "browser") audio.pause();
    this.mode = "spotify"; this.album = album;
    const device_id = await Sdk.deviceForPlay();
    let offset = index;
    if (shuffle) offset = Math.floor(Math.random() * Math.max(1, album.track_list.length));
    try {
      await api("/api/spotify/play", { method: "POST", body: { uri: album.uri, offset, device_id } });
      this.sp = { ...(this.sp || {}), album_id: album.id, is_playing: true };
      this.ui({ title: album.track_list[offset]?.title || album.title, artist: album.artist, art: album.art, playing: true });
      this.startPolling();
      setGlow(); updatePill();
    } catch (err) {
      if (/device/i.test(err.message)) openDevices(album, index);
      toast(err.message, 5000);
    }
  },

  toggle() {
    if (this.mode === "browser") { audio.paused ? audio.play() : audio.pause(); }
    else if (this.mode === "spotify") {
      const action = this.sp?.is_playing ? "pause" : "resume";
      if (this.sp) this.sp.is_playing = !this.sp.is_playing;
      this.ui({ playing: this.sp?.is_playing }); updatePill();
      api("/api/spotify/control", { method: "POST", body: { action } }).catch(e => toast(e.message)).finally(() => this.pollSoon());
    }
  },
  stop() {
    if (this.mode === "browser") { audio.pause(); }
    else if (this.mode === "spotify" && this.sp?.is_playing) { this.sp.is_playing = false; api("/api/spotify/control", { method: "POST", body: { action: "pause" } }).catch(() => {}); }
    this.stopPolling();
    this.mode = null; this.album = null; this.sp = null;
    $("#player").hidden = true;
    setGlow(); render();
  },
  next() {
    if (this.mode === "browser") { if (this.index < this.queue.length - 1) { this.index++; this.load(true); } }
    else if (this.mode === "spotify") api("/api/spotify/control", { method: "POST", body: { action: "next" } }).catch(e => toast(e.message)).finally(() => this.pollSoon());
  },
  prev() {
    if (this.mode === "browser") {
      if (audio.currentTime > 4 || this.index === 0) audio.currentTime = 0; else { this.index--; this.load(true); }
    } else if (this.mode === "spotify") api("/api/spotify/control", { method: "POST", body: { action: "previous" } }).catch(e => toast(e.message)).finally(() => this.pollSoon());
  },

  ui({ title, artist, art, playing, device, pos, dur }) {
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
        pos: (s.progress_ms || 0) / 1000, dur: (s.duration_ms || 0) / 1000 });
      if (changedAlbum && S.byId.has(s.album_id)) setOpen(s.album_id);
      setGlow(); updatePill();
    } catch {}
  },
};

audio.addEventListener("ended", () => {
  if (Player.index < Player.queue.length - 1) Player.next();
  else { Player.ui({ playing: false }); updatePill(); renderSheetState(); }
});
audio.addEventListener("play", () => { if (Player.mode === "browser") { Player.ui({ playing: true }); updatePill(); } });
audio.addEventListener("pause", () => { if (Player.mode === "browser") { Player.ui({ playing: false }); updatePill(); } });
audio.addEventListener("timeupdate", () => Player.mode === "browser" && audio.duration && Player.ui({ pos: audio.currentTime, dur: audio.duration }));
audio.addEventListener("error", () => { if (Player.mode === "browser" && audio.src) { toast("Couldn't play this track in the browser, skipping"); setTimeout(() => Player.next(), 800); } });
$(".p-progress").addEventListener("click", e => {
  if (Player.mode !== "browser" || !audio.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
});
$("#pToggle").onclick = () => Player.toggle();
$("#pNext").onclick = () => Player.next();
$("#pPrev").onclick = () => Player.prev();
$("#pCover").onclick = () => { const id = Player.albumId(); if (id && S.byId.has(id)) { setOpen(id); openSheet(id, $("#pCover")); } };
$("#pDevice").onclick = () => S.status?.spotify?.connected ? openDevices() : toast("Local music and demo previews play on this screen. Connect Spotify in Settings to pick other speakers.");
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
  reveal($("#deviceSheet"), true);
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
      `Fills the shelf with ${demo.total} well-known albums and their 30-second previews, so you can try Spine without an account.`;
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
  if (e.key === "Escape") closeSheets();
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
$("#player").addEventListener("click", peek);
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
