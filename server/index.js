// LASTSYNC server. Runs entirely on this PC with no internet.
//
// Access rules:
//  - The person at this PC (requests from localhost) gets the whole app.
//  - Phones on the local Wi-Fi only get the group pages, the bundled survival
//    guides and the map tiles, and only after joining with the invite code.
//    They never see notes, the household plan, documents or settings.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

import { Store, newId, nowIso } from './store.js';
import { loadGuides, plainText, slug } from './guides.js';
import { SearchIndex } from './search.js';
import { ask, retrieve, URGENT_NOTE } from './ask.js';
import { Wiki } from './wiki.js';
import { VectorTiles, glyphs } from './vtiles.js';
import { sourceManifest, readSourceFile } from './source.js';
import { Relay, decodeTx, RELAY_HOSTS } from './relay.js';
import { KIT, KIT_CATEGORIES, kitSummary } from './kit.js';
import { Group, httpError } from './group.js';
import * as packs from './packs.js';
import { MapStore } from './maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

export function createApp(opts = {}) {
  const WEB_DIR = path.join(APP_DIR, 'web');
  const CONTENT_DIR = opts.contentDir || path.join(APP_DIR, 'content');
  const DATA_DIR = opts.dataDir || process.env.LASTSYNC_DATA || path.join(APP_DIR, 'data');
  const port = opts.port ?? 8787;
  // Public mode = the online demo (e.g. on Replit). Each visitor gets their own
  // workspace (see server/public.js); uploads are capped and the AI-model
  // setting is off, because a model address typed by a visitor would let them
  // make this server call arbitrary URLs.
  const publicMode = !!opts.publicMode;
  const LIMITS = publicMode
    ? { doc: 25 * 1024 * 1024, map: 100 * 1024 * 1024, pack: 100 * 1024 * 1024 }
    : { doc: 1024 * 1024 * 1024, map: 64 * 1024 * 1024 * 1024, pack: 64 * 1024 * 1024 * 1024 };
  const DOWNLOAD_URL = process.env.LASTSYNC_DOWNLOAD_URL || 'https://github.com/HuffyDev/sync/releases/latest';

  const dirs = {
    library: path.join(DATA_DIR, 'library', 'files'),
    libraryText: path.join(DATA_DIR, 'library', 'text'),
    maps: path.join(DATA_DIR, 'maps'),
    packs: path.join(DATA_DIR, 'packs'),
    exports: path.join(DATA_DIR, 'exports'),
    uploads: path.join(DATA_DIR, 'uploads'),
    keys: path.join(DATA_DIR, 'keys'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  // Leftover uploads from a previous run are never needed.
  for (const f of fs.readdirSync(dirs.uploads)) fs.rmSync(path.join(dirs.uploads, f), { force: true });

  const store = new Store(DATA_DIR);
  const group = new Group(store);
  const maps = new MapStore(store, dirs.maps);
  // The encyclopedia is the same for everyone, so the online demo shares one copy.
  const wiki = opts.wiki || new Wiki(opts.wikiDir || path.join(DATA_DIR, 'wiki'));
  // Street map tile cache — also shared between visitors in the online demo.
  const vt = opts.vt || new VectorTiles(path.join(DATA_DIR, 'streetmap'));
  const glyph = glyphs(CONTENT_DIR);
  // Offline crypto relay: carries transactions you already signed; never holds keys.
  const relay = new Relay(store, () => group.broadcast('relay', {}));
  const relayOrigins = Object.values(RELAY_HOSTS).map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter(Boolean).join(' ');

  const defaults = {
    settings: { hostName: '', ai: { provider: 'builtin', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', apiKey: '', timeoutSec: 90 }, pinned: [], printedAt: null, planUpdatedAt: null },
    plan: { contacts: [], meetingPoints: [], responsibilities: [], checklist: [] },
  };
  const get = (name, fb = []) => store.get(name, fb);

  // ---------- guides & search index ----------
  let guides = new Map();
  let index = new SearchIndex([]);
  let dirty = true;

  function reloadGuides() {
    const installed = get('packs');
    const sources = [{ dir: path.join(CONTENT_DIR, 'guides'), pack: 'Starter library' }];
    for (const p of installed) sources.push({ dir: path.join(dirs.packs, p.dir, 'guides'), pack: p.name });
    guides = loadGuides(sources);
    dirty = true;
  }
  reloadGuides();

  function docPages(doc) {
    try { return JSON.parse(fs.readFileSync(path.join(dirs.libraryText, doc.id + '.json'), 'utf8')); } catch { return []; }
  }

  function buildUnits() {
    const units = [];
    for (const g of guides.values()) {
      const base = { kind: 'guide', title: g.title, topic: g.topic, pack: g.pack, fileType: 'guide', public: true };
      if (g.intro) units.push({ ...base, id: `guide:${g.id}#`, subtitle: 'Overview', text: plainText(g.intro), ref: { guide: g.id } });
      for (const s of g.sections) units.push({ ...base, id: `guide:${g.id}#${s.id}`, subtitle: s.heading, text: s.text, md: s.markdown, ref: { guide: g.id, section: s.id } });
    }
    for (const d of get('library')) {
      docPages(d).forEach((text, i) => {
        if (!text.trim()) return;
        units.push({
          id: `doc:${d.id}#${i}`, kind: 'doc', title: d.title, subtitle: d.type === 'pdf' ? `Page ${i + 1}` : `Part ${i + 1}`,
          text, topic: d.topic || 'documents', pack: d.pack || 'My files', fileType: d.type, ref: { doc: d.id, page: i + 1 },
        });
      });
    }
    for (const n of get('notes')) {
      units.push({ id: `note:${n.id}`, kind: 'note', title: n.title || 'Untitled note', subtitle: 'Note', text: n.body || '', topic: n.topic || 'notes', pack: n.pack || 'My notes', fileType: 'note', ref: { note: n.id } });
    }
    for (const p of get('pins')) {
      units.push({ id: `pin:${p.id}`, kind: 'pin', title: p.name, subtitle: categoryLabel(p.category), text: `${p.name}. ${categoryLabel(p.category)}. ${p.note || ''}`, topic: 'maps', pack: p.pack || 'My map', fileType: 'pin', ref: { pin: p.id, lat: p.lat, lon: p.lon } });
    }
    for (const r of get('routes')) {
      units.push({ id: `route:${r.id}`, kind: 'route', title: r.name, subtitle: 'Saved route', text: `${r.name}. ${r.note || ''}`, topic: 'maps', pack: r.pack || 'My map', fileType: 'route', ref: { route: r.id } });
    }
    const plan = get('plan', defaults.plan);
    for (const m of plan.meetingPoints) {
      units.push({ id: `plan:mp:${m.id}`, kind: 'plan', title: m.name, subtitle: 'Meeting point', text: `Meeting point ${m.name}. ${m.address || ''} ${m.note || ''}`, topic: 'plan', pack: 'My plan', fileType: 'plan', ref: { plan: 'meeting', lat: m.lat, lon: m.lon } });
    }
    for (const c of plan.contacts) {
      units.push({ id: `plan:c:${c.id}`, kind: 'plan', title: c.name, subtitle: 'Contact', text: `${c.name} ${c.relation || ''} ${c.phone || ''} ${c.note || ''}`, topic: 'plan', pack: 'My plan', fileType: 'plan', ref: { plan: 'contacts' } });
    }
    for (const meta of Object.values(wiki.index())) {
      const art = wiki.article(meta.id);
      if (!art) continue;
      art.sections.forEach((sec, i) => {
        units.push({ id: `wiki:${art.id}#${i}`, kind: 'wiki', title: art.title, subtitle: sec.heading, text: sec.text.replace(/^### /gm, ''), md: sec.text,
          topic: art.topic, pack: 'Wikipedia', fileType: 'wiki', public: true, ref: { wiki: art.id, section: i } });
      });
    }
    return units;
  }

  let wikiVersion = -1;
  function getIndex() {
    if (wiki.version !== wikiVersion) { wikiVersion = wiki.version; dirty = true; }
    if (dirty) { index = new SearchIndex(buildUnits()); dirty = false; }
    return index;
  }
  const markDirty = () => { dirty = true; };

  function filterFrom(q, guestOnly) {
    return (u) => {
      if (guestOnly && !u.public) return false;
      if (q.topic && u.topic !== q.topic) return false;
      if (q.pack && u.pack !== q.pack) return false;
      if (q.type && u.fileType !== q.type) return false;
      return true;
    };
  }

  function guideList() {
    return [...guides.values()].map((g) => ({
      id: g.id, title: g.title, topic: g.topic, publisher: g.publisher, date: g.date, version: g.version,
      sources: g.sources, summary: g.summary, pack: g.pack, sections: g.sections.map((s) => ({ id: s.id, heading: s.heading })),
    })).sort((a, b) => a.title.localeCompare(b.title));
  }

  function guideFull(id) {
    const g = guides.get(id);
    if (!g) throw httpError(404, 'Guide not found');
    const { file, ...rest } = g;
    return { ...rest, sections: g.sections.map(({ text, ...s }) => s) };
  }

  // ---------- readiness ----------
  function lanAddresses() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
    return out;
  }

  function readiness() {
    const checks = [];
    const add = (c) => checks.push(c);
    const gl = guideList();
    const topics = new Set(gl.map((g) => g.topic));
    const core = ['water', 'first-aid', 'power', 'food'];
    const missingCore = core.filter((t) => !topics.has(t));
    add({ id: 'guides', group: 'Library', label: `${gl.length} survival guides saved`, ok: missingCore.length === 0,
      detail: missingCore.length ? `Missing topics: ${missingCore.join(', ')}` : `Topics: ${[...topics].sort().join(', ')}`, href: '#/library' });
    const docs = get('library');
    add({ id: 'docs', group: 'Library', label: docs.length ? `${docs.length} of your own documents` : 'No documents of your own yet', ok: docs.length > 0, optional: true,
      detail: docs.length ? `${docs.filter((d) => d.type === 'pdf').length} PDFs, ${docs.filter((d) => d.type !== 'pdf').length} text files` : 'Add manuals, PDFs or local info (shelters, water points) before an outage.', href: '#/library' });
    const ml = maps.list();
    const areas = vt.areas();
    const nMaps = ml.length + areas.length;
    add({ id: 'maps', group: 'Maps', label: nMaps ? `${nMaps} map area${nMaps > 1 ? 's' : ''} saved for offline use` : 'No street map saved for offline use', ok: nMaps > 0,
      detail: nMaps ? [...areas.map((a) => `${a.name} (street map, ${fmtBytes(a.bytes)})`), ...ml.map((m) => `${m.name} (zoom ${m.minzoom}–${m.maxzoom}, ${fmtBytes(m.size)})`)].join('; ') : 'Open Maps while online, frame your town and press “Save this area offline”.', href: '#/map' });
    const pins = get('pins');
    const routes = get('routes');
    add({ id: 'pins', group: 'Maps', label: `${pins.length} pins, ${routes.length} saved routes`, ok: pins.length > 0 && routes.length > 0, optional: routes.length === 0 && pins.length > 0,
      detail: routes.length ? 'Routes are ready to show offline.' : 'Save at least one route to your meeting point (draw it or import a GPX file).', href: '#/map' });
    const s = get('settings', defaults.settings);
    const ai = s.ai || {};
    add({ id: 'ai', group: 'Ask LASTSYNC', label: ai.provider === 'openai' ? `AI model set: ${ai.model}` : 'Built-in answers ready (no model needed)', ok: true,
      detail: ai.provider === 'openai'
        ? (/localhost|127\.0\.0\.1/.test(ai.baseUrl || '') ? 'Local model — works offline if it is installed and running. Use “Test model” in Settings.' : 'Online model — will NOT work once the internet is down. Ask falls back to built-in answers.')
        : 'Ask answers from your saved guides with citations. Add a local model in Settings for fuller answers.', href: '#/settings' });
    const plan = get('plan', defaults.plan);
    const planOk = plan.contacts.length > 0 && plan.meetingPoints.length > 0 && plan.checklist.length >= 3;
    const planMissing = [];
    if (!plan.contacts.length) planMissing.push('a contact');
    if (!plan.meetingPoints.length) planMissing.push('a meeting point');
    if (plan.checklist.length < 3) planMissing.push('a grab-and-go checklist');
    add({ id: 'plan', group: 'Household plan', label: planOk ? 'Household plan filled in' : 'Household plan incomplete', ok: planOk,
      detail: planOk ? `${plan.contacts.length} contacts, ${plan.meetingPoints.length} meeting points, ${plan.checklist.length} checklist items` : `Add ${planMissing.join(', ')}.`, href: '#/plan' });
    const printedOk = s.printedAt && (!s.planUpdatedAt || s.printedAt >= s.planUpdatedAt);
    add({ id: 'print', group: 'Household plan', label: printedOk ? 'Paper copy is up to date' : s.printedAt ? 'Plan changed since you last printed' : 'Survival sheet never printed', ok: !!printedOk,
      detail: 'Print a paper copy in case the laptop runs out of power.', href: '#/print' });
    const installed = get('packs');
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString();
    for (const p of installed) {
      add({ id: 'pack:' + p.id, group: 'Packs', label: `${p.name} (v${p.version})`, ok: p.status === 'verified' || p.status === 'unsigned' || p.status === 'signed-untrusted',
        optional: true, detail: `${statusLabel(p.status)} · published ${String(p.published).slice(0, 10)}${p.published < yearAgo ? ' — over a year old, look for an update' : ''}`, href: '#/packs' });
    }
    const lan = publicMode ? [{ address: 'online demo' }] : lanAddresses();
    add({ id: 'net', group: 'Group', label: lan.length ? 'Can host a group on local Wi-Fi' : 'Not connected to any local network', ok: lan.length > 0, optional: true,
      detail: lan.length ? `Phones can reach this PC at ${lan.map((a) => a.address).join(', ')}` : 'To host a group, connect to a router (it works without internet) or turn on a Wi-Fi hotspot.', href: '#/group' });
    const ws = wiki.status();
    add({ id: 'wiki', group: 'Library', label: `${ws.saved} of ${ws.total} encyclopedia articles saved`, ok: ws.saved >= ws.total * 0.8, optional: ws.saved === 0 && publicMode,
      detail: ws.saved < ws.total ? 'Download the offline encyclopedia while you still have internet.' : 'Survival-relevant Wikipedia articles are on this PC.', href: '#/wiki' });
    const ks = kitSummary(get('kit', { have: {} }).have || {});
    add({ id: 'kit', group: 'Gear', label: `${ks.covered} of ${ks.essentials} essential supplies`, ok: ks.covered === ks.essentials,
      detail: ks.covered === ks.essentials ? 'All essential gear ticked off.' : 'Tick off what you own and see what is still missing.', href: '#/kit' });
    let free = null;
    try { const st = fs.statfsSync(DATA_DIR); free = st.bavail * st.bsize; } catch {}
    const scored = checks.filter((c) => !c.optional);
    const score = scored.length ? Math.round((100 * scored.filter((c) => c.ok).length) / scored.length) : 100;
    return { score, checks, freeBytes: free, dataDir: DATA_DIR };
  }

  // ---------- packs ----------
  function trustedKeys() {
    const official = (() => { try { return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'trusted-keys.json'), 'utf8')); } catch { return []; } })();
    return [...official.map((k) => ({ ...k, official: true })), ...get('trustedKeys')];
  }

  function publisherKey() {
    try { return JSON.parse(fs.readFileSync(path.join(dirs.keys, 'publisher.json'), 'utf8')); } catch { return null; }
  }

  function exportable() {
    const plan = get('plan', defaults.plan);
    return {
      guides: guideList().map((g) => ({ id: g.id, name: g.title, detail: g.pack })),
      docs: get('library').map((d) => ({ id: d.id, name: d.title, detail: `${d.type.toUpperCase()} · ${fmtBytes(d.size)}` })),
      notes: get('notes').map((n) => ({ id: n.id, name: n.title || 'Untitled note', detail: (n.body || '').slice(0, 60) })),
      pins: get('pins').map((p) => ({ id: p.id, name: p.name, detail: categoryLabel(p.category) })),
      meetingPoints: plan.meetingPoints.filter((m) => m.lat != null).map((m) => ({ id: m.id, name: m.name, detail: 'Meeting point' })),
      routes: get('routes').map((r) => ({ id: r.id, name: r.name, detail: `${r.points.length} points` })),
      maps: maps.list().map((m) => ({ id: m.id, name: m.name, detail: fmtBytes(m.size) })),
    };
  }

  async function exportPack(body) {
    const sel = body.items || {};
    const pick = (kind) => new Set(Array.isArray(sel[kind]) ? sel[kind] : []);
    const entries = [];
    for (const id of pick('guides')) {
      const g = guides.get(id);
      if (g) entries.push({ item: { type: 'guide', id: g.id, name: g.title }, file: g.file });
    }
    for (const d of get('library').filter((d) => pick('docs').has(d.id))) {
      entries.push({ item: { type: 'doc', id: d.id, name: d.title, meta: { title: d.title, type: d.type, topic: d.topic, ext: path.extname(d.file) } }, file: path.join(dirs.library, d.file) });
      entries.push({ item: { type: 'doctext', id: d.id, name: d.title + ' (text)' }, buffer: Buffer.from(JSON.stringify(docPages(d))) });
    }
    const json = (type, obj, name) => entries.push({ item: { type, id: obj.id, name }, buffer: Buffer.from(JSON.stringify(obj)) });
    for (const n of get('notes').filter((n) => pick('notes').has(n.id))) json('note', { id: n.id, title: n.title, body: n.body, topic: n.topic }, n.title || 'Note');
    for (const p of get('pins').filter((p) => pick('pins').has(p.id))) json('pin', { id: p.id, name: p.name, lat: p.lat, lon: p.lon, category: p.category, note: p.note }, p.name);
    const plan = get('plan', defaults.plan);
    for (const m of plan.meetingPoints.filter((m) => pick('meetingPoints').has(m.id) && m.lat != null)) {
      json('pin', { id: m.id, name: m.name, lat: m.lat, lon: m.lon, category: 'meeting', note: [m.address, m.note].filter(Boolean).join(' — ') }, m.name);
    }
    for (const r of get('routes').filter((r) => pick('routes').has(r.id))) json('route', { id: r.id, name: r.name, points: r.points, note: r.note }, r.name);
    for (const m of maps.list().filter((m) => pick('maps').has(m.id))) {
      entries.push({ item: { type: 'map', id: m.id, name: m.name, meta: { name: m.name } }, file: path.join(dirs.maps, m.file) });
    }
    if (!entries.length) throw httpError(400, 'Pick at least one item to put in the pack.');
    const name = String(body.name || 'My LASTSYNC pack').slice(0, 80);
    const key = body.sign ? publisherKey() : null;
    const fileName = `${slug(name) || 'pack'}-${new Date().toISOString().slice(0, 10)}-${newId().slice(0, 4)}.lspack`;
    const manifest = await packs.writePack(path.join(dirs.exports, fileName), {
      id: body.packId || newId('p_'), name, description: String(body.description || '').slice(0, 500),
      publisher: key ? key.publisher : 'Personal pack', version: String(body.version || '1'),
    }, entries, key);
    return { file: fileName, url: `/api/packs/download/${encodeURIComponent(fileName)}`, items: manifest.items.length, size: fs.statSync(path.join(dirs.exports, fileName)).size, signed: !!key };
  }

  const pendingUploads = new Map(); // uploadId -> { file, verification, at }

  async function installPack(uploadId, selected) {
    const up = pendingUploads.get(uploadId);
    if (!up) throw httpError(404, 'That pack upload has expired. Choose the file again.');
    const v = up.verification;
    if (v.status === 'invalid' || v.status === 'damaged') throw httpError(400, 'This pack failed its safety checks and cannot be installed.');
    const m = v.manifest;
    const want = Array.isArray(selected) && selected.length ? new Set(selected) : null;
    const chosen = m.items.filter((it) => !want || want.has(`${it.type}:${it.id}`) || (it.type === 'doctext' && want.has(`doc:${it.id}`)));

    // Reinstalling the same pack replaces what it installed before.
    const installedList = get('packs');
    const prev = installedList.find((p) => p.id === m.id);
    if (prev) removePackItems(prev);
    const dir = slug(m.id) || newId('p');
    const record = {
      id: m.id, dir, name: m.name, publisher: m.publisher, version: m.version, published: m.published, description: m.description,
      status: v.status, signer: v.signer, installedAt: nowIso(), items: [],
    };
    const packLabel = m.name;
    const docText = new Map();
    for (const it of chosen.filter((i) => i.type === 'doctext')) docText.set(it.id, await packs.readItemText(up.file, v.dataStart, it));
    for (const it of chosen) {
      if (it.type === 'guide') {
        const dest = path.join(dirs.packs, dir, 'guides', slug(it.id) + '.md');
        await packs.extractItem(up.file, v.dataStart, it, dest);
        record.items.push({ type: 'guide', id: slug(it.id), name: it.name });
      } else if (it.type === 'doc') {
        const id = newId('d_');
        const ext = String(it.meta?.ext || '').replace(/[^.a-z0-9]/gi, '').slice(0, 8);
        const file = id + ext;
        await packs.extractItem(up.file, v.dataStart, it, path.join(dirs.library, file));
        let pages = [];
        try { pages = JSON.parse(docText.get(it.id) || '[]'); } catch {}
        fs.writeFileSync(path.join(dirs.libraryText, id + '.json'), JSON.stringify(pages.map(String)));
        store.update('library', [], (l) => { l.push({ id, title: it.meta?.title || it.name, type: it.meta?.type === 'pdf' ? 'pdf' : 'text', topic: it.meta?.topic || '', file, size: it.size, pack: packLabel, packId: m.id, addedAt: nowIso() }); });
        record.items.push({ type: 'doc', id, name: it.name });
      } else if (['note', 'pin', 'route'].includes(it.type)) {
        let obj;
        try { obj = JSON.parse(await packs.readItemText(up.file, v.dataStart, it)); } catch { continue; }
        const id = newId(it.type[0] + '_');
        const listName = it.type + 's';
        let clean;
        if (it.type === 'note') clean = { id, title: str(obj.title, 120), body: str(obj.body, 100000), topic: str(obj.topic, 40), updatedAt: nowIso() };
        if (it.type === 'pin') { const p = cleanPin(obj); if (!p) continue; clean = { ...p, id, createdAt: nowIso() }; }
        if (it.type === 'route') { const r = cleanRoute(obj); if (!r) continue; clean = { ...r, id, createdAt: nowIso() }; }
        clean.pack = packLabel;
        clean.packId = m.id;
        store.update(listName, [], (l) => { l.push(clean); });
        record.items.push({ type: it.type, id, name: it.name });
      } else if (it.type === 'map') {
        const id = newId('map_');
        const file = id + '.mbtiles';
        await packs.extractItem(up.file, v.dataStart, it, path.join(dirs.maps, file));
        try {
          maps.register(id, file, it.meta?.name || it.name, { pack: packLabel, packId: m.id });
          record.items.push({ type: 'map', id, name: it.name });
        } catch (err) {
          fs.rmSync(path.join(dirs.maps, file), { force: true });
        }
      }
    }
    store.update('packs', [], (l) => {
      const i = l.findIndex((p) => p.id === m.id);
      if (i >= 0) l.splice(i, 1);
      l.push(record);
    });
    fs.rmSync(up.file, { force: true });
    pendingUploads.delete(uploadId);
    reloadGuides();
    return record;
  }

  function removePackItems(record) {
    for (const it of record.items) {
      if (it.type === 'doc') removeDoc(it.id);
      if (it.type === 'note') store.update('notes', [], (l) => l.filter((x) => x.id !== it.id));
      if (it.type === 'pin') store.update('pins', [], (l) => l.filter((x) => x.id !== it.id));
      if (it.type === 'route') store.update('routes', [], (l) => l.filter((x) => x.id !== it.id));
      if (it.type === 'map') maps.remove(it.id);
    }
    fs.rmSync(path.join(dirs.packs, record.dir), { recursive: true, force: true });
  }

  function removeDoc(id) {
    const doc = get('library').find((d) => d.id === id);
    if (!doc) return false;
    fs.rmSync(path.join(dirs.library, doc.file), { force: true });
    fs.rmSync(path.join(dirs.libraryText, id + '.json'), { force: true });
    store.update('library', [], (l) => l.filter((d) => d.id !== id));
    return true;
  }

  // ---------- helpers ----------
  function cleanPin(b) {
    if ([b.lat, b.lon].some((v) => v === null || v === undefined || v === '')) return null;
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { name: str(b.name, 80) || 'Pin', lat, lon, category: CATEGORIES[b.category] ? b.category : 'other', note: str(b.note, 2000) };
  }

  function cleanRoute(b) {
    const points = (Array.isArray(b.points) ? b.points : [])
      .map((p) => [Number(p[0]), Number(p[1])])
      .filter(([a, o]) => Number.isFinite(a) && Number.isFinite(o) && Math.abs(a) <= 90 && Math.abs(o) <= 180)
      .slice(0, 20000);
    if (points.length < 2) return null;
    return { name: str(b.name, 80) || 'Route', points, note: str(b.note, 2000) };
  }

  function crud(name, cleaner) {
    return {
      list: () => get(name),
      create: (b) => {
        const c = cleaner(b);
        if (!c) throw httpError(400, 'Some details are missing or invalid.');
        const item = { id: newId(name[0] + '_'), ...c, createdAt: nowIso(), updatedAt: nowIso() };
        store.update(name, [], (l) => { l.push(item); });
        markDirty();
        return item;
      },
      update: (id, b) => {
        const c = cleaner(b);
        if (!c) throw httpError(400, 'Some details are missing or invalid.');
        let out;
        store.update(name, [], (l) => {
          const i = l.findIndex((x) => x.id === id);
          if (i < 0) throw httpError(404, 'Not found');
          out = l[i] = { ...l[i], ...c, updatedAt: nowIso() };
        });
        markDirty();
        return out;
      },
      remove: (id) => {
        store.update(name, [], (l) => l.filter((x) => x.id !== id));
        unpin(name, id);
        markDirty();
        return { ok: true };
      },
    };
  }

  function unpin(kind, id) {
    store.update('settings', defaults.settings, (s) => { s.pinned = (s.pinned || []).filter((p) => !(p.id === id)); });
  }

  const notes = crud('notes', (b) => ({ title: str(b.title, 120), body: str(b.body, 100000), topic: str(b.topic, 40) }));
  const pinsApi = crud('pins', cleanPin);
  const routesApi = crud('routes', cleanRoute);

  function cleanPlan(b) {
    const arr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
    const id = (x) => (typeof x === 'string' && /^[\w-]{1,40}$/.test(x) ? x : newId());
    const num = (v, lim) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) && Math.abs(n) <= lim ? n : null; };
    return {
      contacts: arr(b.contacts, 200).map((c) => ({ id: id(c.id), name: str(c.name, 80), relation: str(c.relation, 60), phone: str(c.phone, 40), radio: str(c.radio, 60), note: str(c.note, 500), print: c.print !== false })),
      meetingPoints: arr(b.meetingPoints, 50).map((m) => ({ id: id(m.id), name: str(m.name, 80), address: str(m.address, 200), lat: num(m.lat, 90), lon: num(m.lon, 180), when: str(m.when, 200), note: str(m.note, 500), print: m.print !== false })),
      responsibilities: arr(b.responsibilities, 200).map((r) => ({ id: id(r.id), person: str(r.person, 80), task: str(r.task, 300) })),
      checklist: arr(b.checklist, 500).map((c) => ({ id: id(c.id), text: str(c.text, 200), section: ['grab', 'go', 'check'].includes(c.section) ? c.section : 'grab', done: !!c.done })),
    };
  }

  function settingsView() {
    const s = get('settings', defaults.settings);
    const ai = { ...defaults.settings.ai, ...(s.ai || {}) };
    return { ...defaults.settings, ...s, ai: { ...ai, apiKey: ai.apiKey ? '••••' + ai.apiKey.slice(-4) : '', hasKey: !!ai.apiKey } };
  }

  // ---------- HTTP plumbing ----------
  const joinAttempts = new Map();

  function isLoopback(req) {
    const a = req.socket.remoteAddress || '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  }

  function ownerRequest(req) {
    if (!isLoopback(req)) return false;
    // Block DNS-rebinding: the page must be addressed as localhost.
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        const o = new URL(origin);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(o.hostname)) return false;
      } catch { return false; }
    }
    return true;
  }

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function memberFor(req, owner) {
    // A joined member's cookie wins even on this PC (e.g. testing the phone
    // page here); it can only ever narrow what the request may see.
    const m = group.memberForToken(cookies(req).ls_member);
    if (m) { group.touch(m.id); return m.id; }
    if (owner) return group.active ? 'host' : null;
    return null;
  }

  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(data);
  }

  async function readJson(req, limit = 20 * 1024 * 1024) {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('application/json')) throw httpError(415, 'Expected JSON');
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw httpError(413, 'That is too large.');
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw httpError(400, 'Invalid JSON'); }
  }

  async function readText(req, limit) {
    let size = 0;
    const chunks = [];
    for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, 'That file is too large.'); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function saveUpload(req, dest, limit) {
    let size = 0;
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    try {
      await pipeline(req, async function* (src) {
        for await (const c of src) {
          size += c.length;
          if (size > limit) throw httpError(413, 'That file is too large.');
          yield c;
        }
      }, out);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    if (!size) { fs.rmSync(tmp, { force: true }); throw httpError(400, 'The file is empty.'); }
    fs.renameSync(tmp, dest);
    return size;
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  };
  const GUEST_STATIC = /^\/(welcome\.html|landing\.js|relay-anim\.js|join\.html|join\.js|shared\.js|nmea\.js|manifest\.webmanifest|icon-(?:192|512)\.png|logo(?:-64)?\.png|vendor\/fonts\/[\w.-]+|styles\.css|icon\.svg|vendor\/leaflet\/[\w.-]+(?:\/[\w.-]+)?|vendor\/countries-(?:110m|50m|10m)\.json|vendor\/topojson-client\.min\.js|basemap\.js)$/;

  async function serveStatic(req, res, pathname, owner) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    if (rel === '/join') rel = '/join.html';
    if (rel === '/welcome') rel = '/welcome.html';
    if (!owner && rel === '/index.html') {
      // Phones that open the bare address go to the join page.
      res.writeHead(302, { location: '/join' });
      return res.end();
    }
    if (!owner && !GUEST_STATIC.test(rel)) return send(res, 404, 'Not found');
    const file = path.normalize(path.join(WEB_DIR, rel));
    if (!file.startsWith(WEB_DIR + path.sep)) return send(res, 403, 'Forbidden');
    let st;
    try { st = await fsp.stat(file); } catch { return send(res, 404, 'Not found'); }
    if (!st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function serveFile(req, res, file, type, downloadName) {
    let st;
    try { st = fs.statSync(file); } catch { return send(res, 404, 'Not found'); }
    const headers = { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache', 'accept-ranges': 'bytes' };
    if (downloadName) headers['content-disposition'] = `attachment; filename="${downloadName.replace(/[^\w.-]/g, '_')}"`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && !downloadName) {
      const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= 0 && start <= end) {
        res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}` });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }

  // ---------- routes ----------
  // access: 'owner' (this PC only), 'member' (anyone who joined the group, incl. host), 'open' (anyone on the network)
  const routes = [];
  const route = (method, pattern, accessSpec, handler) => {
    // "owner:raw" marks upload routes that read the request body themselves.
    const [access, raw] = accessSpec.split(':');
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, access, raw: raw === 'raw', handler });
  };

  // status & dashboard
  route('GET', '/api/status', 'owner', () => ({ version: VERSION, guides: guides.size, lan: publicMode ? [] : lanAddresses(), port, group: group.active, dataDir: publicMode ? 'your browser session on this demo server' : DATA_DIR, mode: publicMode ? 'public' : 'local', downloadUrl: DOWNLOAD_URL }));
  route('GET', '/api/dashboard', 'owner', () => {
    const r = readiness();
    const plan = get('plan', defaults.plan);
    return {
      readiness: { score: r.score, todo: r.checks.filter((c) => !c.ok && !c.optional).map((c) => ({ label: c.label, detail: c.detail, href: c.href })) },
      pinned: get('settings', defaults.settings).pinned || [],
      topics: [...new Set(guideList().map((g) => g.topic))],
      guides: guideList().map(({ sections, ...g }) => g),
      meetingPoints: plan.meetingPoints,
      wiki: { saved: wiki.status().saved, total: wiki.status().total },
      kit: kitSummary(get('kit', { have: {} }).have || {}),
      maps: maps.list().length + vt.areas().length,
      relay: relay.view().counts,
      group: group.active ? { name: group.state.session.name, members: group.roster().length, help: group.state.messages.filter((m) => m.type === 'help').slice(-3) } : null,
    };
  });

  // search & ask
  route('GET', '/api/search', 'owner', ({ query }) => {
    if (!query.q) return { results: [], facets: { topic: {}, pack: {}, type: {} } };
    return getIndex().search(String(query.q).slice(0, 300), { filter: filterFrom(query, false), limit: 40 });
  });
  route('POST', '/api/ask', 'owner', async ({ body }) => ask(getIndex(), get('settings', defaults.settings), body.question, { filter: body.scope === 'guides' ? (u) => u.public : undefined }));

  // guides (open to members too, via /api/public)
  route('GET', '/api/guides', 'owner', () => guideList());
  route('GET', '/api/guides/:id', 'owner', ({ params }) => guideFull(params.id));
  route('GET', '/api/public/guides', 'member', () => guideList());
  route('GET', '/api/public/guides/:id', 'member', ({ params }) => guideFull(params.id));
  route('GET', '/api/public/search', 'member', ({ query }) => {
    if (!query.q) return { results: [] };
    return getIndex().search(String(query.q).slice(0, 300), { filter: filterFrom(query, true), limit: 20 });
  });
  route('POST', '/api/public/ask', 'member', async ({ body, member }) => {
    if (!group.allow('ask:' + member)) throw httpError(429, 'Too many questions in a minute. Wait a moment.');
    return ask(getIndex(), get('settings', defaults.settings), body.question, { filter: (u) => u.public });
  });

  // library (your own documents)
  route('GET', '/api/library', 'owner', () => get('library'));
  route('GET', '/api/library/:id', 'owner', ({ params }) => {
    const d = get('library').find((x) => x.id === params.id);
    if (!d) throw httpError(404, 'Document not found');
    return { ...d, pages: docPages(d) };
  });
  route('POST', '/api/library/upload', 'owner:raw', async ({ req, query }) => {
    const type = query.type === 'pdf' ? 'pdf' : 'text';
    const id = newId('d_');
    const ext = type === 'pdf' ? '.pdf' : (String(query.ext || '.txt').match(/^\.(txt|md|markdown)$/i)?.[0] || '.txt');
    const file = id + ext.toLowerCase();
    const size = await saveUpload(req, path.join(dirs.library, file), LIMITS.doc);
    if (type === 'pdf') {
      const head = Buffer.alloc(5);
      const fd = fs.openSync(path.join(dirs.library, file), 'r');
      fs.readSync(fd, head, 0, 5, 0);
      fs.closeSync(fd);
      if (head.toString() !== '%PDF-') { fs.rmSync(path.join(dirs.library, file), { force: true }); throw httpError(400, 'That file is not a PDF.'); }
    }
    let pages = [];
    if (type === 'text') pages = chunkText(fs.readFileSync(path.join(dirs.library, file), 'utf8'));
    fs.writeFileSync(path.join(dirs.libraryText, id + '.json'), JSON.stringify(pages));
    const doc = { id, title: str(query.title, 160) || 'Untitled', type, topic: slug(query.topic || '') , file, size, pack: 'My files', addedAt: nowIso() };
    store.update('library', [], (l) => { l.push(doc); });
    markDirty();
    return doc;
  });
  route('PUT', '/api/library/:id/text', 'owner', async ({ params, body }) => {
    const d = get('library').find((x) => x.id === params.id);
    if (!d) throw httpError(404, 'Document not found');
    const pages = (Array.isArray(body.pages) ? body.pages : []).slice(0, 5000).map((p) => String(p).slice(0, 50000));
    fs.writeFileSync(path.join(dirs.libraryText, d.id + '.json'), JSON.stringify(pages));
    store.update('library', [], (l) => { const x = l.find((y) => y.id === d.id); x.pageCount = pages.length; x.textChars = pages.join('').length; });
    markDirty();
    return { ok: true, pages: pages.length };
  });
  route('PUT', '/api/library/:id', 'owner', async ({ params, body }) => {
    let out;
    store.update('library', [], (l) => {
      const x = l.find((y) => y.id === params.id);
      if (!x) throw httpError(404, 'Document not found');
      if (body.title !== undefined) x.title = str(body.title, 160) || x.title;
      if (body.topic !== undefined) x.topic = slug(body.topic);
      out = x;
    });
    markDirty();
    return out;
  });
  route('DELETE', '/api/library/:id', 'owner', ({ params }) => { removeDoc(params.id); unpin('library', params.id); markDirty(); return { ok: true }; });
  route('GET', '/files/library/:id', 'owner', ({ req, res, params }) => {
    const d = get('library').find((x) => x.id === params.id);
    if (!d) throw httpError(404, 'Document not found');
    serveFile(req, res, path.join(dirs.library, d.file), d.type === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');
    return undefined;
  });

  // notes, pins, routes
  route('GET', '/api/notes', 'owner', () => notes.list());
  route('POST', '/api/notes', 'owner', ({ body }) => notes.create(body));
  route('PUT', '/api/notes/:id', 'owner', ({ params, body }) => notes.update(params.id, body));
  route('DELETE', '/api/notes/:id', 'owner', ({ params }) => notes.remove(params.id));
  route('GET', '/api/pins', 'owner', () => pinsApi.list());
  route('POST', '/api/pins', 'owner', ({ body }) => pinsApi.create(body));
  route('PUT', '/api/pins/:id', 'owner', ({ params, body }) => pinsApi.update(params.id, body));
  route('DELETE', '/api/pins/:id', 'owner', ({ params }) => pinsApi.remove(params.id));
  route('GET', '/api/routes', 'owner', () => routesApi.list());
  route('POST', '/api/routes', 'owner', ({ body }) => routesApi.create(body));
  route('PUT', '/api/routes/:id', 'owner', ({ params, body }) => routesApi.update(params.id, body));
  route('DELETE', '/api/routes/:id', 'owner', ({ params }) => routesApi.remove(params.id));
  route('POST', '/api/routes/gpx', 'owner:raw', async ({ req, query }) => {
    const parsed = parseGpx(await readText(req, 50 * 1024 * 1024), str(query.name, 80));
    if (!parsed.routes.length && !parsed.pins.length) throw httpError(400, 'No routes, tracks or waypoints found in that GPX file.');
    const made = { routes: parsed.routes.map((r) => routesApi.create(r)), pins: parsed.pins.map((p) => pinsApi.create(p)) };
    return made;
  });

  // maps
  route('GET', '/api/maps', 'member', () => maps.list().map(({ file, ...m }) => m));
  route('POST', '/api/maps/upload', 'owner:raw', async ({ req, query }) => {
    const id = newId('map_');
    const file = id + '.mbtiles';
    await saveUpload(req, path.join(dirs.maps, file), LIMITS.map);
    try {
      return maps.register(id, file, str(query.name, 80));
    } catch (err) {
      fs.rmSync(path.join(dirs.maps, file), { force: true });
      throw httpError(400, err.message);
    }
  });
  route('DELETE', '/api/maps/:id', 'owner', ({ params }) => { maps.remove(params.id); return { ok: true }; });
  route('GET', '/tiles/:id/:z/:x/:y', 'member', ({ res, params }) => {
    const t = maps.tile(params.id, Number(params.z), Number(params.x), parseInt(params.y, 10));
    if (!t) { res.writeHead(204, { 'cache-control': 'max-age=3600' }); res.end(); return undefined; }
    res.writeHead(200, { 'content-type': t.type, 'cache-control': 'max-age=86400', 'content-length': t.data.length });
    res.end(t.data);
    return undefined;
  });

  // plan & settings
  route('GET', '/api/plan', 'owner', () => get('plan', defaults.plan));
  route('PUT', '/api/plan', 'owner', ({ body }) => {
    const p = store.set('plan', cleanPlan(body));
    store.update('settings', defaults.settings, (s) => { s.planUpdatedAt = nowIso(); });
    markDirty();
    return p;
  });
  route('POST', '/api/plan/printed', 'owner', () => { store.update('settings', defaults.settings, (s) => { s.printedAt = nowIso(); }); return { ok: true }; });
  route('GET', '/api/settings', 'owner', () => settingsView());
  route('PUT', '/api/settings', 'owner', ({ body }) => {
    store.update('settings', defaults.settings, (s) => {
      if (body.hostName !== undefined) s.hostName = str(body.hostName, 40);
      if (body.ai) {
        if (publicMode && body.ai.provider === 'openai') throw httpError(400, 'Connecting an AI model is turned off in the online demo. Download the offline app to use your own model.');
        const cur = { ...defaults.settings.ai, ...(s.ai || {}) };
        s.ai = {
          provider: body.ai.provider === 'openai' ? 'openai' : 'builtin',
          baseUrl: str(body.ai.baseUrl ?? cur.baseUrl, 300),
          model: str(body.ai.model ?? cur.model, 120),
          timeoutSec: Math.min(600, Math.max(5, Number(body.ai.timeoutSec) || cur.timeoutSec || 90)),
          // A masked key coming back from the form means "keep the saved one".
          apiKey: body.ai.apiKey === undefined || String(body.ai.apiKey).startsWith('••••') ? cur.apiKey : str(body.ai.apiKey, 400),
        };
        if (s.ai.baseUrl && !/^https?:\/\//i.test(s.ai.baseUrl)) throw httpError(400, 'The model address must start with http:// or https://');
      }
    });
    return settingsView();
  });
  route('POST', '/api/settings/test-ai', 'owner', async () => {
    if (publicMode) return { ok: false, error: 'Turned off in the online demo.' };
    const s = get('settings', defaults.settings);
    const passages = [{ title: 'Test', subtitle: '', text: 'Boil water at a rolling boil for 1 minute to make it safe to drink.' }];
    const { modelAnswer } = await import('./ask.js');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    try {
      const r = await modelAnswer({ ...defaults.settings.ai, ...(s.ai || {}) }, 'How long should I boil water?', passages, { signal: ctrl.signal });
      return { ok: true, answer: r.answer };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? 'Timed out after 60 seconds' : err.message };
    } finally { clearTimeout(t); }
  });
  route('POST', '/api/pinned', 'owner', ({ body }) => {
    const item = { kind: str(body.kind, 20), id: str(body.id, 120), title: str(body.title, 160), href: str(body.href, 300) };
    if (!item.id || !item.href.startsWith('#/')) throw httpError(400, 'Invalid item');
    let pinned;
    store.update('settings', defaults.settings, (s) => {
      s.pinned = s.pinned || [];
      const i = s.pinned.findIndex((p) => p.id === item.id);
      if (i >= 0) s.pinned.splice(i, 1); else s.pinned.unshift(item);
      s.pinned = s.pinned.slice(0, 24);
      pinned = s.pinned;
    });
    return pinned;
  });
  route('GET', '/api/readiness', 'owner', () => readiness());

  // packs
  route('GET', '/api/packs', 'owner', () => ({
    installed: get('packs'),
    exports: fs.readdirSync(dirs.exports).filter((f) => f.endsWith('.lspack')).map((f) => {
      const st = fs.statSync(path.join(dirs.exports, f));
      return { file: f, size: st.size, createdAt: st.mtime.toISOString(), url: `/api/packs/download/${encodeURIComponent(f)}` };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    publisher: (() => { const k = publisherKey(); return k ? { publisher: k.publisher, keyId: k.keyId } : null; })(),
    trusted: trustedKeys().map(({ publicKey, ...k }) => k),
  }));
  route('GET', '/api/packs/exportable', 'owner', () => exportable());
  route('POST', '/api/packs/export', 'owner', ({ body }) => exportPack(body));
  route('GET', '/api/packs/download/:file', 'owner', ({ req, res, params }) => {
    const f = path.basename(decodeURIComponent(params.file));
    if (!f.endsWith('.lspack')) throw httpError(404, 'Not found');
    serveFile(req, res, path.join(dirs.exports, f), 'application/octet-stream', f);
    return undefined;
  });
  route('DELETE', '/api/packs/exports/:file', 'owner', ({ params }) => {
    const f = path.basename(decodeURIComponent(params.file));
    if (f.endsWith('.lspack')) fs.rmSync(path.join(dirs.exports, f), { force: true });
    return { ok: true };
  });
  route('POST', '/api/packs/inspect', 'owner:raw', async ({ req }) => {
    const uploadId = newId('u_');
    const file = path.join(dirs.uploads, uploadId + '.lspack');
    await saveUpload(req, file, LIMITS.pack);
    let verification;
    try { verification = await packs.verifyPack(file, trustedKeys()); } catch (err) { fs.rmSync(file, { force: true }); throw httpError(400, err.message); }
    pendingUploads.set(uploadId, { file, verification, at: Date.now() });
    for (const [k, v] of pendingUploads) if (Date.now() - v.at > 3600e3) { fs.rmSync(v.file, { force: true }); pendingUploads.delete(k); }
    const { manifest, status, signer, problems } = verification;
    const already = get('packs').find((p) => p.id === manifest.id);
    return { uploadId, status, signer, problems, manifest: { ...manifest, items: manifest.items.filter((i) => i.type !== 'doctext').map(({ offset, ...i }) => i) }, alreadyInstalled: already ? { version: already.version, installedAt: already.installedAt } : null };
  });
  route('POST', '/api/packs/install', 'owner', ({ body }) => installPack(body.uploadId, body.items));
  route('POST', '/api/packs/trust', 'owner', async ({ body }) => {
    const up = pendingUploads.get(body.uploadId);
    if (!up || up.verification.status !== 'signed-untrusted') throw httpError(400, 'Nothing to trust.');
    const { header } = await packs.readHeader(up.file);
    store.update('trustedKeys', [], (l) => { if (!l.find((k) => k.keyId === header.signature.keyId)) l.push({ keyId: header.signature.keyId, publisher: header.manifest.publisher, publicKey: header.signature.publicKey, addedAt: nowIso() }); });
    up.verification = await packs.verifyPack(up.file, trustedKeys());
    return { status: up.verification.status, signer: up.verification.signer };
  });
  route('DELETE', '/api/packs/:id', 'owner', ({ params }) => {
    const rec = get('packs').find((p) => p.id === decodeURIComponent(params.id));
    if (!rec) throw httpError(404, 'Pack not found');
    removePackItems(rec);
    store.update('packs', [], (l) => l.filter((p) => p.id !== rec.id));
    reloadGuides();
    return { ok: true };
  });
  route('GET', '/api/publisher', 'owner', () => { const k = publisherKey(); return k ? { publisher: k.publisher, keyId: k.keyId, publicKey: k.publicKey } : null; });
  route('POST', '/api/publisher', 'owner', ({ body }) => {
    if (publisherKey() && !body.replace) throw httpError(409, 'You already have a publisher key.');
    const name = str(body.publisher, 80);
    if (!name) throw httpError(400, 'Enter a publisher name.');
    const k = packs.generateKeyPair(name);
    fs.writeFileSync(path.join(dirs.keys, 'publisher.json'), JSON.stringify(k, null, 2), { mode: 0o600 });
    return { publisher: k.publisher, keyId: k.keyId, publicKey: k.publicKey };
  });

  // retrieval only — for the AI model that runs inside the browser
  const retrieveRoute = (filterPublic) => ({ body }) => {
    const q = String(body.question || '').trim().slice(0, 500);
    const passages = retrieve(getIndex(), q, { filter: filterPublic || body.scope === 'guides' ? (u) => u.public : undefined, limit: 5 });
    return {
      question: q,
      urgent: /\b(not breathing|stopped breathing|unconscious|unresponsive|no pulse|severe bleeding|chest pain|heart attack|stroke|seizure|overdose|poison|choking|anaphyla|carbon monoxide|suicid)/i.test(q) ? URGENT_NOTE : null,
      sources: passages.map((p, i) => ({ n: i + 1, id: p.id, kind: p.kind, title: p.title, subtitle: p.subtitle, ref: p.ref, excerpt: p.excerpt, highlights: p.highlights, text: p.text.slice(0, 2400), coverage: p.coverage })),
    };
  };
  route('POST', '/api/retrieve', 'owner', retrieveRoute(false));

  // offline encyclopedia
  route('GET', '/api/wiki', 'owner', () => wiki.status());
  route('POST', '/api/wiki/download', 'owner', ({ body }) => wiki.start(Array.isArray(body.titles) ? body.titles.map(String) : null, { refresh: !!body.refresh && !publicMode }));
  route('DELETE', '/api/wiki/:id', 'owner', ({ params }) => { if (publicMode) throw httpError(403, 'The shared encyclopedia can\'t be changed in the online demo.'); wiki.remove(params.id); return { ok: true }; });
  const wikiArticle = ({ params }) => { const a = wiki.article(params.id); if (!a) throw httpError(404, 'Article not saved'); return a; };
  route('GET', '/api/wiki/article/:id', 'owner', wikiArticle);
  route('GET', '/api/public/wiki', 'member', () => wiki.status());
  route('GET', '/api/public/wiki/article/:id', 'member', wikiArticle);
  route('GET', '/files/wiki/:file', 'member', ({ req, res, params }) => {
    const p = wiki.imagePath(params.file);
    if (!p) throw httpError(404, 'Not found');
    const ext = path.extname(p).slice(1).toLowerCase();
    serveFile(req, res, p, { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'application/octet-stream');
    return undefined;
  });

  // street map tiles, fonts and offline areas
  route('GET', '/vt/:z/:x/:y', 'member', async ({ res, params }) => {
    const buf = await vt.get(Number(params.z), Number(params.x), parseInt(params.y, 10));
    if (!buf || !buf.length) { res.writeHead(204, { 'cache-control': buf ? 'max-age=86400' : 'no-cache' }); res.end(); return undefined; }
    res.writeHead(200, { 'content-type': 'application/x-protobuf', 'content-length': buf.length, 'cache-control': 'max-age=86400' });
    res.end(buf);
    return undefined;
  });
  route('GET', '/glyphs/:stack/:range', 'member', ({ res, params }) => {
    const buf = glyph(String(params.range).replace(/\.pbf$/, ''));
    if (!buf) throw httpError(404, 'Not found');
    res.writeHead(200, { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip', 'content-length': buf.length, 'cache-control': 'max-age=604800' });
    res.end(buf);
    return undefined;
  });
  route('GET', '/api/vt', 'owner', () => vt.status());
  route('POST', '/api/vt/estimate', 'owner', ({ body }) => ({ tiles: vt.estimate(body.bbox, body.minzoom ?? 0, body.maxzoom ?? 14), limit: vt.maxSaveTiles }));
  route('POST', '/api/vt/save', 'owner', ({ body }) => vt.saveArea(body));
  route('DELETE', '/api/vt/areas/:id', 'owner', ({ params }) => { if (publicMode) throw httpError(403, 'Saved areas are shared in the online demo.'); vt.removeArea(params.id); return { ok: true }; });
  route('POST', '/api/vt/clear', 'owner', async () => { if (publicMode) throw httpError(403, 'Not available in the online demo.'); await vt.clear(); return { ok: true }; });

  // open source: what this copy is running, file by file
  route('GET', '/api/source', 'open', () => sourceManifest(APP_DIR, VERSION));
  route('GET', '/api/source/file', 'open', ({ res, query }) => {
    const text = readSourceFile(APP_DIR, VERSION, String(query.path || ''));
    if (text == null) throw httpError(404, 'Not a source file');
    send(res, 200, text, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
    return undefined;
  });

  // offline crypto relay
  route('GET', '/api/relay', 'owner', () => relay.view());
  route('POST', '/api/relay/decode', 'owner', ({ body }) => { try { const { raw, ...d } = decodeTx(body.tx); return d; } catch (err) { throw httpError(400, err.message); } });
  route('POST', '/api/relay', 'owner', ({ body }) => { try { return relay.add(body.tx, get('settings', defaults.settings).hostName || 'this device', body.note); } catch (err) { throw httpError(err.status || 400, err.message); } });
  route('POST', '/api/relay/:qid/retry', 'owner', ({ params }) => {
    const list = relay.list();
    const it = list.find((x) => x.qid === params.qid);
    if (!it) throw httpError(404, 'Not found');
    if (it.signed) { it.status = 'queued'; it.lastTry = null; it.lastError = null; relay.save(list); relay.tick().catch(() => {}); }
    return it;
  });
  route('DELETE', '/api/relay/:qid', 'owner', ({ params }) => { relay.remove(params.qid); return { ok: true }; });
  // group members (phones) can see the queue, add a transaction, or broadcast one from their own connection
  route('GET', '/api/group/relay', 'member', () => ({ ...relay.view(), hosts: RELAY_HOSTS }));
  route('POST', '/api/group/relay', 'member', ({ body, member }) => {
    if (!group.allow('relay:' + member)) throw httpError(429, 'Too many in a minute.');
    try { return relay.add(body.tx, group.state.members[member]?.name || 'a phone', body.note); } catch (err) { throw httpError(err.status || 400, err.message); }
  });
  route('POST', '/api/group/relay/:qid/result', 'member', ({ params, body, member }) => {
    const by = group.state.members[member]?.name || 'a phone';
    const it = relay.list().find((x) => x.qid === params.qid);
    if (!it) throw httpError(404, 'Not found');
    if (body.ok) return relay.record(params.qid, { ok: true, id: it.id }, by); // confirmation is re-checked by this server later
    return relay.record(params.qid, { ok: false, terminal: false, error: String(body.error || 'Failed').slice(0, 300) }, by);
  });

  // survival gear checklist
  route('GET', '/api/kit', 'owner', () => { const have = get('kit', { have: {} }).have || {}; return { categories: KIT_CATEGORIES, items: KIT, have, summary: kitSummary(have) }; });
  route('PUT', '/api/kit/:id', 'owner', ({ params, body }) => {
    if (!KIT.find((k) => k.id === params.id)) throw httpError(404, 'Unknown item');
    const k = store.update('kit', { have: {} }, (st) => { st.have ||= {}; if (body.have) st.have[params.id] = true; else delete st.have[params.id]; });
    return { have: k.have, summary: kitSummary(k.have) };
  });

  // outage log (shared with the group while a session runs)
  const logRoutes = (prefix, access) => {
    route('GET', prefix, access, () => get('log'));
    route('POST', prefix, access, ({ body, member }) => {
      const text = str(body.text, 1000);
      if (!text) throw httpError(400, 'Write something first.');
      const author = member ? (group.state.members[member]?.name || 'Host') : (get('settings', defaults.settings).hostName || 'Me');
      const entry = { id: newId('l_'), ts: nowIso(), author, kind: ['event', 'checked', 'todo'].includes(body.kind) ? body.kind : 'event', text, done: false };
      store.update('log', [], (l) => { l.push(entry); if (l.length > 5000) l.splice(0, l.length - 5000); });
      group.broadcast('log', entry);
      return entry;
    });
    route('PUT', prefix + '/:id', access, ({ params, body, member }) => {
      let out;
      store.update('log', [], (l) => {
        const e = l.find((x) => x.id === params.id);
        if (!e) throw httpError(404, 'Not found');
        if (body.done !== undefined) { e.done = !!body.done; e.doneBy = member ? group.state.members[member]?.name : 'Host'; e.doneAt = nowIso(); }
        out = e;
      });
      group.broadcast('log', out);
      return out;
    });
  };
  logRoutes('/api/log', 'owner');
  logRoutes('/api/group/log', 'member');
  route('DELETE', '/api/log/:id', 'owner', ({ params }) => { store.update('log', [], (l) => l.filter((e) => e.id !== params.id)); return { ok: true }; });

  // group — host controls
  route('POST', '/api/group/start', 'owner', ({ body }) => {
    const s = get('settings', defaults.settings);
    group.start({ name: body.name, hostName: body.hostName || s.hostName });
    return group.snapshot('host', true);
  });
  route('POST', '/api/group/end', 'owner', () => { group.end(); return { ok: true }; });
  route('POST', '/api/group/code', 'owner', () => ({ code: group.newCode() }));
  route('GET', '/api/group/invite', 'owner', ({ req }) => {
    if (!group.active) throw httpError(404, 'No session');
    const code = group.state.session.code;
    if (opts.inviteUrl) {
      const url = opts.inviteUrl(req, code);
      return { code, urls: [{ name: 'Link', address: new URL(url).host, url, display: url.replace(/#.*$/, '') }] };
    }
    return { code, urls: lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${port}/join#code=${code}` })) };
  });
  route('DELETE', '/api/group/members/:id', 'owner', ({ params }) => { group.remove(params.id); return { ok: true }; });
  route('POST', '/api/group/meeting', 'owner', ({ body }) => group.setMeetingPoint(body.clear ? null : body, 'Host'));

  // group — anyone
  route('GET', '/api/group/info', 'open', () => ({ active: group.active, name: group.active ? group.state.session.name : null }));
  route('POST', '/api/group/join', 'open', ({ req, res, body }) => {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    const tries = (joinAttempts.get(ip) || []).filter((t) => now - t < 60000);
    if (tries.length >= 10) throw httpError(429, 'Too many tries. Wait a minute and scan the QR code again.');
    tries.push(now);
    joinAttempts.set(ip, tries);
    const { member, token } = group.join(body.code, body.name);
    const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    res.setHeader('set-cookie', `ls_member=${token}; Path=/; HttpOnly; ${https && opts.frameAncestors ? 'SameSite=None; Secure' : 'SameSite=Strict'}; Max-Age=${60 * 60 * 24 * 30}`);
    return { member };
  });

  // group — members (and the host)
  route('GET', '/api/group/state', 'member', ({ member, owner }) => group.snapshot(member, owner));
  route('GET', '/api/group/events', 'member', ({ req, res, member }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    group.subscribe(res, member);
    const ka = setInterval(() => res.write(': keep-alive\n\n'), 20000);
    req.on('close', () => clearInterval(ka));
    return undefined;
  });
  route('POST', '/api/group/messages', 'member', ({ body, member }) => group.send(member, body));
  route('POST', '/api/group/ack', 'member', ({ body, member }) => ({ receipts: group.ack(member, body.ids) }));
  route('POST', '/api/group/me', 'member', ({ body, member }) => { group.rename(member, body.name); return { ok: true }; });
  route('POST', '/api/group/leave', 'member', ({ res, member }) => {
    group.remove(member);
    res.setHeader('set-cookie', 'ls_member=; Path=/; Max-Age=0');
    return { ok: true };
  });

  async function handle(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    // The offline app refuses to be framed by other sites. The online demo may
    // be shown inside the hosting site's preview frame (e.g. Replit).
    if (!opts.frameAncestors) res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://raw.githubusercontent.com " + relayOrigins + "; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors " + (opts.frameAncestors || "'self'"));
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURI(url.pathname);
    const owner = opts.isOwner ? opts.isOwner(req) : ownerRequest(req);
    try {
      if (pathname.startsWith('/api/') || pathname.startsWith('/tiles/') || pathname.startsWith('/files/') || pathname.startsWith('/vt/') || pathname.startsWith('/glyphs/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(pathname);
          if (!m) continue;
          const member = r.access === 'open' ? null : memberFor(req, owner);
          if (r.access === 'owner' && !owner) throw httpError(403, 'This is only available on the PC running LASTSYNC.');
          if (r.access === 'member' && !owner && !member) throw httpError(401, 'Join the group first.');
          if (r.access === 'member' && pathname.startsWith('/api/group/') && !group.active) throw httpError(404, 'No group session is running.');
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const query = Object.fromEntries(url.searchParams);
          let body = {};
          if ((req.method === 'POST' || req.method === 'PUT') && String(req.headers['content-type'] || '').includes('application/json')) body = await readJson(req);
          else if ((req.method === 'POST' || req.method === 'PUT') && !r.raw) {
            // Every JSON route must be called with a JSON content type; this
            // also stops other web pages from posting here with plain forms.
            throw httpError(415, 'Expected JSON');
          }
          const out = await r.handler({ req, res, params, query, body, member: member || (owner ? 'host' : null), owner: owner && (!member || member === 'host') });
          if (out !== undefined && !res.headersSent) send(res, 200, out);
          return;
        }
        throw httpError(404, 'Not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed');
      await serveStatic(req, res, pathname, owner);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong: ' + err.message : err.message });
      else res.end();
    }
  }

  const server = opts.noServer ? null : http.createServer(handle);
  if (server) server.requestTimeout = 0; // big map and pack uploads can take a while
  return { server, handle, port, store, group, wiki, vt, dataDir: DATA_DIR, readiness, publicMode };
}

