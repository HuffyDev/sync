// LASTSYNC packs: one file you can carry on a USB drive that bundles guides,
// documents, notes, pins, routes and maps.
//
// File layout:
//   "LSPACK1\n" + <header length in bytes> + "\n" + <header JSON> + <file bytes...>
// The header holds the manifest (every item, its size and SHA-256) and an
// optional Ed25519 signature over the manifest. File bytes follow in
// manifest order, so a large map never has to be loaded into memory.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const MAGIC = 'LSPACK1\n';
const MAX_HEADER = 64 * 1024 * 1024;

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function keyIdFor(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function generateKeyPair(publisher) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { publisher, keyId: keyIdFor(pub), publicKey: pub, privateKey: priv };
}

export function signManifest(manifest, privateKeyPem, publicKeyPem) {
  const sig = crypto.sign(null, Buffer.from(canonical(manifest)), privateKeyPem);
  return { alg: 'ed25519', keyId: keyIdFor(publicKeyPem), publicKey: publicKeyPem, sig: sig.toString('base64') };
}

async function hashFile(file) {
  const h = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { h.update(chunk); size += chunk.length; }
  return { sha256: h.digest('hex'), size };
}

function hashBuffer(buf) {
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

// entries: [{ item: {type,id,name,meta}, file?: path, buffer?: Buffer }]
export async function writePack(outFile, info, entries, signer) {
  const items = [];
  let offset = 0;
  for (const e of entries) {
    let h = { sha256: null, size: 0 };
    if (e.file) h = await hashFile(e.file);
    else if (e.buffer) h = hashBuffer(e.buffer);
    items.push({ ...e.item, size: h.size, sha256: h.sha256, offset });
    offset += h.size;
  }
  const manifest = {
    id: info.id,
    name: info.name,
    publisher: info.publisher || 'Personal pack',
    version: info.version || '1',
    published: info.published || new Date().toISOString(),
    description: info.description || '',
    items,
  };
  const header = { format: 'lastsync-pack', formatVersion: 1, manifest };
  if (signer) header.signature = signManifest(manifest, signer.privateKey, signer.publicKey);
  const headerBuf = Buffer.from(JSON.stringify(header));
  const tmp = outFile + '.tmp';
  const out = fs.createWriteStream(tmp);
  out.write(MAGIC + headerBuf.length + '\n');
  out.write(headerBuf);
  for (const e of entries) {
    if (e.file) await pipeline(fs.createReadStream(e.file), out, { end: false });
    else if (e.buffer) await new Promise((r) => (out.write(e.buffer) ? r() : out.once('drain', r)));
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  await fsp.rename(tmp, outFile);
  return manifest;
}

export async function readHeader(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await fh.read(head, 0, 64, 0);
    const str = head.subarray(0, bytesRead).toString('latin1');
    if (!str.startsWith(MAGIC)) throw new Error('This is not a LASTSYNC pack file.');
    const nl = str.indexOf('\n', MAGIC.length);
    const len = Number(str.slice(MAGIC.length, nl));
    if (!Number.isInteger(len) || len <= 0 || len > MAX_HEADER) throw new Error('The pack header is damaged.');
    const headerStart = nl + 1;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, headerStart);
    const header = JSON.parse(buf.toString('utf8'));
    if (header.format !== 'lastsync-pack' || !header.manifest?.items) throw new Error('The pack header is damaged.');
    return { header, dataStart: headerStart + len };
  } finally {
    await fh.close();
  }
}

// trustedKeys: [{ keyId, publisher, publicKey }]
export async function verifyPack(file, trustedKeys = []) {
  const { header, dataStart } = await readHeader(file);
  const { manifest, signature } = header;
  const problems = [];
  const stat = await fsp.stat(file);

  for (const item of manifest.items) {
    if (!item.size) continue;
    const end = dataStart + item.offset + item.size;
    if (end > stat.size) { problems.push(`${item.name}: file is cut short`); continue; }
    const h = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { start: dataStart + item.offset, end: end - 1 })) h.update(chunk);
    if (h.digest('hex') !== item.sha256) problems.push(`${item.name}: contents don't match the manifest`);
  }

  let status = 'unsigned';
  let signer = null;
  if (signature) {
    let valid = false;
    try {
      valid = crypto.verify(null, Buffer.from(canonical(manifest)), signature.publicKey, Buffer.from(signature.sig, 'base64'));
    } catch { valid = false; }
    const keyId = (() => { try { return keyIdFor(signature.publicKey); } catch { return null; } })();
    if (!valid || keyId !== signature.keyId) {
      status = 'invalid';
      problems.push('The publisher signature does not match. The pack may have been altered.');
    } else {
      const trusted = trustedKeys.find((k) => k.keyId === keyId);
      if (trusted) {
        status = trusted.publisher === manifest.publisher ? 'verified' : 'invalid';
        if (status === 'invalid') problems.push(`Signed by ${trusted.publisher}, but the pack claims to be from ${manifest.publisher}.`);
        signer = { keyId, publisher: trusted.publisher, official: !!trusted.official };
      } else {
        status = 'signed-untrusted';
        signer = { keyId, publisher: manifest.publisher };
      }
    }
  }
  if (problems.length && status !== 'invalid') status = 'damaged';
  return { manifest, status, signer, problems, dataStart, ok: problems.length === 0 };
}

export async function extractItem(file, dataStart, item, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  if (!item.size) await fsp.writeFile(tmp, '');
  else await pipeline(fs.createReadStream(file, { start: dataStart + item.offset, end: dataStart + item.offset + item.size - 1 }), fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
}

export async function readItemText(file, dataStart, item) {
  if (!item.size) return '';
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(item.size);
    await fh.read(buf, 0, item.size, dataStart + item.offset);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}
