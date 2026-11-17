import { $, $$, api, html, mount, raw, esc, toast, icon, highlight, markdown, ago, fmtBytes, groupStream, beep, slugify } from './shared.js';
import { libraryView, docView, notesView, noteView } from './views-library.js';
import { mapView } from './views-map.js';
import { planView, printView } from './views-plan.js';
import { groupView, logView } from './views-group.js';
import { packsView } from './views-packs.js';
import { wikiView, wikiArticleView, kitView, aiView } from './views-extra.js';
import * as ai from './ai.js';
import { sourceView } from './views-source.js';
import { offlineSearch } from './offline.js';

const NAV = [
  'Operations',
  ['#/', 'home', 'Command'],
  ['#/search', 'search', 'Search'],
  ['#/ask', 'ask', 'Ask'],
  ['#/map', 'map', 'Maps'],
  ['#/plan', 'plan', 'My plan'],
  ['#/kit', 'kit', 'Gear'],
  'Intel',
  ['#/library', 'book', 'Field guides'],
  ['#/wiki', 'globe', 'Encyclopedia'],
  ['#/notes', 'note', 'Notes'],
  'Comms',
  ['#/group', 'group', 'Group'],
  ['#/log', 'log', 'Outage log'],
  'System',
  ['#/ai', 'chip', 'On-device AI'],
  ['#/packs', 'pack', 'Packs'],
  ['#/ready', 'ready', 'Readiness'],
  ['#/settings', 'settings', 'Settings'],
  ['#/source', 'code', 'Open source'],
];

// Codes shown above each page title.
const CODES = { '': 'OPS-00 // Command', search: 'OPS-01 // Search', ask: 'OPS-02 // Ask', map: 'OPS-03 // Maps', plan: 'OPS-04 // Plan', print: 'OPS-04 // Printout', library: 'INT-01 // Library', guide: 'INT-01 // Guide', doc: 'INT-01 // Document', notes: 'INT-02 // Notes', note: 'INT-02 // Note', group: 'COM-01 // Group', log: 'COM-02 // Log', packs: 'SYS-01 // Packs', ready: 'SYS-02 // Readiness', settings: 'SYS-03 // Settings', download: 'SYS-05 // Deploy', source: 'SYS-06 // Open source', wiki: 'INT-03 // Encyclopedia', kit: 'OPS-05 // Gear', ai: 'SYS-04 // On-device AI' };

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
  download: downloadView,
  wiki: (el, args, q) => (args.length ? wikiArticleView(el, args, q) : wikiView(el, args, q)),
  kit: kitView,
  source: sourceView,
  ai: aiView,
};

let cleanup = null;
export const state = { group: null, public: false, downloadUrl: '', readiness: null, online: navigator.onLine, battery: null };

function renderNav(active) {
  const items = NAV.map((n) => {
    if (typeof n === 'string') return html`<div class="nav-group">${n}</div>`;
    const badge = n[0] === '#/group' && state.group ? html`<span class="badge ${state.group.help ? 'bad' : 'ok'}">${state.group.help ? 'HELP' : 'live'}</span>` : '';
    return html`<a href="${n[0]}" class="${active === n[0] ? 'on' : ''}">${icon(n[1])}<span>${n[2]}</span>${badge}</a>`;
  });
  const getApp = state.public ? html`<a href="#/download" class="get-app ${active === '#/download' ? 'on' : ''}">${icon('download')}<span>Get the app</span></a>` : '';
  mount($('#nav'), html`${items}${getApp}`);
}

export function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = h.split('?');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || '', args: parts.slice(1), query: new URLSearchParams(q) };
}