// ---------- shared helpers ----------
export const CATEGORIES = {
  meeting: 'Meeting point', water: 'Water source', shelter: 'Shelter', medical: 'Medical help', food: 'Food',
  power: 'Power / charging', comms: 'Communications', hazard: 'Hazard', home: 'Home', other: 'Other',
};
function categoryLabel(c) { return CATEGORIES[c] || 'Pin'; }

function statusLabel(s) {
  return { verified: 'Signature verified', 'signed-untrusted': 'Signed by a publisher you have not trusted', unsigned: 'Unsigned (personal pack)', invalid: 'Signature check failed', damaged: 'Damaged' }[s] || s;
}

function str(v, n) {
  return v === undefined || v === null ? '' : String(v).replace(/\u0000/g, '').trim().slice(0, n);
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function chunkText(text, size = 1800) {
  const paras = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > size) { out.push(cur.trim()); cur = ''; }
    cur += p + '\n\n';
    while (cur.length > size * 2) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseGpx(xml, fallbackName) {
  const attr = (s, a) => Number((new RegExp(`${a}\\s*=\\s*["']([-\\d.eE+]+)["']`).exec(s) || [])[1]);
  const tagText = (s, t) => ((new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(s) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  const pts = (block, tag) => [...block.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => [attr(m[1], 'lat'), attr(m[1], 'lon')]).filter(([a, o]) => Number.isFinite(a) && Number.isFinite(o));
  const routes = [];
  for (const m of xml.matchAll(/<trk\b[\s\S]*?<\/trk>/g)) {
    const p = pts(m[0], 'trkpt');
    if (p.length >= 2) routes.push({ name: tagText(m[0].replace(/<trkseg[\s\S]*/, ''), 'name') || fallbackName || 'Imported track', points: p });
  }
  for (const m of xml.matchAll(/<rte\b[\s\S]*?<\/rte>/g)) {
    const p = pts(m[0], 'rtept');
    if (p.length >= 2) routes.push({ name: tagText(m[0].replace(/<rtept[\s\S]*/, ''), 'name') || fallbackName || 'Imported route', points: p });
  }
  const pins = [];
  for (const m of xml.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/g)) {
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    if (Number.isFinite(lat) && Number.isFinite(lon)) pins.push({ name: tagText(m[2], 'name') || 'Waypoint', lat, lon, category: 'other', note: tagText(m[2], 'desc') });
  }
  return { routes, pins };
}

// Run directly: `node server/index.js`
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.LASTSYNC_HOST || '0.0.0.0';
  const app = createApp({ port });
  app.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`LASTSYNC already seems to be running. Open http://localhost:${port}`);
      process.exit(0);
    }
    throw err;
  });
  app.server.listen(port, host, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  LASTSYNC is running at ${url}`);
    console.log(`  Your data is saved in ${app.dataDir}`);
    console.log('  Keep this window open. Close it to stop LASTSYNC.\n');
    if (process.env.LASTSYNC_OPEN === '1') openBrowser(url);
  });
}

function openBrowser(url) {
  import('node:child_process').then(({ spawn }) => {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  });
}
