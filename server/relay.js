// Offline crypto relay.
//
// LASTSYNC never holds keys and never signs. You sign a transaction in your
// own wallet (offline is fine); LASTSYNC decodes it so you can see exactly
// what it does, checks its signatures, keeps it in a queue, passes it to the
// group over local Wi-Fi or as a QR code, and broadcasts it as soon as any
// device has a connection.
//
// Supported: Bitcoin raw transactions (hex) — they stay valid until their
// inputs are spent — and Solana transactions (base64 or base58). Solana
// transactions only stay valid offline if they use a durable nonce; normal
// ones expire about a minute after signing.
import crypto from 'node:crypto';
import { newId, nowIso } from './store.js';

const BTC_API = process.env.LASTSYNC_BTC_API || 'https://mempool.space/api';
const SOL_RPC = process.env.LASTSYNC_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
export const RELAY_HOSTS = { bitcoin: BTC_API, solana: SOL_RPC };

// ---------- encodings ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const c of str) { if (c === '1') zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
function b58check(version, payload) {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  return b58encode(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
}
const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]; }
  return chk;
}
function segwitAddress(hrp, version, program) {
  const conv = [];
  let acc = 0, bits = 0;
  for (const b of program) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; conv.push((acc >> bits) & 31); } }
  if (bits) conv.push((acc << (5 - bits)) & 31);
  const data = [version, ...conv];
  const hrpx = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const constant = version === 0 ? 1 : 0x2bc830a3; // bech32 / bech32m
  const mod = polymod([...hrpx, ...data, 0, 0, 0, 0, 0, 0]) ^ constant;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map((d) => BECH[d]).join('');
}

// ---------- Bitcoin ----------
class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new Error('Transaction data is cut short'); }
  u8() { this.need(1); return this.b[this.o++]; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  varint() { const f = this.u8(); if (f < 0xfd) return f; if (f === 0xfd) { this.need(2); const v = this.b.readUInt16LE(this.o); this.o += 2; return v; } if (f === 0xfe) return this.u32(); return Number(this.u64()); }
  compact() { let v = 0, s = 0; for (;;) { const b = this.u8(); v |= (b & 0x7f) << s; if (!(b & 0x80)) return v; s += 7; if (s > 14) throw new Error('bad length'); } }
}

function btcScriptAddress(script) {
  const h = script.toString('hex');
  if (/^76a914[0-9a-f]{40}88ac$/.test(h)) return b58check(0x00, script.subarray(3, 23));
  if (/^a914[0-9a-f]{40}87$/.test(h)) return b58check(0x05, script.subarray(2, 22));
  if (/^0014[0-9a-f]{40}$/.test(h)) return segwitAddress('bc', 0, script.subarray(2));
  if (/^0020[0-9a-f]{64}$/.test(h)) return segwitAddress('bc', 0, script.subarray(2));
  if (/^5120[0-9a-f]{64}$/.test(h)) return segwitAddress('bc', 1, script.subarray(2));
  if (h.startsWith('6a')) return 'OP_RETURN (data)';
  return 'non-standard script';
}

