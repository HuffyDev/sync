import { $, $$, api, html, mount, toast, icon, markdown, fmtBytes, ago, esc } from './shared.js';
import { topicLabel, refresh, togglePin, isPinned } from './app.js';
import * as ai from './ai.js';

// ---------- offline encyclopedia ----------
export async function wikiView(el) {
  const st = await api('/api/wiki');
  const pct = Math.round((100 * st.saved) / st.total);
  mount(el, html`
    <div class="page-head"><div><h1>Offline encyclopedia</h1><p>${st.total} survival-relevant Wikipedia articles — download them while you have internet, read and search them with none.</p></div>
      <div class="row">${st.job.running ? '' : html`<button class="btn primary" id="dl-all" ${st.saved === st.total ? 'disabled' : ''}>${icon('download')}${st.saved ? `Download missing (${st.total - st.saved})` : 'Download all'}</button>`}</div></div>
    <div class="stat-row">
      <div class="stat"><div class="label">Articles on disk</div><div class="v ${st.saved === st.total ? 'ok' : st.saved ? 'warn' : 'bad'}">${st.saved}/${st.total}</div></div>
      <div class="stat"><div class="label">Coverage</div><div class="v">${pct}%</div></div>
      <div class="stat"><div class="label">Size on disk</div><div class="v">${fmtBytes(st.bytes)}</div></div>
      <div class="stat"><div class="label">Source</div><div class="v" style="font-size:1rem;padding-top:6px">Wikipedia · CC BY-SA</div></div>
    </div>
    <div id="job"></div>
    ${st.catalog.map((c) => html`<section class="card">
      <div class="card-title"><h2>${c.label}</h2><span class="badge">${c.titles.filter((t) => t.saved).length}/${c.titles.length}</span></div>
      <div class="wiki-grid">${c.titles.map((t) => t.saved
        ? html`<a class="wiki-card" href="#/wiki/${t.id}">${t.image ? html`<img src="/files/wiki/${t.image}" alt="" loading="lazy">` : html`<div class="wiki-noimg">${icon('book')}</div>`}<div><strong>${t.title}</strong><small>${t.summary.slice(0, 110)}${t.summary.length > 110 ? '…' : ''}</small></div></a>`
        : html`<div class="wiki-card missing"><div class="wiki-noimg">${icon('download')}</div><div><strong>${t.title}</strong><small>Not downloaded yet</small></div></div>`)}</div>
    </section>`)}
    <p class="faint" style="font-size:.8rem;margin-top:16px">Article text from Wikipedia, the free encyclopedia, under CC BY-SA 4.0. Images credited on each article. Content may contain errors — for medical emergencies, follow the first aid guides and get professional help when you can.</p>`);
  $('#dl-all')?.addEventListener('click', async () => {
    try { await api('/api/wiki/download', { method: 'POST', body: {} }); poll(); } catch (err) { toast(err.message, 'bad'); }
  });
  let timer = null;
  const poll = async () => {
    const s = await api('/api/wiki').catch(() => null);
    if (!s || !$('#job')) return;
    const j = s.job;
    if (j.running) {
      mount($('#job'), html`<div class="notice" style="margin-bottom:14px"><div class="row between"><strong>Downloading ${j.current || '…'}</strong><span class="mono">${j.done}/${j.total}</span></div><div class="progress" style="margin-top:8px"><i style="width:${j.total ? Math.round((100 * j.done) / j.total) : 0}%"></i></div></div>`);
      timer = setTimeout(poll, 1200);
    } else {
      if (j.total) {
        toast(`Encyclopedia: ${j.done - j.errors.length} articles saved${j.errors.length ? `, ${j.errors.length} failed` : ''}`, j.errors.length && j.errors.length === j.done ? 'bad' : '');
        if (j.errors.length === j.done && j.done) toast('Could not reach Wikipedia — are you online?', 'bad');
      }
      refresh('wiki');
    }
  };
  if (st.job.running) poll();
  return () => clearTimeout(timer);
}

