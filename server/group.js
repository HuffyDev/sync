// Local group sessions: the laptop hosts an invite-only session on the local
// network. Phones join by QR code in their browser and send check-ins.
// A message only shows "Received" once the other device has confirmed it.
import crypto from 'node:crypto';
import { newId, nowIso } from './store.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const MESSAGE_TYPES = ['safe', 'meet', 'help', 'ping', 'text'];
const MAX_MESSAGES = 1000;

function makeCode() {
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function clampText(s, n) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);
}

function coord(v, lim) {
  // Number(null) and Number('') are 0, which would put a pin off the coast of Africa.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= lim ? Number(n.toFixed(6)) : null;
}

export class Group {
  constructor(store) {
    this.store = store;
    this.clients = new Set(); // { res, memberId }
    this.buckets = new Map();
    const st = store.get('group', null);
    this.state = st || { session: null, members: {}, messages: [] };
  }

  save() {
    this.store.set('group', this.state);
  }

  get active() {
    return !!this.state.session;
  }

  start({ name, hostName }) {
    this.state = {
      session: {
        id: newId('s_'),
        name: clampText(name, 60) || 'Household',
        code: makeCode(),
        createdAt: nowIso(),
        meetingPoint: null,
      },
      members: {
        host: { id: 'host', name: clampText(hostName, 40) || 'Host laptop', role: 'host', joinedAt: nowIso(), lastSeen: nowIso(), lastCheckIn: null },
      },
      messages: [],
    };
    this.save();
    this.broadcast('session', this.sessionView());
    return this.state.session;
  }

  end() {
    this.broadcast('ended', {});
    this.state = { session: null, members: {}, messages: [] };
    this.save();
    for (const c of this.clients) if (c.memberId !== 'host') c.res.end();
  }

  newCode() {
    if (!this.active) return null;
    this.state.session.code = makeCode();
    this.save();
    return this.state.session.code;
  }

  join(code, name) {
    if (!this.active) throw httpError(404, 'There is no group session running on this laptop.');
    if (String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') !== this.state.session.code) {
      throw httpError(403, 'That invite code is not right. Scan the QR code again.');
    }
    const cleanName = clampText(name, 40);
    if (!cleanName) throw httpError(400, 'Enter your name so the group knows who you are.');
    if (Object.keys(this.state.members).length >= 100) throw httpError(409, 'This group is full.');
    const token = crypto.randomBytes(24).toString('base64url');
    const member = { id: newId('m_'), name: cleanName, role: 'member', tokenHash: hash(token), joinedAt: nowIso(), lastSeen: nowIso(), lastCheckIn: null };
    this.state.members[member.id] = member;
    this.save();
    this.broadcast('members', this.roster());
    return { member: this.publicMember(member), token };
  }

  memberForToken(token) {
    if (!token || !this.active) return null;
    const h = hash(token);
    return Object.values(this.state.members).find((m) => m.tokenHash && m.tokenHash === h) || null;
  }

  remove(memberId) {
    if (memberId === 'host') return;
    delete this.state.members[memberId];
    this.save();
    for (const c of this.clients) if (c.memberId === memberId) { c.res.write('event: removed\ndata: {}\n\n'); c.res.end(); }
    this.broadcast('members', this.roster());
  }

  rename(memberId, name) {
    const m = this.state.members[memberId];
    const n = clampText(name, 40);
    if (m && n) { m.name = n; this.save(); this.broadcast('members', this.roster()); }
  }

  touch(memberId) {
    const m = this.state.members[memberId];
    if (!m) return;
    const now = Date.now();
    if (!m._touched || now - m._touched > 15000) {
      m._touched = now;
      m.lastSeen = nowIso();
      this.broadcast('members', this.roster());
    }
  }

  allow(memberId) {
    const now = Date.now();
    const b = this.buckets.get(memberId) || { tokens: 20, at: now };
    b.tokens = Math.min(20, b.tokens + ((now - b.at) / 60000) * 20);
    b.at = now;
    if (b.tokens < 1) { this.buckets.set(memberId, b); return false; }
    b.tokens -= 1;
    this.buckets.set(memberId, b);
    return true;
  }

