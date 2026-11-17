// Offline regional maps stored as MBTiles files (one SQLite file per region,
// raster PNG/JPG/WebP tiles). Read with Node's built-in SQLite, so nothing
// extra has to be installed.
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './store.js';

let DatabaseSync = null;
async function loadSqlite() {
  // node:sqlite prints an "experimental" warning on load; hide only that one.
  const listeners = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    for (const l of listeners) l(w);
  });
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    DatabaseSync = null;
  }
}
await loadSqlite();

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export class MapStore {
  constructor(store, dir) {
    this.store = store;
    this.dir = dir;
    this.open = new Map();
  }

  list() {
    return this.store.get('maps', []);
  }

  db(id) {
    if (this.open.has(id)) return this.open.get(id);
    const m = this.list().find((x) => x.id === id);
    if (!m || !DatabaseSync) return null;
    const db = new DatabaseSync(path.join(this.dir, m.file), { readOnly: true });
    const stmt = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
    const entry = { db, stmt, type: TYPES[m.format] || 'image/png' };
    this.open.set(id, entry);
    return entry;
  }

  register(id, file, name, extra = {}) {
    if (!DatabaseSync) throw new Error('This version of Node cannot read map files (needs Node 22.13 or newer).');
    const full = path.join(this.dir, file);
    let meta = {};
    let db;
    try {
      db = new DatabaseSync(full, { readOnly: true });
      for (const row of db.prepare('SELECT name, value FROM metadata').all()) meta[row.name] = row.value;
      const one = db.prepare('SELECT zoom_level FROM tiles LIMIT 1').get();
      if (!one) throw new Error('The map file has no tiles in it.');
      if (!meta.minzoom || !meta.maxzoom) {
        const z = db.prepare('SELECT MIN(zoom_level) AS lo, MAX(zoom_level) AS hi FROM tiles').get();
        meta.minzoom ??= z.lo;
        meta.maxzoom ??= z.hi;
      }
    } catch (err) {
      throw new Error(/no such table/i.test(err.message) || /not a database/i.test(err.message)
        ? 'That file is not an MBTiles map.' : err.message);
    } finally {
      try { db?.close(); } catch {}
    }
    const format = String(meta.format || 'png').toLowerCase();
    if (format === 'pbf' || format === 'mvt') {
      throw new Error('This is a vector map (.pbf tiles). LASTSYNC currently shows raster maps (PNG, JPG or WebP tiles).');
    }
    const bounds = String(meta.bounds || '').split(',').map(Number);
    const entry = {
      id,
      file,
      name: name || meta.name || 'Regional map',
      format,
      size: fs.statSync(full).size,
      minzoom: Number(meta.minzoom),
      maxzoom: Number(meta.maxzoom),
      bounds: bounds.length === 4 && bounds.every(Number.isFinite) ? bounds : null,
      attribution: meta.attribution ? String(meta.attribution).replace(/<[^>]+>/g, '').slice(0, 300) : '',
      addedAt: nowIso(),
      ...extra,
    };
    this.store.update('maps', [], (l) => { l.push(entry); });
    return entry;
  }

  remove(id) {
    const m = this.list().find((x) => x.id === id);
    if (!m) return;
    const open = this.open.get(id);
    if (open) { try { open.db.close(); } catch {} this.open.delete(id); }
    fs.rmSync(path.join(this.dir, m.file), { force: true });
    this.store.update('maps', [], (l) => l.filter((x) => x.id !== id));
  }

  tile(id, z, x, y) {
    if (![z, x, y].every(Number.isInteger)) return null;
    const e = this.db(id);
    if (!e) return null;
    const row = e.stmt.get(z, x, (1 << z) - 1 - y); // MBTiles rows count from the bottom
    return row ? { data: Buffer.from(row.tile_data), type: e.type } : null;
  }
}
