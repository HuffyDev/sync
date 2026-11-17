// Open source manifest: the exact files this copy of LASTSYNC is running,
// each with its SHA-256, plus the version and commit it was built from — so
// anyone can compare it with the public repository.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const REPO = 'https://github.com/HuffyDev/sync';
// Exactly the files the app runs, which every copy ships (GitHub checkout, the
// Windows ZIP, Replit) — so honest copies always produce the same fingerprint.
const INCLUDE = ['server', 'web', 'content', 'package.json', 'LICENSE'];
const SKIP = /(^|\/)(\.git|node_modules|data|dist)(\/|$)/;

export function listFiles(appDir) {
  const out = [];
  const walk = (rel) => {
    const full = path.join(appDir, rel);
    let st;
    try { st = fs.statSync(full); } catch { return; }
    if (SKIP.test(rel)) return;
    if (st.isDirectory()) { for (const name of fs.readdirSync(full).sort()) walk(rel ? `${rel}/${name}` : name); return; }
    out.push({ path: rel, size: st.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
  };
  for (const item of INCLUDE) walk(item);
  return out;
}

function gitCommit(appDir) {
  try {
    const build = JSON.parse(fs.readFileSync(path.join(appDir, 'BUILD.json'), 'utf8'));
    if (build.commit) return { commit: build.commit, builtAt: build.builtAt || null };
  } catch {}
  try {
    const gitDir = path.join(appDir, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return { commit: head };
    const ref = head.replace(/^ref:\s*/, '');
    try { return { commit: fs.readFileSync(path.join(gitDir, ref), 'utf8').trim(), branch: ref.replace('refs/heads/', '') }; } catch {}
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref));
    if (packed) return { commit: packed.split(' ')[0], branch: ref.replace('refs/heads/', '') };
  } catch {}
  return { commit: null };
}

let cache = null;
export function sourceManifest(appDir, version) {
  if (cache) return cache;
  const files = listFiles(appDir);
  const git = gitCommit(appDir);
  // One fingerprint for the whole set, so two copies are easy to compare.
  const combined = crypto.createHash('sha256').update(files.map((f) => `${f.sha256}  ${f.path}`).join('\n')).digest('hex');
  cache = { license: 'MIT', repo: REPO, version, ...git, generatedAt: new Date().toISOString(), totalFiles: files.length, totalBytes: files.reduce((s, f) => s + f.size, 0), fingerprint: combined, files };
  return cache;
}

const TEXT = /\.(js|mjs|cjs|json|md|css|html|txt|cs|yml|yaml|webmanifest|svg)$|^(LICENSE|\.replit|\.gitignore|\.gitattributes)$/;
export function readSourceFile(appDir, version, rel) {
  const m = sourceManifest(appDir, version);
  const f = m.files.find((x) => x.path === rel);
  if (!f || !TEXT.test(path.basename(rel)) || f.size > 2 * 1024 * 1024) return null;
  return fs.readFileSync(path.join(appDir, rel), 'utf8');
}
