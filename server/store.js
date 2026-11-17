// Small JSON file store. Every write goes to a temp file first and is then
// renamed, so a power cut mid-write never leaves a half-written file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
  }

  file(name) {
    return path.join(this.dir, name + '.json');
  }

  get(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let value = fallback;
    try {
      value = JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a copy of an unreadable file instead of silently losing it.
        try { fs.copyFileSync(this.file(name), this.file(name) + '.corrupt-' + Date.now()); } catch {}
      }
      value = structuredClone(fallback);
    }
    this.cache.set(name, value);
    return value;
  }

  set(name, value) {
    this.cache.set(name, value);
    const target = this.file(name);
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
    return value;
  }

  update(name, fallback, fn) {
    const current = this.get(name, fallback);
    const next = fn(current) ?? current;
    return this.set(name, next);
  }
}

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('base64url');
}

export function nowIso() {
  return new Date().toISOString();
}