export async function wikiArticleView(el, [id, section]) {
  const a = await api('/api/wiki/article/' + encodeURIComponent(id));
  const pinned = await isPinned('wiki:' + a.id);
  mount(el, html`
    <div class="page-head"><div><p class="muted" style="margin:0 0 4px"><a href="#/wiki">Encyclopedia</a> › ${topicLabel(a.topic)}</p><h1>${a.title}</h1>
      <div class="meta-line"><span>Wikipedia</span><span>Revision ${a.revid || '—'} · ${String(a.revisedAt || '').slice(0, 10)}</span><span>Saved ${ago(a.savedAt)}</span><span>${a.license}</span></div></div>
      <div class="row no-print"><button class="btn" id="pin">${icon('star')}${pinned ? 'Pinned' : 'Pin'}</button><button class="btn" data-print>${icon('print')}Print</button></div></div>
    <div class="guide-layout">
      <article class="prose">
        ${a.image ? html`<figure class="wiki-hero"><img src="/files/wiki/${a.image}" alt=""><figcaption>${a.imageCredit ? `Image: ${a.imageCredit.artist} · ${a.imageCredit.license} · Wikimedia Commons` : 'Image: Wikimedia Commons'}</figcaption></figure>` : ''}
        ${a.sections.map((s, i) => html`<section id="s-${i}">${i ? html`<h2>${s.heading}</h2>` : ''}${markdown(s.text)}</section>`)}
        <hr><p class="faint" style="font-size:.8rem">From the Wikipedia article “${a.title}” (${a.url}), text under CC BY-SA 4.0. Saved for offline use by LASTSYNC; it may be out of date.</p>
      </article>
      <nav class="toc no-print" aria-label="Sections"><strong style="display:block;margin-bottom:8px" class="label">Sections</strong>${a.sections.map((s, i) => html`<a href="#/wiki/${a.id}/${i}">${i ? s.heading : 'Overview'}</a>`)}</nav>
    </div>`);
  $('#pin').addEventListener('click', async (e) => {
    const on = await togglePin({ kind: 'wiki', id: 'wiki:' + a.id, title: a.title, href: '#/wiki/' + a.id });
    mount(e.currentTarget, html`${icon('star')}${on ? 'Pinned' : 'Pin'}`);
  });
  if (section) {
    const t = document.getElementById('s-' + section);
    if (t) requestAnimationFrame(() => { t.scrollIntoView({ block: 'start' }); t.classList.add('section-flash'); });
  }
}

// ---------- gear checklist ----------
export async function kitView(el, _args, query) {
  const d = await api('/api/kit');
  let cat = query.get('c') || 'all';
  const render = () => {
    const s = d.summary;
    const items = d.items.filter((k) => cat === 'all' || k.cat === cat);
    mount(el, html`
      <div class="page-head"><div><h1>Survival gear</h1><p>What to have before the lights go out — what each item is for, what to look for, and roughly what it costs. Tick what you already own.</p></div>
        <div class="kit-meter"><div class="ring" style="--p:${s.pct};--ring-color:${s.pct === 100 ? 'var(--safe)' : s.pct >= 50 ? 'var(--warn)' : 'var(--help)'}" data-label="${s.pct}%"></div><div><div class="label">Essentials covered</div><div class="mono" style="color:#fff;font-size:1.1rem">${s.covered}/${s.essentials}</div><small class="muted">${s.owned} of ${s.total} items owned</small></div></div></div>
      <div class="chips" style="margin-bottom:16px">
        <button class="chip ${cat === 'all' ? 'on' : ''}" data-cat="all">All</button>
        ${d.categories.map(([k, label]) => html`<button class="chip ${cat === k ? 'on' : ''}" data-cat="${k}">${label}</button>`)}
      </div>
      <div class="kit-grid">${items.map((k) => html`<article class="card kit-item ${d.have[k.id] ? 'owned' : ''}">
        <div class="row between"><span class="badge ${k.level === 'essential' ? 'bad' : 'blue'}">${k.level}</span><span class="label">${d.categories.find((c) => c[0] === k.cat)[1]}</span></div>
        <h3 class="kit-name">${k.name}</h3>
        <p class="muted" style="margin:0 0 8px">${k.why}</p>
        <ul class="feature-list">${k.look.map((l) => html`<li>${l}</li>`)}</ul>
        <div class="row between" style="margin-top:auto;padding-top:12px">
          <span class="mono" style="color:#fff">${k.price}</span>
          <label class="check"><input type="checkbox" data-have="${k.id}" ${d.have[k.id] ? 'checked' : ''}> I have this</label>
        </div>
        <a class="btn small" style="margin-top:10px" href="https://duckduckgo.com/?q=${encodeURIComponent(k.name + ' ' + k.look[0])}" target="_blank" rel="noopener noreferrer">${icon('search')}Search shops online</a>
      </article>`)}</div>
      <p class="faint" style="font-size:.8rem;margin-top:16px">Prices are rough US ranges, not recommendations of any brand or shop. LASTSYNC earns nothing from these links.</p>`);
    $$('[data-cat]', el).forEach((b) => b.addEventListener('click', () => { cat = b.dataset.cat; history.replaceState(null, '', '#/kit' + (cat === 'all' ? '' : '?c=' + cat)); render(); }));
    $$('[data-have]', el).forEach((c) => c.addEventListener('change', async () => {
      try {
        const r = await api('/api/kit/' + c.dataset.have, { method: 'PUT', body: { have: c.checked } });
        d.have = r.have; d.summary = r.summary; render();
      } catch (err) { toast(err.message, 'bad'); }
    }));
  };
  render();
}

