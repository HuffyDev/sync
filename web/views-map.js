import { refresh } from './app.js';
import { parseNmea } from './nmea.js';
import { $, $$, api, upload, html, mount, toast, icon, fmtBytes, ago, pinIcon, msgIcon, CATEGORIES, fmtCoord, MSG } from './shared.js';

// ---------- GPS (kept across page changes) ----------
export const gps = { source: null, lat: null, lon: null, accuracy: null, sats: null, fixAt: null, port: null, reader: null, watchId: null, error: null, listeners: new Set() };
const emit = () => gps.listeners.forEach((fn) => fn());

async function connectSerialGps(baudRate) {
  if (!('serial' in navigator)) throw new Error('This browser cannot talk to USB devices. Open LASTSYNC in Microsoft Edge or Google Chrome.');
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate });
  stopGps();
  gps.port = port;
  gps.source = 'usb';
  gps.error = null;
  emit();
  const decoder = new TextDecoderStream();
  port.readable.pipeTo(decoder.writable).catch(() => {});
  const reader = decoder.readable.getReader();
  gps.reader = reader;
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const r = parseNmea(line);
          if (r?.fix && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
            gps.lat = r.lat; gps.lon = r.lon; gps.fixAt = new Date().toISOString();
            if (r.sats) gps.sats = r.sats;
            if (r.hdop) gps.accuracy = Math.round(r.hdop * 5);
            emit();
          } else if (r && !r.fix) { gps.error = 'Receiver connected — waiting for satellites (go near a window or outside).'; emit(); }
        }
        if (buf.length > 4096) buf = '';
      }
    } catch (err) {
      gps.error = 'GPS disconnected: ' + err.message;
      emit();
    }
  })();
}

function useDeviceLocation() {
  if (!navigator.geolocation) throw new Error('This device has no location service.');
  stopGps();
  gps.source = 'device';
  gps.error = 'Asking this device for its location…';
  emit();
  gps.watchId = navigator.geolocation.watchPosition(
    (p) => { gps.lat = p.coords.latitude; gps.lon = p.coords.longitude; gps.accuracy = Math.round(p.coords.accuracy); gps.fixAt = new Date(p.timestamp).toISOString(); gps.error = null; emit(); },
    (err) => { gps.error = 'Location unavailable: ' + err.message + '. Without internet, PCs often can\'t locate themselves — use a USB GPS receiver or place a pin by hand.'; emit(); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
  );
}

function stopGps() {
  if (gps.watchId != null) navigator.geolocation.clearWatch(gps.watchId);
  gps.watchId = null;
  try { gps.reader?.cancel(); } catch {}
  try { gps.port?.close(); } catch {}
  gps.port = null; gps.reader = null; gps.source = null; gps.error = null;
  emit();
}

// ---------- map page ----------
let mlReady = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (!mlReady) {
    mlReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/maplibre/maplibre-gl-csp.js';
      s.onload = () => { window.maplibregl.setWorkerUrl('/vendor/maplibre/maplibre-gl-csp-worker.js'); resolve(); };
      s.onerror = () => reject(new Error('Map engine failed to load'));
      document.head.append(s);
    });
  }
  return mlReady;
}

const fc = (features = []) => ({ type: 'FeatureCollection', features });
const ptF = ([lat, lon], props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
const lineF = (pts, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts.map(([a, o]) => [o, a]) } });
const circleF = ([lat, lon], km, props = {}) => {
  const ring = [];
  for (let i = 0; i <= 72; i++) { const [a, o] = destination([lat, lon], km, i * 5); ring.push([o, a]); }
  return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
};
const bboxTiles = (b, minz, maxz) => {
  let n = 0;
  for (let z = minz; z <= maxz; z++) {
    const s = 2 ** z;
    const x = (lon) => Math.floor(((lon + 180) / 360) * s);
    const y = (lat) => { const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s); };
    n += (x(b[2]) - x(b[0]) + 1) * (y(b[1]) - y(b[3]) + 1);
  }
  return n;
};

