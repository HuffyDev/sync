// Helpers shared by the main app (this PC) and the join page (phones).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Tagged template that escapes interpolated values unless wrapped in raw().
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: String(s ?? '') });
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += renderValue(values[i]);
  });
  return raw(out);
}
function renderValue(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
}
export function mount(el, tpl) {
  el.innerHTML = typeof tpl === 'string' ? tpl : tpl[RAW];
  return el;
}

export async function api(path, { method = 'GET', body, raw: rawBody, headers = {}, signal } = {}) {
  const opts = { method, headers: { ...headers }, signal, credentials: 'same-origin' };
  if (rawBody !== undefined) {
    opts.body = rawBody;
    opts.headers['content-type'] = opts.headers['content-type'] || 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['content-type'] = 'application/json';
  } else if (method !== 'GET') {
    opts.body = '{}';
    opts.headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Upload a file with progress (fetch has no upload progress).
export function upload(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = { error: xhr.responseText }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — is LASTSYNC still running?'));
    xhr.send(file);
  });
}

export function toast(msg, kind = '') {
  let wrap = $('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; wrap.setAttribute('role', 'status'); document.body.append(wrap); }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  wrap.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3200);
}

export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

export function clock(iso) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ') + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function highlight(text, ranges = []) {
  let out = '';
  let last = 0;
  for (const [a, b] of ranges) {
    if (a < last) continue;
    out += esc(text.slice(last, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
    last = b;
  }
  return raw(out + esc(text.slice(last)));
}

// Minimal Markdown for guides and answers: headings, paragraphs, lists,
// one-line callouts, bold/italic and [n] citation links.
export function markdown(src, { cite, headingIds = false } = {}) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  let out = '';
  let list = null;
  let para = [];
  const inline = (s) => {
    let h = esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
    if (cite) h = h.replace(/\[(\d{1,2})\]/g, (_, n) => cite(Number(n)));
    return h;
  };
  const flushPara = () => { if (para.length) { out += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const flushList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const line of lines) {
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = /^(#{2,4})\s+(.*)$/.exec(line))) {
      flushPara(); flushList();
      const lvl = Math.min(4, m[1].length + 1);
      const id = headingIds ? ` id="${esc(slugify(m[2]))}"` : '';
      out += `<h${lvl}${id}>${inline(m[2])}</h${lvl}>`;
      continue;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); out += `<blockquote><p>${inline(m[1])}</p></blockquote>`; continue; }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      flushPara();
      if (list !== 'ul') { flushList(); out += '<ul>'; list = 'ul'; }
      out += `<li>${inline(m[1])}</li>`;
      continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      if (list !== 'ol') { flushList(); out += '<ol>'; list = 'ol'; }
      out += `<li>${inline(m[1])}</li>`;
      continue;
    }
    if (list) flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return raw(out);
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80);
}

export const CATEGORIES = {
  meeting: { label: 'Meeting point', color: '#59a8ff', letter: 'M' },
  water: { label: 'Water source', color: '#1fb6d6', letter: 'W' },
  shelter: { label: 'Shelter', color: '#8b6cf0', letter: 'S' },
  medical: { label: 'Medical help', color: '#ff5a4f', letter: '+' },
  food: { label: 'Food', color: '#3ecf7a', letter: 'F' },
  power: { label: 'Power / charging', color: '#f5a524', letter: 'P' },
  comms: { label: 'Communications', color: '#c58bff', letter: 'C' },
  hazard: { label: 'Hazard', color: '#ff7a1a', letter: '!' },
  home: { label: 'Home', color: '#9aa4b1', letter: 'H' },
  other: { label: 'Other', color: '#6b7480', letter: '•' },
};

export const MSG = {
  safe: { label: "I'm safe", cls: 'safe' },
  help: { label: 'I need help', cls: 'help' },
  meet: { label: 'Meet here', cls: 'meet' },
  ping: { label: 'Are you OK?', cls: 'ping' },
  text: { label: 'Message', cls: '' },
};

export function receiptText(msg, members, me) {
  const others = members.filter((m) => m.id !== msg.from && (!msg.to || m.id === msg.to));
  const got = Object.keys(msg.receipts || {}).map((id) => members.find((m) => m.id === id)?.name || 'someone');
  if (msg.from !== me) return null;
  if (!others.length) return { cls: '', text: 'Sent — nobody else is in the group yet' };
  if (!got.length) return { cls: '', text: 'Sent — not yet received by any device' };
  const missing = others.length - got.length;
  return { cls: 'got', text: `Received by ${got.join(', ')}${missing > 0 ? ` · waiting on ${missing}` : ''}` };
}

