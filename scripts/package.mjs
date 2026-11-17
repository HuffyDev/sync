// Assembles the portable folder that goes into the Windows ZIP:
//
//   LASTSYNC/
//     LASTSYNC.exe        launcher (compiled separately from launcher/LastSync.cs)
//     LASTSYNC.cmd        fallback launcher
//     README.txt
//     runtime/node.exe    bundled Node.js runtime
//     app/                server, web app, bundled guides
//     data/               created on first run — your plan, notes, maps
//
// Usage: node scripts/package.mjs <path to node.exe> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeExe = process.argv[2];
const out = path.resolve(process.argv[3] || path.join(root, 'dist', 'LASTSYNC'));
if (!nodeExe || !fs.existsSync(nodeExe)) {
  console.error('Usage: node scripts/package.mjs <path to node.exe> [out dir]');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'runtime'), { recursive: true });
fs.mkdirSync(path.join(out, 'app'), { recursive: true });
fs.mkdirSync(path.join(out, 'data'), { recursive: true });

for (const item of ['package.json', 'server', 'web', 'content', 'LICENSE']) {
  const src = path.join(root, item);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, 'app', item), { recursive: true });
}
fs.copyFileSync(nodeExe, path.join(out, 'runtime', 'node.exe'));

fs.writeFileSync(path.join(out, 'LASTSYNC.cmd'), [
  '@echo off',
  'title LASTSYNC',
  'cd /d "%~dp0"',
  'set LASTSYNC_OPEN=1',
  'if "%LASTSYNC_DATA%"=="" set LASTSYNC_DATA=%~dp0data',
  '"%~dp0runtime\\node.exe" "%~dp0app\\server\\index.js"',
  'if errorlevel 1 pause',
  '',
].join('\r\n'));

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(out, 'README.txt'), `LASTSYNC ${version} — offline survival kit
=============================================

START
  Double-click LASTSYNC.exe. Your browser opens http://localhost:8787.
  Keep the black LASTSYNC window open while you use it. Close it to stop.
  (If LASTSYNC.exe is blocked, use LASTSYNC.cmd instead.)

NO INTERNET NEEDED
  Everything — guides, search, Ask, maps, your plan — runs on this PC.
  Do the setup now, while you still have internet:
    1. Open Readiness and fix what it lists.
    2. Fill in My plan and print the survival sheet.
    3. Import a regional map (.mbtiles) for your area.
    4. Add your own PDFs and notes to the Library.

USB DRIVE
  You can run LASTSYNC straight from a USB drive. Your data is saved in the
  "data" folder next to LASTSYNC.exe, so it travels with the drive.

GROUP OVER WI-FI
  Group > Start group shows a QR code. Phones on the same Wi-Fi scan it and
  join in their browser. If Windows asks whether to allow LASTSYNC on
  private networks, choose Allow. No router? Turn on Mobile hotspot in
  Windows Settings > Network & internet.

FIRST LAUNCH WARNING
  Windows SmartScreen may say the app is unrecognized because it isn't
  code-signed. Click "More info" > "Run anyway".
`.replace(/\n/g, '\r\n'));

console.log('Packaged into', out);
