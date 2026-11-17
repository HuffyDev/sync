// Front page animation: a rotating dotted globe built from real country
// shapes, with sync pulses travelling between cities. Every so often a region
// loses its uplink, drops out of the network, keeps running locally, then
// resyncs. Pure canvas 2D, capped at 2x pixel ratio, paused when hidden.

const canvas = document.getElementById('lp-bg');
const ctx = canvas.getContext('2d');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STEEL = [143, 180, 217];
const RED = [240, 86, 106];
const GREEN = [95, 212, 154];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

const CITIES = [
  ['New York', 40.7, -74], ['Los Angeles', 34.05, -118.2], ['Mexico City', 19.4, -99.1], ['São Paulo', -23.5, -46.6],
  ['London', 51.5, -0.1], ['Lagos', 6.5, 3.4], ['Cairo', 30, 31.2], ['Nairobi', -1.3, 36.8], ['Moscow', 55.75, 37.6],
  ['Dubai', 25.2, 55.3], ['Mumbai', 19.1, 72.9], ['Singapore', 1.35, 103.8], ['Tokyo', 35.7, 139.7], ['Sydney', -33.9, 151.2],
  ['Seoul', 37.6, 127], ['Johannesburg', -26.2, 28], ['Buenos Aires', -34.6, -58.4], ['Chicago', 41.9, -87.6], ['Berlin', 52.5, 13.4], ['Jakarta', -6.2, 106.8],
];

let W = 0, H = 0, DPR = 1, R = 0, CX = 0, CY = 0;
let dots = [];
let rot = 1.3; // radians
const tilt = 0.32;
const links = [];
const ripples = [];
const dark = new Map(); // city index -> until (ms)

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const wide = W > 980;
  R = wide ? Math.min(H * 0.4, W * 0.24) : Math.min(W * 0.4, H * 0.4);
  CX = wide ? W * 0.73 : W * 0.5;
  CY = H * 0.5;
}

function toXYZ(lat, lon) {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
}
function project([x, y, z], lift = 1) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const x1 = x * c + z * s, z1 = -x * s + z * c;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
  return [CX + x1 * R * lift, CY - y2 * R * lift, z2];
}
function slerp(a, b, t) {
  const d = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  if (d < 1e-6) return a;
  const s = Math.sin(d), k0 = Math.sin((1 - t) * d) / s, k1 = Math.sin(t * d) / s;
  return [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1];
}

async function buildDots() {
  // Rasterise land once (equirectangular) and keep sphere points that fall on it.
  const off = document.createElement('canvas');
  off.width = 720; off.height = 360;
  const o = off.getContext('2d');
  try {
    const topo = await (await fetch('/vendor/countries-110m.json')).json();
    const land = window.topojson.feature(topo, topo.objects.countries);
    o.fillStyle = '#fff';
    for (const f of land.features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const p of polys) {
        o.beginPath();
        for (const ring of p) ring.forEach(([lon, lat], i) => { const x = ((lon + 180) / 360) * 720, y = ((90 - lat) / 180) * 360; i ? o.lineTo(x, y) : o.moveTo(x, y); });
        o.fill('evenodd');
      }
    }
  } catch { /* no land data: ocean-only globe */ }
  const img = o.getImageData(0, 0, 720, 360).data;
  const N = W < 700 ? 5200 : 9000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  dots = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    const p = [Math.cos(th) * r, y, Math.sin(th) * r];
    const lat = (Math.asin(y) * 180) / Math.PI;
    const lon = (Math.atan2(p[0], p[2]) * 180) / Math.PI;
    const px = Math.min(719, Math.max(0, Math.round(((lon + 180) / 360) * 719)));
    const py = Math.min(359, Math.max(0, Math.round(((90 - lat) / 180) * 359)));
    const isLand = img[(py * 720 + px) * 4 + 3] > 0;
    if (isLand || i % 5 === 0) dots.push({ p, land: isLand });
  }
}

const cityXYZ = CITIES.map(([, la, lo]) => toXYZ(la, lo));
function spawnLink(now) {
  let a = Math.floor(Math.random() * CITIES.length), b = Math.floor(Math.random() * CITIES.length);
  if (a === b) return;
  const d = Math.acos(cityXYZ[a][0] * cityXYZ[b][0] + cityXYZ[a][1] * cityXYZ[b][1] + cityXYZ[a][2] * cityXYZ[b][2]);
  if (d < 0.25 || d > 2.4) return;
  const blocked = dark.has(a) || dark.has(b);
  links.push({ a, b, start: now, dur: 1400 + d * 900, blocked });
}