// ---------- on-device AI ----------
export async function aiView(el) {
  const sup = ai.support();
  const [gpu, cached] = await Promise.all([sup.ok ? ai.gpuInfo() : null, sup.ok ? ai.cachedTiers() : []]);
  const pref = ai.preferred();
  const live = ai.loaded();
  const status = await api('/api/status');
  mount(el, html`
    <div class="page-head"><div><h1>On-device AI</h1><p>A small AI model that runs inside this browser on your own graphics chip. Download it once while online — after that it answers with no internet and no servers, using only your saved library.</p></div></div>
    ${!sup.ok ? html`<div class="notice warn" style="margin-bottom:14px"><strong>Not available in this browser.</strong> ${sup.why} Ask still works with built-in answers.</div>`
      : html`<div class="notice ${gpu ? 'ok' : 'warn'}" style="margin-bottom:14px"><strong>${gpu ? 'Graphics chip found' : 'No usable graphics chip found'}</strong>${gpu ? html` — <span class="mono">${[gpu.vendor, gpu.arch, gpu.desc].filter(Boolean).join(' · ') || 'WebGPU adapter'}${gpu.fallback ? ' (software fallback — will be slow)' : ''}</span>` : ''}</div>`}
    ${status.mode === 'public' ? html`<div class="notice" style="margin-bottom:14px">The model downloads to <strong>your</strong> device, not to this server. It stays in this browser's storage until you remove it.</div>` : ''}
    <div class="grid grid-3">${ai.TIERS.map((t) => {
      const isCached = cached.includes(t.id);
      const isLive = live?.id === t.id;
      return html`<section class="card tier ${pref?.id === t.id ? 'chosen' : ''}">
        <div class="row between"><span class="label">${t.device}</span>${isLive ? html`<span class="badge ok">Loaded</span>` : isCached ? html`<span class="badge blue">On device</span>` : html`<span class="badge">Not downloaded</span>`}</div>
        <div class="tier-name">${t.name}</div>
        <div class="tier-size">${t.size}</div>
        <p class="muted" style="margin:6px 0 10px">${t.blurb} Needs about ${t.vram} of graphics memory.</p>
        <div class="mono faint" style="font-size:.66rem;letter-spacing:.06em;margin-bottom:12px">${t.model}</div>
        <div id="prog-${t.id}"></div>
        <div class="row" style="margin-top:auto">
          <button class="btn ${isCached ? '' : 'primary'}" data-load="${t.id}" ${sup.ok ? '' : 'disabled'}>${icon(isCached ? 'check' : 'download')}${isLive ? 'Use for Ask' : isCached ? 'Load & use' : 'Download & use'}</button>
          ${isCached ? html`<button class="btn ghost small" data-del="${t.id}">Remove</button>` : ''}
        </div>
      </section>`;
    })}</div>
    <section class="card" style="margin-top:14px"><h2>How it answers</h2><p class="muted" style="margin:0">When you ask a question, LASTSYNC first finds the best passages in your guides, encyclopedia, PDFs and notes. Only those passages go to the model, which must cite them. If it can't find an answer there, it says so. Without a model, Ask quotes the best matching section directly. ${pref ? html`Ask currently uses <strong>${pref.name}</strong>. <button class="btn small ghost" id="use-builtin">Switch to built-in answers</button>` : 'Ask currently uses built-in answers.'}</p></section>`);
  $$('[data-load]', el).forEach((b) => b.addEventListener('click', async () => {
    const t = ai.TIERS.find((x) => x.id === b.dataset.load);
    const box = $('#prog-' + t.id);
    $$('[data-load]', el).forEach((x) => { x.disabled = true; });
    try {
      await ai.load(t, (p, text) => { if (box) mount(box, html`<div class="progress"><i style="width:${Math.round(p * 100)}%"></i></div><small class="muted mono" style="display:block;margin:6px 0 10px;font-size:.66rem">${text.slice(0, 120)}</small>`); });
      ai.setPreferred(t.id);
      toast(`${t.name} is ready. Ask will use it.`);
      refresh('ai');
    } catch (err) {
      $$('[data-load]', el).forEach((x) => { x.disabled = false; });
      if (box) mount(box, html`<div class="notice bad" style="margin-bottom:10px">${/fetch|network/i.test(err.message) ? 'Download failed — the model needs an internet connection the first time.' : err.message}</div>`);
    }
  }));
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => {
    const t = ai.TIERS.find((x) => x.id === b.dataset.del);
    if (!confirm(`Remove the ${t.name} model from this browser? You'll need internet to download it again.`)) return;
    await ai.remove(t);
    if (ai.preferred()?.id === t.id) ai.setPreferred(null);
    refresh('ai');
  }));
  $('#use-builtin')?.addEventListener('click', () => { ai.setPreferred(null); refresh('ai'); });
}

export { esc };
