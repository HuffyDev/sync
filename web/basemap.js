// Offline tactical basemap. The world outline is projected once, then each
// 256px tile is painted onto a canvas a single time and cached by Leaflet, so
// panning and zooming only move images around instead of redrawing ~100k
// coastline points every frame (which is what made the old map lag).
//
// Detail follows zoom: Natural Earth 1:110m (z0–2), 1:50m (z3–5), 1:10m (z6+).

const SOURCES = [
  { maxZ: 2, url: '/vendor/countries-110m.json' },
  { maxZ: 5, url: '/vendor/countries-50m.json' },
  { maxZ: 99, url: '/vendor/countries-10m.json' },
];
const cache = new Map();

export const PAPER = {
  ocean: '#ffffff', land: '#ececec', landEdge: 'rgba(40, 40, 40, 0.9)', landGlow: 'rgba(0, 0, 0, 0)',
  border: 'rgba(60, 60, 60, 0.6)', grid: 'rgba(0, 0, 0, 0.06)', gridMajor: 'rgba(0, 0, 0, 0.12)', dots: false,
};
export const COLORS = {
  ocean: '#0c0e11',
  land: '#16181c',
  landEdge: 'rgba(170, 185, 205, 0.42)',
  landGlow: 'rgba(170, 185, 205, 0.05)',
  border: 'rgba(170, 185, 205, 0.18)',
  grid: 'rgba(255, 255, 255, 0.03)',
  gridMajor: 'rgba(255, 255, 255, 0.06)',
  dots: true,
};

const MAX_LAT = 85.0511287798;
function projX(lon) { return (lon + 180) / 360; }
function projY(lat) {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / Math.PI) / 2;
}

function sourceFor(z) { return SOURCES.find((s) => z <= s.maxZ).url; }

export function loadWorld(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => r.json()).then((topo) => prepare(window.topojson.feature(topo, topo.objects.countries))));
  }
  return cache.get(url);
}

function prepare(fc) {
  const features = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const rings = [];
    let minx = 1, miny = 1, maxx = 0, maxy = 0;
    let best = null;
    let bestArea = -1;
    for (const poly of polys) {
      let pminx = 1, pminy = 1, pmaxx = 0, pmaxy = 0;
      poly.forEach((ring, ri) => {
        const arr = new Float64Array(ring.length * 2);
        ring.forEach(([lon, lat], i) => {
          const x = projX(lon), y = projY(lat);
          arr[i * 2] = x; arr[i * 2 + 1] = y;
          if (ri === 0) { if (x < pminx) pminx = x; if (x > pmaxx) pmaxx = x; if (y < pminy) pminy = y; if (y > pmaxy) pmaxy = y; }
        });
        rings.push(arr);
      });
      const area = (pmaxx - pminx) * (pmaxy - pminy);
      if (area > bestArea) { bestArea = area; best = [pminx, pminy, pmaxx, pmaxy]; }
      minx = Math.min(minx, pminx); miny = Math.min(miny, pminy); maxx = Math.max(maxx, pmaxx); maxy = Math.max(maxy, pmaxy);
    }
    if (!rings.length) continue;
    features.push({
      name: f.properties?.name || '',
      rings,
      bbox: [minx, miny, maxx, maxy],
      label: best ? [(best[0] + best[2]) / 2, (best[1] + best[3]) / 2] : null,
      labelSize: best ? best[2] - best[0] : 0,
    });
  }
  return features;
}

function gridStep(z) { return z <= 2 ? 30 : z <= 4 ? 10 : z <= 6 ? 5 : z <= 9 ? 1 : 0.25; }

