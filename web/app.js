import { $, $$, api, html, mount, raw, esc, toast, icon, highlight, markdown, ago, fmtBytes, groupStream, beep, slugify } from './shared.js';
import { libraryView, docView, notesView, noteView } from './views-library.js';
import { mapView } from './views-map.js';
import { planView, printView } from './views-plan.js';
import { groupView, logView } from './views-group.js';
import { packsView } from './views-packs.js';

const NAV = [
  ['#/', 'home', 'Home'],
  ['#/search', 'search', 'Search'],
  ['#/ask', 'ask', 'Ask'],
  ['#/map', 'map', 'Maps'],
  ['#/plan', 'plan', 'My plan'],
  null,
  ['#/library', 'book', 'Library'],
  ['#/notes', 'note', 'Notes'],
  ['#/group', 'group', 'Group'],
  ['#/log', 'log', 'Outage log'],
  null,
  ['#/packs', 'pack', 'Packs'],
  ['#/ready', 'ready', 'Readiness'],
  ['#/settings', 'settings', 'Settings'],
];

const ROUTES = {
  '': dashboard,
  search: searchView,
  ask: askView,
  guide: guideView,
  library: libraryView,
  doc: docView,
  notes: notesView,
  note: noteView,
  map: mapView,
  plan: planView,
  print: printView,
  group: groupView,
  log: logView,
  packs: packsView,
  ready: readyView,
  settings: settingsView,
};

let cleanup = null;
export const state = { group: null };

function renderNav(active) {
  mount($('#nav'), html`${NAV.map((n) => (n ? html`<a href="${n[0]}" class="${active === n[0] ? 'on' : ''}">${icon(n[1])}<span>${n[2]}</span>${n[0] === '#/group' && state.group ? html`<span class="badge ${state.group.help ? 'bad' : 'ok'}">${state.group.help ? 'HELP' : 'live'}</span>` : ''}</a>` : html`<div class="nav-sep"></div>`))}`);
}

export function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = h.split('?');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || '', args: parts.slice(1), query: new URLSearchParams(q) };
}

async function route() {
  const { name, args, query } = parseHash();
  const view = ROUTES[name] || notFound;
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  renderNav(name ? '#/' + name : '#/');
  const el = $('#view');
  el.innerHTML = '';
  try {
    cleanup = (await view(el, args, query)) || null;
  } catch (err) {
    console.error(err);
    mount(el, html`<div class="notice bad"><strong>Something went wrong.</strong> ${err.message}</div>`);
  }
  if (!location.hash.includes('#') || !query.get('keep')) window.scrollTo(0, 0);
  document.title = (el.querySelector('h1')?.textContent || 'LASTSYNC') + (name ? ' · LASTSYNC' : '');
}

function notFound(el) {
  mount(el, html`<div class="empty">That page doesn't exist. <a href="#/">Go home</a></div>`);
}

export function hrefFor(ref) {
  if (!ref) return '#/';
  if (ref.guide) return `#/guide/${encodeURIComponent(ref.guide)}${ref.section ? '/' + encodeURIComponent(ref.section) : ''}`;
  if (ref.doc) return `#/doc/${encodeURIComponent(ref.doc)}/${ref.page || 1}`;
  if (ref.note) return `#/note/${encodeURIComponent(ref.note)}`;
  if (ref.pin) return `#/map?pin=${encodeURIComponent(ref.pin)}`;
  if (ref.route) return `#/map?route=${encodeURIComponent(ref.route)}`;
  if (ref.plan === 'meeting' && ref.lat != null) return `#/map?lat=${ref.lat}&lon=${ref.lon}`;
  if (ref.plan) return '#/plan';
  return '#/';
}

export async function togglePin(item) {
  const pinned = await api('/api/pinned', { method: 'POST', body: item });
  const on = pinned.some((p) => p.id === item.id);
  toast(on ? 'Pinned to your dashboard' : 'Removed from your dashboard');
  return on;
}

export async function isPinned(id) {
  const s = await api('/api/settings');
  return (s.pinned || []).some((p) => p.id === id);
}