let routeGen = 0;
async function route() {
  const gen = ++routeGen;
  const { name, args, query } = parseHash();
  const view = ROUTES[name] || notFound;
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  renderNav(name ? '#/' + name : '#/');
  const el = $('#view');
  el.innerHTML = '';
  el.className = ''; // a page may widen the layout (e.g. the map); always start clean
  try {
    const done = (await view(el, args, query)) || null;
    // A newer navigation started while this page was loading: discard this one.
    if (gen !== routeGen) { try { done?.(); } catch {} return; }
    cleanup = done;
    const h1 = el.querySelector('.page-head h1');
    if (h1 && CODES[name] && !h1.previousElementSibling?.classList.contains('kicker')) h1.insertAdjacentHTML('beforebegin', `<p class="kicker">${esc(CODES[name])}</p>`);
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
  if (ref.wiki) return `#/wiki/${encodeURIComponent(ref.wiki)}${ref.section != null ? '/' + ref.section : ''}`;
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

const KIND_LABEL = { wiki: 'Wikipedia', guide: 'Guide', doc: 'Document', note: 'Note', pin: 'Map pin', route: 'Route', plan: 'My plan', pdf: 'PDF', text: 'Text' };
const TOPIC_LABEL = {
  water: 'Water', power: 'Power outage', food: 'Food', 'first-aid': 'First aid', shelter: 'Shelter & warmth',
  sanitation: 'Sanitation', communications: 'Communications', preparedness: 'Preparedness', hazards: 'Disasters', medical: 'Health', navigation: 'Navigation', 'local-info': 'Local info', maps: 'Maps', notes: 'Notes', plan: 'My plan', documents: 'Documents',
};
export const topicLabel = (t) => TOPIC_LABEL[t] || (t ? t[0].toUpperCase() + t.slice(1).replace(/-/g, ' ') : 'Other');

// ---------- dashboard ----------
async function dashboard(el) {
  const d = await api('/api/dashboard');
  const r = d.readiness;
  const ringColor = r.score >= 80 ? 'var(--safe)' : r.score >= 50 ? 'var(--warn)' : 'var(--help)';
  const byTopic = {};
  for (const g of d.guides) (byTopic[g.topic] ||= []).push(g);
  const gm = d.group ? d.group.members : 0;
  mount(el, html`
    <div class="page-head"><div><h1>Command center</h1><p>Every system below runs on this machine. No uplink required.</p></div>
      <div class="row"><a class="btn" href="#/print">${icon('print')}Printout</a><a class="btn primary" href="#/group">${icon('group')}${d.group ? 'Group live' : 'Start group'}</a></div></div>
    ${d.group?.help?.length ? html`<div class="notice bad" style="margin-bottom:16px"><strong>${d.group.help.at(-1).fromName} asked for help</strong> ${ago(d.group.help.at(-1).ts)}. <a href="#/group">Open the group</a></div>` : ''}
    <div class="stat-row">
      <div class="stat"><div class="label">Readiness</div><div class="v ${r.score >= 80 ? 'ok' : r.score >= 50 ? 'warn' : 'bad'}">${r.score}%</div></div>
      <div class="stat"><div class="label">Field guides</div><div class="v">${d.guides.length}</div></div>
      <a class="stat" href="#/wiki"><div class="label">Encyclopedia</div><div class="v ${d.wiki.saved === d.wiki.total ? 'ok' : d.wiki.saved ? 'warn' : 'bad'}">${d.wiki.saved}<span class="of">/${d.wiki.total}</span></div></a>
      <a class="stat" href="#/ai"><div class="label">AI on device</div><div class="v" id="stat-ai">—</div></a>
      <a class="stat" href="#/kit"><div class="label">Gear essentials</div><div class="v ${d.kit.pct === 100 ? 'ok' : d.kit.pct >= 50 ? 'warn' : 'bad'}">${d.kit.pct}%</div></a>
      <a class="stat" href="#/map"><div class="label">Map areas</div><div class="v ${d.maps ? '' : 'warn'}">${d.maps}</div></a>
    </div>
    <form class="cmd" id="dash-search" role="search">
      ${icon('search')}
      <input type="search" name="q" placeholder="Query the library — e.g. cleaning water, generator, bleeding" aria-label="Search" autofocus>
    </form>
    <div class="big-tiles">
      <a class="tile" href="#/search"><span class="num">01</span>${icon('search')}<strong>Search</strong><span>Every guide, PDF, note and pin on this machine</span></a>
      <a class="tile" href="#/ask"><span class="num">02</span>${icon('ask')}<strong>Ask</strong><span>Answers from your library, with sources</span></a>
      <a class="tile" href="#/map"><span class="num">03</span>${icon('map')}<strong>Maps</strong><span>Tactical map, pins, routes, range rings, GPS</span></a>
      <a class="tile" href="#/plan"><span class="num">04</span>${icon('plan')}<strong>My plan</strong><span>Contacts, rally points, grab list</span></a>
      <a class="tile" href="#/wiki"><span class="num">05</span>${icon('globe')}<strong>Encyclopedia</strong><span>Wikipedia survival library, offline</span></a>
      <a class="tile" href="#/kit"><span class="num">06</span>${icon('kit')}<strong>Gear</strong><span>The kit to own before the lights go out</span></a>
      <a class="tile" href="#/ai"><span class="num">07</span>${icon('chip')}<strong>On-device AI</strong><span>Your own AI. No servers, no signal</span></a>
      <a class="tile" href="#/group"><span class="num">08</span>${icon('group')}<strong>Group</strong><span>Check-ins over local Wi-Fi</span></a>
    </div>
    <div class="grid grid-2">
      <section class="card">
        <div class="card-title"><h2>Field guides</h2><a class="btn small ghost" href="#/library">All</a></div>
        <div class="chips">
          ${Object.entries(byTopic).map(([t, gs]) => gs.map((g) => html`<a class="chip" href="#/guide/${g.id}" title="${topicLabel(t)}">${g.title}</a>`))}
        </div>
        ${d.meetingPoints.length ? html`<hr><h3>Rally points</h3><ul class="list">${d.meetingPoints.slice(0, 3).map((m) => html`<li class="row between"><span><strong>${m.name}</strong><br><small>${m.address || m.when || ''}</small></span>${m.lat != null ? html`<a class="btn small" href="#/map?lat=${m.lat}&lon=${m.lon}">${icon('map')}Show</a>` : ''}</li>`)}</ul>` : ''}
      </section>
      <section class="card">
        <div class="card-title"><h2>Readiness</h2><a class="btn small ghost" href="#/ready">Details</a></div>
        <div class="score">
          <div class="ring" style="--p:${r.score};--ring-color:${ringColor}" data-label="${r.score}%"></div>
          <div>${r.todo.length ? html`<strong>${r.todo.length} gap${r.todo.length > 1 ? 's' : ''} to close while you still can</strong>` : html`<strong>All essentials secured.</strong>`}<br><small>Guides, maps, plan and paper backup.</small></div>
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
        <div class="card-title"><h2>Comms</h2><a class="btn small ghost" href="#/group">Open</a></div>
        ${d.group
          ? html`<p><span class="badge ok">Live</span> <strong>${d.group.name}</strong> · ${d.group.members} connected</p><a class="btn" href="#/group">${icon('group')}Status board</a>`
          : html`<p class="muted">Host a group so your household can check in from their phones — no internet or cell service needed.</p><a class="btn" href="#/group">${icon('group')}Start a group</a>`}
      </section>
    </div>
  `);
  if (ai.support().ok) ai.cachedTiers().then((c) => { const e = $('#stat-ai'); if (e) { e.textContent = c.length; e.className = 'v ' + (c.length ? 'ok' : ''); } });
  else { const e = $('#stat-ai'); if (e) e.textContent = 'n/a'; }
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
  let data;
  let offline = false;
  try { data = await api('/api/search?' + params); }
  catch (err) {
    if (err.status && err.status !== 503) throw err;
    offline = true;
    data = { results: await offlineSearch(q), facets: { topic: {}, pack: {}, type: {} } };
  }
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
        ${offline ? html`<div class="notice warn" style="margin-bottom:10px">Can't reach the LASTSYNC server — showing matches from what this browser saved for offline use.</div>` : ''}
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
  const devTier = ai.support().ok ? ai.preferred() : null;
  const engine = devTier ? `On-device AI: ${devTier.name}` : settings.ai.provider === 'openai' ? `AI model: ${settings.ai.model}` : 'Built-in answers (no AI model)';
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
      const scope = $('#scope').checked ? 'guides' : 'all';
      let a = null;
      if (devTier) a = await askOnDevice(q, scope, devTier, placeholder).catch((err) => { toast('On-device AI failed: ' + err.message + ' — using built-in answers', 'bad'); return null; });
      if (!a) {
        try { a = await api('/api/ask', { method: 'POST', body: { question: q, scope } }); }
        catch (err) {
          if (err.status && err.status !== 503) throw err;
          const hits = await offlineSearch(q, 4);
          a = { question: q, engine: 'builtin', urgent: null, covered: !!hits.length, format: 'markdown',
            note: "Can't reach the LASTSYNC server — this answer comes from what this browser saved for offline use.",
            answer: hits.length ? `**From ${hits[0].title} — ${hits[0].subtitle}** [1]\n\n${hits[0].md.slice(0, 1600)}` : "Nothing saved on this device matches. Open guides while online, or use “Save for offline” on the Get the app page.",
            sources: hits.map((h, i) => ({ n: i + 1, used: i === 0, kind: h.kind, title: h.title, subtitle: h.subtitle, ref: h.ref, excerpt: h.excerpt, highlights: [] })) };
        }
      }
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

// Ask with the model running in this browser: the server only retrieves passages.
async function askOnDevice(q, scope, tier, placeholder) {
  const r = await api('/api/retrieve', { method: 'POST', body: { question: q, scope } });
  if (!r.sources.length || r.sources[0].coverage < 0.5) return null; // let the built-in answerer explain what's missing
  const card = placeholder.querySelector('.a-card');
  if (!ai.loaded() || ai.loaded().id !== tier.id) {
    await ai.load(tier, (p, text) => mount(card, html`<span class="label">Loading ${tier.name} model</span><div class="progress" style="margin:8px 0"><i style="width:${Math.round(p * 100)}%"></i></div><small class="muted mono" style="font-size:.66rem">${text.slice(0, 120)}</small>`));
  }
  const text = await ai.answer(q, r.sources, (partial) => mount(card, html`<span class="label">${tier.name} · on this device</span><div class="prose" style="margin-top:6px">${markdown(partial)}</div>`));
  const used = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  return {
    question: q, engine: `${tier.name} (on-device)`, urgent: r.urgent, note: null, format: 'markdown',
    covered: !/saved sources don.t cover this/i.test(text), answer: text,
    sources: r.sources.map((s) => ({ ...s, text: undefined, used: used.includes(s.n) })),
  };
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
  const ringColor = r.score >= 80 ? 'var(--safe)' : r.score >= 50 ? 'var(--warn)' : 'var(--help)';
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
  if (status.mode === 'public') {
    f.querySelector('input[value=openai]').disabled = true;
    f.querySelector('input[value=builtin]').checked = true;
    f.querySelector('input[value=openai]').closest('.row').insertAdjacentHTML('afterend', '<div class="notice warn">Connecting an AI model is turned off in the online demo. In the offline app you can connect a local model (Ollama, LM Studio, llama.cpp) that keeps working in a blackout.</div>');
  }
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
      renderAlerts(); renderNav(currentNav()); renderHud();
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
api('/api/status').then((s) => {
  state.public = s.mode === 'public';
  state.downloadUrl = s.downloadUrl;
  if (state.public) { const brand = document.querySelector('.brand'); if (brand) { brand.href = '/welcome'; brand.title = 'Front page'; } }
  renderNav(currentNav());
  if (state.public) mount($('#side-foot'), html`<span class="offline-dot"></span>DEMO UPLINK<br>DATA KEPT 7 DAYS IN THIS BROWSER<br><a href="#/source" class="foot-link">OPEN SOURCE · MIT</a>`);
  renderHud();
}).catch(() => {});
startHud();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; renderHud(); });
window.addEventListener('appinstalled', () => { state.installPrompt = null; toast('LASTSYNC installed'); renderHud(); });
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-install]') || !state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice.catch(() => {});
  state.installPrompt = null;
  renderHud();
});

