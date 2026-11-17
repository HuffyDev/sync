// Street map tiles (vector, OpenMapTiles schema) with an offline cache.
//
// The browser only ever asks this server for tiles. If a tile is on disk it
// is served from there; otherwise, while there is internet, it is fetched
// from the street-map host (OpenFreeMap by default), stored, and served — so
// every place you look at is kept for later. "Save this area" downloads a
// whole region ahead of time. With no internet and no saved copy, the map
// falls back to the built-in world outline.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { newId, nowIso } from './store.js';

const TILEJSON = process.env.LASTSYNC_VECTOR_TILEJSON || 'https://tiles.openfreemap.org/planet';
const UA = 'LASTSYNC/1.0 (offline survival app; https://github.com/HuffyDev/sync)';
const MAX_Z = 14;

export function tilesForBounds([w, s, e, n], minz, maxz) {
  const out = [];
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => {
    const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  for (let z = minz; z <= maxz; z++) {
    const x0 = lon2x(w, z), x1 = lon2x(e, z), y0 = lat2y(n, z), y1 = lat2y(s, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, Math.max(0, Math.min(2 ** z - 1, x)), Math.max(0, Math.min(2 ** z - 1, y))]);
  }
  return out;
}

export class VectorTiles {
  constructor(dir, { capBytes = Infinity, maxSaveTiles = 6000 } = {}) {
    this.dir = dir;
    this.tileDir = path.join(dir, 'tiles');
    fs.mkdirSync(this.tileDir, { recursive: true });
    this.capBytes = capBytes;
    this.maxSaveTiles = maxSaveTiles;
    this.meta = null;
    this.online = null; // last known reachability of the host
    this.inflight = new Map();
    this.active = 0;
    this.queue = [];
    this.job = { running: false };
    this.stats = this.readJson('stats.json', { tiles: 0, bytes: 0 });
  }

  readJson(name, fb) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return fb; } }
  writeJson(name, v) { const p = path.join(this.dir, name); fs.writeFileSync(p + '.tmp', JSON.stringify(v)); fs.renameSync(p + '.tmp', p); }

  areas() { return this.readJson('areas.json', []); }

  async tilejson() {
    if (this.meta) return this.meta;
    try {
      const res = await fetch(TILEJSON, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error('status ' + res.status);
      const tj = await res.json();
      if (!Array.isArray(tj.tiles) || !tj.tiles[0]) throw new Error('no tile URL');
      this.meta = { tiles: tj.tiles[0], maxzoom: Math.min(MAX_Z, tj.maxzoom ?? MAX_Z), attribution: tj.attribution || '' };
      this.writeJson('tilejson.json', this.meta);
      this.online = true;
    } catch {
      this.online = false;
      this.meta = this.readJson('tilejson.json', null); // last known template, if any
      if (this.meta) setTimeout(() => { this.meta = null; }, 60000); // retry the host later
    }
    return this.meta;
  }

  file(z, x, y) { return path.join(this.tileDir, String(z), String(x), y + '.pbf'); }

  // Returns a Buffer (possibly empty = no data in this tile) or null (unavailable).
  async get(z, x, y) {
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > MAX_Z || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;
    const f = this.file(z, x, y);
    try { return await fsp.readFile(f); } catch {}
    const key = `${z}/${x}/${y}`;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.fetchTile(z, x, y).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async slot() {
    if (this.active < 6) { this.active++; return; }
    await new Promise((r) => this.queue.push(r));
    this.active++;
  }
  release() { this.active--; const next = this.queue.shift(); if (next) next(); }

  async fetchTile(z, x, y) {
    if (this.online === false && this.lastFail && Date.now() - this.lastFail < 15000) return null;
    const meta = await this.tilejson();
    if (!meta) return null;
    await this.slot();
    try {
      const url = meta.tiles.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
      if (res.status === 204 || res.status === 404) { this.online = true; return this.store(z, x, y, Buffer.alloc(0)); }
      if (!res.ok) throw new Error('status ' + res.status);
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      this.online = true;
      return this.store(z, x, y, buf);
    } catch {
      this.online = false;
      this.lastFail = Date.now();
      return null;
    } finally {
      this.release();
    }
  }

  async store(z, x, y, buf) {
    if (this.stats.bytes + buf.length > this.capBytes) return buf; // serve but don't keep
    const f = this.file(z, x, y);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f + '.tmp', buf);
    await fsp.rename(f + '.tmp', f);
    this.stats.tiles++;
    this.stats.bytes += buf.length;
    if (!this.statsTimer) this.statsTimer = setTimeout(() => { this.statsTimer = null; this.writeJson('stats.json', this.stats); }, 3000);
    return buf;
  }

  status() {
    return { online: this.online, cached: this.stats, areas: this.areas(), job: this.job, maxZoom: MAX_Z, attribution: this.meta?.attribution || '© OpenMapTiles © OpenStreetMap contributors' };
  }

  estimate(bbox, minz, maxz) { return tilesForBounds(bbox, minz, Math.min(MAX_Z, maxz)).length; }

  saveArea({ name, bbox, minzoom = 0, maxzoom = MAX_Z }) {
    if (this.job.running) throw Object.assign(new Error('Already saving an area — wait for it to finish.'), { status: 409 });
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) throw Object.assign(new Error('Bad area'), { status: 400 });
    const maxz = Math.min(MAX_Z, Math.max(0, Math.round(maxzoom)));
    const tiles = tilesForBounds(bbox, Math.max(0, Math.round(minzoom)), maxz);
    if (tiles.length > this.maxSaveTiles) throw Object.assign(new Error(`That area needs ${tiles.length} tiles — the limit is ${this.maxSaveTiles}. Zoom in further or save a smaller area.`), { status: 400 });
    const area = { id: newId('a_'), name: String(name || 'Saved area').slice(0, 80), bbox, minzoom, maxzoom: maxz, tiles: tiles.length, bytes: 0, createdAt: nowIso(), complete: false };
    this.job = { running: true, area: area.id, name: area.name, done: 0, total: tiles.length, failed: 0 };
    (async () => {
      let i = 0;
      const worker = async () => {
        while (i < tiles.length) {
          const [z, x, y] = tiles[i++];
          const buf = await this.get(z, x, y);
          if (buf == null) this.job.failed++; else area.bytes += buf.length;
          this.job.done++;
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      area.complete = this.job.failed === 0;
      area.failed = this.job.failed;
      const list = this.areas();
      list.push(area);
      this.writeJson('areas.json', list);
      this.writeJson('stats.json', this.stats);
      this.job = { running: false, last: { name: area.name, done: this.job.done, failed: this.job.failed } };
    })();
    return this.job;
  }

  removeArea(id) { this.writeJson('areas.json', this.areas().filter((a) => a.id !== id)); }

  async clear() {
    await fsp.rm(this.tileDir, { recursive: true, force: true });
    fs.mkdirSync(this.tileDir, { recursive: true });
    this.stats = { tiles: 0, bytes: 0 };
    this.writeJson('stats.json', this.stats);
    this.writeJson('areas.json', []);
  }
}

// Label fonts (SDF glyph PBFs) ship with the app, so map text works offline.
export function glyphs(contentDir) {
  const dir = path.join(contentDir, 'glyphs');
  const EMPTY = zlib.gzipSync(Buffer.alloc(0));
  return (range) => {
    if (!/^\d+-\d+$/.test(range)) return null;
    try { return fs.readFileSync(path.join(dir, range + '.pbf.gz')); } catch { return EMPTY; }
  };
}
