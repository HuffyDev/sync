import { refresh } from './app.js';
import { parseNmea } from './nmea.js';
import { $, $$, api, upload, html, mount, toast, icon, esc, fmtBytes, ago, createMap, pinIcon, msgIcon, CATEGORIES, fmtCoord, MSG } from './shared.js';

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
export async function mapView(el, _args, query) {
  const [maps, pins, routes, plan, info] = await Promise.all([api('/api/maps'), api('/api/pins'), api('/api/routes'), api('/api/plan'), api('/api/group/info')]);
  const group = info.active ? await api('/api/group/state') : null;
  el.classList.add('full');
  mount(el, html`
    <h1 class="sr-only">Maps</h1>
    <div class="map-page">
      <div class="map-stage" id="stage">
        <div id="map" class="map"></div>
        <div class="map-vignette"></div>
        <div class="crosshair"></div>
        <div class="ov ov-tools" role="toolbar" aria-label="Map tools">
          <button class="tool" data-tool="pin" data-tip="Drop pin" aria-label="Drop pin">${icon('pin')}</button>
          <button class="tool" data-tool="route" data-tip="Draw route" aria-label="Draw route">${icon('route')}</button>
          <button class="tool" data-tool="measure" data-tip="Measure" aria-label="Measure distance">${icon('ruler')}</button>
          <button class="tool" data-tool="rings" data-tip="Range rings" aria-label="Range rings">${icon('target')}</button>
          <div class="tool-sep"></div>
          <button class="tool" data-act="locate" data-tip="My position" aria-label="My position">${icon('gps')}</button>
          <button class="tool" data-act="fit" data-tip="Fit all" aria-label="Fit everything">${icon('expand')}</button>
          <button class="tool" data-act="full" data-tip="Full screen" aria-label="Full screen">${icon('fullscreen')}</button>
        </div>
        <div class="ov ov-search"><input id="msearch" type="search" placeholder="LOCATE — PIN, ROUTE OR LAT, LON" autocomplete="off" aria-label="Find on map"><div class="hits" id="mhits"></div></div>
        <div class="ov ov-layers" id="layers"></div>
        <div class="ov ov-coords" id="coords"></div>
        <div class="ov ov-measure" id="measure" hidden></div>
        <div id="mode" class="map-mode" hidden></div>
      </div>
      <aside class="map-side" id="side"></aside>
    </div>`);
  const { map, layers: tileLayers, labels: labelLayer } = await createMap($('#map'), { maps });
  const L = window.L;
  L.control.scale({ position: 'bottomright', maxWidth: 140 }).addTo(map);
  const lyr = {
    pins: L.layerGroup().addTo(map),
    rally: L.layerGroup().addTo(map),
    routes: L.layerGroup().addTo(map),
    group: L.layerGroup().addTo(map),
    rings: L.layerGroup().addTo(map),
    measure: L.layerGroup().addTo(map),
    search: L.layerGroup().addTo(map),
  };
  let alive = true;
  let meMarker = null;
  let mode = null; // pin | route | measure | rings
  let draft = null;
  let draftLine = null;
  let measurePts = [];
  let cursor = null;
  let night = true;
  let activeMap = Object.keys(tileLayers)[0] || null;
  const markers = new Map();
  const lines = new Map();

  const popupFor = (title, rows, actions = []) => {
    const div = document.createElement('div');
    mount(div, html`<strong>${title}</strong>${rows.filter(Boolean).map((l) => html`<br><small>${l}</small>`)}<div class="row" style="margin-top:8px">${actions.map((a, i) => html`<button class="btn small ${a.cls || ''}" data-a="${i}">${a.label}</button>`)}</div>`);
    actions.forEach((a, i) => div.querySelector(`[data-a="${i}"]`).addEventListener('click', a.fn));
    return div;
  };

  // ---------- drawing ----------
  function drawPins() {
    lyr.pins.clearLayers(); lyr.rally.clearLayers(); markers.clear();
    for (const p of pins) {
      const m = L.marker([p.lat, p.lon], { icon: pinIcon(p.category), title: p.name, riseOnHover: true }).addTo(lyr.pins);
      m.bindPopup(() => popupFor(p.name, [CATEGORIES[p.category]?.label, p.note, fmtCoord(p.lat, p.lon), p.pack], [
        { label: 'Rings', fn: () => { map.closePopup(); drawRings([p.lat, p.lon]); } },
        { label: 'Edit', fn: () => { map.closePopup(); editPin(p); } },
        { label: 'Delete', cls: 'danger', fn: async () => { if (!confirm(`Delete pin “${p.name}”?`)) return; await api('/api/pins/' + p.id, { method: 'DELETE' }); pins.splice(pins.indexOf(p), 1); map.closePopup(); drawPins(); renderSide(); } },
      ]));
      markers.set(p.id, m);
    }
    for (const mp of plan.meetingPoints.filter((m) => m.lat != null && m.lon != null)) {
      const m = L.marker([mp.lat, mp.lon], { icon: pinIcon('meeting'), title: mp.name, zIndexOffset: 500 }).addTo(lyr.rally)
        .bindPopup(() => popupFor(mp.name, ['Rally point (your plan)', mp.address, mp.when, fmtCoord(mp.lat, mp.lon)], [
          { label: 'Rings', fn: () => { map.closePopup(); drawRings([mp.lat, mp.lon]); } },
          { label: 'Edit plan', fn: () => { location.hash = '#/plan'; } },
        ]));
      markers.set('mp:' + mp.id, m);
    }
  }

  function drawRoutes() {
    lyr.routes.clearLayers(); lines.clear();
    for (const r of routes) {
      L.polyline(r.points, { color: '#45d4ff', weight: 9, opacity: 0.12, interactive: false }).addTo(lyr.routes);
      const line = L.polyline(r.points, { color: '#8ae9ff', weight: 2.5, opacity: 0.95, dashArray: '10 6' }).addTo(lyr.routes);
      L.circleMarker(r.points[0], { radius: 5, color: '#2ef2a0', fillColor: '#03080c', fillOpacity: 1, weight: 2 }).addTo(lyr.routes).bindTooltip('Start: ' + r.name);
      L.circleMarker(r.points.at(-1), { radius: 5, color: '#ff2e4d', fillColor: '#03080c', fillOpacity: 1, weight: 2 }).addTo(lyr.routes).bindTooltip('End: ' + r.name);
      const dist = km(r.points);
      line.bindPopup(() => popupFor(r.name, [`${dist.toFixed(2)} km · ${(dist * 0.621371).toFixed(2)} mi`, `~${walkMin(dist)} min on foot · ${r.points.length} points`, r.note, r.pack], [
        { label: 'Delete', cls: 'danger', fn: async () => { if (!confirm(`Delete route “${r.name}”?`)) return; await api('/api/routes/' + r.id, { method: 'DELETE' }); routes.splice(routes.indexOf(r), 1); map.closePopup(); drawRoutes(); renderSide(); } },
      ]));
      lines.set(r.id, line);
    }
  }

  function drawGroup() {
    lyr.group.clearLayers();
    if (!group) return;
    for (const m of group.members) {
      const c = m.lastCheckIn;
      if (!c || c.lat == null) continue;
      L.marker([c.lat, c.lon], { icon: msgIcon(c.type), title: m.name, zIndexOffset: 800 }).addTo(lyr.group)
        .bindPopup(() => popupFor(m.name, [`${MSG[c.type]?.label} · ${ago(c.ts)}`, c.place, c.text]));
    }
    const mp = group.session.meetingPoint;
    if (mp?.lat != null) L.marker([mp.lat, mp.lon], { icon: pinIcon('meeting'), zIndexOffset: 900 }).addTo(lyr.group).bindPopup(() => popupFor('Group rally: ' + mp.name, [mp.note, 'Set by ' + mp.setBy + ' · ' + ago(mp.ts)]));
  }

  function drawMe() {
    if (gps.lat == null) { if (meMarker) { meMarker.remove(); meMarker = null; } return; }
    const ll = [gps.lat, gps.lon];
    if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: 'mk-wrap', html: '<div class="me-icon"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 }).addTo(map).bindTooltip('You');
    else meMarker.setLatLng(ll);
  }

  const RINGS = [0.5, 1, 2, 5];
  function drawRings(center) {
    lyr.rings.clearLayers();
    for (const r of RINGS) {
      L.circle(center, { radius: r * 1000, color: '#45d4ff', weight: 1.2, opacity: 0.8, fill: r === RINGS[0], fillOpacity: 0.05, dashArray: r === 5 ? '6 6' : null, interactive: false }).addTo(lyr.rings);
      const north = destination(center, r, 0);
      L.marker(north, { interactive: false, icon: L.divIcon({ className: '', html: `<span class="ring-label">${r < 1 ? r * 1000 + ' M' : r + ' KM'} · ${walkMin(r)} MIN</span>`, iconSize: null }) }).addTo(lyr.rings);
    }
    L.circleMarker(center, { radius: 3, color: '#45d4ff', fillColor: '#45d4ff', fillOpacity: 1, interactive: false }).addTo(lyr.rings);
    map.fitBounds(L.latLng(center).toBounds(11000), { maxZoom: 14 });
    renderLayers();
  }

  function drawMeasure() {
    if (!alive) return;
    lyr.measure.clearLayers();
    const box = $('#measure');
    if (mode !== 'measure' && !measurePts.length) { box.hidden = true; return; }
    if (measurePts.length) {
      L.polyline(measurePts, { color: '#45d4ff', weight: 2, dashArray: '4 6', interactive: false }).addTo(lyr.measure);
      let run = 0;
      measurePts.forEach((p, i) => {
        if (i) run += haversine(measurePts[i - 1], p);
        L.circleMarker(p, { radius: 4, color: '#fff', weight: 1.5, fillColor: '#45d4ff', fillOpacity: 1, interactive: false }).addTo(lyr.measure);
        if (i) L.marker(p, { interactive: false, icon: L.divIcon({ className: '', html: `<span class="measure-label">${fmtKm(run)}</span>`, iconSize: null }) }).addTo(lyr.measure);
      });
    }
    const total = km(measurePts);
    const last = measurePts.length > 1 ? bearing(measurePts.at(-2), measurePts.at(-1)) : null;
    box.hidden = false;
    mount(box, html`<span><span class="k faint">DIST</span> <b>${fmtKm(total)}</b> / ${(total * 0.621371).toFixed(2)} MI</span>
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

  // ---------- overlays ----------
  function renderLayers() {
    const toggles = [
      ['pins', 'Pins', '#7dd3fc'], ['rally', 'Rally points', '#4da3ff'], ['routes', 'Routes', '#8ae9ff'],
      ['group', 'Group check-ins', '#2ef2a0'],
    ];
    const names = Object.keys(tileLayers);
    mount($('#layers'), html`<span class="label">Layers</span>
      ${toggles.map(([k, label, c]) => html`<label><input type="checkbox" data-lyr="${k}" ${map.hasLayer(lyr[k]) ? 'checked' : ''}><span class="sw" style="border-color:${c}"></span>${label}</label>`)}
      ${labelLayer ? html`<label><input type="checkbox" data-lyr="labels" ${map.hasLayer(labelLayer) ? 'checked' : ''}>Country labels</label>` : ''}
      ${names.length ? html`<span class="label" style="margin-top:10px">Regional map</span>
        <label><input type="radio" name="basemap" value="" ${!activeMap ? 'checked' : ''}>Outline only</label>
        ${names.map((n) => html`<label><input type="radio" name="basemap" value="${n}" ${activeMap === n ? 'checked' : ''}>${n}</label>`)}
        <label><input type="checkbox" id="night" ${night ? 'checked' : ''}>Night filter</label>` : ''}
      ${lyr.rings.getLayers().length ? html`<button class="btn small" id="clear-rings" style="margin-top:8px;width:100%">Clear rings</button>` : ''}`);
    $$('[data-lyr]', $('#layers')).forEach((c) => c.addEventListener('change', () => {
      const l = c.dataset.lyr === 'labels' ? labelLayer : lyr[c.dataset.lyr];
      if (c.checked) l.addTo(map); else l.remove();
    }));
    $$('input[name=basemap]', $('#layers')).forEach((r) => r.addEventListener('change', () => {
      for (const t of Object.values(tileLayers)) t.remove();
      activeMap = r.value || null;
      if (activeMap) tileLayers[activeMap].addTo(map);
    }));
    $('#night')?.addEventListener('change', (e) => { night = e.target.checked; $('#map').classList.toggle('day', !night); });
    $('#clear-rings')?.addEventListener('click', () => { lyr.rings.clearLayers(); renderLayers(); });
  }

  function renderCoords() {
    if (!alive) return;
    const c = cursor || map.getCenter();
    const age = gps.fixAt ? (Date.now() - new Date(gps.fixAt)) / 1000 : null;
    mount($('#coords'), html`
      <div><span class="k">${cursor ? 'CURSOR' : 'CENTER'}</span>${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</div>
      <div><span class="k">DMS</span>${dms(c.lat, 'NS')} ${dms(c.lng, 'EW')}</div>
      <div><span class="k">ZOOM</span>${map.getZoom().toFixed(1)}${activeMap ? ' · ' + activeMap.toUpperCase() : ' · OUTLINE'}</div>
      <div><span class="k">GPS</span>${gps.lat != null ? html`<span style="color:${age > 120 ? 'var(--warn)' : 'var(--safe)'}">${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)} · ${ago(gps.fixAt)}</span>` : html`<span class="faint">NO FIX</span>`}</div>`);
  }

  function setMode(m) {
    if (!alive) return;
    if (mode === 'route' && m !== 'route') { draftLine?.remove(); draftLine = null; draft = null; }
    mode = mode === m ? null : m;
    if (mode === 'route') draft = { name: '', points: [] };
    $$('[data-tool]', el).forEach((b) => b.classList.toggle('on', b.dataset.tool === mode));
    const box = $('#mode');
    box.hidden = !mode;
    box.textContent = { pin: 'Click to drop a pin · Esc to cancel', route: 'Click to add route points · Esc to cancel', measure: 'Click points to measure · Esc to finish', rings: 'Click a point for range rings · Esc to cancel' }[mode] || '';
    $('#map').style.cursor = mode ? 'crosshair' : '';
    if (mode === 'measure' || measurePts.length) drawMeasure();
    renderSide();
  }

  map.on('click', (e) => {
    const ll = [e.latlng.lat, e.latlng.lng];
    if (mode === 'pin') { setMode(null); editPin({ name: '', category: 'other', note: '', lat: ll[0], lon: ll[1] }); }
    else if (mode === 'route') {
      draft.points.push(ll);
      if (!draftLine) draftLine = L.polyline(draft.points, { color: '#45d4ff', weight: 3, dashArray: '6 6' }).addTo(map);
      else draftLine.setLatLngs(draft.points);
      renderSide();
    } else if (mode === 'measure') { measurePts.push(ll); drawMeasure(); }
    else if (mode === 'rings') { setMode(null); drawRings(ll); }
  });
  let raf = 0;
  map.on('mousemove', (e) => { cursor = e.latlng; if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderCoords(); }); });
  map.on('mouseout', () => { cursor = null; renderCoords(); });
  map.on('zoomend moveend', renderCoords);
  const onKey = (e) => { if (e.key === 'Escape' && mode) setMode(null); };
  document.addEventListener('keydown', onKey);

  $$('[data-tool]', el).forEach((b) => b.addEventListener('click', () => setMode(b.dataset.tool)));
  $$('[data-act]', el).forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'locate') {
      if (gps.lat != null) map.setView([gps.lat, gps.lon], Math.max(map.getZoom(), 15));
      else { try { useDeviceLocation(); toast('Looking for your position…'); } catch (err) { toast(err.message, 'bad'); } }
    }
    if (a === 'fit') fitAll(true);
    if (a === 'full') {
      const st = $('#stage');
      if (document.fullscreenElement) document.exitFullscreen(); else st.requestFullscreen?.();
      setTimeout(() => map.invalidateSize(), 250);
    }
  }));

  // search
  const search = $('#msearch');
  const hits = $('#mhits');
  const candidates = () => [
    ...pins.map((p) => ({ name: p.name, kind: CATEGORIES[p.category]?.label || 'Pin', go: () => focusMarker(p.id) })),
    ...plan.meetingPoints.filter((m) => m.lat != null).map((m) => ({ name: m.name, kind: 'Rally point', go: () => focusMarker('mp:' + m.id) })),
    ...routes.map((r) => ({ name: r.name, kind: `Route · ${km(r.points).toFixed(1)} km`, go: () => focusRoute(r.id) })),
  ];
  const runSearch = () => {
    const q = search.value.trim();
    const coord = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
    let list = [];
    if (coord && Math.abs(+coord[1]) <= 90 && Math.abs(+coord[2]) <= 180) {
      list = [{ name: `${(+coord[1]).toFixed(5)}, ${(+coord[2]).toFixed(5)}`, kind: 'Go to coordinates', go: () => {
        lyr.search.clearLayers();
        L.circleMarker([+coord[1], +coord[2]], { radius: 8, color: '#45d4ff', weight: 2, fillOpacity: 0.15 }).addTo(lyr.search);
        map.setView([+coord[1], +coord[2]], Math.max(map.getZoom(), 13));
      } }];
    } else if (q) list = candidates().filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
    mount(hits, html`${list.map((c, i) => html`<button data-hit="${i}">${c.name}<small class="muted">${c.kind}</small></button>`)}${q && !list.length ? html`<button disabled><small class="muted">No match</small></button>` : ''}`);
    $$('[data-hit]', hits).forEach((b) => b.addEventListener('click', () => { list[+b.dataset.hit].go(); hits.innerHTML = ''; search.blur(); }));
    return list;
  };
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const l = runSearch(); if (l[0]) { l[0].go(); hits.innerHTML = ''; } } if (e.key === 'Escape') { search.value = ''; hits.innerHTML = ''; } });

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
        toast('Pin saved');
        drawPins(); renderSide();
      } catch (err) { toast(err.message, 'bad'); }
    });
    side.querySelector('input').focus();
  }

  function renderSide() {
    const side = $('#side');
    if (mode === 'route' && draft) {
      mount(side, html`<div class="card stack"><h2>Draw route</h2><p class="muted">Click along the way you'd walk or drive — e.g. home to your rally point.</p>
        <div class="stat-row" style="grid-template-columns:1fr 1fr;margin:0"><div class="stat"><div class="label">Points</div><div class="v">${draft.points.length}</div></div><div class="stat"><div class="label">Distance</div><div class="v">${fmtKm(km(draft.points))}</div></div></div>
        <label class="field"><span>Route name</span><input id="rname" value="${draft.name}" placeholder="e.g. Home to school (on foot)"></label>
        <div class="row"><button class="btn small" id="undo" ${draft.points.length ? '' : 'disabled'}>Undo</button><span class="spacer"></span><button class="btn small ghost" id="rcancel">Cancel</button><button class="btn small primary" id="rsave" ${draft.points.length > 1 ? '' : 'disabled'}>Save</button></div></div>`);
      $('#rname').addEventListener('input', (e) => { draft.name = e.target.value; });
      $('#undo').addEventListener('click', () => { draft.points.pop(); draftLine?.setLatLngs(draft.points); renderSide(); });
      $('#rcancel').addEventListener('click', () => setMode(null));
      $('#rsave').addEventListener('click', async () => {
        try {
          routes.push(await api('/api/routes', { method: 'POST', body: { name: draft.name || 'Route', points: draft.points } }));
          setMode(null); drawRoutes(); renderSide(); toast('Route saved');
        } catch (err) { toast(err.message, 'bad'); }
      });
      return;
    }
    mount(side, html`
      <section class="card stack">
        <div class="card-title"><h2>Position</h2>${gps.source ? html`<button class="btn small ghost" id="gps-stop">Stop</button>` : ''}</div>
        <div id="gps-box"></div>
        <div class="row">
          <button class="btn small" id="gps-usb">${icon('gps')}USB GPS</button>
          <select id="baud" style="width:auto;min-height:30px;padding:3px 28px 3px 8px;font-size:.8rem" aria-label="GPS speed"><option>4800</option><option selected>9600</option><option>38400</option><option>115200</option></select>
          <button class="btn small" id="gps-dev">Device</button>
        </div>
      </section>
      <section class="card stack">
        <div class="card-title"><h2>Regional maps</h2><label class="btn small">${icon('upload')}Import<input type="file" id="mbt" accept=".mbtiles" hidden></label></div>
        <div id="mbt-progress"></div>
        ${maps.length ? html`<ul class="list">${maps.map((m) => html`<li class="row between"><span><strong>${m.name}</strong><br><small class="mono">Z${m.minzoom}–${m.maxzoom} · ${fmtBytes(m.size)}${m.pack ? ' · ' + m.pack : ''}</small></span><span class="row"><button class="btn small" data-fit="${m.id}">Go</button><button class="icon-btn" data-delmap="${m.id}" aria-label="Delete map">${icon('trash')}</button></span></li>`)}</ul>`
          : html`<p class="muted" style="margin:0">The built-in tactical map covers the whole world. For street-level detail, import an <strong>.mbtiles</strong> file for your region (PNG/JPG tiles) — e.g. from QGIS or MapTiler, or from a pack.</p>`}
      </section>
      <section class="card">
        <div class="card-title"><h2>Pins · ${pins.length}</h2><label class="btn small">${icon('upload')}GPX<input type="file" id="gpx" accept=".gpx,application/gpx+xml" hidden></label></div>
        ${pins.length ? html`<ul class="list">${pins.map((p) => html`<li><a href="#" class="item-link row" data-pin="${p.id}"><span class="status-dot" style="background:${CATEGORIES[p.category]?.color};box-shadow:0 0 8px ${CATEGORIES[p.category]?.color}"></span><span><strong>${p.name}</strong><br><small>${CATEGORIES[p.category]?.label}</small></span></a></li>`)}</ul>` : html`<p class="muted" style="margin:0">No pins yet. Mark water, shelters, hospitals and rally points.</p>`}
      </section>
      <section class="card">
        <h2>Routes · ${routes.length}</h2>
        ${routes.length ? html`<ul class="list">${routes.map((r) => html`<li><a href="#" class="item-link" data-route="${r.id}"><strong>${r.name}</strong><br><small class="mono">${fmtKm(km(r.points))} · ~${walkMin(km(r.points))} MIN ON FOOT${r.pack ? ' · ' + r.pack : ''}</small></a></li>`)}</ul>` : html`<p class="muted" style="margin:0">No routes saved yet.</p>`}
      </section>`);
    renderGps();
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
        if (all.length) map.fitBounds(all, { padding: [40, 40] });
      } catch (err) { toast(err.message, 'bad'); }
    });
    $('#mbt').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const box = $('#mbt-progress');
      try {
        const m = await upload('/api/maps/upload?name=' + encodeURIComponent(file.name.replace(/\.mbtiles$/i, '')), file, (p) => mount(box, html`<div class="progress"><i style="width:${Math.round(p * 100)}%"></i></div><small class="muted mono">UPLOADING ${Math.round(p * 100)}%</small>`));
        toast(`Map “${m.name}” saved`);
        refresh('map');
      } catch (err) { mount(box, html`<div class="notice bad">${err.message}</div>`); }
    });
    $$('[data-fit]', side).forEach((b) => b.addEventListener('click', () => {
      const m = maps.find((x) => x.id === b.dataset.fit);
      if (m.bounds) map.fitBounds([[m.bounds[1], m.bounds[0]], [m.bounds[3], m.bounds[2]]]);
    }));
    $$('[data-delmap]', side).forEach((b) => b.addEventListener('click', async () => {
      const m = maps.find((x) => x.id === b.dataset.delmap);
      if (!confirm(`Delete the map “${m.name}” from this PC?`)) return;
      await api('/api/maps/' + m.id, { method: 'DELETE' });
      refresh('map');
    }));
    $$('[data-pin]', side).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); focusMarker(a.dataset.pin); }));
    $$('[data-route]', side).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); focusRoute(a.dataset.route); }));
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
    $('#gps-center').addEventListener('click', () => map.setView([gps.lat, gps.lon], Math.max(map.getZoom(), 15)));
    $('#gps-pin').addEventListener('click', () => editPin({ name: 'My position', category: 'other', note: `Saved ${new Date().toLocaleString()}`, lat: gps.lat, lon: gps.lon }));
    $('#gps-rings').addEventListener('click', () => drawRings([gps.lat, gps.lon]));
  }

  function focusMarker(id) {
    const m = markers.get(id);
    if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 15)); m.openPopup(); }
  }
  function focusRoute(id) {
    const l = lines.get(id);
    if (l) { map.fitBounds(l.getBounds(), { padding: [50, 50] }); l.openPopup(); }
  }
  function fitAll(announce) {
    const pts = [...pins.map((p) => [p.lat, p.lon]), ...routes.flatMap((r) => r.points), ...plan.meetingPoints.filter((m) => m.lat != null).map((m) => [m.lat, m.lon])];
    if (gps.lat != null) pts.push([gps.lat, gps.lon]);
    if (pts.length) map.fitBounds(pts, { padding: [60, 60], maxZoom: 15 });
    else if (maps[0]?.bounds) map.fitBounds([[maps[0].bounds[1], maps[0].bounds[0]], [maps[0].bounds[3], maps[0].bounds[2]]]);
    else if (announce) toast('Nothing on the map yet');
    return pts.length > 0;
  }

  drawPins(); drawRoutes(); drawGroup(); drawMe(); renderSide(); renderLayers(); renderCoords();
  let firstFix = gps.lat == null;
  const onGps = () => {
    drawMe(); renderGps(); renderCoords();
    if (firstFix && gps.lat != null) { firstFix = false; map.setView([gps.lat, gps.lon], 15); }
  };
  gps.listeners.add(onGps);
  const tick = setInterval(() => { renderGps(); renderCoords(); }, 15000);

  const pinQ = query.get('pin');
  const routeQ = query.get('route');
  const lat = Number(query.get('lat'));
  const lon = Number(query.get('lon'));
  if (pinQ && markers.has(pinQ)) focusMarker(pinQ);
  else if (routeQ && lines.has(routeQ)) focusRoute(routeQ);
  else if (query.get('lat') && Number.isFinite(lat) && Number.isFinite(lon)) {
    map.setView([lat, lon], 16);
    const near = [...markers.values()].find((m) => m.getLatLng().distanceTo([lat, lon]) < 5);
    near?.openPopup();
  } else if (gps.lat != null) map.setView([gps.lat, gps.lon], 15);
  else fitAll(false);
  setTimeout(() => map.invalidateSize(), 60);

  return () => {
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    gps.listeners.delete(onGps);
    clearInterval(tick);
    document.removeEventListener('keydown', onKey);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    el.classList.remove('full');
    map.remove();
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
