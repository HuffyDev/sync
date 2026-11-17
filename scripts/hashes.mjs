// Prints the SHA-256 of every app file — the same list the in-app
// "Open source" page shows — so you can compare a running copy with a
// fresh checkout:  node scripts/hashes.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceManifest } from '../server/source.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const m = sourceManifest(root, 'local');
for (const f of m.files) console.log(`${f.sha256}  ${f.path}`);
console.log(`\n${m.totalFiles} files · fingerprint ${m.fingerprint}`);