export async function mapView(el, _args, query) {
  const [maps, pins, routes, plan, info, status, vtStatus] = await Promise.all([api('/api/maps'), api('/api/pins'), api('/api/routes'), api('/api/plan'), api('/api/group/info'), api('/api/status'), api('/api/vt')]);
  const group = info.active ? await api('/api/group/state') : null;
  const isPublic = status.mode === 'public';
  el.classList.add('full');
  mount(el, html`
    <h1 class="sr-only">Maps</h1>
    <div class="map-page">
      <div class="map-stage" id="stage">
        <div id="map" class="map"></div>
        <div class="map-vignette"></div>
        <div class="ov ov-tools" role="toolbar" aria-label="Map tools">
          <button class="tool" data-tool="pin" data-tip="Drop pin" aria-label="Drop pin">${icon('pin')}</button>
          <button class="tool" data-tool="route" data-tip="Draw route" aria-label="Draw route">${icon('route')}</button>
          <button class="tool" data-tool="measure" data-tip="Measure" aria-label="Measure distance">${icon('ruler')}</button>
          <button class="tool" data-tool="rings" data-tip="Range rings" aria-label="Range rings">${icon('target')}</button>
          <div class="tool-sep"></div>
          <button class="tool" data-act="locate" data-tip="My position" aria-label="My position">${icon('gps')}</button>
          <button class="tool" data-act="follow" data-tip="Follow GPS" aria-label="Follow my position">${icon('nav')}</button>
          <button class="tool" data-act="3d" data-tip="3D view" aria-label="Toggle 3D">${icon('cube')}</button>
          <button class="tool" data-act="north" data-tip="Reset north" aria-label="Reset north">${icon('compass')}</button>
          <button class="tool" data-act="fit" data-tip="Fit all" aria-label="Fit everything">${icon('expand')}</button>
          <button class="tool" data-act="full" data-tip="Full screen" aria-label="Full screen">${icon('fullscreen')}</button>
        </div>
        <div class="ov ov-search"><input id="msearch" type="search" placeholder="Find a pin, place, street or lat, lon" autocomplete="off" aria-label="Find on map"><div class="hits" id="mhits"></div></div>
        <div class="ov ov-layers" id="layers"></div>
        <div class="ov ov-coords" id="coords"></div>
        <div class="ov ov-measure" id="measure" hidden></div>
        <div class="ov-status" id="mstatus"></div>
        <div id="mode" class="map-mode" hidden></div>
        <div id="ctx" class="ctx-menu" hidden></div>
      </div>
      <aside class="map-side" id="side"></aside>
    </div>`);

  const stageEl = $('#stage');
  const stale = () => !stageEl.isConnected; // the person left the page while it was loading
  await loadMapLibre();
  if (stale()) return null;
  const ML = window.maplibregl;
  const { buildStyle, setGroupVisible, EMERGENCY_TYPES } = await import('./mapstyle.js');
  const style = await buildStyle({ rasters: maps });
  if (stale()) return null;
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem('ls-map-view') || 'null'); } catch { return null; } })();
  const map = new ML.Map({
    container: $('#map'), style, center: saved?.center || [0, 20], zoom: saved?.zoom ?? 1.6, pitch: saved?.pitch || 0, bearing: saved?.bearing || 0,
    attributionControl: { compact: true }, maxPitch: 75, hash: false, fadeDuration: 150, dragRotate: true, touchPitch: true,
  });
  map.addControl(new ML.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new ML.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-right');
  await new Promise((r) => (map.loaded() ? r() : map.once('load', r)));
  if (stale()) { try { map.remove(); } catch {} return null; }

  let alive = true;
  const vis = { pins: true, rally: true, routes: true, group: true, emergency: true, grid: true, labels: true, streets: true, buildings3d: false };
  const rasterOn = new Set();
  let mode = null;
  let draft = null;
  let measurePts = [];
  let follow = false;
  let ringsActive = false;
  let cursor = null;
  const markers = new Map(); // id -> { marker, layer }
  let meMarker = null;

  // ---------- overlay sources ----------
  const addSrc = (id) => map.addSource(id, { type: 'geojson', data: fc() });
  ['routes', 'routeEnds', 'rings', 'ringLabels', 'measure', 'measurePts', 'draft', 'searchHit'].forEach(addSrc);
  const font = ['Noto Sans Regular'];
  map.addLayer({ id: 'rings-fill', type: 'fill', source: 'rings', paint: { 'fill-color': '#8fb4d9', 'fill-opacity': ['case', ['==', ['get', 'i'], 0], 0.06, 0] } });
  map.addLayer({ id: 'rings-line', type: 'line', source: 'rings', paint: { 'line-color': '#8fb4d9', 'line-width': 1.2, 'line-opacity': 0.8, 'line-dasharray': ['case', ['==', ['get', 'i'], 3], ['literal', [4, 3]], ['literal', [1, 0]]] } });
  map.addLayer({ id: 'rings-label', type: 'symbol', source: 'ringLabels', layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 10.5, 'text-letter-spacing': 0.1, 'text-allow-overlap': true }, paint: { 'text-color': '#b9d1ea', 'text-halo-color': '#0c0e11', 'text-halo-width': 1.6 } });
  map.addLayer({ id: 'routes-glow', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#8fb4d9', 'line-width': 10, 'line-opacity': 0.14, 'line-blur': 2 } });
  map.addLayer({ id: 'routes-line', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#b9d1ea', 'line-width': 3, 'line-dasharray': [2, 1.2] } });
  map.addLayer({ id: 'route-ends', type: 'circle', source: 'routeEnds', paint: { 'circle-radius': 5, 'circle-color': '#0c0e11', 'circle-stroke-width': 2, 'circle-stroke-color': ['match', ['get', 'end'], 'start', '#5fd49a', '#f0566a'] } });
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#8fb4d9', 'line-width': 3, 'line-dasharray': [1, 1] } });
  map.addLayer({ id: 'measure-line', type: 'line', source: 'measure', paint: { 'line-color': '#e6e7e9', 'line-width': 1.6, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'measure-pts', type: 'circle', source: 'measurePts', paint: { 'circle-radius': 4, 'circle-color': '#8fb4d9', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2 } });
  map.addLayer({ id: 'measure-label', type: 'symbol', source: 'measurePts', filter: ['has', 'label'], layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 10.5, 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-allow-overlap': true }, paint: { 'text-color': '#fff', 'text-halo-color': '#0c0e11', 'text-halo-width': 2 } });
  map.addLayer({ id: 'search-hit', type: 'circle', source: 'searchHit', paint: { 'circle-radius': 10, 'circle-color': 'rgba(143,180,217,0.15)', 'circle-stroke-color': '#b9d1ea', 'circle-stroke-width': 2 } });
  const setData = (id, data) => map.getSource(id)?.setData(data);

  const popupFor = (title, rows, actions = []) => {
    const div = document.createElement('div');
    mount(div, html`<strong>${title}</strong>${rows.filter(Boolean).map((l) => html`<br><small>${l}</small>`)}${actions.length ? html`<div class="row" style="margin-top:8px">${actions.map((a, i) => html`<button class="btn small ${a.cls || ''}" data-a="${i}">${a.label}</button>`)}</div>` : ''}`);
    actions.forEach((a, i) => div.querySelector(`[data-a="${i}"]`).addEventListener('click', a.fn));
    return div;
  };
  let openPopup = null;
  const showPopup = (lngLat, content) => { openPopup?.remove(); openPopup = new ML.Popup({ offset: 14, maxWidth: '300px' }).setLngLat(lngLat).setDOMContent(content).addTo(map); };

  const iconEl = (divIcon) => { const e = document.createElement('div'); e.className = 'mk-wrap'; e.innerHTML = divIcon; return e; };
  const markerHtml = (category) => pinIcon(category).options.html;
  const msgHtml = (type) => msgIcon(type).options.html;

  function addMarker(id, layer, latlon, htmlStr, popupFn, z = 0) {
    const el2 = iconEl(htmlStr);
    el2.style.zIndex = String(z);
    const m = new ML.Marker({ element: el2, anchor: 'bottom' }).setLngLat([latlon[1], latlon[0]]).addTo(map);
    el2.addEventListener('click', (e) => { e.stopPropagation(); showPopup(m.getLngLat(), popupFn()); });
    el2.style.display = vis[layer] ? '' : 'none';
    markers.set(id, { marker: m, layer, popupFn });
  }
  function clearMarkers(layer) { for (const [id, m] of markers) if (m.layer === layer) { m.marker.remove(); markers.delete(id); } }

  // ---------- drawing ----------
  function drawPins() {
    clearMarkers('pins'); clearMarkers('rally');
    for (const p of pins) {
      addMarker(p.id, 'pins', [p.lat, p.lon], markerHtml(p.category), () => popupFor(p.name, [CATEGORIES[p.category]?.label, p.note, fmtCoord(p.lat, p.lon), p.pack], [
        { label: 'Rings', fn: () => { openPopup?.remove(); drawRings([p.lat, p.lon]); } },
        { label: 'Edit', fn: () => { openPopup?.remove(); editPin(p); } },
        { label: 'Delete', cls: 'danger', fn: async () => { if (!confirm(`Delete pin “${p.name}”?`)) return; await api('/api/pins/' + p.id, { method: 'DELETE' }); pins.splice(pins.indexOf(p), 1); openPopup?.remove(); drawPins(); renderSide(); } },
      ]), 1);
    }
    for (const mp of plan.meetingPoints.filter((m) => m.lat != null && m.lon != null)) {
      addMarker('mp:' + mp.id, 'rally', [mp.lat, mp.lon], markerHtml('meeting'), () => popupFor(mp.name, ['Rally point (your plan)', mp.address, mp.when, fmtCoord(mp.lat, mp.lon)], [
        { label: 'Rings', fn: () => { openPopup?.remove(); drawRings([mp.lat, mp.lon]); } },
        { label: 'Edit plan', fn: () => { location.hash = '#/plan'; } },
      ]), 2);
    }
  }
  function drawRoutes() {
    setData('routes', fc(routes.map((r) => lineF(r.points, { id: r.id }))));
    setData('routeEnds', fc(routes.flatMap((r) => [ptF(r.points[0], { end: 'start' }), ptF(r.points.at(-1), { end: 'end' })])));
  }
  function drawGroup() {
    clearMarkers('group');
    if (!group) return;
    for (const m of group.members) {
      const c = m.lastCheckIn;
      if (!c || c.lat == null) continue;
      addMarker('g:' + m.id, 'group', [c.lat, c.lon], msgHtml(c.type), () => popupFor(m.name, [`${MSG[c.type]?.label} · ${ago(c.ts)}`, c.place, c.text]), 3);
    }
    const mp = group.session.meetingPoint;
    if (mp?.lat != null) addMarker('g:rally', 'group', [mp.lat, mp.lon], markerHtml('meeting'), () => popupFor('Group rally: ' + mp.name, [mp.note, 'Set by ' + mp.setBy + ' · ' + ago(mp.ts)]), 3);
  }
  function drawMe() {
    if (gps.lat == null) { meMarker?.remove(); meMarker = null; return; }
    if (!meMarker) {
      const e = document.createElement('div'); e.className = 'me-icon';
      meMarker = new ML.Marker({ element: e }).setLngLat([gps.lon, gps.lat]).addTo(map);
    } else meMarker.setLngLat([gps.lon, gps.lat]);
    if (follow) map.easeTo({ center: [gps.lon, gps.lat], duration: 600 });
  }
  const RINGS = [0.5, 1, 2, 5];
  function drawRings(center) {
    ringsActive = true;
    setData('rings', fc(RINGS.map((r, i) => circleF(center, r, { i }))));
    setData('ringLabels', fc(RINGS.map((r) => ptF(destination(center, r, 0), { label: `${r < 1 ? r * 1000 + ' M' : r + ' KM'} · ${walkMin(r)} MIN` }))));
    map.fitBounds(bounds(circleF(center, 5.5).geometry.coordinates[0].map(([o, a]) => [a, o])), { padding: 40, maxZoom: 14, duration: 700 });
    renderLayers();
  }
  function drawMeasure() {
    if (!alive) return;
    setData('measure', fc(measurePts.length > 1 ? [lineF(measurePts)] : []));
    let run = 0;
    setData('measurePts', fc(measurePts.map((p, i) => { if (i) run += haversine(measurePts[i - 1], p); return ptF(p, i ? { label: fmtKm(run) } : {}); })));
    const box = $('#measure');
    if (mode !== 'measure' && !measurePts.length) { box.hidden = true; return; }
    const total = km(measurePts);
    const last = measurePts.length > 1 ? bearing(measurePts.at(-2), measurePts.at(-1)) : null;
    box.hidden = false;
    mount(box, html`<span><span class="faint">DIST</span> <b>${fmtKm(total)}</b> / ${(total * 0.621371).toFixed(2)} MI</span>
      ${last != null ? html`<span><span class="faint">BRG</span> <b>${Math.round(last).toString().padStart(3, '0')}°</b> ${compass(last)}</span>` : ''}
      <span><span class="faint">ON FOOT</span> <b>${walkMin(total)} MIN</b></span>
      <button class="btn small" id="m-undo" ${measurePts.length ? '' : 'disabled'}>Undo</button>
      ${measurePts.length > 1 ? html`<button class="btn small" id="m-save">Save as route</button>` : ''}
      <button class="btn small ghost" id="m-clear">Clear</button>`);
    $('#m-undo')?.addEventListener('click', () => { measurePts.pop(); drawMeasure(); });
    $('#m-clear').addEventListener('click', () => { measurePts = []; setMode(null); drawMeasure(); });
    $('#m-save')?.addEventListener('click', async () => {
      const name = prompt('Route name', 'Measured route');
      if (!name) return;
      routes.push(await api('/api/routes', { method: 'POST', body: { name, points: measurePts } }));
      measurePts = []; setMode(null); drawMeasure(); drawRoutes(); renderSide(); toast('Route saved');
    });
  }

  // ---------- layers panel ----------
  function applyVis() {
    for (const [id, m] of markers) m.marker.getElement().style.display = vis[m.layer] ? '' : 'none';
    for (const id of ['routes-glow', 'routes-line', 'route-ends']) map.setLayoutProperty(id, 'visibility', vis.routes ? 'visible' : 'none');
    setGroupVisible(map, 'emergency', vis.emergency && vis.streets);
    setGroupVisible(map, 'grid', vis.grid);
    setGroupVisible(map, 'labels', vis.labels);
    setGroupVisible(map, 'streets', vis.streets);
    setGroupVisible(map, 'buildings3d', vis.buildings3d && vis.streets);
    if (vis.buildings3d) map.setLayoutProperty('building', 'visibility', 'none');
    for (const r of maps) map.setLayoutProperty('raster-' + r.id, 'visibility', rasterOn.has(r.id) ? 'visible' : 'none');
    $$('[data-act="3d"]', el).forEach((b) => b.classList.toggle('on', vis.buildings3d));
    try { sessionStorage.setItem('ls-map-vis', JSON.stringify({ ...vis, rasters: [...rasterOn] })); } catch {}
  }
  function renderLayers() {
    const toggles = [['streets', 'Street map'], ['emergency', 'Emergency places'], ['buildings3d', '3D buildings'], ['pins', 'Pins'], ['rally', 'Rally points'], ['routes', 'Routes'], ['group', 'Group check-ins'], ['grid', 'Lat / lon grid'], ['labels', 'Country labels']];
    mount($('#layers'), html`<span class="label">Layers</span>
      ${toggles.map(([k, label]) => html`<label><input type="checkbox" data-lyr="${k}" ${vis[k] ? 'checked' : ''}>${label}</label>`)}
      ${maps.length ? html`<span class="label" style="margin-top:10px">Imported maps</span>${maps.map((m) => html`<label><input type="checkbox" data-raster="${m.id}" ${rasterOn.has(m.id) ? 'checked' : ''}>${m.name}</label>`)}` : ''}
      <details class="legend"><summary class="label">Legend</summary>${EMERGENCY_TYPES.map((t) => html`<div><span class="dot" style="background:${t.color}"></span>${t.label}</div>`)}</details>
      ${ringsActive ? html`<button class="btn small" id="clear-rings" style="margin-top:8px;width:100%">Clear rings</button>` : ''}`);
    $$('[data-lyr]', $('#layers')).forEach((c) => c.addEventListener('change', () => {
      vis[c.dataset.lyr] = c.checked;
      if (c.dataset.lyr === 'buildings3d' && c.checked && map.getPitch() < 30) map.easeTo({ pitch: 55, zoom: Math.max(map.getZoom(), 15.5), duration: 900 });
      applyVis();
    }));
    $$('[data-raster]', $('#layers')).forEach((c) => c.addEventListener('change', () => { if (c.checked) rasterOn.add(c.dataset.raster); else rasterOn.delete(c.dataset.raster); applyVis(); }));
    $('#clear-rings')?.addEventListener('click', () => { setData('rings', fc()); setData('ringLabels', fc()); ringsActive = false; renderLayers(); });
  }

  function renderCoords() {
    if (!alive) return;
    const c = cursor || map.getCenter();
    const age = gps.fixAt ? (Date.now() - new Date(gps.fixAt)) / 1000 : null;
    mount($('#coords'), html`
      <div><span class="k">${cursor ? 'CURSOR' : 'CENTER'}</span>${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</div>
      <div><span class="k">DMS</span>${dms(c.lat, 'NS')} ${dms(c.lng, 'EW')}</div>
      <div><span class="k">VIEW</span>Z ${map.getZoom().toFixed(1)} · HDG ${String(Math.round((map.getBearing() + 360) % 360)).padStart(3, '0')}° · TILT ${Math.round(map.getPitch())}°</div>
      <div><span class="k">GPS</span>${gps.lat != null ? html`<span style="color:${age > 120 ? 'var(--warn)' : 'var(--safe)'}">${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)} · ${ago(gps.fixAt)}</span>` : html`<span class="faint">NO FIX</span>`}</div>`);
  }

  // Street map status chip: live / cached / offline.
  let tileErrors = 0;
  let tileOk = 0;
  map.on('data', (e) => { if (e.sourceId === 'omt' && e.tile) tileOk++; });
  map.on('error', (e) => { if (e.sourceId === 'omt') tileErrors++; });
  async function renderStatus() {
    if (!alive) return;
    const s = await api('/api/vt').catch(() => null);
    if (!s || !alive) return;
    const z = map.getZoom();
    const st = s.online ? ['ok', 'Street map live'] : s.cached.tiles ? ['warn', 'Offline — showing saved areas'] : ['bad', 'Offline — world outline only'];
    mount($('#mstatus'), html`<span class="led-dot ${st[0]}"></span>${st[1]}${z < 4 && vis.streets ? ' · zoom in for streets' : ''}`);
    const changed = vtStatus.online !== s.online || vtStatus.areas?.length !== s.areas.length || vtStatus.cached?.tiles !== s.cached.tiles;
    vtStatus.online = s.online; vtStatus.cached = s.cached; vtStatus.areas = s.areas; vtStatus.job = s.job;
    // Refresh the side panel unless the person is filling in a form there.
    if (changed && !mode && !$('#pinf') && document.activeElement?.id !== 'area-name') renderSide();
  }

  function setMode(m) {
    if (!alive) return;
    if (mode === 'route' && m !== 'route') { setData('draft', fc()); draft = null; }
    mode = mode === m ? null : m;
    if (mode === 'route') draft = { name: '', points: [] };
    $$('[data-tool]', el).forEach((b) => b.classList.toggle('on', b.dataset.tool === mode));
    const box = $('#mode');
    box.hidden = !mode;
    box.textContent = { pin: 'Click to drop a pin · Esc to cancel', route: 'Click to add route points · Esc to cancel', measure: 'Click points to measure · Esc to finish', rings: 'Click a point for range rings · Esc to cancel' }[mode] || '';
    map.getCanvas().style.cursor = mode ? 'crosshair' : '';
    if (mode === 'measure' || measurePts.length) drawMeasure();
    renderSide();
  }

  map.on('click', (e) => {
    hideCtx();
    const ll = [e.lngLat.lat, e.lngLat.lng];
    if (mode === 'pin') { setMode(null); editPin({ name: '', category: 'other', note: '', lat: ll[0], lon: ll[1] }); return; }
    if (mode === 'route') { draft.points.push(ll); setData('draft', fc(draft.points.length > 1 ? [lineF(draft.points)] : [])); renderSide(); return; }
    if (mode === 'measure') { measurePts.push(ll); drawMeasure(); return; }
    if (mode === 'rings') { setMode(null); drawRings(ll); return; }
    // inspect routes and emergency places
    const hits = map.queryRenderedFeatures(e.point, { layers: ['routes-line', 'emergency', 'emergency-label'].filter((l) => map.getLayer(l)) });
    const h = hits[0];
    if (!h) return;
    if (h.layer.id === 'routes-line') {
      const r = routes.find((x) => x.id === h.properties.id);
      if (!r) return;
      const dist = km(r.points);
      showPopup(e.lngLat, popupFor(r.name, [`${dist.toFixed(2)} km · ${(dist * 0.621371).toFixed(2)} mi`, `~${walkMin(dist)} min on foot · ${r.points.length} points`, r.note, r.pack], [
        { label: 'Delete', cls: 'danger', fn: async () => { if (!confirm(`Delete route “${r.name}”?`)) return; await api('/api/routes/' + r.id, { method: 'DELETE' }); routes.splice(routes.indexOf(r), 1); openPopup?.remove(); drawRoutes(); renderSide(); } },
      ]));
    } else {
      const kind = h.properties.subclass || h.properties.class;
      const t = EMERGENCY_TYPES.find((x) => x.k === kind);
      showPopup(e.lngLat, popupFor(h.properties.name || t?.label || 'Place', [t?.label, fmtCoord(e.lngLat.lat, e.lngLat.lng)], [
        { label: 'Save as pin', fn: async () => {
          const cat = { hospital: 'medical', clinic: 'medical', doctors: 'medical', pharmacy: 'medical', drinking_water: 'water', water_point: 'water', shelter: 'shelter', fuel: 'power', supermarket: 'food', police: 'other', fire_station: 'other' }[kind] || 'other';
          pins.push(await api('/api/pins', { method: 'POST', body: { name: h.properties.name || t?.label || 'Place', lat: e.lngLat.lat, lon: e.lngLat.lng, category: cat, note: t?.label || '' } }));
          openPopup?.remove(); drawPins(); renderSide(); toast('Saved as a pin');
        } },
      ]));
    }
  });
  for (const l of ['routes-line', 'emergency']) {
    map.on('mouseenter', l, () => { if (!mode) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { if (!mode) map.getCanvas().style.cursor = ''; });
  }

  // right-click menu
  const ctx = $('#ctx');
  function hideCtx() { ctx.hidden = true; }
  map.on('contextmenu', (e) => {
    const ll = [e.lngLat.lat, e.lngLat.lng];
    mount(ctx, html`<div class="ctx-head mono">${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}</div>
      <button data-c="pin">${icon('pin')}Drop pin here</button><button data-c="rings">${icon('target')}Range rings here</button>
      <button data-c="measure">${icon('ruler')}Measure from here</button><button data-c="center">${icon('gps')}Center here</button><button data-c="copy">${icon('note')}Copy coordinates</button>`);
    ctx.style.left = Math.min(e.point.x, map.getCanvas().clientWidth - 220) + 'px';
    ctx.style.top = Math.min(e.point.y, map.getCanvas().clientHeight - 230) + 'px';
    ctx.hidden = false;
    $$('[data-c]', ctx).forEach((b) => b.addEventListener('click', () => {
      hideCtx();
      const c = b.dataset.c;
      if (c === 'pin') editPin({ name: '', category: 'other', note: '', lat: ll[0], lon: ll[1] });
      if (c === 'rings') drawRings(ll);
      if (c === 'measure') { measurePts = [ll]; if (mode !== 'measure') setMode('measure'); drawMeasure(); }
      if (c === 'center') map.easeTo({ center: [ll[1], ll[0]] });
      if (c === 'copy') navigator.clipboard?.writeText(`${ll[0].toFixed(6)}, ${ll[1].toFixed(6)}`).then(() => toast('Coordinates copied'), () => toast(`${ll[0].toFixed(6)}, ${ll[1].toFixed(6)}`));
    }));
  });
  map.on('movestart', hideCtx);

  let raf = 0;
  map.on('mousemove', (e) => { cursor = e.lngLat; if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderCoords(); }); });
  map.on('mouseout', () => { cursor = null; renderCoords(); });
  map.on('moveend', () => {
    renderCoords();
    try { sessionStorage.setItem('ls-map-view', JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() })); } catch {}
    renderSaveEstimate();
  });
  map.on('dragstart', () => { if (follow) { follow = false; $$('[data-act="follow"]', el).forEach((b) => b.classList.remove('on')); } });
  const onKey = (e) => { if (e.key === 'Escape') { if (mode) setMode(null); hideCtx(); } };
  document.addEventListener('keydown', onKey);

  $$('[data-tool]', el).forEach((b) => b.addEventListener('click', () => setMode(b.dataset.tool)));
  $$('[data-act]', el).forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'locate') {
      if (gps.lat != null) map.flyTo({ center: [gps.lon, gps.lat], zoom: Math.max(map.getZoom(), 15) });
      else { try { useDeviceLocation(); toast('Looking for your position…'); } catch (err) { toast(err.message, 'bad'); } }
    }
    if (a === 'follow') {
      follow = !follow;
      b.classList.toggle('on', follow);
      if (follow && gps.lat == null) { try { useDeviceLocation(); } catch (err) { toast(err.message, 'bad'); } }
      if (follow && gps.lat != null) map.flyTo({ center: [gps.lon, gps.lat], zoom: Math.max(map.getZoom(), 16) });
    }
    if (a === '3d') {
      vis.buildings3d = !vis.buildings3d;
      map.easeTo(vis.buildings3d ? { pitch: 58, zoom: Math.max(map.getZoom(), 15.5), duration: 900 } : { pitch: 0, duration: 700 });
      applyVis(); renderLayers();
    }
    if (a === 'north') map.easeTo({ bearing: 0, pitch: vis.buildings3d ? map.getPitch() : 0, duration: 600 });
    if (a === 'fit') fitAll(true);
    if (a === 'full') {
      const st = $('#stage');
      if (document.fullscreenElement) document.exitFullscreen(); else st.requestFullscreen?.();
      setTimeout(() => map.resize(), 250);
    }
  }));

  // ---------- search (pins, routes, rally points, places and streets on the map) ----------
  const search = $('#msearch');
  const hitsBox = $('#mhits');
  const goTo = (lat, lon, zoom = 15) => {
    setData('searchHit', fc([ptF([lat, lon])]));
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom) });
  };
  const runSearch = () => {
    const q = search.value.trim();
    const ql = q.toLowerCase();
    const coord = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
    let list = [];
    if (coord && Math.abs(+coord[1]) <= 90 && Math.abs(+coord[2]) <= 180) {
      list = [{ name: `${(+coord[1]).toFixed(5)}, ${(+coord[2]).toFixed(5)}`, kind: 'Go to coordinates', go: () => goTo(+coord[1], +coord[2], 13) }];
    } else if (q) {
      list = [
        ...pins.map((p) => ({ name: p.name, kind: CATEGORIES[p.category]?.label || 'Pin', go: () => focusMarker(p.id) })),
        ...plan.meetingPoints.filter((m) => m.lat != null).map((m) => ({ name: m.name, kind: 'Rally point', go: () => focusMarker('mp:' + m.id) })),
        ...routes.map((r) => ({ name: r.name, kind: `Route · ${km(r.points).toFixed(1)} km`, go: () => fitRoute(r) })),
      ].filter((c) => c.name.toLowerCase().includes(ql));
      // Places, streets and emergency places from the street map tiles currently loaded.
      const seen = new Set(list.map((c) => c.name.toLowerCase()));
      for (const [layer, kind] of [['place', 'Place'], ['poi', 'Place'], ['transportation_name', 'Street'], ['water_name', 'Water']]) {
        let feats = [];
        try { feats = map.querySourceFeatures('omt', { sourceLayer: layer }); } catch {}
        for (const f of feats) {
          const n = f.properties.name;
          if (!n || !n.toLowerCase().includes(ql) || seen.has(n.toLowerCase())) continue;
          seen.add(n.toLowerCase());
          const g = f.geometry;
          const c = g.type === 'Point' ? g.coordinates : g.type === 'LineString' ? g.coordinates[Math.floor(g.coordinates.length / 2)] : g.coordinates[0]?.[0];
          if (!c) continue;
          const t = EMERGENCY_TYPES.find((x) => x.k === (f.properties.subclass || f.properties.class));
          list.push({ name: n, kind: t?.label || (f.properties.class ? `${kind} · ${f.properties.class}` : kind), go: () => goTo(c[1], c[0], layer === 'place' ? 13 : 16) });
          if (list.length > 14) break;
        }
      }
      list = list.slice(0, 12);
    }
    mount(hitsBox, html`${list.map((c, i) => html`<button data-hit="${i}">${c.name}<small class="muted">${c.kind}</small></button>`)}${q && !list.length ? html`<button disabled><small class="muted">No match on this device or in the loaded map area</small></button>` : ''}`);
    $$('[data-hit]', hitsBox).forEach((b) => b.addEventListener('click', () => { list[+b.dataset.hit].go(); hitsBox.innerHTML = ''; search.blur(); }));
    return list;
  };
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const l = runSearch(); if (l[0]) { l[0].go(); hitsBox.innerHTML = ''; } } if (e.key === 'Escape') { search.value = ''; hitsBox.innerHTML = ''; } });

  // ---------- side panel ----------
  function editPin(p) {
    const side = $('#side');
    mount(side, html`<form class="card stack" id="pinf">
      <h2>${p.id ? 'Edit pin' : 'New pin'}</h2>
      <label class="field"><span>Name</span><input name="name" value="${p.name}" required maxlength="80" placeholder="e.g. Community center"></label>
      <label class="field"><span>Type</span><select name="category">${Object.entries(CATEGORIES).map(([k, c]) => html`<option value="${k}" ${p.category === k ? 'selected' : ''}>${c.label}</option>`)}</select></label>
      <label class="field"><span>Note</span><textarea name="note" rows="3" maxlength="2000">${p.note || ''}</textarea></label>
      <div class="grid" style="grid-template-columns:1fr 1fr"><label class="field"><span>Lat</span><input name="lat" value="${p.lat.toFixed(6)}"></label><label class="field"><span>Lon</span><input name="lon" value="${p.lon.toFixed(6)}"></label></div>
      <div class="row end"><button type="button" class="btn ghost" id="cancel">Cancel</button><button class="btn primary">Save pin</button></div></form>`);
    $('#cancel').addEventListener('click', renderSide);
    $('#pinf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { name: f.name.value, category: f.category.value, note: f.note.value, lat: Number(f.lat.value), lon: Number(f.lon.value) };
      try {
        if (p.id) Object.assign(p, await api('/api/pins/' + p.id, { method: 'PUT', body }));
        else pins.push(await api('/api/pins', { method: 'POST', body }));
        toast('Pin saved'); drawPins(); renderSide();
      } catch (err) { toast(err.message, 'bad'); }
    });
    side.querySelector('input').focus();
  }

  function saveBox() {
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const z = Math.floor(map.getZoom());
    const minz = Math.max(0, Math.min(z, 10) - 2);
    const n = bboxTiles(bbox, minz, 14);
    return { bbox, minz, n, z };
  }
  function renderSaveEstimate() {
    const e = $('#save-est');
    if (!e) return;
    const s = saveBox();
    const limit = isPublic ? 2500 : 6000;
    e.innerHTML = s.z < 9 ? '<span class="faint">Zoom in to a town or city to save it.</span>' : s.n > limit ? `<span style="color:var(--warn)">≈ ${s.n.toLocaleString()} tiles — too big (limit ${limit.toLocaleString()}). Zoom in a little.</span>` : `≈ ${s.n.toLocaleString()} tiles · about ${fmtBytes(s.n * 22000)} · street level (zoom 14)`;
    const btn = $('#save-area');
    if (btn) btn.disabled = s.z < 9 || s.n > limit || !!vtStatus.job?.running;
  }

  function renderSide() {
    if (!alive) return;
    const side = $('#side');
    if (mode === 'route' && draft) {
      mount(side, html`<div class="card stack"><h2>Draw route</h2><p class="muted">Click along the way you'd walk or drive — e.g. home to your rally point.</p>
        <div class="stat-row" style="margin:0"><div class="stat"><div class="label">Points</div><div class="v">${draft.points.length}</div></div><div class="stat"><div class="label">Distance</div><div class="v">${fmtKm(km(draft.points))}</div></div></div>
        <label class="field"><span>Route name</span><input id="rname" value="${draft.name}" placeholder="e.g. Home to school (on foot)"></label>
        <div class="row"><button class="btn small" id="undo" ${draft.points.length ? '' : 'disabled'}>Undo</button><span class="spacer"></span><button class="btn small ghost" id="rcancel">Cancel</button><button class="btn small primary" id="rsave" ${draft.points.length > 1 ? '' : 'disabled'}>Save</button></div></div>`);
      $('#rname').addEventListener('input', (e) => { draft.name = e.target.value; });
      $('#undo').addEventListener('click', () => { draft.points.pop(); setData('draft', fc(draft.points.length > 1 ? [lineF(draft.points)] : [])); renderSide(); });
      $('#rcancel').addEventListener('click', () => setMode(null));
      $('#rsave').addEventListener('click', async () => {
        try { routes.push(await api('/api/routes', { method: 'POST', body: { name: draft.name || 'Route', points: draft.points } })); setMode(null); drawRoutes(); renderSide(); toast('Route saved'); } catch (err) { toast(err.message, 'bad'); }
      });
      return;
    }
    const job = vtStatus.job || {};
    mount(side, html`
      <section class="card stack">
        <div class="card-title"><h2>Offline street map</h2><span class="badge ${vtStatus.online ? 'ok' : vtStatus.cached?.tiles ? 'warn' : 'bad'}">${vtStatus.online ? 'live' : vtStatus.cached?.tiles ? 'cached' : 'offline'}</span></div>
        <p class="muted" style="margin:0;font-size:.88rem">Every area you look at while online is kept on ${isPublic ? 'the demo server' : 'this PC'}. Save your whole town ahead of time so it works with no signal.</p>
        <div class="mono faint" style="font-size:.7rem;letter-spacing:.06em">${(vtStatus.cached?.tiles || 0).toLocaleString()} TILES CACHED · ${fmtBytes(vtStatus.cached?.bytes || 0)}</div>
        ${job.running ? html`<div><div class="row between"><strong style="font-size:.9rem">Saving ${job.name}</strong><span class="mono">${job.done}/${job.total}</span></div><div class="progress" style="margin-top:6px"><i style="width:${Math.round((100 * job.done) / job.total)}%"></i></div></div>`
          : html`<div class="row" style="flex-wrap:nowrap"><input id="area-name" placeholder="Name this area, e.g. Home town" maxlength="80"><button class="btn small primary" id="save-area">${icon('download')}Save</button></div><small class="muted mono" id="save-est" style="font-size:.7rem"></small>`}
        ${vtStatus.areas?.length ? html`<ul class="list">${vtStatus.areas.map((a) => html`<li class="row between"><span><strong>${a.name}</strong><br><small class="mono">${a.tiles.toLocaleString()} TILES · ${fmtBytes(a.bytes)}${a.failed ? ` · ${a.failed} MISSED` : ''}</small></span><span class="row"><button class="btn small" data-area="${a.id}">Go</button>${isPublic ? '' : html`<button class="icon-btn" data-delarea="${a.id}" aria-label="Remove">${icon('trash')}</button>`}</span></li>`)}</ul>` : ''}
      </section>
      <section class="card stack">
        <div class="card-title"><h2>Position</h2>${gps.source ? html`<button class="btn small ghost" id="gps-stop">Stop</button>` : ''}</div>
        <div id="gps-box"></div>
        <div class="row">
          <button class="btn small" id="gps-usb">${icon('gps')}USB GPS</button>
          <select id="baud" style="width:auto;min-height:30px;padding:3px 28px 3px 8px;font-size:.8rem" aria-label="GPS speed"><option>4800</option><option selected>9600</option><option>38400</option><option>115200</option></select>
          <button class="btn small" id="gps-dev">Device</button>
        </div>
      </section>
      <section class="card">
        <div class="card-title"><h2>Pins · ${pins.length}</h2><label class="btn small">${icon('upload')}GPX<input type="file" id="gpx" accept=".gpx,application/gpx+xml" hidden></label></div>
        ${pins.length ? html`<ul class="list">${pins.map((p) => html`<li><a href="#" class="item-link row" data-pin="${p.id}"><span class="status-dot" style="background:${CATEGORIES[p.category]?.color}"></span><span><strong>${p.name}</strong><br><small>${CATEGORIES[p.category]?.label}</small></span></a></li>`)}</ul>` : html`<p class="muted" style="margin:0">No pins yet. Right-click the map, or click an emergency place and “Save as pin”.</p>`}
      </section>
      <section class="card">
        <h2>Routes · ${routes.length}</h2>
        ${routes.length ? html`<ul class="list">${routes.map((r) => html`<li><a href="#" class="item-link" data-route="${r.id}"><strong>${r.name}</strong><br><small class="mono">${fmtKm(km(r.points))} · ~${walkMin(km(r.points))} MIN ON FOOT${r.pack ? ' · ' + r.pack : ''}</small></a></li>`)}</ul>` : html`<p class="muted" style="margin:0">No routes saved yet.</p>`}
      </section>
      <section class="card stack">
        <div class="card-title"><h2>Imported maps</h2><label class="btn small">${icon('upload')}.mbtiles<input type="file" id="mbt" accept=".mbtiles" hidden></label></div>
        <div id="mbt-progress"></div>
        ${maps.length ? html`<ul class="list">${maps.map((m) => html`<li class="row between"><span><strong>${m.name}</strong><br><small class="mono">Z${m.minzoom}–${m.maxzoom} · ${fmtBytes(m.size)}</small></span><span class="row"><button class="btn small" data-fit="${m.id}">Go</button><button class="icon-btn" data-delmap="${m.id}" aria-label="Delete map">${icon('trash')}</button></span></li>`)}</ul>`
          : html`<p class="muted" style="margin:0;font-size:.88rem">Optional: add raster map files (topo maps, aerial photos) you already have.</p>`}
      </section>`);
    renderGps();
    renderSaveEstimate();
    $('#save-area')?.addEventListener('click', async () => {
      const s = saveBox();
      const name = $('#area-name').value.trim() || `Area at ${map.getCenter().lat.toFixed(2)}, ${map.getCenter().lng.toFixed(2)}`;
      try {
        await api('/api/vt/save', { method: 'POST', body: { name, bbox: s.bbox, minzoom: s.minz, maxzoom: 14 } });
        toast(`Saving “${name}” for offline use…`);
        pollSave();
      } catch (err) { toast(err.message, 'bad'); }
    });
    $$('[data-area]', side).forEach((b) => b.addEventListener('click', () => { const a = vtStatus.areas.find((x) => x.id === b.dataset.area); map.fitBounds([[a.bbox[0], a.bbox[1]], [a.bbox[2], a.bbox[3]]], { padding: 20 }); }));
    $$('[data-delarea]', side).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this saved area from the list? (Cached map data stays until you clear it.)')) return;
      await api('/api/vt/areas/' + b.dataset.delarea, { method: 'DELETE' });
      await renderStatus(); renderSide();
    }));
    $('#gps-usb').addEventListener('click', async () => { try { await connectSerialGps(Number($('#baud').value)); } catch (err) { if (err.name !== 'NotFoundError') toast(err.message, 'bad'); } });
    $('#gps-dev').addEventListener('click', () => { try { useDeviceLocation(); } catch (err) { toast(err.message, 'bad'); } });
    $('#gps-stop')?.addEventListener('click', () => { stopGps(); renderSide(); });
    $('#gpx').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const r = await upload('/api/routes/gpx?name=' + encodeURIComponent(file.name.replace(/\.gpx$/i, '')), file);
        routes.push(...r.routes); pins.push(...r.pins);
        drawRoutes(); drawPins(); renderSide();
        toast(`Imported ${r.routes.length} routes and ${r.pins.length} waypoints`);
        const all = [...r.routes.flatMap((x) => x.points), ...r.pins.map((p) => [p.lat, p.lon])];
        if (all.length) map.fitBounds(bounds(all), { padding: 50 });
      } catch (err) { toast(err.message, 'bad'); }
    });
    $('#mbt').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const box = $('#mbt-progress');
      try {
        const m = await upload('/api/maps/upload?name=' + encodeURIComponent(file.name.replace(/\.mbtiles$/i, '')), file, (p) => mount(box, html`<div class="progress"><i style="width:${Math.round(p * 100)}%"></i></div><small class="muted mono">UPLOADING ${Math.round(p * 100)}%</small>`));
        toast(`Map “${m.name}” saved`);
        try { sessionStorage.setItem('ls-map-vis', JSON.stringify({ ...vis, rasters: [...rasterOn, m.id] })); } catch {}
        refresh('map');
      } catch (err) { mount(box, html`<div class="notice bad">${err.message}</div>`); }
    });
    $$('[data-fit]', side).forEach((b) => b.addEventListener('click', () => {
      const m = maps.find((x) => x.id === b.dataset.fit);
      rasterOn.add(m.id); applyVis(); renderLayers();
      if (m.bounds) map.fitBounds([[m.bounds[0], m.bounds[1]], [m.bounds[2], m.bounds[3]]]);
    }));
    $$('[data-delmap]', side).forEach((b) => b.addEventListener('click', async () => {
      const m = maps.find((x) => x.id === b.dataset.delmap);
      if (!confirm(`Delete the map “${m.name}” from this PC?`)) return;
      await api('/api/maps/' + m.id, { method: 'DELETE' });
      refresh('map');
    }));
    $$('[data-pin]', side).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); focusMarker(a.dataset.pin); }));
    $$('[data-route]', side).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); fitRoute(routes.find((r) => r.id === a.dataset.route)); }));
  }

  let saveTimer = null;
  async function pollSave() {
    await renderStatus();
    if (!alive) return;
    renderSide();
    if (vtStatus.job?.running) saveTimer = setTimeout(pollSave, 1500);
    else if (vtStatus.job?.last) toast(`Saved “${vtStatus.job.last.name}”: ${vtStatus.job.last.done - vtStatus.job.last.failed} tiles${vtStatus.job.last.failed ? `, ${vtStatus.job.last.failed} couldn't be downloaded` : ''}`, vtStatus.job.last.failed ? 'bad' : '');
  }

  function renderGps() {
    if (!alive) return;
    const box = $('#gps-box');
    if (!box) return;
    if (gps.lat == null) { mount(box, html`<p class="muted" style="margin:0">${gps.error || 'No position fix. Connect a USB GPS receiver, or drop a pin by hand.'}</p>`); return; }
    const age = (Date.now() - new Date(gps.fixAt)) / 1000;
    mount(box, html`<div class="mono" style="font-size:.95rem;color:#fff">${fmtCoord(gps.lat, gps.lon)}</div>
      <small class="mono" style="color:${age > 120 ? 'var(--warn)' : 'var(--muted)'}">FIX ${ago(gps.fixAt).toUpperCase()}${gps.source === 'usb' ? ' · USB' : ' · DEVICE'}${gps.sats ? ` · ${gps.sats} SATS` : ''}${gps.accuracy ? ` · ±${gps.accuracy} M` : ''}${age > 120 ? ' · STALE' : ''}</small>
      ${gps.error ? html`<br><small class="muted">${gps.error}</small>` : ''}
      <div class="row" style="margin-top:8px"><button class="btn small" id="gps-center">Center</button><button class="btn small" id="gps-pin">${icon('pin')}Pin here</button><button class="btn small" id="gps-rings">${icon('target')}Rings</button></div>`);
    $('#gps-center').addEventListener('click', () => map.flyTo({ center: [gps.lon, gps.lat], zoom: Math.max(map.getZoom(), 15) }));
    $('#gps-pin').addEventListener('click', () => editPin({ name: 'My position', category: 'other', note: `Saved ${new Date().toLocaleString()}`, lat: gps.lat, lon: gps.lon }));
    $('#gps-rings').addEventListener('click', () => drawRings([gps.lat, gps.lon]));
  }

  function bounds(latlons) {
    let w = 180, s = 90, e = -180, n = -90;
    for (const [a, o] of latlons) { w = Math.min(w, o); e = Math.max(e, o); s = Math.min(s, a); n = Math.max(n, a); }
    return [[w, s], [e, n]];
  }
  function focusMarker(id) {
    const m = markers.get(id);
    if (!m) return;
    const ll = m.marker.getLngLat();
    map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 15.5) });
    map.once('moveend', () => showPopup(ll, m.popupFn()));
  }
  function fitRoute(r) { if (r) map.fitBounds(bounds(r.points), { padding: 60, maxZoom: 16 }); }
  function fitAll(announce) {
    const pts = [...pins.map((p) => [p.lat, p.lon]), ...routes.flatMap((r) => r.points), ...plan.meetingPoints.filter((m) => m.lat != null).map((m) => [m.lat, m.lon])];
    if (gps.lat != null) pts.push([gps.lat, gps.lon]);
    if (pts.length) map.fitBounds(bounds(pts), { padding: 70, maxZoom: 15.5 });
    else if (announce) toast('Nothing on the map yet');
    return pts.length > 0;
  }

  // restore layer choices from this session
  try { const v = JSON.parse(sessionStorage.getItem('ls-map-vis') || 'null'); if (v) { Object.assign(vis, v); (v.rasters || []).forEach((id) => maps.some((m) => m.id === id) && rasterOn.add(id)); } } catch {}
  drawPins(); drawRoutes(); drawGroup(); drawMe();
  applyVis(); renderSide(); renderLayers(); renderCoords(); renderStatus();
  const onGps = () => { drawMe(); renderGps(); renderCoords(); };
  gps.listeners.add(onGps);
  const tick = setInterval(() => { renderGps(); renderCoords(); renderStatus(); }, 15000);
  if (vtStatus.job?.running) pollSave();

  const pinQ = query.get('pin');
  const routeQ = query.get('route');
  const lat = Number(query.get('lat'));
  const lon = Number(query.get('lon'));
  if (pinQ && markers.has(pinQ)) focusMarker(pinQ);
  else if (routeQ) fitRoute(routes.find((r) => r.id === routeQ));
  else if (query.get('lat') && Number.isFinite(lat) && Number.isFinite(lon)) map.jumpTo({ center: [lon, lat], zoom: 16 });
  else if (!saved) { if (gps.lat != null) map.jumpTo({ center: [gps.lon, gps.lat], zoom: 15 }); else fitAll(false); }

  return () => {
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(saveTimer);
    gps.listeners.delete(onGps);
    clearInterval(tick);
    document.removeEventListener('keydown', onKey);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try { map.remove(); } catch {}
  };
}

