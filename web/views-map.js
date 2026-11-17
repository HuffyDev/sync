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
  mount(el, html`
    <div class="page-head"><div><h1>Maps</h1><p>Works offline. Import a regional map, save pins and routes, and see your GPS position.</p></div></div>
    <div class="map-layout">
      <div class="map-wrap"><div id="map" class="map" style="height:100%"></div><div id="mode" class="map-mode" hidden></div></div>
      <aside class="map-side" id="side"></aside>
    </div>`);
  const { map } = await createMap($('#map'), { maps });
  const L = window.L;
  const pinLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const groupLayer = L.layerGroup().addTo(map);
  let meMarker = null;
  let mode = null; // 'pin' | 'route'
  let draft = null;
  let draftLine = null;
  const markers = new Map();
  const lines = new Map();

  const popupFor = (title, lines2, actions = []) => {
    const div = document.createElement('div');
    mount(div, html`<strong>${title}</strong>${lines2.filter(Boolean).map((l) => html`<br><small>${l}</small>`)}<div class="row" style="margin-top:8px">${actions.map((a, i) => html`<button class="btn small ${a.cls || ''}" data-a="${i}">${a.label}</button>`)}</div>`);
    actions.forEach((a, i) => div.querySelector(`[data-a="${i}"]`).addEventListener('click', a.fn));
    return div;
  };

  function drawPins() {
    pinLayer.clearLayers();
    markers.clear();
    for (const p of pins) {
      const m = L.marker([p.lat, p.lon], { icon: pinIcon(p.category), title: p.name }).addTo(pinLayer);
      m.bindPopup(() => popupFor(p.name, [CATEGORIES[p.category]?.label, p.note, fmtCoord(p.lat, p.lon), p.pack], [
        { label: 'Edit', fn: () => { map.closePopup(); editPin(p); } },
        { label: 'Delete', cls: 'danger', fn: async () => { if (!confirm(`Delete pin “${p.name}”?`)) return; await api('/api/pins/' + p.id, { method: 'DELETE' }); pins.splice(pins.indexOf(p), 1); map.closePopup(); drawPins(); renderSide(); } },
      ]));
      markers.set(p.id, m);
    }
    for (const mp of plan.meetingPoints.filter((m) => m.lat != null && m.lon != null)) {
      L.marker([mp.lat, mp.lon], { icon: pinIcon('meeting'), title: mp.name }).addTo(pinLayer)
        .bindPopup(() => popupFor(mp.name, ['Meeting point (from your plan)', mp.address, mp.when, fmtCoord(mp.lat, mp.lon)], [{ label: 'Edit plan', fn: () => { location.hash = '#/plan'; } }]));
    }
  }

  function drawRoutes() {
    routeLayer.clearLayers();
    lines.clear();
    for (const r of routes) {
      const line = L.polyline(r.points, { color: '#f5a524', weight: 5, opacity: 0.9 }).addTo(routeLayer);
      L.circleMarker(r.points[0], { radius: 6, color: '#fff', fillColor: '#3ecf7a', fillOpacity: 1, weight: 2 }).addTo(routeLayer);
      L.circleMarker(r.points.at(-1), { radius: 6, color: '#fff', fillColor: '#ff5a4f', fillOpacity: 1, weight: 2 }).addTo(routeLayer);
      line.bindPopup(() => popupFor(r.name, [`${r.points.length} points · ${km(r.points).toFixed(1)} km`, r.note, r.pack], [
        { label: 'Delete', cls: 'danger', fn: async () => { if (!confirm(`Delete route “${r.name}”?`)) return; await api('/api/routes/' + r.id, { method: 'DELETE' }); routes.splice(routes.indexOf(r), 1); map.closePopup(); drawRoutes(); renderSide(); } },
      ]));
      lines.set(r.id, line);
    }
  }

  function drawGroup() {
    groupLayer.clearLayers();
    if (!group) return;
    for (const m of group.members) {
      const c = m.lastCheckIn;
      if (!c || c.lat == null) continue;
      L.marker([c.lat, c.lon], { icon: msgIcon(c.type), title: m.name }).addTo(groupLayer)
        .bindPopup(() => popupFor(m.name, [`${MSG[c.type]?.label} · ${ago(c.ts)}`, c.place, c.text]));
    }
    const mp = group.session.meetingPoint;
    if (mp?.lat != null) L.marker([mp.lat, mp.lon], { icon: pinIcon('meeting') }).addTo(groupLayer).bindPopup(() => popupFor('Group meeting point: ' + mp.name, [mp.note, 'Set by ' + mp.setBy + ' · ' + ago(mp.ts)]));
  }

  function drawMe() {
    if (gps.lat == null) { if (meMarker) { meMarker.remove(); meMarker = null; } return; }
    const ll = [gps.lat, gps.lon];
    if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-icon"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(map).bindTooltip('You');
    else meMarker.setLatLng(ll);
  }

  function setMode(m) {
    mode = m;
    const box = $('#mode');
    box.hidden = !m;
    box.textContent = m === 'pin' ? 'Click the map to place a pin' : m === 'route' ? 'Click the map to add route points' : '';
    $('#map').style.cursor = m ? 'crosshair' : '';
  }

  map.on('click', (e) => {
    if (mode === 'pin') {
      setMode(null);
      editPin({ name: '', category: 'other', note: '', lat: e.latlng.lat, lon: e.latlng.lng });
    } else if (mode === 'route') {
      draft.points.push([e.latlng.lat, e.latlng.lng]);
      if (!draftLine) draftLine = L.polyline(draft.points, { color: '#59a8ff', weight: 4, dashArray: '6 6' }).addTo(map);
      else draftLine.setLatLngs(draft.points);
      renderSide();
    }
  });

  function editPin(p) {
    const side = $('#side');
    mount(side, html`<form class="card stack" id="pinf">
      <h3>${p.id ? 'Edit pin' : 'New pin'}</h3>
      <label class="field"><span>Name</span><input name="name" value="${p.name}" required maxlength="80" placeholder="e.g. Community center"></label>
      <label class="field"><span>Type</span><select name="category">${Object.entries(CATEGORIES).map(([k, c]) => html`<option value="${k}" ${p.category === k ? 'selected' : ''}>${c.label}</option>`)}</select></label>
      <label class="field"><span>Note</span><textarea name="note" rows="3" maxlength="2000">${p.note || ''}</textarea></label>
      <div class="grid grid-2"><label class="field"><span>Latitude</span><input name="lat" value="${p.lat.toFixed(6)}"></label><label class="field"><span>Longitude</span><input name="lon" value="${p.lon.toFixed(6)}"></label></div>
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
        drawPins();
        renderSide();
      } catch (err) { toast(err.message, 'bad'); }
    });
    side.querySelector('input').focus();
  }

  function renderSide() {
    const side = $('#side');
    if (mode === 'route') {
      mount(side, html`<div class="card stack"><h3>Draw a route</h3><p class="muted">Click along the way you'd walk or drive — for example from home to your meeting point. ${draft.points.length} points so far${draft.points.length > 1 ? ` · ${km(draft.points).toFixed(2)} km` : ''}.</p>
        <label class="field"><span>Route name</span><input id="rname" value="${draft.name}" placeholder="e.g. Home to school (on foot)"></label>
        <div class="row"><button class="btn" id="undo" ${draft.points.length ? '' : 'disabled'}>Undo point</button><span class="spacer"></span><button class="btn ghost" id="rcancel">Cancel</button><button class="btn primary" id="rsave" ${draft.points.length > 1 ? '' : 'disabled'}>Save route</button></div></div>`);
      $('#rname').addEventListener('input', (e) => { draft.name = e.target.value; });
      $('#undo').addEventListener('click', () => { draft.points.pop(); draftLine?.setLatLngs(draft.points); renderSide(); });
      $('#rcancel').addEventListener('click', () => { draftLine?.remove(); draftLine = null; draft = null; setMode(null); renderSide(); });
      $('#rsave').addEventListener('click', async () => {
        try {
          routes.push(await api('/api/routes', { method: 'POST', body: { name: draft.name || 'Route', points: draft.points } }));
          draftLine?.remove(); draftLine = null; draft = null; setMode(null);
          drawRoutes(); renderSide(); toast('Route saved');
        } catch (err) { toast(err.message, 'bad'); }
      });
      return;
    }
    mount(side, html`
      <section class="card stack">
        <div class="card-title"><h3>Your position</h3>${gps.source ? html`<button class="btn small ghost" id="gps-stop">Stop</button>` : ''}</div>
        <div id="gps-box"></div>
        <div class="row">
          <button class="btn small" id="gps-usb">${icon('gps')}USB GPS</button>
          <select id="baud" style="width:auto;min-height:32px;padding:4px 8px" aria-label="GPS speed"><option>4800</option><option selected>9600</option><option>38400</option><option>115200</option></select>
          <button class="btn small" id="gps-dev">This device</button>
        </div>
      </section>
      <section class="card stack">
        <h3>Add to the map</h3>
        <div class="row"><button class="btn small" id="add-pin">${icon('pin')}Place a pin</button><button class="btn small" id="add-route">${icon('route')}Draw a route</button>
        <label class="btn small">${icon('upload')}Import GPX<input type="file" id="gpx" accept=".gpx,application/gpx+xml" hidden></label></div>
      </section>
      <section class="card stack">
        <div class="card-title"><h3>Regional maps</h3><label class="btn small">${icon('upload')}Import<input type="file" id="mbt" accept=".mbtiles" hidden></label></div>
        <div id="mbt-progress"></div>
        ${maps.length ? html`<ul class="list">${maps.map((m) => html`<li class="row between"><span><strong>${m.name}</strong><br><small>Zoom ${m.minzoom}–${m.maxzoom} · ${fmtBytes(m.size)}${m.pack ? ' · ' + m.pack : ''}</small></span><span class="row"><button class="btn small" data-fit="${m.id}">Show</button><button class="icon-btn" data-delmap="${m.id}" aria-label="Delete map">${icon('trash')}</button></span></li>`)}</ul>`
          : html`<p class="muted">Only the world outline is saved. Import an <strong>.mbtiles</strong> file for your region (PNG/JPG tiles) while you're online — for example made with QGIS or MapTiler, or shared by a friend in a LASTSYNC pack.</p>`}
      </section>
      <section class="card">
        <h3>Pins (${pins.length})</h3>
        ${pins.length ? html`<ul class="list">${pins.map((p) => html`<li><a href="#" class="item-link row" data-pin="${p.id}"><span class="status-dot" style="background:${CATEGORIES[p.category]?.color}"></span><span><strong>${p.name}</strong><br><small>${CATEGORIES[p.category]?.label}</small></span></a></li>`)}</ul>` : html`<p class="muted">No pins yet. Mark water sources, shelters, hospitals and meeting points.</p>`}
      </section>
      <section class="card">
        <h3>Routes (${routes.length})</h3>
        ${routes.length ? html`<ul class="list">${routes.map((r) => html`<li><a href="#" class="item-link" data-route="${r.id}"><strong>${r.name}</strong><br><small>${km(r.points).toFixed(1)} km${r.pack ? ' · ' + r.pack : ''}</small></a></li>`)}</ul>` : html`<p class="muted">No routes saved yet.</p>`}
      </section>`);
    renderGps();
    $('#gps-usb').addEventListener('click', async () => { try { await connectSerialGps(Number($('#baud').value)); } catch (err) { if (err.name !== 'NotFoundError') toast(err.message, 'bad'); } });
    $('#gps-dev').addEventListener('click', () => { try { useDeviceLocation(); } catch (err) { toast(err.message, 'bad'); } });
    $('#gps-stop')?.addEventListener('click', () => { stopGps(); renderSide(); });
    $('#add-pin').addEventListener('click', () => setMode('pin'));
    $('#add-route').addEventListener('click', () => { draft = { name: '', points: [] }; setMode('route'); renderSide(); });
    $('#gpx').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const r = await upload('/api/routes/gpx?name=' + encodeURIComponent(file.name.replace(/\.gpx$/i, '')), file);
        routes.push(...r.routes); pins.push(...r.pins);
        drawRoutes(); drawPins(); renderSide();
        toast(`Imported ${r.routes.length} routes and ${r.pins.length} waypoints`);
        const all = [...r.routes.flatMap((x) => x.points), ...r.pins.map((p) => [p.lat, p.lon])];
        if (all.length) map.fitBounds(all, { padding: [30, 30] });
      } catch (err) { toast(err.message, 'bad'); }
    });
    $('#mbt').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const box = $('#mbt-progress');
      try {
        const m = await upload('/api/maps/upload?name=' + encodeURIComponent(file.name.replace(/\.mbtiles$/i, '')), file, (p) => mount(box, html`<div class="progress"><i style="width:${Math.round(p * 100)}%"></i></div><small class="muted">Copying ${file.name}…</small>`));
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
    $$('[data-pin]', side).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); focusPin(a.dataset.pin); }));
    $$('[data-route]', side).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); focusRoute(a.dataset.route); }));
  }

  function renderGps() {
    const box = $('#gps-box');
    if (!box) return;
    if (gps.lat == null) {
      mount(box, html`<p class="muted" style="margin:0">${gps.error || 'Connect a USB GPS receiver, or place a pin by hand.'}</p>`);
      return;
    }
    const age = (Date.now() - new Date(gps.fixAt)) / 1000;
    mount(box, html`<p style="margin:0"><strong class="mono">${fmtCoord(gps.lat, gps.lon)}</strong><br>
      <small class="${age > 120 ? '' : 'muted'}" style="${age > 120 ? 'color:var(--accent)' : ''}">Updated ${ago(gps.fixAt)}${gps.source === 'usb' ? ' · USB GPS' : ' · this device'}${gps.sats ? ` · ${gps.sats} satellites` : ''}${gps.accuracy ? ` · ±${gps.accuracy} m` : ''}${age > 120 ? ' — position may be old' : ''}</small></p>
      ${gps.error ? html`<small class="muted">${gps.error}</small>` : ''}
      <div class="row" style="margin-top:8px"><button class="btn small" id="gps-center">Center map</button><button class="btn small" id="gps-pin">${icon('pin')}Pin here</button></div>`);
    $('#gps-center').addEventListener('click', () => map.setView([gps.lat, gps.lon], Math.max(map.getZoom(), 15)));
    $('#gps-pin').addEventListener('click', () => editPin({ name: 'My position', category: 'other', note: `Saved ${new Date().toLocaleString()}`, lat: gps.lat, lon: gps.lon }));
  }

  function focusPin(id) {
    const m = markers.get(id);
    if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 15)); m.openPopup(); }
  }
  function focusRoute(id) {
    const l = lines.get(id);
    if (l) { map.fitBounds(l.getBounds(), { padding: [30, 30] }); l.openPopup(); }
  }

  drawPins(); drawRoutes(); drawGroup(); drawMe(); renderSide();
  let firstFix = gps.lat == null;
  const onGps = () => {
    drawMe();
    renderGps();
    if (firstFix && gps.lat != null) { firstFix = false; map.setView([gps.lat, gps.lon], 15); }
  };
  gps.listeners.add(onGps);
  const tick = setInterval(renderGps, 15000);

  // Initial view
  const pinQ = query.get('pin');
  const routeQ = query.get('route');
  const lat = Number(query.get('lat'));
  const lon = Number(query.get('lon'));
  if (pinQ && markers.has(pinQ)) focusPin(pinQ);
  else if (routeQ && lines.has(routeQ)) focusRoute(routeQ);
  else if (query.get('lat') && Number.isFinite(lat) && Number.isFinite(lon)) map.setView([lat, lon], 16);
  else if (gps.lat != null) map.setView([gps.lat, gps.lon], 15);
  else {
    const pts = [...pins.map((p) => [p.lat, p.lon]), ...routes.flatMap((r) => r.points), ...plan.meetingPoints.filter((m) => m.lat != null).map((m) => [m.lat, m.lon])];
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
    else if (maps[0]?.bounds) map.fitBounds([[maps[0].bounds[1], maps[0].bounds[0]], [maps[0].bounds[3], maps[0].bounds[2]]]);
  }
  setTimeout(() => map.invalidateSize(), 50);

  return () => { gps.listeners.delete(onGps); clearInterval(tick); map.remove(); };
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