function drawTile(canvas, coords, features, COLORS) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const S = 256 * dpr;
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  const n = 2 ** coords.z;
  const x0 = coords.x / n, y0 = coords.y / n, span = 1 / n;
  const pad = span * 0.02;
  const k = S * n; // normalized -> tile pixels
  ctx.fillStyle = COLORS.ocean;
  ctx.fillRect(0, 0, S, S);

  // Graticule
  const step = gridStep(coords.z);
  ctx.lineWidth = dpr;
  for (let lon = -180; lon <= 180; lon += step) {
    const px = (projX(lon) - x0) * k;
    if (px < -1 || px > S + 1) continue;
    ctx.strokeStyle = lon % (step * 3) === 0 ? COLORS.gridMajor : COLORS.grid;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, S); ctx.stroke();
  }
  for (let lat = -80; lat <= 80; lat += step) {
    const py = (projY(lat) - y0) * k;
    if (py < -1 || py > S + 1) continue;
    ctx.strokeStyle = lat % (step * 3) === 0 ? COLORS.gridMajor : COLORS.grid;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(S, py); ctx.stroke();
  }

  // Land: one path for every country touching this tile.
  ctx.beginPath();
  const minStep = 0.6 * dpr;
  let any = false;
  for (const f of features) {
    const b = f.bbox;
    if (b[2] < x0 - pad || b[0] > x0 + span + pad || b[3] < y0 - pad || b[1] > y0 + span + pad) continue;
    any = true;
    for (const r of f.rings) {
      let lx = (r[0] - x0) * k, ly = (r[1] - y0) * k;
      ctx.moveTo(lx, ly);
      for (let i = 2; i < r.length; i += 2) {
        const px = (r[i] - x0) * k, py = (r[i + 1] - y0) * k;
        if (Math.abs(px - lx) + Math.abs(py - ly) < minStep && i < r.length - 2) continue;
        ctx.lineTo(px, py);
        lx = px; ly = py;
      }
      ctx.closePath();
    }
  }
  if (!any) return;
  ctx.fillStyle = COLORS.land;
  ctx.fill('evenodd');
  // Fine dot texture on land for the "ops screen" look (cheap: clipped pattern).
  if (COLORS.dots && coords.z >= 2) {
    ctx.save();
    ctx.clip('evenodd');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    const gap = 6 * dpr;
    for (let yy = 0; yy < S; yy += gap) for (let xx = (yy / gap) % 2 ? gap / 2 : 0; xx < S; xx += gap) ctx.fillRect(xx, yy, dpr, dpr);
    ctx.restore();
  }
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLORS.landGlow;
  ctx.lineWidth = 4 * dpr;
  ctx.stroke();
  ctx.strokeStyle = coords.z >= 3 ? COLORS.landEdge : COLORS.border;
  ctx.lineWidth = (coords.z >= 5 ? 1.2 : 0.9) * dpr;
  ctx.stroke();
}

export function tacticalBaseLayer(palette = COLORS) {
  const L = window.L;
  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const canvas = document.createElement('canvas');
      canvas.className = 'tac-tile';
      loadWorld(sourceFor(coords.z))
        .then((features) => { drawTile(canvas, coords, features, palette); done(null, canvas); })
        .catch((err) => done(err, canvas));
      return canvas;
    },
  });
  return new Layer({ tileSize: 256, keepBuffer: 4, updateWhenZooming: false, attribution: 'Natural Earth', className: 'tac-base' });
}

// Country names, only where there's room for them.
export function countryLabels(map) {
  const L = window.L;
  const layer = L.layerGroup();
  let feats = null;
  const update = () => {
    layer.clearLayers();
    const z = map.getZoom();
    if (!feats || z < 3 || z > 8 || !map.hasLayer(layer)) return;
    const b = map.getBounds().pad(0.1);
    const scale = 256 * 2 ** z;
    for (const f of feats) {
      if (!f.label || f.labelSize * scale < 70) continue;
      const lon = f.label[0] * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * f.label[1]))) * 180) / Math.PI;
      if (!b.contains([lat, lon])) continue;
      L.marker([lat, lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'country-label', html: f.name.toUpperCase(), iconSize: null }) }).addTo(layer);
    }
  };
  loadWorld('/vendor/countries-50m.json').then((f) => { feats = f; update(); });
  map.on('moveend zoomend', update);
  layer.on('add', update);
  return layer;
}