// ---------- geometry helpers ----------
function fmtKm(d) { return d < 1 ? `${Math.round(d * 1000)} M` : `${d.toFixed(2)} KM`; }
function walkMin(d) { return Math.max(1, Math.round((d / 5) * 60)); } // ~5 km/h on foot
function dms(v, hemi) {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = ((a - d - m / 60) * 3600).toFixed(1);
  return `${d}°${String(m).padStart(2, '0')}'${s.padStart(4, '0')}"${v >= 0 ? hemi[0] : hemi[1]}`;
}
function bearing([a1, o1], [a2, o2]) {
  const r = Math.PI / 180;
  const y = Math.sin((o2 - o1) * r) * Math.cos(a2 * r);
  const x = Math.cos(a1 * r) * Math.sin(a2 * r) - Math.sin(a1 * r) * Math.cos(a2 * r) * Math.cos((o2 - o1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}
function compass(b) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8]; }
function destination([lat, lon], distKm, brg) {
  const R = 6371;
  const r = Math.PI / 180;
  const d = distKm / R;
  const lat2 = Math.asin(Math.sin(lat * r) * Math.cos(d) + Math.cos(lat * r) * Math.sin(d) * Math.cos(brg * r));
  const lon2 = lon * r + Math.atan2(Math.sin(brg * r) * Math.sin(d) * Math.cos(lat * r), Math.cos(d) - Math.sin(lat * r) * Math.sin(lat2));
  return [lat2 / r, lon2 / r];
}

export function km(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}
function haversine([a1, o1], [a2, o2]) {
  const R = 6371;
  const r = Math.PI / 180;
  const x = Math.sin(((a2 - a1) * r) / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(((o2 - o1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
