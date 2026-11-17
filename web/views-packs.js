import { refresh } from './app.js';
import { $, $$, api, upload, html, mount, toast, icon, fmtBytes, ago } from './shared.js';

const STATUS = {
  verified: { cls: 'ok', label: 'Verified publisher', text: (s) => `Signed by ${s.signer.publisher}${s.signer.official ? ' (official)' : ''}, and every file matches. Safe to install.` },
  'signed-untrusted': { cls: 'warn', label: 'Unknown publisher', text: (s) => `Signed with a key you haven't trusted yet (key ${s.signer.keyId}). The files haven't been changed since signing, but LASTSYNC can't confirm who made it. Trust it only if you know where this USB came from.` },
  unsigned: { cls: 'warn', label: 'Personal pack (unsigned)', text: () => 'Shared by a person, not an official publisher. Every file matches its checksum. Install it if you trust whoever gave it to you.' },
  invalid: { cls: 'bad', label: 'Failed signature check', text: () => 'The signature does not match. This pack may have been tampered with. It cannot be installed.' },
  damaged: { cls: 'bad', label: 'Damaged', text: () => 'Some files are incomplete or changed. Copy the pack again from the original drive.' },
};
const TYPE = { guide: 'Guide', doc: 'Document', note: 'Note', pin: 'Map pin', route: 'Route', map: 'Regional map' };
const GROUPS = [['guides', 'Guides'], ['docs', 'Documents'], ['notes', 'Notes'], ['meetingPoints', 'Meeting points'], ['pins', 'Map pins'], ['routes', 'Routes'], ['maps', 'Regional maps']];