// Fetch everything once so the service worker keeps a copy for offline use.
export async function saveForOffline(onProgress) {
  const urls = ['/', '/api/dashboard', '/api/guides', '/api/wiki', '/api/plan', '/api/kit', '/api/settings', '/api/readiness', '/api/pins', '/api/routes', '/api/maps', '/api/notes', '/api/library', '/api/status', '/vendor/countries-10m.json'];
  const guides = await api('/api/guides').catch(() => []);
  urls.push(...guides.map((g) => '/api/guides/' + g.id));
  const w = await api('/api/wiki').catch(() => null);
  for (const c of w?.catalog || []) for (const t of c.titles.filter((x) => x.saved)) {
    urls.push('/api/wiki/article/' + t.id);
    if (t.image) urls.push('/files/wiki/' + t.image);
  }
  let done = 0;
  for (const u of urls) { await fetch(u, { credentials: 'same-origin' }).catch(() => {}); onProgress?.(++done, urls.length); }
  return urls.length;
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-print]')) window.print(); });

// ---------- HUD (status bar) ----------
function pad(n) { return String(n).padStart(2, '0'); }
function renderHud() {
  const now = new Date();
  const lcl = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const utc = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}Z`;
  const date = now.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const b = state.battery;
  let pwr = html`<span class="hud-item"><span class="led"></span><span class="k">PWR</span><b>—</b></span>`;
  if (b) {
    const pct = Math.round(b.level * 100);
    const cls = b.charging ? 'ok' : pct <= 15 ? 'bad' : pct <= 35 ? 'warn' : 'ok';
    pwr = html`<span class="hud-item ${cls}" title="Battery of this device"><span class="led"></span><span class="k">PWR</span><b>${b.charging ? 'AC ' : 'BATT '}${pct}%</b>${!b.charging && b.dischargingTime && Number.isFinite(b.dischargingTime) ? html`<span class="k">~${Math.round(b.dischargingTime / 60)} MIN</span>` : ''}</span>`;
  }
  const r = state.readiness;
  const g = state.group;
  mount($('#hud'), html`
    <span class="hud-item"><span class="k">LCL</span><b>${lcl}</b></span>
    <span class="hud-item"><span class="k">UTC</span><b>${utc}</b></span>
    <span class="hud-item"><span class="k">${date}</span></span>
    <span class="hud-item ${state.online ? 'ok' : 'bad'}" title="Internet connection"><span class="led"></span><span class="k">UPLINK</span><b>${state.online ? 'UP' : 'DOWN'}</b></span>
    ${pwr}
    <span class="hud-spacer"></span>
    ${g?.help ? html`<a class="hud-item alert" href="#/group"><span class="k">SOS</span><b>${g.help.fromName}</b></a>` : g ? html`<a class="hud-item ok" href="#/group"><span class="led"></span><span class="k">GROUP</span><b>LIVE</b></a>` : ''}
    ${r != null ? html`<a class="hud-item ${r >= 80 ? 'ok' : r >= 50 ? 'warn' : 'bad'}" href="#/ready"><span class="led"></span><span class="k">READY</span><b>${r}%</b></a>` : ''}
    ${state.installPrompt ? html`<button class="hud-item ok" data-install style="background:none;border:0;border-right:1px solid var(--line);cursor:pointer;font:inherit;letter-spacing:inherit"><span class="led"></span><b>INSTALL APP</b></button>` : ''}
    <span class="hud-item"><span class="k">MODE</span><b>${state.public ? 'DEMO' : 'LOCAL'}</b></span>`);
}
function startHud() {
  renderHud();
  setInterval(renderHud, 1000);
  window.addEventListener('online', () => { state.online = true; renderHud(); });
  window.addEventListener('offline', () => { state.online = false; renderHud(); });
  navigator.getBattery?.().then((b) => {
    const upd = () => { state.battery = { level: b.level, charging: b.charging, dischargingTime: b.dischargingTime }; renderHud(); };
    upd();
    ['levelchange', 'chargingchange', 'dischargingtimechange'].forEach((e) => b.addEventListener(e, upd));
  }).catch(() => {});
  const ready = () => api('/api/readiness').then((x) => { state.readiness = x.score; }).catch(() => {});
  ready();
  setInterval(ready, 120000);
  window.addEventListener('hashchange', ready);
}

// ---------- get the app ----------
async function downloadView(el) {
  const s = await api('/api/status');
  setTimeout(() => $('#save-offline')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const n = await saveForOffline((d, t) => { const st = $('#save-status'); if (st) st.textContent = `SAVING ${d}/${t}`; });
    const st = $('#save-status'); if (st) st.textContent = `✓ ${n} ITEMS SAVED IN THIS BROWSER`;
  }), 0);
  const url = s.downloadUrl;
  mount(el, html`
    <div class="dl-hero">
      <div class="globe" aria-hidden="true"></div>
      <p class="kicker">SYS-04 // Deploy offline</p>
      <h1>When the grid goes dark, this keeps working.</h1>
      <p>This website is a demo. The real LASTSYNC runs entirely on your own Windows PC or a USB stick — guides, search, Ask, maps, your plan and the group check-in all keep working with no internet and no cell service.</p>
      <div class="row" style="margin-top:18px"><a class="btn primary" href="${url}" target="_blank" rel="noopener">${icon('download')}Download for Windows</a><span class="muted mono" style="font-size:.75rem;letter-spacing:.1em">FREE · NO ACCOUNT · ~40 MB ZIP</span></div>
    </div>
    <div class="grid grid-3" style="margin-top:14px">
      <section class="card"><h2>Install in 60 seconds</h2>
        <ol class="steps">
          <li><span>Download the ZIP and unzip it — onto your PC or a USB drive.</span></li>
          <li><span>Open <strong>LASTSYNC.exe</strong>. Your browser opens the app at <span class="mono">localhost:8787</span>.</span></li>
          <li><span>Do the setup while you still have internet: fill in your plan, print the sheet, add a regional map.</span></li>
          <li><span>Unplug and test it. Then put the USB in your go-bag.</span></li>
        </ol>
      </section>
      <section class="card"><h2>Works with zero signal</h2>
        <ul class="feature-list">
          <li>Field guides for water, power, food, first aid, warmth, sanitation and comms</li>
          <li>Search and Ask across your guides, PDFs and notes</li>
          <li>Tactical offline maps, pins, routes, range rings and USB GPS</li>
          <li>Group check-ins over local Wi-Fi — phones join by QR code</li>
          <li>Household plan with a printable one-page backup</li>
          <li>Signed packs to share maps and guides by USB</li>
        </ul>
      </section>
      <section class="card"><h2>Specs</h2>
        <dl class="spec">
          <dt>System</dt><dd>Windows 10 or 11, 64-bit</dd>
          <dt>Runs from</dt><dd>PC or USB drive (data travels with it)</dd>
          <dt>Account</dt><dd>None. Nothing is sent anywhere.</dd>
          <dt>Phones</dt><dd>Any phone browser on the same Wi-Fi</dd>
          <dt>AI</dt><dd>Built-in answers, or plug in a local model (Ollama, LM Studio)</dd>
          <dt>Source</dt><dd><a href="#/source">Open source · MIT license</a></dd>
        </dl>
      </section>
    </div>
    <section class="card" style="margin-top:14px"><div class="card-title"><h2>Use this website offline</h2>${state.installPrompt ? html`<button class="btn" data-install>${icon('download')}Install as app</button>` : ''}</div>
      <p class="muted">No download needed for the basics: save the guides, encyclopedia and your plan into this browser. Later, with no connection, open this site again (or the installed app) and they're still here. Search and Ask fall back to the saved copies.</p>
      <div class="row"><button class="btn primary" id="save-offline">${icon('download')}Save for offline use</button><span class="muted mono" id="save-status" style="font-size:.75rem"></span></div></section>
    <section class="card" style="margin-top:14px"><h2>First launch</h2><p class="muted" style="margin:0">Windows SmartScreen may say the app is unrecognized because it isn't code-signed yet — choose <strong>More info → Run anyway</strong>. If Windows asks whether LASTSYNC may use private networks, choose <strong>Allow</strong> so phones can join your group.</p></section>`);
}

// Re-render the current page through the router (so the old page is cleaned
// up), but only if the person is still on the page that asked for it.
export function refresh(name) {
  if (parseHash().name === name) route();
}
