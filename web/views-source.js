import { $, $$, api, html, mount, toast, icon, fmtBytes, ago } from './shared.js';

const CONNECTIONS = [
  ['Street map tiles', 'tiles.openfreemap.org', 'When you look at the map while online, or press “Save this area offline”. Requests go through this LASTSYNC server, which keeps a copy.'],
  ['Encyclopedia articles', 'en.wikipedia.org · upload.wikimedia.org', 'Only when you press Download on the Encyclopedia page.'],
  ['On-device AI models', 'huggingface.co · raw.githubusercontent.com', 'Only when you choose to download a model on the On-device AI page. Your browser fetches it directly.'],
  ['Your own AI model', 'the address you type in Settings', 'Only if you connect one yourself. Off by default.'],
];

const COMPONENTS = [
  ['MapLibre GL JS', 'BSD-3-Clause', 'Street map engine'],
  ['Leaflet', 'BSD-2-Clause', 'Small maps (printout, phones)'],
  ['PDF.js', 'Apache-2.0', 'Reading PDFs for search'],
  ['WebLLM', 'Apache-2.0', 'On-device AI engine'],
  ['qrcode-generator', 'MIT', 'Group invite QR codes'],
  ['topojson-client · world-atlas', 'ISC', 'World outline'],
  ['Natural Earth', 'Public domain', 'Country shapes'],
  ['Noto Sans (GoNotoKurrent)', 'OFL-1.1', 'Map label fonts'],
  ['OpenStreetMap · OpenMapTiles', 'ODbL · CC-BY', 'Street map data'],
  ['Wikipedia', 'CC BY-SA 4.0', 'Encyclopedia text'],
];

