// Map style for the MapLibre street map: graphite land, muted blue water,
// roads in shades of grey, 3D buildings, emergency places, and an offline
// world layer underneath so the map is never blank without internet.

export const C = {
  bg: '#0c0e11',
  land: '#15181c',
  coast: '#3a4250',
  border: '#4a525e',
  water: '#0f1923',
  waterLine: '#1d2c3a',
  park: '#141d18',
  wood: '#131b16',
  residential: '#171a1e',
  grid: 'rgba(170, 190, 215, 0.06)',
  gridMajor: 'rgba(170, 190, 215, 0.11)',
  road: { motorway: '#5a6472', trunk: '#525b68', primary: '#454d58', secondary: '#3c434c', tertiary: '#343a42', minor: '#2b3036', service: '#262a2f', track: '#2c3029', path: '#30353b', rail: '#3d434c' },
  casing: '#0c0e11',
  building: '#1d2025',
  building3d: '#2a2e35',
  label: '#c9ced6',
  labelDim: '#8b929c',
  halo: '#0c0e11',
  waterLabel: '#6f8aa5',
};

const EMERGENCY = [
  ['hospital', '#f0566a', 'Hospital'], ['clinic', '#f0566a', 'Clinic'], ['doctors', '#f0566a', 'Doctor'],
  ['pharmacy', '#5fd49a', 'Pharmacy'], ['police', '#7aa7e0', 'Police'], ['fire_station', '#e3896b', 'Fire station'],
  ['drinking_water', '#6fb3d9', 'Drinking water'], ['water_point', '#6fb3d9', 'Water point'], ['shelter', '#b39ddb', 'Shelter'],
  ['fuel', '#d9c36b', 'Fuel'], ['supermarket', '#9fb88a', 'Supermarket'], ['toilets', '#8b929c', 'Toilets'],
];
export const EMERGENCY_TYPES = EMERGENCY.map(([k, color, label]) => ({ k, color, label }));
const kinds = EMERGENCY.map((e) => e[0]);
const kindExpr = ['coalesce', ['get', 'subclass'], ['get', 'class']];

let worldCache = null;
export async function worldData() {
  if (worldCache) return worldCache;
  const topo = await (await fetch('/vendor/countries-50m.json')).json();
  const tj = window.topojson;
  // Shapes that cross the date line (Russia, Fiji…) would be drawn the long way
  // round the world; "unwrap" their longitudes so they stay continuous.
  const unwrap = (ring) => {
    const out = [ring[0].slice()];
    for (let i = 1; i < ring.length; i++) {
      let lon = ring[i][0];
      const prev = out[i - 1][0];
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
      out.push([lon, ring[i][1]]);
    }
    const lons = out.map((c) => c[0]);
    return Math.max(...lons) - Math.min(...lons) > 340 ? ring : out; // leave pole-wrapping rings (Antarctica) alone
  };
  const fixGeom = (g) => {
    if (!g) return g;
    if (g.type === 'Polygon') return { ...g, coordinates: g.coordinates.map(unwrap) };
    if (g.type === 'MultiPolygon') return { ...g, coordinates: g.coordinates.map((p) => p.map(unwrap)) };
    if (g.type === 'LineString') return { ...g, coordinates: unwrap(g.coordinates) };
    if (g.type === 'MultiLineString') return { ...g, coordinates: g.coordinates.map(unwrap) };
    return g;
  };
  const countries = tj.feature(topo, topo.objects.countries);
  countries.features.forEach((f) => { f.geometry = fixGeom(f.geometry); });
  const borders = fixGeom(tj.mesh(topo, topo.objects.countries, (a, b) => a !== b));
  const coast = fixGeom(tj.mesh(topo, topo.objects.countries, (a, b) => a === b));
  const labels = { type: 'FeatureCollection', features: [] };
  for (const f of countries.features) {
    const g = f.geometry;
    if (!g || !f.properties?.name) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let best = null;
    let bestArea = -1;
    for (const p of polys) {
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
      for (const [x, y] of p[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const a = (x1 - x0) * (y1 - y0);
      if (a > bestArea) { bestArea = a; best = [(x0 + x1) / 2, (y0 + y1) / 2, x1 - x0]; }
    }
    if (best) labels.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [best[0], best[1]] }, properties: { name: f.properties.name.toUpperCase(), size: best[2] } });
  }
  const grid = (step) => {
    const features = [];
    for (let lon = -180; lon <= 180; lon += step) features.push({ type: 'Feature', properties: { major: lon % (step * 3) === 0 }, geometry: { type: 'LineString', coordinates: [[lon, -85], [lon, 0], [lon, 85]] } });
    for (let lat = -80; lat <= 80; lat += step) {
      const coords = [];
      for (let lon = -180; lon <= 180; lon += 10) coords.push([lon, lat]);
      features.push({ type: 'Feature', properties: { major: lat % (step * 3) === 0 }, geometry: { type: 'LineString', coordinates: coords } });
    }
    return { type: 'FeatureCollection', features };
  };
  worldCache = { countries, borders, coast, labels, grid10: grid(10), grid1: grid(1) };
  return worldCache;
}