export function decodeBitcoin(hex) {
  const buf = Buffer.from(hex, 'hex');
  const r = new Reader(buf);
  const version = r.u32();
  let segwit = false;
  if (buf[r.o] === 0 && buf[r.o + 1] === 1) { segwit = true; r.o += 2; }
  const afterVersion = r.o;
  const nIn = r.varint();
  if (!nIn || nIn > 5000) throw new Error('No inputs — not a Bitcoin transaction');
  const inputs = [];
  for (let i = 0; i < nIn; i++) {
    const prev = Buffer.from(r.bytes(32)).reverse().toString('hex');
    const vout = r.u32();
    const scriptSig = r.bytes(r.varint());
    r.u32();
    inputs.push({ prev, vout, signed: scriptSig.length > 0 });
  }
  const nOut = r.varint();
  if (!nOut || nOut > 5000) throw new Error('No outputs — not a Bitcoin transaction');
  const outputs = [];
  for (let i = 0; i < nOut; i++) {
    const sats = r.u64();
    const script = r.bytes(r.varint());
    outputs.push({ address: btcScriptAddress(script), sats: Number(sats), btc: (Number(sats) / 1e8).toFixed(8) });
  }
  const endOutputs = r.o;
  if (segwit) for (let i = 0; i < nIn; i++) { const items = r.varint(); for (let k = 0; k < items; k++) { const it = r.bytes(r.varint()); if (it.length) inputs[i].signed = true; } }
  const locktime = r.u32();
  if (r.o !== buf.length) throw new Error('Extra bytes after the transaction');
  const stripped = Buffer.concat([buf.subarray(0, 4), buf.subarray(afterVersion, endOutputs), buf.subarray(buf.length - 4)]);
  const txid = Buffer.from(sha256(sha256(stripped))).reverse().toString('hex');
  const unsigned = inputs.filter((x) => !x.signed).length;
  return {
    chain: 'bitcoin', id: txid, version, segwit, locktime, inputs, outputs,
    totalOut: outputs.reduce((s, o) => s + o.sats, 0),
    signed: unsigned === 0,
    problems: unsigned ? [`${unsigned} input${unsigned > 1 ? 's are' : ' is'} not signed yet — sign it in your wallet first.`] : [],
    expiry: 'Stays valid until its coins are spent some other way.',
    summary: outputs.filter((o) => !o.address.startsWith('OP_RETURN')).map((o) => `${o.btc} BTC → ${o.address}`).join(', '),
  };
}

// ---------- Solana ----------
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PQnBqCXEpPxuEb';
const MEMO = ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'];
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

export function decodeSolana(buf) {
  const r = new Reader(buf);
  const nSig = r.compact();
  if (!nSig || nSig > 32) throw new Error('Not a signed Solana transaction');
  const sigs = [];
  for (let i = 0; i < nSig; i++) sigs.push(r.bytes(64));
  const msgStart = r.o;
  let versioned = false;
  if (buf[r.o] & 0x80) { versioned = true; r.u8(); }
  const header = { required: r.u8(), roSigned: r.u8(), roUnsigned: r.u8() };
  const nKeys = r.compact();
  const keys = [];
  for (let i = 0; i < nKeys; i++) keys.push(b58encode(r.bytes(32)));
  const blockhash = b58encode(r.bytes(32));
  const nIx = r.compact();
  const ixs = [];
  for (let i = 0; i < nIx; i++) {
    const prog = r.u8();
    const accs = [...r.bytes(r.compact())];
    const data = Buffer.from(r.bytes(r.compact()));
    ixs.push({ prog, accs, data });
  }
  if (versioned) { const n = r.compact(); for (let i = 0; i < n; i++) { r.bytes(32); r.bytes(r.compact()); r.bytes(r.compact()); } }
  if (r.o !== buf.length) throw new Error('Extra bytes after the transaction');
  const message = buf.subarray(msgStart);
  const key = (i) => keys[i] ?? `(lookup table #${i})`;

  const problems = [];
  if (nSig !== header.required) problems.push('Signature count does not match the transaction.');
  let validSigs = 0;
  for (let i = 0; i < Math.min(nSig, header.required); i++) {
    if (sigs[i].every((b) => b === 0)) { problems.push(`Missing signature from ${key(i)}.`); continue; }
    const pub = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, b58decode(keys[i])]), format: 'der', type: 'spki' });
    if (crypto.verify(null, message, pub, sigs[i])) validSigs++;
    else problems.push(`Signature from ${key(i)} does not match — the transaction was changed after signing.`);
  }

  const actions = [];
  let nonce = null;
  ixs.forEach((ix, i) => {
    const p = key(ix.prog);
    const d = ix.data;
    if (p === SYSTEM && d.length >= 4) {
      const kind = d.readUInt32LE(0);
      if (kind === 2 && d.length >= 12) actions.push({ type: 'transfer', asset: 'SOL', from: key(ix.accs[0]), to: key(ix.accs[1]), amount: (Number(d.readBigUInt64LE(4)) / 1e9).toString(), raw: d.readBigUInt64LE(4).toString() });
      else if (kind === 4 && i === 0) nonce = { account: key(ix.accs[0]), authority: key(ix.accs[2]) };
      else actions.push({ type: 'system', detail: `System instruction ${kind}` });
    } else if ((p === TOKEN || p === TOKEN22) && d.length >= 9 && (d[0] === 3 || d[0] === 12)) {
      const amount = d.readBigUInt64LE(1).toString();
      if (d[0] === 3) actions.push({ type: 'token', from: key(ix.accs[0]), to: key(ix.accs[1]), owner: key(ix.accs[2]), amountRaw: amount });
      else actions.push({ type: 'token', from: key(ix.accs[0]), mint: key(ix.accs[1]), to: key(ix.accs[2]), owner: key(ix.accs[3]), amountRaw: amount, decimals: d[9], amount: fmtUnits(BigInt(amount), d[9]) });
    } else if (MEMO.includes(p)) actions.push({ type: 'memo', text: d.toString('utf8').slice(0, 200) });
    else if (p === COMPUTE) { /* priority fee settings */ }
    else actions.push({ type: 'program', program: p });
  });
  if (!validSigs && !problems.length) problems.push('Not signed yet — sign it in your wallet first.');
  return {
    chain: 'solana', id: b58encode(sigs[0]), versioned, feePayer: key(0), blockhash, nonce, actions,
    signers: keys.slice(0, header.required), validSignatures: validSigs,
    signed: problems.length === 0,
    problems,
    expiry: nonce ? `Uses a durable nonce (${nonce.account.slice(0, 6)}…) — stays valid until that nonce is used.` : 'Uses a recent blockhash — it expires about a minute after it was signed. To send Solana offline, sign with a durable nonce.',
    expires: !nonce,
    summary: actions.filter((a) => a.type === 'transfer' || a.type === 'token').map((a) => (a.type === 'transfer' ? `${a.amount} SOL → ${a.to}` : `${a.amount ?? a.amountRaw + ' (raw units)'} tokens${a.mint ? ` of ${a.mint.slice(0, 6)}…` : ''} → token account ${a.to}`)).join(', ') || 'Program call (see details)',
  };
}

