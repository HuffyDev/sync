import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decodeTx, b58encode, b58decode } from '../server/relay.js';

const cu16 = (n) => (n < 128 ? Buffer.from([n]) : Buffer.from([(n & 0x7f) | 0x80, n >> 7]));
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(12), privateKey };
}
function solTransfer({ nonce = false, tamper = false } = {}) {
  const payer = keypair();
  const to = crypto.randomBytes(32);
  const system = Buffer.alloc(32);
  const nonceAcct = crypto.randomBytes(32);
  const sysvar = b58decode('SysvarRecentB1ockHashes11111111111111111111');
  const keys = nonce ? [payer.pub, nonceAcct, to, sysvar, system] : [payer.pub, to, system];
  const sysIdx = keys.length - 1;
  const lamports = Buffer.alloc(8); lamports.writeBigUInt64LE(1_500_000_000n);
  const transfer = Buffer.concat([Buffer.from([2, 0, 0, 0]), lamports]);
  const ixs = [];
  if (nonce) ixs.push(Buffer.concat([Buffer.from([sysIdx]), cu16(3), Buffer.from([1, 3, 0]), cu16(4), Buffer.from([4, 0, 0, 0])]));
  ixs.push(Buffer.concat([Buffer.from([sysIdx]), cu16(2), Buffer.from([0, nonce ? 2 : 1]), cu16(transfer.length), transfer]));
  const msg = Buffer.concat([Buffer.from([1, 0, nonce ? 2 : 1]), cu16(keys.length), ...keys, crypto.randomBytes(32), cu16(ixs.length), ...ixs]);
  const sig = crypto.sign(null, msg, payer.privateKey);
  if (tamper) msg[msg.length - 1] ^= 1;
  return { b64: Buffer.concat([cu16(1), sig, msg]).toString('base64'), payer: b58encode(payer.pub), to: b58encode(to) };
}

test('base58 round trip', () => {
  const b = Buffer.from([0, 0, 1, 2, 3, 255]);
  assert.deepEqual(b58decode(b58encode(b)), b);
});

test('solana: decodes a signed SOL transfer and verifies the signature', () => {
  const t = solTransfer();
  const d = decodeTx(t.b64);
  assert.equal(d.chain, 'solana');
  assert.equal(d.signed, true);
  assert.equal(d.validSignatures, 1);
  assert.equal(d.actions[0].type, 'transfer');
  assert.equal(d.actions[0].amount, '1.5');
  assert.equal(d.actions[0].to, t.to);
  assert.equal(d.feePayer, t.payer);
  assert.equal(d.expires, true, 'blockhash transactions expire');
  // base58 encoding of the same bytes works too
  assert.equal(decodeTx(b58encode(Buffer.from(t.b64, 'base64'))).id, d.id);
});

test('solana: durable nonce transactions are marked as valid offline', () => {
  const d = decodeTx(solTransfer({ nonce: true }).b64);
  assert.ok(d.nonce);
  assert.equal(d.expires, false);
  assert.equal(d.actions.find((a) => a.type === 'transfer').amount, '1.5');
});

test('solana: a transaction changed after signing is flagged', () => {
  const d = decodeTx(solTransfer({ tamper: true }).b64);
  assert.equal(d.signed, false);
  assert.match(d.problems.join(' '), /changed after signing/);
});

test('bitcoin: decodes outputs with standard addresses (BIP173/BIP350 vectors)', () => {
  const out = (sats, scriptHex) => { const v = Buffer.alloc(8); v.writeBigUInt64LE(BigInt(sats)); const sc = Buffer.from(scriptHex, 'hex'); return Buffer.concat([v, Buffer.from([sc.length]), sc]); };
  const tx = Buffer.concat([
    Buffer.from('01000000', 'hex'), Buffer.from([1]), crypto.randomBytes(32), Buffer.from('00000000', 'hex'), Buffer.from([1, 0x51]), Buffer.from('ffffffff', 'hex'),
    Buffer.from([2]),
    out(50000, '0014751e76e8199196d454941c45d1b3a323f1433bd6'),
    out(1200, '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
    Buffer.from('00000000', 'hex'),
  ]).toString('hex');
  const d = decodeTx(tx);
  assert.equal(d.chain, 'bitcoin');
  assert.equal(d.outputs[0].address, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.equal(d.outputs[1].address, 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0');
  assert.equal(d.outputs[0].btc, '0.00050000');
  assert.equal(d.signed, true);
  assert.equal(d.id.length, 64);
});

test('garbage is rejected with a clear message', () => {
  assert.throws(() => decodeTx('hello world'), /Couldn't read/);
  assert.throws(() => decodeTx(''), /Paste/);
});