const FONT = ['Noto Sans Regular'];
const roadColor = (cls) => ['match', ['get', 'class'], ...Object.entries(C.road).flatMap(([k, v]) => [k, v]), C.road.minor];
const roadWidth = (scale = 1) => ['interpolate', ['exponential', 1.5], ['zoom'], 6, 0.4 * scale, 10, ['match', ['get', 'class'], ['motorway', 'trunk'], 2 * scale, ['primary'], 1.4 * scale, ['secondary', 'tertiary'], 1 * scale, 0.5 * scale],
  16, ['match', ['get', 'class'], ['motorway', 'trunk'], 14 * scale, ['primary'], 11 * scale, ['secondary', 'tertiary'], 9 * scale, ['minor'], 6 * scale, 2.5 * scale]];

export async function buildStyle({ rasters = [] } = {}) {
  const w = await worldData();
  const origin = location.origin;
  const sources = {
    world: { type: 'geojson', data: w.countries, tolerance: 0.6 },
    borders: { type: 'geojson', data: w.borders },
    coast: { type: 'geojson', data: w.coast },
    worldLabels: { type: 'geojson', data: w.labels },
    grid10: { type: 'geojson', data: w.grid10 },
    grid1: { type: 'geojson', data: w.grid1 },
    omt: { type: 'vector', tiles: [origin + '/vt/{z}/{x}/{y}.pbf'], maxzoom: 14, attribution: '© OpenMapTiles © OpenStreetMap contributors · Natural Earth' },
  };
  for (const r of rasters) {
    sources['raster-' + r.id] = { type: 'raster', tiles: [origin + `/tiles/${r.id}/{z}/{x}/{y}`], tileSize: 256, minzoom: r.minzoom, maxzoom: r.maxzoom, bounds: r.bounds || undefined, attribution: r.attribution || '' };
  }
  const L = (id, group, def) => ({ id, metadata: { group }, ...def });
  const layers = [
    L('bg', 'base', { type: 'background', paint: { 'background-color': C.bg } }),
    L('world-land', 'base', { type: 'fill', source: 'world', paint: { 'fill-color': C.land } }),
    L('grid10', 'grid', { type: 'line', source: 'grid10', maxzoom: 6, paint: { 'line-color': ['case', ['get', 'major'], C.gridMajor, C.grid], 'line-width': 1 } }),
    L('grid1', 'grid', { type: 'line', source: 'grid1', minzoom: 6, maxzoom: 11, paint: { 'line-color': C.grid, 'line-width': 1 } }),
    // streets (vector)
    L('water', 'streets', { type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': C.water } }),
    L('landcover', 'streets', { type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'farmland', 'wetland']]], paint: { 'fill-color': ['match', ['get', 'class'], 'wood', C.wood, C.park], 'fill-opacity': 0.8 } }),
    L('park', 'streets', { type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': C.park, 'fill-opacity': 0.9 } }),
    L('landuse', 'streets', { type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 10, filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood']]], paint: { 'fill-color': C.residential, 'fill-opacity': 0.6 } }),
    L('waterway', 'streets', { type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': C.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 2] } }),
    L('coast', 'base', { type: 'line', source: 'coast', maxzoom: 9, paint: { 'line-color': C.coast, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 8, 1.4] } }),
    L('borders', 'base', { type: 'line', source: 'borders', paint: { 'line-color': C.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 8, 1.2], 'line-dasharray': [3, 2] } }),
    L('building', 'streets', { type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': C.building, 'fill-outline-color': '#262a30' } }),
    L('road-casing', 'streets', { type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['!', ['in', ['get', 'class'], ['literal', ['rail', 'transit', 'path', 'track']]]], minzoom: 12, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.casing, 'line-width': roadWidth(1.35) } }),
    L('road', 'streets', { type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['!', ['in', ['get', 'class'], ['literal', ['rail', 'transit']]]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': roadColor(), 'line-width': roadWidth() } }),
    L('rail', 'streets', { type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['rail', 'transit']]], paint: { 'line-color': C.road.rail, 'line-width': 1.2, 'line-dasharray': [4, 3] } }),
    L('building-3d', 'buildings3d', { type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14, layout: { visibility: 'none' }, paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, C.building, 80, C.building3d, 250, '#3a3f48'],
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.92 } }),
    L('boundary', 'streets', { type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['<=', ['get', 'admin_level'], 4], paint: { 'line-color': C.border, 'line-width': 1, 'line-dasharray': [3, 2] } }),
  ];
  for (const r of rasters) layers.push(L('raster-' + r.id, 'raster', { type: 'raster', source: 'raster-' + r.id, layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.55, 'raster-brightness-max': 0.72, 'raster-contrast': 0.05 } }));
  layers.push(
    L('water-name', 'streets', { type: 'symbol', source: 'omt', 'source-layer': 'water_name', layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-letter-spacing': 0.15 }, paint: { 'text-color': C.waterLabel, 'text-halo-color': C.halo, 'text-halo-width': 1.2 } }),
    L('road-name', 'streets', { type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 13, layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 17, 12] }, paint: { 'text-color': C.labelDim, 'text-halo-color': C.halo, 'text-halo-width': 1.4 } }),
    L('emergency', 'emergency', { type: 'circle', source: 'omt', 'source-layer': 'poi', minzoom: 12, filter: ['in', kindExpr, ['literal', kinds]], paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 6], 'circle-color': ['match', kindExpr, ...EMERGENCY.flatMap(([k, c]) => [k, c]), '#8b929c'],
      'circle-stroke-color': C.halo, 'circle-stroke-width': 1.5 } }),
    L('emergency-label', 'emergency', { type: 'symbol', source: 'omt', 'source-layer': 'poi', minzoom: 14, filter: ['in', kindExpr, ['literal', kinds]], layout: { 'text-field': ['coalesce', ['get', 'name'], ['match', kindExpr, ...EMERGENCY.flatMap(([k, , l]) => [k, l]), '']], 'text-font': FONT, 'text-size': 10.5, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true }, paint: {
      'text-color': ['match', kindExpr, ...EMERGENCY.flatMap(([k, c]) => [k, c]), C.labelDim], 'text-halo-color': C.halo, 'text-halo-width': 1.4 } }),
    L('place', 'streets', { type: 'symbol', source: 'omt', 'source-layer': 'place', filter: ['!=', ['get', 'class'], 'country'], layout: {
      'text-field': ['get', 'name'], 'text-font': FONT, 'text-transform': ['match', ['get', 'class'], ['city', 'town'], 'uppercase', 'none'], 'text-letter-spacing': ['match', ['get', 'class'], ['city', 'town'], 0.12, 0.04],
      'text-size': ['match', ['get', 'class'], 'city', 14, 'town', 12, 'village', 11, 10], 'symbol-sort-key': ['match', ['get', 'class'], 'city', 1, 'town', 2, 3] }, paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.6 } }),
    L('country-label', 'labels', { type: 'symbol', source: 'worldLabels', maxzoom: 7, layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 9, 6, 13], 'text-letter-spacing': 0.25, 'symbol-sort-key': ['-', 0, ['get', 'size']] }, paint: { 'text-color': 'rgba(200, 210, 222, 0.55)', 'text-halo-color': C.halo, 'text-halo-width': 1.2 } }),
  );
  return { version: 8, glyphs: origin + '/glyphs/{fontstack}/{range}.pbf', sources, layers };
}

export function setGroupVisible(map, group, on) {
  for (const l of map.getStyle().layers) if (l.metadata?.group === group) map.setLayoutProperty(l.id, 'visibility', on ? 'visible' : 'none');
}