function outage(now) {
  const center = Math.floor(Math.random() * CITIES.length);
  const until = now + 4200;
  cityXYZ.forEach((c, i) => {
    const d = Math.acos(c[0] * cityXYZ[center][0] + c[1] * cityXYZ[center][1] + c[2] * cityXYZ[center][2]);
    if (d < 0.55) dark.set(i, until);
  });
  ripples.push({ i: center, start: now, color: RED, big: true });
  log(`uplink lost near ${CITIES[center][0]} — switching to local core`, 'bad');
  setState('Internet lost. Running locally.', true);
  setTimeout(() => { log(`${CITIES[center][0]}: guides, maps and AI still running offline`); }, 1300);
  setTimeout(() => {
    ripples.push({ i: center, start: performance.now(), color: GREEN, big: true });
    log(`${CITIES[center][0]} back online — resynced`, 'ok');
    setState('Everything running locally', false);
  }, 4300);
}

let lastLink = 0, lastOutage = 0, linkCount = 0;
function frame(now) {
  ctx.clearRect(0, 0, W, H);
  // Soft halo behind the globe
  const halo = ctx.createRadialGradient(CX, CY, R * 0.6, CX, CY, R * 1.45);
  halo.addColorStop(0, rgba(STEEL, 0.07)); halo.addColorStop(1, rgba(STEEL, 0));
  ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
  // Globe disc + rim
  ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2);
  const disc = ctx.createRadialGradient(CX - R * 0.35, CY - R * 0.35, R * 0.1, CX, CY, R);
  disc.addColorStop(0, 'rgba(32,35,40,0.55)'); disc.addColorStop(1, 'rgba(12,13,15,0.85)');
  ctx.fillStyle = disc; ctx.fill();
  ctx.strokeStyle = rgba(STEEL, 0.18); ctx.lineWidth = 1; ctx.stroke();
  // Orbit rings
  for (const [k, a] of [[1.18, 0.07], [1.32, 0.045]]) {
    ctx.beginPath(); ctx.ellipse(CX, CY, R * k, R * k * 0.28, -0.35, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(STEEL, a); ctx.setLineDash([2, 6]); ctx.stroke(); ctx.setLineDash([]);
  }
  // Dots
  for (const d of dots) {
    const [x, y, z] = project(d.p);
    if (z < -0.05) continue;
    const a = d.land ? 0.18 + z * 0.62 : 0.05 + z * 0.08;
    ctx.fillStyle = d.land ? `rgba(200,212,226,${a})` : rgba(STEEL, a);
    const s = d.land ? 1.15 + z * 0.75 : 0.9;
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
  }
  // Scan sweep
  const sweep = ((now / 5200) % 1) * Math.PI * 2;
  ctx.save(); ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2); ctx.clip();
  const g = ctx.createConicGradient ? ctx.createConicGradient(sweep, CX, CY) : null;
  if (g) { g.addColorStop(0, rgba(STEEL, 0.10)); g.addColorStop(0.08, rgba(STEEL, 0)); g.addColorStop(1, rgba(STEEL, 0)); ctx.fillStyle = g; ctx.fillRect(CX - R, CY - R, R * 2, R * 2); }
  ctx.restore();
  // Links (great-circle arcs lifted above the surface) with travelling pulses
  for (let i = links.length - 1; i >= 0; i--) {
    const L = links[i];
    const t = (now - L.start) / L.dur;
    if (t > 1.35) { links.splice(i, 1); continue; }
    const a = cityXYZ[L.a], b = cityXYZ[L.b];
    const head = Math.min(1, t), tail = Math.max(0, t - 0.35);
    const pts = [];
    for (let k = 0; k <= 40; k++) {
      const u = k / 40;
      const p = slerp(a, b, u);
      pts.push([...project(p, 1 + Math.sin(Math.PI * u) * 0.16), u]);
    }
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (const [x, y, z] of pts) { if (z < -0.1) { started = false; continue; } started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), (started = true)); }
    ctx.strokeStyle = L.blocked ? rgba(RED, 0.16) : rgba(STEEL, 0.13 * Math.max(0, 1 - Math.max(0, t - 1) * 3));
    if (L.blocked) ctx.setLineDash([3, 5]);
    ctx.stroke(); ctx.setLineDash([]);
    if (!L.blocked) {
      ctx.beginPath(); started = false;
      for (const [x, y, z, u] of pts) { if (u < tail || u > head || z < -0.1) { started = false; continue; } started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), (started = true)); }
      ctx.strokeStyle = rgba([220, 232, 245], 0.85); ctx.lineWidth = 1.6; ctx.stroke();
      const hp = pts[Math.round(head * 40)];
      if (t < 1 && hp[2] > -0.1) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hp[0], hp[1], 1.8, 0, Math.PI * 2); ctx.fill(); }
      if (t >= 1 && !L.arrived) { L.arrived = true; ripples.push({ i: L.b, start: now, color: STEEL }); linkCount++; }
    }
  }
  // Cities
  CITIES.forEach((c, i) => {
    const [x, y, z] = project(cityXYZ[i]);
    if (z < 0) return;
    const isDark = dark.has(i);
    ctx.fillStyle = isDark ? rgba(RED, 0.9) : rgba([225, 235, 245], 0.6 + z * 0.4);
    ctx.beginPath(); ctx.arc(x, y, isDark ? 2.4 : 2, 0, Math.PI * 2); ctx.fill();
    if (z > 0.55 && W > 980) { ctx.fillStyle = rgba([200, 210, 222], 0.35 * z); ctx.font = '500 10px "Instrument Sans", system-ui, sans-serif'; ctx.fillText(c[0], x + 6, y + 3); }
  });
  // Ripples
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i];
    const t = (now - rp.start) / (rp.big ? 1600 : 900);
    if (t > 1) { ripples.splice(i, 1); continue; }
    const [x, y, z] = project(cityXYZ[rp.i]);
    if (z < 0) continue;
    ctx.strokeStyle = rgba(rp.color, (1 - t) * (rp.big ? 0.8 : 0.5)); ctx.lineWidth = rp.big ? 1.6 : 1;
    ctx.beginPath(); ctx.arc(x, y, (rp.big ? 34 : 12) * t + 2, 0, Math.PI * 2); ctx.stroke();
  }
  for (const [k, until] of dark) if (now > until) dark.delete(k);

  if (!reduced) {
    rot += 0.0016;
    if (now - lastLink > 260) { lastLink = now; spawnLink(now); }
    if (now - lastOutage > 9000) { lastOutage = now; outage(now); }
  }
  hud();
  if (!reduced && !document.hidden) requestAnimationFrame(frame);
}