export async function packsView(el) {
  const [data, ex] = await Promise.all([api('/api/packs'), api('/api/packs/exportable')]);
  mount(el, html`
    <div class="page-head"><div><h1>Packs</h1><p>Move guides, maps, routes and notes between offline PCs on a USB drive.</p></div></div>
    <div class="grid grid-2">
      <section class="card stack">
        <h2>Import a pack</h2>
        <p class="muted">Choose a <span class="mono">.lspack</span> file. LASTSYNC checks every file and the publisher's signature before anything is installed — no internet needed.</p>
        <label class="btn primary" style="width:fit-content">${icon('upload')}Choose pack file<input type="file" id="packfile" accept=".lspack" hidden></label>
        <div id="inspect"></div>
      </section>
      <section class="card stack">
        <h2>Installed packs</h2>
        ${data.installed.length ? html`<ul class="list">${data.installed.map((p) => html`<li class="row between"><span><strong>${p.name}</strong> <span class="badge ${STATUS[p.status]?.cls}">${STATUS[p.status]?.label}</span><br><small>${p.publisher} · v${p.version} · published ${String(p.published).slice(0, 10)} · ${p.items.length} items · installed ${ago(p.installedAt)}</small></span><button class="btn small danger" data-remove="${p.id}">Remove</button></li>`)}</ul>`
          : html`<p class="muted">The starter library is built in. Packs you install appear here with their publisher and date.</p>`}
      </section>
    </div>
    <section class="card" style="margin-top:14px">
      <div class="card-title"><h2>Export a pack</h2></div>
      <p class="muted">Only the items you tick go into the pack. Your household plan and contacts are never included unless you tick a meeting point.</p>
      <form id="exportf" class="stack">
        <div class="grid grid-2">
          <label class="field"><span>Pack name</span><input name="name" value="My survival pack" maxlength="80" required></label>
          <label class="field"><span>Description</span><input name="description" maxlength="500" placeholder="What's inside, who it's for"></label>
        </div>
        <div class="grid grid-3">${GROUPS.filter(([k]) => ex[k]?.length).map(([k, label]) => html`<fieldset class="card" style="padding:12px;margin:0;box-shadow:none">
          <legend class="row" style="padding:0 6px"><label class="check"><input type="checkbox" data-all="${k}"> <strong>${label}</strong></label></legend>
          ${ex[k].map((it) => html`<label class="check" style="display:flex;padding:3px 0"><input type="checkbox" name="${k}" value="${it.id}"> <span>${it.name}<br><small class="muted">${it.detail}</small></span></label>`)}
        </fieldset>`)}</div>
        <div class="row">
          ${data.publisher ? html`<label class="check"><input type="checkbox" name="sign" checked> Sign as <strong>${data.publisher.publisher}</strong> <small class="muted">(key ${data.publisher.keyId})</small></label>` : html`<span class="muted">Packs are unsigned. <button type="button" class="btn small ghost" id="mkkey">Create a publisher key</button> to sign them.</span>`}
          <span class="spacer"></span><button class="btn primary">${icon('download')}Create pack</button>
        </div>
        <div id="export-out"></div>
      </form>
    </section>
    ${data.exports.length ? html`<section class="card"><h2>Packs you've made</h2><ul class="list">${data.exports.map((x) => html`<li class="row between"><span><strong class="mono">${x.file}</strong><br><small>${fmtBytes(x.size)} · ${ago(x.createdAt)}</small></span><span class="row"><a class="btn small" href="${x.url}" download>${icon('download')}Save to USB</a><button class="icon-btn" data-delx="${x.file}" aria-label="Delete">${icon('trash')}</button></span></li>`)}</ul></section>` : ''}
    <section class="card"><h2>Trusted publishers</h2>${data.trusted.length ? html`<ul class="list">${data.trusted.map((k) => html`<li><strong>${k.publisher}</strong> <small class="mono muted">${k.keyId}</small> ${k.official ? html`<span class="badge ok">official</span>` : ''}</li>`)}</ul>` : html`<p class="muted">No publisher keys yet. Official LASTSYNC packs will be verified against keys shipped with the app.</p>`}</section>`);

  $('#packfile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const box = $('#inspect');
    try {
      const r = await upload('/api/packs/inspect', file, (p) => mount(box, html`<div class="progress"><i style="width:${Math.round(p * 100)}%"></i></div><small class="muted">Checking ${file.name}…</small>`));
      showInspect(box, r, el);
    } catch (err) { mount(box, html`<div class="notice bad">${err.message}</div>`); }
  });
  $$('[data-remove]', el).forEach((b) => b.addEventListener('click', async () => {
    const p = data.installed.find((x) => x.id === b.dataset.remove);
    if (!confirm(`Remove “${p.name}” and everything it installed?`)) return;
    await api('/api/packs/' + encodeURIComponent(p.id), { method: 'DELETE' });
    toast('Pack removed');
    refresh('packs');
  }));
  $$('[data-delx]', el).forEach((b) => b.addEventListener('click', async () => {
    await api('/api/packs/exports/' + encodeURIComponent(b.dataset.delx), { method: 'DELETE' });
    refresh('packs');
  }));
  $$('[data-all]', el).forEach((c) => c.addEventListener('change', () => $$(`input[name="${c.dataset.all}"]`, el).forEach((x) => { x.checked = c.checked; })));
  $('#mkkey')?.addEventListener('click', async () => {
    const name = prompt('Publisher name shown on your packs (e.g. “Maple Street Neighbors”):');
    if (!name) return;
    try { await api('/api/publisher', { method: 'POST', body: { publisher: name } }); toast('Publisher key created'); refresh('packs'); } catch (err) { toast(err.message, 'bad'); }
  });
  $('#exportf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const items = {};
    for (const [k] of GROUPS) items[k] = $$(`input[name="${k}"]:checked`, f).map((x) => x.value);
    const out = $('#export-out');
    mount(out, html`<p class="muted">Building pack…</p>`);
    try {
      const r = await api('/api/packs/export', { method: 'POST', body: { name: f.name.value, description: f.description.value, items, sign: !!f.sign?.checked } });
      mount(out, html`<div class="notice ok row between"><span><strong>${r.file}</strong><br><small>${r.items} files · ${fmtBytes(r.size)} · ${r.signed ? 'signed' : 'unsigned'}</small></span><a class="btn primary" href="${r.url}" download>${icon('download')}Save to USB</a></div>`);
    } catch (err) { mount(out, html`<div class="notice bad">${err.message}</div>`); }
  });
}

function showInspect(box, r, el) {
  const st = STATUS[r.status] || STATUS.damaged;
  const m = r.manifest;
  const canInstall = r.status !== 'invalid' && r.status !== 'damaged';
  mount(box, html`<div class="notice ${st.cls} stack">
    <div class="row between"><strong>${m.name}</strong><span class="badge ${st.cls}">${st.label}</span></div>
    <small>${m.publisher} · version ${m.version} · published ${String(m.published).slice(0, 10)}</small>
    ${m.description ? html`<p style="margin:0">${m.description}</p>` : ''}
    <p style="margin:0">${st.text(r)}</p>
    ${r.problems.length ? html`<ul style="margin:0">${r.problems.map((p) => html`<li>${p}</li>`)}</ul>` : ''}
    ${r.alreadyInstalled ? html`<small>Version ${r.alreadyInstalled.version} is already installed — installing replaces it.</small>` : ''}
  </div>
  ${canInstall ? html`<div class="stack" style="margin-top:10px">
    <strong>Choose what to install</strong>
    ${m.items.map((it) => html`<label class="check" style="display:flex"><input type="checkbox" checked value="${it.type}:${it.id}"> <span>${it.name} <small class="muted">${TYPE[it.type] || it.type} · ${fmtBytes(it.size)}</small></span></label>`)}
    <div class="row">${r.status === 'signed-untrusted' ? html`<button class="btn" id="trust">Trust this publisher</button>` : ''}<span class="spacer"></span><button class="btn primary" id="install">Install selected</button></div>
  </div>` : ''}`);
  $('#install', box)?.addEventListener('click', async () => {
    const items = $$('input[type=checkbox]:checked', box).map((x) => x.value);
    if (!items.length) { toast('Pick at least one item', 'bad'); return; }
    try {
      const rec = await api('/api/packs/install', { method: 'POST', body: { uploadId: r.uploadId, items } });
      toast(`Installed ${rec.items.length} items from ${rec.name}`);
      refresh('packs');
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('#trust', box)?.addEventListener('click', async () => {
    if (!confirm(`Trust “${m.publisher}” (key ${r.signer.keyId}) for future packs too?`)) return;
    const t = await api('/api/packs/trust', { method: 'POST', body: { uploadId: r.uploadId } });
    showInspect(box, { ...r, ...t }, el);
  });
}