// ---------- maps ----------
let worldCache = null;
async function world() {
  if (!worldCache) {
    worldCache = fetch('/vendor/countries-50m.json').then((r) => r.json()).then((topo) => window.topojson.feature(topo, topo.objects.countries));
  }
  return worldCache;
}

export async function createMap(el, { maps = [], center = [20, 0], zoom = 2, interactive = true } = {}) {
  const L = window.L;
  const map = L.map(el, { worldCopyJump: true, zoomControl: interactive, attributionControl: true, dragging: interactive, scrollWheelZoom: interactive, doubleClickZoom: interactive, boxZoom: interactive, keyboard: interactive, touchZoom: interactive, preferCanvas: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView(center, zoom);
  map.attributionControl.setPrefix('');
  const base = L.geoJSON(await world(), {
    style: { color: '#4d6b7d', weight: 1, fillColor: '#1d3443', fillOpacity: 1 },
    interactive: false,
  }).addTo(map);
  base.getAttribution = () => 'Natural Earth';
  map.attributionControl.addAttribution('Natural Earth');
  const layers = {};
  for (const m of maps) {
    layers[m.name] = L.tileLayer(`/tiles/${m.id}/{z}/{x}/{y}`, {
      minZoom: 0, maxZoom: Math.max(19, m.maxzoom + 2), maxNativeZoom: m.maxzoom, minNativeZoom: m.minzoom,
      bounds: m.bounds ? [[m.bounds[1], m.bounds[0]], [m.bounds[3], m.bounds[2]]] : undefined,
      attribution: m.attribution || '',
    });
  }
  const names = Object.keys(layers);
  if (names.length) {
    layers[names[0]].addTo(map);
    if (interactive && names.length > 1) L.control.layers(layers, {}, { collapsed: true }).addTo(map);
  }
  map.setMaxZoom(names.length ? 19 : 10);
  return { map, layers };
}

export function pinIcon(category) {
  const c = CATEGORIES[category] || CATEGORIES.other;
  return window.L.divIcon({ className: '', html: `<div class="pin-icon" style="background:${c.color}"><b>${esc(c.letter)}</b></div>`, iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24] });
}

export function msgIcon(type) {
  const color = { safe: '#3ecf7a', help: '#ff5a4f', meet: '#59a8ff' }[type] || '#9aa4b1';
  const letter = { safe: '✓', help: '!', meet: 'M' }[type] || '•';
  return window.L.divIcon({ className: '', html: `<div class="pin-icon" style="background:${color}"><b>${letter}</b></div>`, iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24] });
}

export function fmtCoord(lat, lon) {
  if (lat == null || lon == null) return '';
  return `${Math.abs(lat).toFixed(5)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}°${lon >= 0 ? 'E' : 'W'}`;
}

export function beep(kind = 'normal') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const tones = kind === 'help' ? [880, 660, 880, 660] : [660, 880];
    tones.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.17);
    });
  } catch {}
  if (navigator.vibrate) navigator.vibrate(kind === 'help' ? [300, 120, 300, 120, 300] : [150]);
}

// A live connection to the group with automatic reconnect and polling fallback.
export function groupStream(handlers) {
  let es;
  let closed = false;
  const open = () => {
    if (closed) return;
    es = new EventSource('/api/group/events');
    for (const [ev, fn] of Object.entries(handlers)) {
      if (ev === 'open' || ev === 'error') continue;
      es.addEventListener(ev, (e) => { try { fn(JSON.parse(e.data)); } catch {} });
    }
    es.onopen = () => handlers.open?.();
    es.onerror = () => { handlers.error?.(); };
  };
  open();
  return { close() { closed = true; es?.close(); } };
}

// Icons (stroke icons, 24px grid).
const P = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  ask: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1v.5"/><path d="M12 16h.01"/>',
  map: '<path d="m9 4-6 3v13l6-3 6 3 6-3V4l-6 3z"/><path d="M9 4v13M15 7v13"/>',
  plan: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2"/><path d="m9 13 2 2 4-4"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/>',
  note: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  group: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.2c2.9.2 5 2.6 5 5.8"/>',
  log: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  pack: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  ready: '<path d="M12 3 4 6v6c0 4.6 3.2 8.2 8 9 4.8-.8 8-4.4 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="1.5"/><path d="M7 14h10v7H7z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gps: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 18h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
};
export function icon(name) {
  return raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`);
}