// ---------- HUD + log ----------
const $ = (id) => document.getElementById(id);
function hud() {
  $('lp-nodes').textContent = `${CITIES.length - dark.size}/${CITIES.length}`;
  $('lp-links').textContent = linkCount.toLocaleString();
  const up = $('lp-uplink');
  up.textContent = dark.size ? 'degraded' : 'online';
  up.className = dark.size ? 'bad' : 'ok';
}
function setState(text, bad) {
  const s = $('lp-state');
  s.textContent = text;
  s.parentElement.classList.toggle('bad', bad);
}
const lines = [];
function log(text, cls = '') {
  const d = new Date();
  const ts = d.toTimeString().slice(0, 8);
  lines.push({ ts, text, cls });
  while (lines.length > 5) lines.shift();
  const box = $('lp-lines');
  box.innerHTML = '';
  for (const l of lines) {
    const row = document.createElement('div');
    row.className = 'lp-line ' + l.cls;
    const t = document.createElement('span'); t.className = 'ts'; t.textContent = l.ts;
    const m = document.createElement('span'); m.textContent = l.text;
    row.append(t, m);
    box.append(row);
  }
}
const BOOT = ['boot: local core online', 'library: 22 field guides indexed', 'encyclopedia: 64 articles ready', 'maps: street tiles cached for offline use', 'ai: on-device model available (no servers)', 'group: listening on local wi-fi'];
const IDLE = ['group: 4 devices checked in · all safe', 'maps: rally point synced to 4 phones', 'ask: answered from Safe Drinking Water [1]', 'readiness: plan, map and printout up to date', 'tiles: area saved for offline · 0 failed', 'log: handover notes shared with the group'];
let idle = 0;
BOOT.forEach((l, i) => setTimeout(() => log(l), 250 + i * 420));
setInterval(() => { log(IDLE[idle++ % IDLE.length]); }, 3400);
setInterval(() => { $('lp-clock').textContent = new Date().toTimeString().slice(0, 8); }, 1000);

// Open-source details from the running copy.
fetch('/api/source').then((r) => r.json()).then((m) => {
  const short = m.commit ? m.commit.slice(0, 7) : 'local';
  $('lp-commit').textContent = short;
  $('lp-files').textContent = m.totalFiles;
  $('lp-fp').textContent = m.fingerprint;
  $('lp-foot-commit').textContent = `build ${short}`;
}).catch(() => {});

resize();
window.addEventListener('resize', () => { resize(); if (reduced) requestAnimationFrame(frame); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !reduced) requestAnimationFrame(frame); });
buildDots().then(() => requestAnimationFrame(frame));

// Copy the contract address.
document.querySelectorAll('[data-copy-ca]').forEach((b) => b.addEventListener('click', async () => {
  const el = b.closest('.ca-card, .ca-bar').querySelector('[data-ca]');
  try { await navigator.clipboard.writeText(el.textContent.trim()); }
  catch { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('copy'); }
  b.textContent = 'Copied'; b.classList.add('done');
  setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1600);
}));
