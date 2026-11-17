import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createApp, parseGpx, chunkText } from '../server/index.js';
import { writePack, verifyPack, generateKeyPair } from '../server/packs.js';
import { parseNmea } from '../web/nmea.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lastsync-test-'));
let app;
let base;

before(async () => {
  app = createApp({ dataDir: path.join(tmp, 'data'), port: 0 });
  await new Promise((r) => app.server.listen(0, '0.0.0.0', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const j = async (p, opts = {}) => {
  const res = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

test('search finds water disinfection for everyday words', async () => {
  const { body } = await j('/api/search?q=cleaning%20water');
  assert.ok(body.results.length > 0);
  assert.equal(body.results[0].ref.guide, 'water');
});

test('Ask quotes the right section and never mixes in other doses', async () => {
  const { body } = await j('/api/ask', { method: 'POST', body: { question: 'how do I make water safe with bleach?' } });
  assert.equal(body.covered, true);
  assert.equal(body.sources[0].subtitle, 'Disinfecting with household bleach');
  assert.match(body.answer, /8 drops/);
  assert.doesNotMatch(body.answer, /5 tablespoons/, 'surface-cleaning dose must not leak into a drinking-water answer');
});

test('Ask says so when the library does not cover a question', async () => {
  const { body } = await j('/api/ask', { method: 'POST', body: { question: 'how to build a nuclear reactor' } });
  assert.equal(body.covered, false);
  assert.match(body.answer, /doesn't cover/);
});

test('Ask flags emergencies', async () => {
  const { body } = await j('/api/ask', { method: 'POST', body: { question: 'my dad is not breathing' } });
  assert.ok(body.urgent);
  assert.match(body.sources[0].subtitle, /CPR/);
});

test('owner-only routes refuse other hosts and non-JSON posts', async () => {
  assert.equal((await j('/api/notes')).status, 200);
  // fetch() ignores a custom Host header, so use http.request for the DNS-rebinding check.
  const status = await new Promise((resolve, reject) => {
    const u = new URL(base + '/api/notes');
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  const form = await fetch(base + '/api/notes', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"title":"x"}' });
  assert.equal(form.status, 415);
});

test('phones on the LAN cannot read private data', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
  if (!lan) return t.skip('no LAN interface');
  const url = `http://${lan.address}:${app.server.address().port}`;
  for (const p of ['/api/notes', '/api/plan', '/api/settings', '/api/library', '/app.js']) {
    const r = await fetch(url + p);
    assert.ok([401, 403, 404].includes(r.status), `${p} returned ${r.status}`);
  }
  assert.equal((await fetch(url + '/api/group/info')).status, 200);
  assert.equal((await fetch(url + '/join')).status, 200);
  const docs = await fetch(url + '/docs');
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /G9WZ6x6Zqdw8B96tgWAmgagkMFdgqr23u6P3GX6oSync/);
  assert.equal((await fetch(url + '/docs.js')).status, 200);
});

test('group: invite code, check-in, delivery receipt', async () => {
  const start = await j('/api/group/start', { method: 'POST', body: { name: 'Test', hostName: 'Host' } });
  const code = start.body.session.code;
  assert.equal((await j('/api/group/join', { method: 'POST', body: { code: 'NOPE00', name: 'A' } })).status, 403);
  const joined = await j('/api/group/join', { method: 'POST', body: { code, name: 'Alex' } });
  assert.equal(joined.status, 200);
  const cookie = joined.headers.get('set-cookie').split(';')[0];
  const sent = await j('/api/group/messages', { method: 'POST', headers: { cookie }, body: { type: 'safe', place: 'Park', lat: null, lon: null } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.lat, null, 'missing location must stay missing, not 0,0');
  assert.deepEqual(sent.body.receipts, {});
  await j('/api/group/ack', { method: 'POST', body: { ids: [sent.body.id] } });
  const st = await j('/api/group/state', { headers: { cookie } });
  assert.ok(st.body.messages.find((m) => m.id === sent.body.id).receipts.host);
  await j('/api/group/end', { method: 'POST' });
});

test('packs: integrity and signatures', async () => {
  const file = path.join(tmp, 'a.txt');
  fs.writeFileSync(file, 'hello offline world');
  const out = path.join(tmp, 'p.lspack');
  const key = generateKeyPair('Test Publisher');
  await writePack(out, { id: 'p1', name: 'P', publisher: 'Test Publisher' }, [{ item: { type: 'guide', id: 'g', name: 'G' }, file }], key);
  const trusted = [{ keyId: key.keyId, publisher: 'Test Publisher', publicKey: key.publicKey }];
  assert.equal((await verifyPack(out, trusted)).status, 'verified');
  assert.equal((await verifyPack(out, [])).status, 'signed-untrusted');
  // flip one byte of file data -> damaged
  const buf = fs.readFileSync(out);
  buf[buf.length - 1] ^= 1;
  fs.writeFileSync(out, buf);
  assert.equal((await verifyPack(out, trusted)).status, 'damaged');
  // tamper with manifest -> invalid signature
  buf[buf.length - 1] ^= 1;
  const tampered = Buffer.from(buf.toString('latin1').replace('"name":"P"', '"name":"Q"'), 'latin1');
  fs.writeFileSync(out, tampered);
  assert.equal((await verifyPack(out, trusted)).status, 'invalid');
});

test('NMEA, GPX and text chunking', () => {
  const r = parseNmea('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47');
  assert.ok(Math.abs(r.lat - 48.1173) < 1e-4 && Math.abs(r.lon - 11.516667) < 1e-4);
  assert.equal(parseNmea('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*48'), null, 'bad checksum rejected');
  const g = parseGpx('<gpx><trk><name>T</name><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk><wpt lat="3" lon="4"><name>W</name></wpt></gpx>');
  assert.equal(g.routes[0].name, 'T');
  assert.equal(g.routes[0].points.length, 2);
  assert.equal(g.pins[0].name, 'W');
  assert.ok(chunkText('a\n\n'.repeat(3000)).length > 1);
});

test('encyclopedia: extract parsing drops reference sections', async () => {
  const { parseExtract } = await import('../server/wiki.js');
  const secs = parseExtract('Intro text that is long enough to keep around here.\n\n== Methods ==\nBoil water for one minute at a rolling boil, longer at altitude.\n=== Detail ===\nMore detail text here that is long enough.\n\n== See also ==\nOther\n\n== References ==\nRefs');
  assert.deepEqual(secs.map((s) => s.heading), ['Overview', 'Methods']);
  assert.match(secs[1].text, /### Detail/);
});

test('gear checklist tracks essentials', async () => {
  const before = await j('/api/kit');
  assert.equal(before.body.summary.covered, 0);
  const r = await j('/api/kit/radio', { method: 'PUT', body: { have: true } });
  assert.equal(r.body.summary.covered, 1);
  assert.equal((await j('/api/kit/not-a-thing', { method: 'PUT', body: { have: true } })).status, 404);
});

test('retrieval for on-device AI returns passage text and prefers guides', async () => {
  const { body } = await j('/api/retrieve', { method: 'POST', body: { question: 'how do I make water safe with bleach?' } });
  assert.equal(body.sources[0].kind, 'guide');
  assert.ok(body.sources[0].text.length > 200);
});

test('open source manifest lists every app file with correct hashes', async () => {
  const { body } = await j('/api/source');
  assert.equal(body.license, 'MIT');
  const lic = body.files.find((f) => f.path === 'LICENSE');
  assert.ok(lic);
  const crypto = await import('node:crypto');
  assert.equal(lic.sha256, crypto.createHash('sha256').update(fs.readFileSync(new URL('../LICENSE', import.meta.url))).digest('hex'));
  assert.ok(!body.files.some((f) => /^data\//.test(f.path) || f.path.startsWith('.git/')), 'no user data or git internals');
  const file = await fetch(base + '/api/source/file?path=server/index.js');
  assert.equal(file.status, 200);
  assert.equal((await fetch(base + '/api/source/file?path=../../etc/passwd')).status, 404);
});