const KIND_LABEL = { guide: 'Guide', doc: 'Document', note: 'Note', pin: 'Map pin', route: 'Route', plan: 'My plan', pdf: 'PDF', text: 'Text' };
const TOPIC_LABEL = {
  water: 'Water', power: 'Power outage', food: 'Food', 'first-aid': 'First aid', shelter: 'Shelter & warmth',
  sanitation: 'Sanitation', communications: 'Communications', preparedness: 'Emergency kit', maps: 'Maps', notes: 'Notes', plan: 'My plan', documents: 'Documents',
};
export const topicLabel = (t) => TOPIC_LABEL[t] || (t ? t[0].toUpperCase() + t.slice(1).replace(/-/g, ' ') : 'Other');

// ---------- dashboard ----------
async function dashboard(el) {
  const d = await api('/api/dashboard');
  const r = d.readiness;
  const ringColor = r.score >= 80 ? 'var(--safe)' : r.score >= 50 ? 'var(--accent)' : 'var(--help)';
  const byTopic = {};
  for (const g of d.guides) (byTopic[g.topic] ||= []).push(g);
  mount(el, html`
    <div class="page-head"><div><h1>Survival dashboard</h1><p>Everything here works without the internet.</p></div></div>
    ${d.group?.help?.length ? html`<div class="notice bad" style="margin-bottom:16px"><strong>${d.group.help.at(-1).fromName} asked for help</strong> ${ago(d.group.help.at(-1).ts)}. <a href="#/group">Open the group</a></div>` : ''}
    <form class="hero-search" id="dash-search" role="search">
      ${icon('search')}
      <input type="search" name="q" placeholder="Search guides, files, notes and map pins — e.g. “cleaning water”" aria-label="Search" autofocus>
    </form>
    <div class="big-tiles">
      <a class="tile" href="#/search">${icon('search')}<strong>Search</strong><span>Every guide, PDF, note and pin on this PC</span></a>
      <a class="tile" href="#/ask">${icon('ask')}<strong>Ask</strong><span>Answers from your library, with sources</span></a>
      <a class="tile" href="#/map">${icon('map')}<strong>Maps</strong><span>Offline maps, pins, routes and GPS</span></a>
      <a class="tile" href="#/plan">${icon('plan')}<strong>My plan</strong><span>Contacts, meeting points, checklist</span></a>
    </div>
    <div class="grid grid-2">
      <section class="card">
        <div class="card-title"><h2>Quick help</h2><a class="btn small ghost" href="#/library">All guides</a></div>
        <div class="chips">
          ${Object.entries(byTopic).map(([t, gs]) => gs.map((g) => html`<a class="chip" href="#/guide/${g.id}">${topicLabel(t)}</a>`))}
        </div>
        ${d.meetingPoints.length ? html`<hr><h3>Meeting points</h3><ul class="list">${d.meetingPoints.slice(0, 3).map((m) => html`<li class="row between"><span><strong>${m.name}</strong><br><small>${m.address || m.when || ''}</small></span>${m.lat != null ? html`<a class="btn small" href="#/map?lat=${m.lat}&lon=${m.lon}">${icon('map')}Show</a>` : ''}</li>`)}</ul>` : ''}
      </section>
      <section class="card">
        <div class="card-title"><h2>Ready for an outage?</h2><a class="btn small ghost" href="#/ready">Details</a></div>
        <div class="score">
          <div class="ring" style="--p:${r.score};--ring-color:${ringColor}" data-label="${r.score}%"></div>
          <div>${r.todo.length ? html`<strong>${r.todo.length} thing${r.todo.length > 1 ? 's' : ''} to do while you still can</strong>` : html`<strong>You're ready.</strong>`}<br><small>Checks your guides, maps, plan and printouts.</small></div>
        </div>
        ${r.todo.length ? html`<ul class="list" style="margin-top:10px">${r.todo.slice(0, 4).map((t) => html`<li><a href="${t.href}" class="item-link"><strong>${t.label}</strong><br><small>${t.detail}</small></a></li>`)}</ul>` : ''}
      </section>
      <section class="card">
        <div class="card-title"><h2>Pinned</h2></div>
        ${d.pinned.length
          ? html`<ul class="list">${d.pinned.map((p) => html`<li><a class="item-link row" href="${p.href}">${icon('star')}<span><strong>${p.title}</strong><br><small>${KIND_LABEL[p.kind] || p.kind}</small></span></a></li>`)}</ul>`
          : html`<div class="empty">Pin guides and files with the ☆ button so you can reach them fast.</div>`}
      </section>
      <section class="card">
        <div class="card-title"><h2>Group</h2><a class="btn small ghost" href="#/group">Open</a></div>
        ${d.group
          ? html`<p><span class="badge ok">Live</span> <strong>${d.group.name}</strong> · ${d.group.members} people connected</p><a class="btn" href="#/group">${icon('group')}Status board</a>`
          : html`<p class="muted">Host a group on local Wi-Fi so your household can check in from their phones — no internet or cell service needed.</p><a class="btn" href="#/group">${icon('group')}Start a group</a>`}
      </section>
    </div>
  `);
  $('#dash-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get('q').trim();
    if (q) location.hash = '#/search?q=' + encodeURIComponent(q);
  });
}

// ---------- search ----------
async function searchView(el, _args, query) {
  const q = query.get('q') || '';
  const filters = { topic: query.get('topic') || '', pack: query.get('pack') || '', type: query.get('type') || '' };
  mount(el, html`
    <div class="page-head"><div><h1>Search</h1><p>Guides, your PDFs and text files, notes, map pins and your plan.</p></div></div>
    <form class="hero-search" id="sform" role="search">${icon('search')}<input type="search" name="q" value="${q}" placeholder="What do you need?" aria-label="Search" autofocus></form>
    <div id="sresults" style="margin-top:20px"></div>`);
  $('#sform').addEventListener('submit', (e) => {
    e.preventDefault();
    const nq = new FormData(e.target).get('q').trim();
    location.hash = '#/search?q=' + encodeURIComponent(nq);
  });
  const out = $('#sresults');
  if (!q) {
    mount(out, html`<div class="chips">${['cleaning water', 'generator safety', 'bleeding', 'fridge food safe', 'stay warm', 'toilet not flushing', 'radio', 'meeting point'].map((s) => html`<a class="chip" href="#/search?q=${encodeURIComponent(s)}">${s}</a>`)}</div>`);
    return;
  }
  const params = new URLSearchParams({ q, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
  const data = await api('/api/search?' + params);
  const link = (k, v) => {
    const p = new URLSearchParams(params);
    if (filters[k] === v) p.delete(k); else p.set(k, v);
    return '#/search?' + p;
  };
  const facet = (k, title, labeler) => {
    const entries = Object.entries(data.facets[k] || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '';
    return html`<h3>${title}</h3>${entries.map(([v, n]) => html`<a href="${link(k, v)}" class="${filters[k] === v ? 'on' : ''}"><span>${labeler(v)}</span><span>${n}</span></a>`)}`;
  };
  mount(out, html`
    <div class="search-layout">
      <aside class="facet">
        ${facet('topic', 'Topic', topicLabel)}
        ${facet('type', 'Type', (v) => KIND_LABEL[v] || v)}
        ${facet('pack', 'Pack', (v) => v)}
      </aside>
      <div>
        <p class="muted">${data.results.length ? `${data.results.length}${data.results.length === 40 ? '+' : ''} matches` : ''}</p>
        ${data.results.length
          ? data.results.map((r) => html`<a class="result" href="${hrefFor(r.ref)}">
              <div class="result-head"><span class="badge">${KIND_LABEL[r.fileType] || r.kind}</span><span class="result-title">${r.title}</span>${r.subtitle ? html`<span class="result-sub">› ${r.subtitle}</span>` : ''}</div>
              <p>${highlight(r.excerpt, r.highlights)}</p></a>`)
          : html`<div class="empty">Nothing found for “${q}”. Try simpler words, or <a href="#/ask?q=${encodeURIComponent(q)}">ask instead</a>.</div>`}
      </div>
    </div>`);
}

// ---------- guide ----------
async function guideView(el, [id, section]) {
  const g = await api('/api/guides/' + encodeURIComponent(id));
  const pinned = await isPinned('guide:' + g.id);
  mount(el, html`
    <div class="page-head">
      <div>
        <p class="muted" style="margin:0 0 4px"><a href="#/library">Library</a> › ${topicLabel(g.topic)}</p>
        <h1>${g.title}</h1>
        <div class="meta-line"><span>Publisher: <strong>${g.publisher}</strong></span><span>Date: ${g.date || 'unknown'}</span><span>Version: ${g.version || '—'}</span><span>Pack: ${g.pack}</span></div>
        ${g.sources ? html`<div class="meta-line" style="margin-top:4px"><span>Based on: ${g.sources}</span></div>` : ''}
      </div>
      <div class="row no-print">
        <button class="btn" id="pin-btn">${icon('star')}${pinned ? 'Pinned' : 'Pin'}</button>
        <button class="btn" data-print>${icon('print')}Print</button>
      </div>
    </div>
    <div class="guide-layout">
      <article class="prose">
        ${g.intro ? markdown(g.intro) : ''}
        ${g.sections.map((s) => html`<section id="s-${s.id}"><h2>${s.heading}</h2>${markdown(s.markdown)}</section>`)}
      </article>
      <nav class="toc no-print" aria-label="Sections">
        <strong style="display:block;margin-bottom:8px">On this page</strong>
        ${g.sections.map((s) => html`<a href="#/guide/${g.id}/${s.id}">${s.heading}</a>`)}
      </nav>
    </div>`);
  $('#pin-btn').addEventListener('click', async (e) => {
    const on = await togglePin({ kind: 'guide', id: 'guide:' + g.id, title: g.title, href: '#/guide/' + g.id });
    mount(e.currentTarget, html`${icon('star')}${on ? 'Pinned' : 'Pin'}`);
  });
  if (section) {
    const target = document.getElementById('s-' + section);
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'start' });
        target.classList.add('section-flash');
      });
    }
  }
}

// ---------- ask ----------
const askHistory = (() => { try { return JSON.parse(sessionStorage.getItem('ls-ask') || '[]'); } catch { return []; } })();
function saveAsk() { try { sessionStorage.setItem('ls-ask', JSON.stringify(askHistory.slice(-20))); } catch {} }

async function askView(el, _args, query) {
  const settings = await api('/api/settings');
  const engine = settings.ai.provider === 'openai' ? `AI model: ${settings.ai.model}` : 'Built-in answers (no AI model)';
  mount(el, html`
    <div class="page-head">
      <div><h1>Ask LASTSYNC</h1><p>Answers come only from what's saved on this PC, and every answer links to its source.</p></div>
      <div class="row"><span class="badge">${engine}</span><a class="btn small ghost" href="#/settings">Change</a>${askHistory.length ? html`<button class="btn small ghost" id="clear">Clear</button>` : ''}</div>
    </div>
    <div class="qa" id="qa"></div>
    <div class="ask-bar">
      <form id="askf"><input name="q" placeholder="e.g. How do I make water safe to drink?" aria-label="Your question" autocomplete="off" maxlength="500"><button class="btn primary">${icon('send')}Ask</button></form>
      <div class="row" style="margin-top:8px"><label class="check"><input type="checkbox" id="scope"> Guides only (skip my files and notes)</label></div>
    </div>`);
  const qa = $('#qa');
  const renderAll = () => {
    if (!askHistory.length) {
      mount(qa, html`<div class="empty">Try: ${['How much water do we need?', 'Is food in the fridge still safe?', 'How do I do CPR?', 'Can I run a generator in the garage?'].map((s) => html`<a class="chip" style="margin:4px" href="#/ask?q=${encodeURIComponent(s)}">${s}</a>`)}</div>`);
      return;
    }
    mount(qa, html`${askHistory.map((a, i) => renderAnswer(a, i))}`);
  };
  renderAll();
  $('#clear')?.addEventListener('click', () => { askHistory.length = 0; saveAsk(); route(); });
  qa.addEventListener('click', (e) => {
    const c = e.target.closest('.cite');
    if (!c) return;
    e.preventDefault();
    const target = document.getElementById(c.dataset.target);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target?.classList.remove('section-flash'); void target?.offsetWidth; target?.classList.add('section-flash');
  });
  const run = async (q) => {
    if (!q) return;
    const placeholder = document.createElement('div');
    mount(placeholder, html`<div class="q-bubble">${q}</div><div class="card a-card" style="margin-top:12px"><span class="thinking"><i></i><i></i><i></i></span> <span class="muted">Searching your library…</span></div>`);
    if (!askHistory.length) qa.innerHTML = '';
    qa.append(placeholder);
    placeholder.scrollIntoView({ block: 'end' });
    try {
      const a = await api('/api/ask', { method: 'POST', body: { question: q, scope: $('#scope').checked ? 'guides' : 'all' } });
      askHistory.push(a);
      saveAsk();
      renderAll();
      qa.lastElementChild?.scrollIntoView({ block: 'start' });
    } catch (err) {
      placeholder.remove();
      toast(err.message, 'bad');
    }
  };
  $('#askf').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.q;
    const q = input.value.trim();
    input.value = '';
    run(q);
  });
  const pre = query.get('q');
  if (pre) { history.replaceState(null, '', '#/ask'); run(pre); }
}

function renderAnswer(a, i) {
  const cite = (n) => {
    const s = a.sources[n - 1];
    return s ? `<a class="cite" href="#" data-target="src-${i}-${n}" title="${esc(s.title + ' — ' + (s.subtitle || ''))}">${n}</a>` : `[${n}]`;
  };
  return html`<div>
    <div class="q-bubble" style="margin-left:auto;width:fit-content">${a.question}</div>
    <div class="card a-card ${a.covered ? '' : 'uncovered'}" style="margin-top:12px">
      ${a.urgent ? html`<div class="urgent">${a.urgent}</div>` : ''}
      ${a.note ? html`<div class="notice warn" style="margin-bottom:10px">${a.note}</div>` : ''}
      <div class="prose">${markdown(a.answer, { cite })}</div>
      ${a.sources.length ? html`<div class="sources">${a.sources.map((s) => html`<a id="src-${i}-${s.n}" class="source ${s.used ? '' : 'unused'}" href="${hrefFor(s.ref)}"><span class="n">${s.n}</span><span><strong>${s.title}</strong>${s.subtitle ? ` › ${s.subtitle}` : ''}<p>${highlight(s.excerpt, s.highlights)}</p></span></a>`)}</div>` : ''}
      <p class="faint" style="margin:10px 0 0;font-size:0.8rem">${a.engine === 'builtin' ? 'Built-in answer: quoted from your library.' : `Written by ${a.engine} from the sources above. Check the sources before acting.`}</p>
    </div></div>`;
}

// ---------- readiness ----------
async function readyView(el) {
  const r = await api('/api/readiness');
  const groups = {};
  for (const c of r.checks) (groups[c.group] ||= []).push(c);
  const ringColor = r.score >= 80 ? 'var(--safe)' : r.score >= 50 ? 'var(--accent)' : 'var(--help)';
  mount(el, html`
    <div class="page-head"><div><h1>Offline readiness</h1><p>What's actually saved on this PC. Fix the gaps before an outage.</p></div></div>
    <div class="card score" style="margin-bottom:16px"><div class="ring" style="--p:${r.score};--ring-color:${ringColor}" data-label="${r.score}%"></div>
      <div><strong>${r.score >= 100 ? 'Everything essential is saved.' : 'Some essentials are missing.'}</strong><br><small>Data folder: <span class="mono">${r.dataDir}</span>${r.freeBytes != null ? ` · ${fmtBytes(r.freeBytes)} free` : ''}</small></div></div>
    <div class="grid grid-2">
      ${Object.entries(groups).map(([g, cs]) => html`<section class="card"><h2>${g}</h2>
        ${cs.map((c) => html`<div class="check-row"><span class="check-icon ${c.ok ? 'ok' : c.optional ? 'opt' : 'no'}">${c.ok ? '✓' : c.optional ? '–' : '!'}</span>
          <div><strong>${c.label}</strong><br><small>${c.detail}</small></div>${c.ok ? '' : html`<a class="btn small" href="${c.href}">Fix</a>`}</div>`)}
      </section>`)}
    </div>`);
}

// ---------- settings ----------
const PRESETS = {
  ollama: { label: 'Ollama (offline)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  lmstudio: { label: 'LM Studio (offline)', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  llamacpp: { label: 'llama.cpp server (offline)', baseUrl: 'http://localhost:8080/v1', model: 'local' },
  openai: { label: 'OpenAI (needs internet)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
};

async function settingsView(el) {
  const s = await api('/api/settings');
  const status = await api('/api/status');
  mount(el, html`
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <form id="setf" class="stack">
      <section class="card stack">
        <h2>You</h2>
        <label class="field"><span>Your name (shown to your group)</span><input name="hostName" value="${s.hostName}" maxlength="40" placeholder="e.g. Sam (laptop)"></label>
      </section>
      <section class="card stack">
        <h2>Ask LASTSYNC — AI model</h2>
        <p class="muted">Ask always works without a model: it quotes the best matching section of your library. Connect a model for written answers. A <strong>local</strong> model (Ollama, LM Studio, llama.cpp) runs on this PC and keeps working in a blackout. An online model like OpenAI stops working when the internet does — LASTSYNC then falls back to built-in answers. Either way, the model only sees the passages LASTSYNC found and must cite them.</p>
        <div class="row">
          <label class="check"><input type="radio" name="provider" value="builtin" ${raw(s.ai.provider !== 'openai' ? 'checked' : '')}> Built-in only</label>
          <label class="check"><input type="radio" name="provider" value="openai" ${raw(s.ai.provider === 'openai' ? 'checked' : '')}> Use a model (OpenAI-compatible)</label>
        </div>
        <div id="model-fields" class="stack">
          <div class="chips">${Object.entries(PRESETS).map(([k, p]) => html`<button type="button" class="chip" data-preset="${k}">${p.label}</button>`)}</div>
          <div class="grid grid-2">
            <label class="field"><span>Model server address</span><input name="baseUrl" value="${s.ai.baseUrl}" placeholder="http://localhost:11434/v1"></label>
            <label class="field"><span>Model name</span><input name="model" value="${s.ai.model}" placeholder="llama3.2"></label>
            <label class="field"><span>API key (only for online services)</span><input name="apiKey" type="password" value="${s.ai.apiKey}" autocomplete="off" placeholder="Leave empty for local models"></label>
            <label class="field"><span>Give up after (seconds)</span><input name="timeoutSec" type="number" min="5" max="600" value="${s.ai.timeoutSec}"></label>
          </div>
          <div class="row"><button type="button" class="btn" id="test-ai">Test model</button><span id="test-out" class="muted"></span></div>
        </div>
      </section>
      <div class="row end"><button class="btn primary">Save settings</button></div>
    </form>
    <section class="card" style="margin-top:14px">
      <h2>About</h2>
      <p class="muted">LASTSYNC ${status.version} · ${status.guides} guides · data saved in <span class="mono">${status.dataDir}</span></p>
      <p class="muted">Phones on the same Wi-Fi can reach this PC at ${status.lan.length ? status.lan.map((a) => `http://${a.address}:${status.port}`).join(', ') : '(no network connected)'} — but only the group pages and public guides, after joining with your invite code.</p>
    </section>`);
  const f = $('#setf');
  const sync = () => { $('#model-fields').style.display = f.provider.value === 'openai' ? '' : 'none'; };
  sync();
  $$('input[name=provider]', f).forEach((r) => r.addEventListener('change', sync));
  $$('[data-preset]', f).forEach((b) => b.addEventListener('click', () => {
    const p = PRESETS[b.dataset.preset];
    f.baseUrl.value = p.baseUrl;
    f.model.value = p.model;
    if (b.dataset.preset !== 'openai') f.apiKey.value = '';
  }));
  const save = () => api('/api/settings', { method: 'PUT', body: {
    hostName: f.hostName.value,
    ai: { provider: f.provider.value, baseUrl: f.baseUrl.value.trim(), model: f.model.value.trim(), apiKey: f.apiKey.value, timeoutSec: Number(f.timeoutSec.value) },
  } });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await save(); toast('Settings saved'); } catch (err) { toast(err.message, 'bad'); }
  });
  $('#test-ai').addEventListener('click', async () => {
    const out = $('#test-out');
    out.textContent = 'Testing…';
    try {
      await save();
      const r = await api('/api/settings/test-ai', { method: 'POST' });
      out.innerHTML = r.ok ? `<span class="badge ok">Works</span> ${esc(r.answer.slice(0, 160))}` : `<span class="badge bad">Not reachable</span> ${esc(r.error)}`;
    } catch (err) { out.textContent = err.message; }
  });
}

// ---------- group alerts everywhere ----------
let stream = null;
export async function watchGroup() {
  let info;
  try { info = await api('/api/group/info'); } catch { return; }
  stream?.close();
  stream = null;
  state.group = null;
  if (!info.active) { renderAlerts(); renderNav(currentNav()); return; }
  state.group = { help: null };
  const snap = await api('/api/group/state');
  const helps = snap.messages.filter((m) => m.type === 'help' && Date.now() - new Date(m.ts) < 6 * 3600e3);
  state.group.help = helps.at(-1) || null;
  stream = groupStream({
    message: (m) => {
      if (m.from === 'host') return;
      // This PC confirms it received the message, so the sender sees "Received".
      api('/api/group/ack', { method: 'POST', body: { ids: [m.id] } }).catch(() => {});
      if (m.type === 'help') { state.group.help = m; beep('help'); }
      else beep();
      if (parseHash().name !== 'group') toast(`${m.fromName}: ${m.type === 'text' ? m.text : { safe: "I'm safe", help: 'I need help', meet: 'Meet here', ping: 'Are you OK?' }[m.type]}`);
      renderAlerts(); renderNav(currentNav());
    },
    ended: () => { state.group = null; renderAlerts(); renderNav(currentNav()); },
  });
  // Confirm anything that arrived while this page was closed.
  const unacked = snap.messages.filter((m) => m.from !== 'host' && !m.receipts.host).map((m) => m.id);
  if (unacked.length) api('/api/group/ack', { method: 'POST', body: { ids: unacked } }).catch(() => {});
  renderAlerts(); renderNav(currentNav());
}
export function dismissHelp() { if (state.group) state.group.help = null; renderAlerts(); renderNav(currentNav()); }
function currentNav() { const n = parseHash().name; return n ? '#/' + n : '#/'; }
function renderAlerts() {
  const h = state.group?.help;
  mount($('#alerts'), h ? html`<div class="alert-bar" role="alert">${icon('bell')}<span>${h.fromName} needs help${h.place ? ' at ' + h.place : ''} · ${ago(h.ts)}</span><span class="spacer"></span><a href="#/group">Open group</a><button class="icon-btn" style="color:#fff" id="dismiss-help" aria-label="Dismiss">${icon('x')}</button></div>` : '');
  $('#dismiss-help')?.addEventListener('click', dismissHelp);
}

window.addEventListener('hashchange', route);
route();
watchGroup();
document.addEventListener('click', (e) => { if (e.target.closest('[data-print]')) window.print(); });

// Re-render the current page through the router (so the old page is cleaned
// up), but only if the person is still on the page that asked for it.
export function refresh(name) {
  if (parseHash().name === name) route();
}