function fmtUnits(v, decimals) {
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// Accepts Bitcoin hex, Solana base64 or base58; returns the decoded transaction.
export function decodeTx(input) {
  const s = String(input || '').trim().replace(/\s+/g, '');
  if (!s) throw new Error('Paste a signed transaction first.');
  if (s.length > 200000) throw new Error('That is too large to be a transaction.');
  let btcErr = null;
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    try { return { ...decodeBitcoin(s), raw: s.toLowerCase(), encoding: 'hex' }; } catch (err) { btcErr = err; }
  }
  const tries = [];
  if (/^[A-Za-z0-9+/]+=*$/.test(s)) tries.push(['base64', () => Buffer.from(s, 'base64')]);
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) tries.push(['base58', () => b58decode(s)]);
  let lastErr = null;
  for (const [enc, get] of tries) {
    try { const buf = get(); return { ...decodeSolana(buf), raw: buf.toString('base64'), encoding: enc }; } catch (err) { lastErr = err; }
  }
  if (btcErr) throw new Error(`Couldn't read that Bitcoin transaction (${btcErr.message}).`);
  throw new Error(lastErr ? `Couldn't read that as a Bitcoin or Solana transaction (${lastErr.message}).` : "Couldn't read that as a Bitcoin (hex) or Solana (base64/base58) transaction.");
}

// ---------- broadcasting ----------
async function broadcast(item) {
  if (item.chain === 'bitcoin') {
    const res = await fetch(BTC_API + '/tx', { method: 'POST', body: item.raw, headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(20000) });
    const text = (await res.text()).trim();
    if (res.ok) return { ok: true, id: text || item.id };
    if (/already in block chain|txn-already-known|txn-already-in-mempool/i.test(text)) return { ok: true, id: item.id };
    return { ok: false, terminal: true, error: text.slice(0, 300) || `HTTP ${res.status}` };
  }
  const res = await fetch(SOL_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [item.raw, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.result) return { ok: true, id: j.result };
  const msg = j.error?.message || `HTTP ${res.status}`;
  if (/already been processed/i.test(msg)) return { ok: true, id: item.id };
  if (/blockhash not found/i.test(msg)) return { ok: false, terminal: true, expired: true, error: 'Expired: its blockhash is too old. Sign it again (with a durable nonce to send offline).' };
  // An error from the network itself is final; an HTTP failure (rate limit, outage) is retried.
  return { ok: false, terminal: res.ok, error: msg.slice(0, 300) };
}

async function checkStatus(item) {
  try {
    if (item.chain === 'bitcoin') {
      const res = await fetch(`${BTC_API}/tx/${item.id}/status`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const s = await res.json();
      return s.confirmed ? 'confirmed' : 'pending';
    }
    const res = await fetch(SOL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[item.id], { searchTransactionHistory: true }] }) });
    const s = (await res.json())?.result?.value?.[0];
    if (!s) return 'pending';
    if (s.err) return 'failed';
    return s.confirmationStatus === 'finalized' || s.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending';
  } catch { return null; }
}