  send(fromId, body) {
    if (!this.active) throw httpError(404, 'No group session is running.');
    const from = this.state.members[fromId];
    if (!from) throw httpError(403, 'You are not in this group.');
    if (!this.allow(fromId)) throw httpError(429, 'Slow down a little — too many messages in a minute.');
    const type = MESSAGE_TYPES.includes(body.type) ? body.type : 'text';
    const to = body.to && this.state.members[body.to] ? body.to : null;
    const lat = coord(body.lat, 90);
    const lon = coord(body.lon, 180);
    const msg = {
      id: newId('g_'),
      ts: nowIso(),
      from: fromId,
      fromName: from.name,
      to,
      type,
      text: clampText(body.text, 500),
      lat: lat !== null && lon !== null ? lat : null,
      lon: lat !== null && lon !== null ? lon : null,
      place: clampText(body.place, 80) || null,
      receipts: {},
    };
    if (type === 'text' && !msg.text) throw httpError(400, 'Message is empty.');
    this.state.messages.push(msg);
    if (this.state.messages.length > MAX_MESSAGES) this.state.messages.splice(0, this.state.messages.length - MAX_MESSAGES);
    if (type !== 'text' && type !== 'ping') {
      from.lastCheckIn = { type, ts: msg.ts, text: msg.text, lat: msg.lat, lon: msg.lon, place: msg.place };
    }
    if (type === 'meet' && (msg.lat !== null || msg.place) && (fromId === 'host' || body.setMeetingPoint)) {
      this.state.session.meetingPoint = { name: msg.place || msg.text || 'Meeting point', lat: msg.lat, lon: msg.lon, note: msg.text, setBy: from.name, ts: msg.ts };
      this.broadcast('session', this.sessionView());
    }
    from.lastSeen = msg.ts;
    this.save();
    this.broadcast('message', msg, (memberId) => this.canSee(memberId, msg));
    this.broadcast('members', this.roster());
    return msg;
  }

  canSee(memberId, msg) {
    return memberId === 'host' || !msg.to || msg.to === memberId || msg.from === memberId;
  }

  ack(memberId, ids) {
    if (!this.state.members[memberId]) return [];
    const done = [];
    const ts = nowIso();
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 200)) {
      const msg = this.state.messages.find((m) => m.id === id);
      if (!msg || msg.from === memberId || msg.receipts[memberId] || !this.canSee(memberId, msg)) continue;
      msg.receipts[memberId] = ts;
      done.push({ id, memberId, ts });
    }
    if (done.length) {
      this.save();
      for (const r of done) this.broadcast('receipt', r);
    }
    this.touch(memberId);
    return done;
  }

  setMeetingPoint(mp, byName) {
    if (!this.active) return null;
    this.state.session.meetingPoint = mp
      ? { name: clampText(mp.name, 80) || 'Meeting point', lat: coord(mp.lat, 90), lon: coord(mp.lon, 180), note: clampText(mp.note, 300), setBy: byName, ts: nowIso() }
      : null;
    this.save();
    this.broadcast('session', this.sessionView());
    return this.state.session.meetingPoint;
  }

  publicMember(m) {
    return { id: m.id, name: m.name, role: m.role, joinedAt: m.joinedAt, lastSeen: m.lastSeen, lastCheckIn: m.lastCheckIn };
  }

  roster() {
    return Object.values(this.state.members).map((m) => this.publicMember(m));
  }

  sessionView(includeCode = false) {
    if (!this.active) return null;
    const { code, ...rest } = this.state.session;
    return includeCode ? { ...rest, code } : rest;
  }

  snapshot(memberId, includeCode = false) {
    return {
      session: this.sessionView(includeCode),
      me: memberId,
      members: this.roster(),
      messages: this.state.messages.filter((m) => this.canSee(memberId, m)).slice(-300),
    };
  }

  subscribe(res, memberId) {
    const client = { res, memberId };
    this.clients.add(client);
    res.on('close', () => this.clients.delete(client));
    return client;
  }

  broadcast(event, data, filter) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      if (filter && !filter(c.memberId)) continue;
      try { c.res.write(payload); } catch {}
    }
  }
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