export async function sourceView(el, args) {
  const m = await api('/api/source');
  if (args[0] === 'file') return fileView(el, m, decodeURIComponent(args.slice(1).join('/')));
  const short = m.commit ? m.commit.slice(0, 7) : null;
  const tree = m.commit ? `${m.repo}/tree/${m.commit}` : m.repo;
  const folders = {};
  for (const f of m.files) (folders[f.path.includes('/') ? f.path.split('/')[0] : '(root)'] ||= []).push(f);
  mount(el, html`
    <div class="os-hero">
      <p class="kicker">Open source</p>
      <h1>Every line is public.</h1>
      <p>LASTSYNC is free and open source under the MIT license. The code that runs this ${m.version ? 'site' : 'app'} is the same code on GitHub — read it, run it yourself, change it, or share it.</p>
      <div class="row" style="margin-top:18px">
        <a class="btn primary" href="${m.repo}" target="_blank" rel="noopener">${icon('code')}View source on GitHub</a>
        <a class="btn" href="${m.repo}/archive/refs/heads/main.zip" target="_blank" rel="noopener">${icon('download')}Download source</a>
      </div>
    </div>
    <div class="stat-row" style="margin-top:14px">
      <div class="stat"><div class="label">License</div><div class="v">MIT</div></div>
      <div class="stat"><div class="label">Version</div><div class="v">${m.version}</div></div>
      <a class="stat" href="${tree}" target="_blank" rel="noopener"><div class="label">Running commit</div><div class="v mono">${short || '—'}</div></a>
      <div class="stat"><div class="label">Files</div><div class="v">${m.totalFiles}</div></div>
    </div>
    <div class="grid grid-2">
      <section class="card">
        <h2>Running right now</h2>
        <p class="muted">This copy is running ${short ? html`commit <a class="mono" href="${tree}" target="_blank" rel="noopener">${short}</a>${m.branch ? ` on ${m.branch}` : ''}` : 'a local build'}. Every file the app runs is listed below with its SHA-256 fingerprint, computed by this server from the files it is actually using. Docs, tests and build tools are on GitHub too.</p>
        <div class="mono os-fp"><span class="label">Combined fingerprint</span><br>${m.fingerprint}</div>
        <p class="muted" style="margin:12px 0 6px">Check it yourself from a fresh copy:</p>
        <pre class="os-code">git clone ${m.repo}.git
cd sync${m.commit ? `\ngit checkout ${short}` : ''}
npm run hashes</pre>
        <p class="faint" style="font-size:.8rem;margin:0">The last line prints the combined fingerprint. If it matches the one above, this copy is identical to the public code.</p>
      </section>
      <section class="card">
        <h2>What it connects to</h2>
        <p class="muted">Everything runs on this ${m.version ? 'server or your own device' : 'machine'}. These are the only outside services it ever contacts, and only when you ask for them:</p>
        <ul class="list">${CONNECTIONS.map(([what, host, when]) => html`<li><strong>${what}</strong> <span class="mono faint" style="font-size:.74rem">${host}</span><br><small class="muted">${when}</small></li>`)}</ul>
        <p class="muted" style="margin:10px 0 0">No accounts, no analytics, no ads, no trackers.</p>
      </section>
    </div>
    <section class="card">
      <div class="card-title"><h2>Source files · ${m.totalFiles}</h2><span class="muted mono" style="font-size:.72rem">${fmtBytes(m.totalBytes)} · generated ${ago(m.generatedAt)}</span></div>
      <input id="os-filter" type="search" placeholder="Filter files…" style="margin-bottom:10px">
      <div id="os-tree">${Object.entries(folders).map(([dir, files]) => html`<details class="os-dir" ${dir === 'server' ? 'open' : ''}><summary><span class="mono">${dir}/</span><span class="faint mono">${files.length} files</span></summary>
        <table class="table os-table"><tbody>${files.map((f) => html`<tr data-path="${f.path}"><td class="mono"><a href="#/source/file/${encodeURIComponent(f.path)}">${f.path}</a></td><td class="mono faint">${fmtBytes(f.size)}</td><td class="mono faint" title="${f.sha256}">${f.sha256.slice(0, 16)}…</td><td><a class="icon-btn" href="${m.repo}/blob/${m.commit || 'main'}/${f.path}" target="_blank" rel="noopener" title="Open on GitHub">${icon('external')}</a></td></tr>`)}</tbody></table></details>`)}</div>
    </section>
    <div class="grid grid-2">
      <section class="card"><h2>Built with</h2><ul class="list">${COMPONENTS.map(([n, lic, what]) => html`<li class="row between"><span><strong>${n}</strong><br><small class="muted">${what}</small></span><span class="badge">${lic}</span></li>`)}</ul></section>
      <section class="card stack"><h2>Get involved</h2>
        <p class="muted" style="margin:0">Found a mistake in a guide, a bug, or have an idea? Everything happens in the open.</p>
        <div class="row"><a class="btn" href="${m.repo}/issues" target="_blank" rel="noopener">Report an issue</a><a class="btn" href="${m.repo}/pulls" target="_blank" rel="noopener">Pull requests</a><a class="btn" href="${m.repo}/blob/main/LICENSE" target="_blank" rel="noopener">License text</a></div>
        <p class="muted" style="margin:0">You may use, copy, modify and distribute LASTSYNC freely, including commercially, as long as the license notice stays with it.</p>
      </section>
    </div>`);
  $('#os-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('#os-tree tr').forEach((tr) => { tr.style.display = !q || tr.dataset.path.toLowerCase().includes(q) ? '' : 'none'; });
    $$('#os-tree details').forEach((d) => { if (q) d.open = true; });
  });
}

async function fileView(el, m, rel) {
  const f = m.files.find((x) => x.path === rel);
  if (!f) { mount(el, html`<div class="empty">That file isn't part of LASTSYNC. <a href="#/source">All files</a></div>`); return; }
  const res = await fetch('/api/source/file?path=' + encodeURIComponent(rel));
  const text = res.ok ? await res.text() : null;
  mount(el, html`
    <div class="page-head"><div><p class="muted" style="margin:0 0 4px"><a href="#/source">Open source</a> › ${rel.split('/').slice(0, -1).join('/') || 'root'}</p><h1 class="mono" style="font-size:1.2rem">${rel}</h1>
      <div class="meta-line"><span>${fmtBytes(f.size)}</span><span title="SHA-256">SHA-256 ${f.sha256}</span></div></div>
      <div class="row"><button class="btn" id="copy-hash">Copy fingerprint</button><a class="btn" href="${m.repo}/blob/${m.commit || 'main'}/${rel}" target="_blank" rel="noopener">${icon('external')}On GitHub</a></div></div>
    ${text == null ? html`<div class="empty">This is a binary or very large file — view it on GitHub.</div>`
      : html`<pre class="os-code os-file">${text.split('\n').map((line, i) => html`<span class="ln">${i + 1}</span>${line}\n`)}</pre>`}`);
  $('#copy-hash').addEventListener('click', () => navigator.clipboard?.writeText(f.sha256).then(() => toast('Fingerprint copied'), () => toast(f.sha256)));
}
