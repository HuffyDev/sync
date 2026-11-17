// Online demo host (Replit or any server). The offline app trusts "whoever is
// sitting at this PC"; online there is no such person, so instead:
//  - every visitor gets a private workspace, owned through a secret cookie;
//  - people they invite to a group join that workspace as guests via a link;
//  - workspaces are deleted after a week of inactivity, and disk use is capped.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp, APP_DIR } from './index.js';

const ROOT = path.resolve(process.env.LASTSYNC_DATA || path.join(APP_DIR, 'data', 'public'));
const PORT = Number(process.env.PORT) || 8787;
const TTL_MS = (Number(process.env.LASTSYNC_TTL_DAYS) || 7) * 864e5;
const MAX_WORKSPACES = Number(process.env.LASTSYNC_MAX_WORKSPACES) || 500;
const MAX_LIVE = Number(process.env.LASTSYNC_MAX_LIVE) || 80;
const QUOTA = (Number(process.env.LASTSYNC_QUOTA_MB) || 200) * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{12}$/;
const UPLOADS = new Set(['/api/library/upload', '/api/maps/upload', '/api/packs/inspect', '/api/routes/gpx']);
const GUEST_PATHS = /^\/(join(\.html|\.js)?$|api\/group\/|api\/public\/|api\/maps$|tiles\/)/;

fs.mkdirSync(ROOT, { recursive: true });
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const live = new Map(); // id -> { app, lastUsed }
const created = new Map(); // ip -> [timestamps]

function wsDir(id) { return path.join(ROOT, id); }
function readMeta(id) {
  if (!ID_RE.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(wsDir(id), 'workspace.json'), 'utf8')); } catch { return null; }
}
function writeMeta(meta) {
  fs.mkdirSync(wsDir(meta.id), { recursive: true });
  fs.writeFileSync(path.join(wsDir(meta.id), 'workspace.json'), JSON.stringify(meta));
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const origin = (req) => `${isHttps(req) ? 'https' : 'http'}://${String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim()}`;
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function cookie(req, name, value, maxAgeSec) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}
function addCookie(res, c) {
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(prev ? [].concat(prev) : []), c]);
}

function ownerWorkspace(req) {
  const raw = cookies(req).ls_owner || '';
  const [id, secret] = raw.split('.');
  if (!id || !secret) return null;
  const meta = readMeta(id);
  if (!meta) return null;
  const a = sha(secret);
  const b = Buffer.from(meta.secretHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

function createWorkspace(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (created.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= 30) return null;
  recent.push(now);
  created.set(ip, recent);
  const id = crypto.randomBytes(9).toString('base64url');
  const secret = crypto.randomBytes(24).toString('base64url');
  writeMeta({ id, secretHash: sha(secret).toString('hex'), createdAt: new Date().toISOString(), lastUsed: now });
  return { id, secret };
}

function appFor(id) {
  let entry = live.get(id);
  if (!entry) {
    const app = createApp({
      dataDir: path.join(wsDir(id), 'data'),
      port: PORT,
      publicMode: true,
      noServer: true,
      isOwner: (req) => req.lsOwner === true,
      inviteUrl: (req, code) => `${origin(req)}/join?ws=${id}#code=${code}`,
    });
    entry = { app, lastUsed: Date.now(), touchedMeta: 0 };
    live.set(id, entry);
    evictLive();
  }
  entry.lastUsed = Date.now();
  if (entry.lastUsed - entry.touchedMeta > 10 * 60e3) {
    entry.touchedMeta = entry.lastUsed;
    const meta = readMeta(id);
    if (meta) { meta.lastUsed = entry.lastUsed; writeMeta(meta); }
  }
  return entry.app;
}

function evictLive() {
  if (live.size <= MAX_LIVE) return;
  const idle = [...live.entries()].filter(([, e]) => e.app.group.clients.size === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [id] of idle.slice(0, live.size - MAX_LIVE)) live.delete(id);
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch {} }
  }
  return total;
}

// A request that carries no workspace (e.g. a stylesheet fetched before the
// cookie exists) is answered by an empty, guest-only workspace.
let blank = null;
function blankApp() {
  if (!blank) blank = createApp({ dataDir: path.join(ROOT, '_blank'), port: PORT, publicMode: true, noServer: true, isOwner: () => false });
  return blank;
}

function sweep() {
  const now = Date.now();
  let metas = [];
  for (const id of fs.readdirSync(ROOT)) {
    const m = readMeta(id);
    if (m) metas.push(m);
  }
  const drop = (id) => { live.delete(id); fs.rmSync(wsDir(id), { recursive: true, force: true }); };
  for (const m of metas) if (now - (live.get(m.id)?.lastUsed || m.lastUsed) > TTL_MS) drop(m.id);
  metas = metas.filter((m) => fs.existsSync(wsDir(m.id))).sort((a, b) => a.lastUsed - b.lastUsed);
  while (metas.length > MAX_WORKSPACES) drop(metas.shift().id);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  let ownerId = ownerWorkspace(req);
  let guestId = cookies(req).ls_guest;
  if (guestId && !readMeta(guestId)) guestId = null;

  // Invite links: /join?ws=<id>#code=...
  const wsParam = url.searchParams.get('ws');
  if (pathname === '/join' && wsParam) {
    if (!readMeta(wsParam)) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:24px">This group link has expired. Ask for a new one.</body>');
    }
    if (wsParam !== ownerId) {
      guestId = wsParam;
      addCookie(res, cookie(req, 'ls_guest', wsParam, 30 * 86400));
    }
  }

  let target = null;
  let asOwner = false;
  if (guestId && guestId !== ownerId && (GUEST_PATHS.test(pathname) || !ownerId)) target = guestId;
  else if (ownerId) { target = ownerId; asOwner = true; }
  else if (guestId) target = guestId;
  else if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const ws = createWorkspace(req);
    if (!ws) return send(res, 429, { error: 'Too many new sessions from your network. Try again later.' });
    addCookie(res, cookie(req, 'ls_owner', `${ws.id}.${ws.secret}`, Math.round(TTL_MS / 1000)));
    target = ws.id;
    asOwner = true;
  }

  if (asOwner && req.method === 'POST' && UPLOADS.has(pathname) && dirSize(wsDir(target)) > QUOTA) {
    req.resume();
    return send(res, 413, { error: `The online demo keeps at most ${Math.round(QUOTA / 1048576)} MB per visitor. Delete something, or download the offline app.` });
  }

  req.lsOwner = asOwner;
  const app = target ? appFor(target) : blankApp();
  return app.handle(req, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
  });
});
server.requestTimeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`LASTSYNC online demo on port ${PORT} (workspaces in ${ROOT})`);
});
sweep();
setInterval(sweep, 3600e3).unref();