export function explorerUrl(item) {
  return item.chain === 'bitcoin' ? `https://mempool.space/tx/${item.id}` : `https://solscan.io/tx/${item.id}`;
}

export class Relay {
  constructor(store, onChange = () => {}) {
    this.store = store;
    this.onChange = onChange;
    this.online = null;
    this.busy = false;
    this.timer = setInterval(() => this.tick().catch(() => {}), 20000);
    this.timer.unref?.();
  }
  list() { return this.store.get('relay', []); }
  save(list) { this.store.set('relay', list); this.onChange(); }

  add(input, by = 'this device', note = '') {
    const tx = decodeTx(input);
    const list = this.list();
    const dup = list.find((x) => x.id === tx.id && x.chain === tx.chain);
    if (dup) return dup;
    if (list.filter((x) => x.status === 'queued').length >= 50) throw Object.assign(new Error('The relay queue is full (50 waiting).'), { status: 409 });
    const item = { qid: newId('r_'), ...tx, note: String(note || '').slice(0, 140), by, addedAt: nowIso(), status: tx.signed ? 'queued' : 'needs-signature', attempts: 0, lastTry: null, lastError: null, sentAt: null, sentBy: null, confirmed: false };
    list.unshift(item);
    this.save(list.slice(0, 300));
    setTimeout(() => this.tick().catch(() => {}), 50);
    return item;
  }

  remove(qid) { this.save(this.list().filter((x) => x.qid !== qid)); }

  record(qid, result, by) {
    const list = this.list();
    const it = list.find((x) => x.qid === qid);
    if (!it) return null;
    it.attempts++;
    it.lastTry = nowIso();
    if (result.ok) { it.status = 'sent'; it.sentAt = nowIso(); it.sentBy = by; it.id = result.id || it.id; it.lastError = null; }
    else { it.lastError = result.error; if (result.terminal) it.status = result.expired ? 'expired' : 'rejected'; }
    this.save(list);
    return it;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const list = this.list();
      for (const it of list.filter((x) => x.status === 'queued')) {
        if (it.lastTry && Date.now() - new Date(it.lastTry).getTime() < 15000) continue;
        let result;
        try { result = await broadcast(it); this.online = true; }
        catch { this.online = false; it.lastTry = nowIso(); it.lastError = 'No internet connection yet — will retry automatically.'; this.save(list); break; }
        this.record(it.qid, result, 'this device');
      }
      for (const it of this.list().filter((x) => x.status === 'sent' && !x.confirmed)) {
        const s = await checkStatus(it);
        if (s === null) continue;
        this.online = true;
        if (s === 'confirmed' || s === 'failed') {
          const l = this.list();
          const x = l.find((y) => y.qid === it.qid);
          if (x) { x.confirmed = s === 'confirmed'; if (s === 'failed') { x.status = 'rejected'; x.lastError = 'The network processed it but it failed.'; } this.save(l); }
        }
      }
    } finally { this.busy = false; }
  }

  view() {
    const list = this.list();
    return { online: this.online, counts: { queued: list.filter((x) => x.status === 'queued').length, sent: list.filter((x) => x.status === 'sent').length, confirmed: list.filter((x) => x.confirmed).length }, items: list.map((x) => ({ ...x, explorer: x.status === 'sent' ? explorerUrl(x) : null })) };
  }
}
