// The page phones see after scanning the QR code. Talks only to the laptop
// over local Wi-Fi; nothing here needs the internet.
import { $, $$, api, html, mount, toast, icon, ago, clock, groupStream, MSG, receiptText, markdown, highlight, fmtCoord, createMap, pinIcon, msgIcon, beep } from './shared.js';

const app = $('#app');
const S = { snap: null, me: null, tab: 'checkin', unread: 0, stream: null, connected: true, log: [], maps: [], place: null };

async function start() {
  try {
    S.snap = await api('/api/group/state');
    S.me = S.snap.me;
    joined();
  } catch (err) {
    if (err.status === 401 || err.status === 404) return joinForm(err.status === 404);
    mount(app, html`<div class="notice bad" style="margin-top:20px">Can't reach the LASTSYNC laptop. Make sure you're on the same Wi-Fi, then reload.</div>`);
  }
}

async function joinForm(noSession) {
  const info = await api('/api/group/info').catch(() => ({ active: false }));
  const code = new URLSearchParams(location.hash.slice(1)).get('code') || '';
  let name = '';
  try { name = localStorage.getItem('ls-name') || ''; } catch {}
  $('#tabs').hidden = true;
  mount(app, html`
    <div class="phone-head"><img src="/icon.svg" width="34" height="34" alt=""><div><strong style="letter-spacing:.12em">LASTSYNC</strong><br><small class="muted">Local group — works without internet</small></div></div>
    ${!info.active ? html`<div class="notice warn">There's no group running on this laptop right now. Ask the person with the laptop to start one, then scan the QR code again.</div>` : html`
    <form class="card stack" id="jf">
      <h1 style="font-size:1.4rem">Join “${info.name}”</h1>
      <label class="field"><span>Your name</span><input name="name" value="${name}" maxlength="40" required autocomplete="name" placeholder="So your group knows who you are"></label>
      <label class="field"><span>Invite code</span><input name="code" value="${code}" maxlength="8" required autocapitalize="characters" autocomplete="off" style="font-family:var(--mono);letter-spacing:.2em;text-transform:uppercase"></label>
      <button class="btn primary" style="min-height:52px">Join group</button>
      <small class="muted">Your phone may say this Wi-Fi has no internet — stay connected anyway.</small>
    </form>`}
    <p class="faint mono" style="font-size:.66rem;letter-spacing:.1em;text-align:center;margin-top:18px">LASTSYNC IS OPEN SOURCE · MIT LICENSE<br>GITHUB.COM/HUFFYDEV/SYNC</p>`);
  $('#jf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/group/join', { method: 'POST', body: { name: f.name.value, code: f.code.value } });
      try { localStorage.setItem('ls-name', f.name.value); } catch {}
      history.replaceState(null, '', '/join');
      start();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

function joined() {
  $('#tabs').hidden = false;
  S.stream?.close();
  S.stream = groupStream({
    open: async () => {
      if (!S.connected) { S.connected = true; banner(); try { S.snap = await api('/api/group/state'); ackAll(); render(); } catch {} }
    },
    error: () => { S.connected = false; banner(); },
    message: (m) => {
      if (S.snap.messages.some((x) => x.id === m.id)) return;
      S.snap.messages.push(m);
      if (m.from !== S.me) {
        ack([m.id]);
        if (S.tab !== 'messages') S.unread++;
        beep(m.type === 'help' ? 'help' : 'normal');
        if (m.type === 'ping' && m.to === S.me) pingModal(m);
        else if (m.type === 'help') toast(`${m.fromName} needs help!`, 'bad');
      }
      render();
    },
    receipt: (r) => { const m = S.snap.messages.find((x) => x.id === r.id); if (m) { m.receipts[r.memberId] = r.ts; if (S.tab === 'messages') render(); } },
    members: (list) => { S.snap.members = list; if (S.tab === 'board' || S.tab === 'checkin') render(); },
    session: (s) => { if (s) { S.snap.session = s; render(); } },
    log: (e) => { const i = S.log.findIndex((x) => x.id === e.id); if (i >= 0) S.log[i] = e; else S.log.push(e); if (S.tab === 'log') render(); },
    ended: () => { S.stream.close(); mount(app, html`<div class="notice warn" style="margin-top:20px">The group session has ended.</div>`); $('#tabs').hidden = true; },
    removed: () => { S.stream.close(); mount(app, html`<div class="notice warn" style="margin-top:20px">You were removed from the group.</div>`); $('#tabs').hidden = true; },
  });
  ackAll();
  api('/api/maps').then((m) => { S.maps = m; }).catch(() => {});
  render();
}

function ack(ids) { api('/api/group/ack', { method: 'POST', body: { ids } }).catch(() => {}); }
function ackAll() {
  const ids = S.snap.messages.filter((m) => m.from !== S.me && !m.receipts[S.me]).map((m) => m.id);
  if (ids.length) ack(ids);
}

function banner() {
  mount($('#banner'), S.connected ? '' : html`<div class="alert-bar" style="background:var(--accent);color:var(--accent-ink)">Lost connection to the laptop — retrying… Stay on the same Wi-Fi.</div>`);
}

const TABS = [['checkin', 'check', 'Check in'], ['messages', 'ask', 'Messages'], ['board', 'group', 'Board'], ['guides', 'book', 'Guides'], ['log', 'log', 'Log']];
function renderTabs() {
  mount($('#tabs'), html`${TABS.map(([k, ic, label]) => html`<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${icon(ic)}${label}${k === 'messages' && S.unread ? html`<span class="dot"></span>` : ''}</button>`)}`);
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; if (S.tab === 'messages') S.unread = 0; render(); window.scrollTo(0, 0); }));
}

function me() { return S.snap.members.find((m) => m.id === S.me); }

function render() {
  renderTabs();
  ({ checkin, messages, board, guides, log })[S.tab]();
}

// ---------- check in ----------
function checkin() {
  const m = me();
  const mp = S.snap.session.meetingPoint;
  const last = m?.lastCheckIn;
  mount(app, html`
    <div class="phone-head"><img src="/icon.svg" width="30" height="30" alt=""><div style="flex:1"><strong>${S.snap.session.name}</strong><br><small class="muted">You're ${m?.name || '…'} · ${S.snap.members.length} in group</small></div></div>
    ${mp ? html`<div class="card" style="border-color:var(--meet)"><small class="muted">MEETING POINT</small><br><strong style="font-size:1.15rem">${mp.name}</strong>${mp.note && mp.note !== mp.name ? html`<br><span>${mp.note}</span>` : ''}<br><small class="muted">Set by ${mp.setBy} ${ago(mp.ts)}</small>${mp.lat != null ? html`<div><button class="btn small" id="mp-map" style="margin-top:8px">${icon('map')}Show on map</button></div>` : ''}</div>` : ''}
    <div class="card stack" style="margin-top:14px">
      <h2 style="margin:0">Tell your group</h2>
      <div class="checkin-btns">
        <button class="btn safe" data-send="safe">${icon('check')}I'm safe</button>
        <button class="btn meet" data-send="meet">${icon('pin')}Meet here</button>
        <button class="btn help" data-send="help">${icon('bell')}Need help</button>
      </div>
      <input id="place" placeholder="Where are you? (optional)" maxlength="80" value="${S.place?.label || ''}">
      <div class="row"><button class="btn small" id="pick">${icon('map')}${S.place?.lat != null ? 'Location set ✓' : 'Mark on map'}</button>${S.place?.lat != null ? html`<button class="btn small ghost" id="clearloc">Remove location</button>` : ''}</div>
      <textarea id="note" rows="2" placeholder="Add a note (optional)" maxlength="500" style="min-height:64px"></textarea>
      ${last ? html`<small class="muted">Your last check-in: ${MSG[last.type]?.label} · ${ago(last.ts)}</small>` : ''}
    </div>`);
  $('#mp-map')?.addEventListener('click', () => mapModal({ view: [mp.lat, mp.lon], title: mp.name }));
  $('#pick').addEventListener('click', () => mapModal({ pick: true, title: 'Tap where you are' }));
  $('#clearloc')?.addEventListener('click', () => { S.place = { label: $('#place').value }; checkin(); });
  $('#place').addEventListener('input', (e) => { S.place = { ...(S.place || {}), label: e.target.value }; });
  $$('[data-send]').forEach((b) => b.addEventListener('click', async () => {
    const type = b.dataset.send;
    const body = { type, text: $('#note').value, place: $('#place').value, lat: S.place?.lat ?? null, lon: S.place?.lon ?? null };
    if (type === 'help' && !confirm('Send “I need help” to everyone in the group?')) return;
    try {
      await api('/api/group/messages', { method: 'POST', body });
      toast(type === 'help' ? 'Help request sent' : 'Sent');
      $('#note').value = '';
      S.tab = 'messages';
      render();
    } catch (err) { toast(err.message, 'bad'); }
  }));
}

// ---------- messages ----------
function messages() {
  const msgs = [...S.snap.messages].reverse();
  mount(app, html`
    <form id="mf" class="card" style="padding:12px"><div class="row" style="flex-wrap:nowrap"><select id="to" style="width:auto;max-width:40%"><option value="">Everyone</option>${S.snap.members.filter((m) => m.id !== S.me).map((m) => html`<option value="${m.id}">${m.name}</option>`)}</select><input id="mtext" placeholder="Message" maxlength="500"><button class="btn primary" aria-label="Send">${icon('send')}</button></div></form>
    <div class="feed" style="margin-top:14px">${msgs.length ? msgs.map((m) => {
      const r = receiptText(m, S.snap.members, S.me);
      const to = m.to ? (m.to === S.me ? 'you' : S.snap.members.find((x) => x.id === m.to)?.name) : null;
      return html`<div class="msg ${MSG[m.type]?.cls}">
        <div class="msg-head"><strong>${m.from === S.me ? 'You' : m.fromName}</strong>${m.type !== 'text' ? html`<span class="badge ${m.type === 'help' ? 'bad' : m.type === 'safe' ? 'ok' : 'blue'}">${MSG[m.type].label}</span>` : ''}${to ? html`<small class="muted">to ${to}</small>` : ''}<span class="spacer"></span><small class="muted">${clock(m.ts)}</small></div>
        ${m.text ? html`<div class="msg-body">${m.text}</div>` : ''}
        ${m.place || m.lat != null ? html`<div class="msg-body"><small>📍 ${m.place || fmtCoord(m.lat, m.lon)}</small>${m.lat != null ? html` <button class="btn small" data-show="${m.id}">Map</button>` : ''}</div>` : ''}
        ${m.type === 'ping' && m.to === S.me ? html`<div class="row" style="margin-top:8px"><button class="btn small safe" data-reply="safe">I'm safe</button><button class="btn small help" data-reply="help">I need help</button></div>` : ''}
        ${r ? html`<div class="receipt ${r.cls}">${r.cls === 'got' ? '✓✓ ' : '✓ '}${r.text}</div>` : ''}
      </div>`;
    }) : html`<div class="empty">No messages yet.</div>`}</div>`);
  $('#mf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#mtext').value.trim();
    if (!text) return;
    try { await api('/api/group/messages', { method: 'POST', body: { type: 'text', text, to: $('#to').value || null } }); $('#mtext').value = ''; } catch (err) { toast(err.message, 'bad'); }
  });
  $$('[data-show]').forEach((b) => b.addEventListener('click', () => { const m = S.snap.messages.find((x) => x.id === b.dataset.show); mapModal({ view: [m.lat, m.lon], title: m.fromName + (m.place ? ' — ' + m.place : ''), type: m.type }); }));
  $$('[data-reply]').forEach((b) => b.addEventListener('click', () => api('/api/group/messages', { method: 'POST', body: { type: b.dataset.reply, text: 'Answering ping' } }).then(() => toast('Sent')).catch((e) => toast(e.message, 'bad'))));
}

// ---------- board ----------
function board() {
  mount(app, html`<h1 style="font-size:1.3rem;margin-top:8px">Status board</h1>
    <div class="card">${S.snap.members.map((m) => {
      const c = m.lastCheckIn;
      return html`<div class="member"><span class="status-dot ${c?.type || ''}"></span><div class="who"><strong>${m.name}${m.id === S.me ? ' (you)' : ''}</strong>${m.role === 'host' ? html` <span class="badge">laptop</span>` : ''}
        <small>${c ? html`${MSG[c.type]?.label}${c.place ? ' — ' + c.place : ''} · ${ago(c.ts)}` : 'No check-in yet'}</small><small class="faint">Last heard from ${ago(m.lastSeen)}</small></div>
        ${c?.lat != null ? html`<button class="icon-btn" data-loc="${m.id}" aria-label="Show on map">${icon('map')}</button>` : ''}</div>`;
    })}</div>
    <div class="row" style="margin-top:16px"><button class="btn small ghost" id="rename">Change my name</button><span class="spacer"></span><button class="btn small danger" id="leave">Leave group</button></div>`);
  $$('[data-loc]').forEach((b) => b.addEventListener('click', () => { const m = S.snap.members.find((x) => x.id === b.dataset.loc); mapModal({ view: [m.lastCheckIn.lat, m.lastCheckIn.lon], title: m.name, type: m.lastCheckIn.type }); }));
  $('#rename').addEventListener('click', async () => { const n = prompt('Your name', me()?.name); if (n) await api('/api/group/me', { method: 'POST', body: { name: n } }); });
  $('#leave').addEventListener('click', async () => {
    if (!confirm('Leave the group? You will need the invite code to rejoin.')) return;
    await api('/api/group/leave', { method: 'POST' });
    S.stream?.close();
    location.href = '/join';
  });
}

// ---------- guides & ask ----------
let guideCache = null;
const refAttr = (ref) => (ref.wiki ? html`data-w="${ref.wiki}" data-sec="${ref.section ?? ''}"` : html`data-g="${ref.guide}" data-sec="${ref.section || ''}"`);
async function guides(state = {}) {
  if (state.wiki) {
    const a = await api('/api/public/wiki/article/' + encodeURIComponent(state.wiki));
    mount(app, html`<button class="btn small ghost" id="back">← Guides</button><h1 style="font-size:1.35rem;margin-top:10px">${a.title}</h1><small class="muted">Wikipedia · saved ${String(a.savedAt).slice(0, 10)} · CC BY-SA 4.0</small>
      <article class="prose" style="margin-top:12px">${a.image ? html`<figure class="wiki-hero"><img src="/files/wiki/${a.image}" alt=""><figcaption>${a.imageCredit ? `Image: ${a.imageCredit.artist} · ${a.imageCredit.license}` : 'Image: Wikimedia Commons'}</figcaption></figure>` : ''}${a.sections.map((x, i) => html`<section id="s-${i}">${i ? html`<h2>${x.heading}</h2>` : ''}${markdown(x.text)}</section>`)}</article>`);
    $('#back').addEventListener('click', () => guides());
    if (state.section) document.getElementById('s-' + state.section)?.scrollIntoView(); else window.scrollTo(0, 0);
    return;
  }
  if (state.guide) {
    const g = await api('/api/public/guides/' + encodeURIComponent(state.guide));
    mount(app, html`<button class="btn small ghost" id="back">← Guides</button><h1 style="font-size:1.35rem;margin-top:10px">${g.title}</h1><small class="muted">${g.publisher} · ${g.date} · v${g.version}</small>
      <article class="prose" style="margin-top:12px">${g.intro ? markdown(g.intro) : ''}${g.sections.map((s) => html`<section id="s-${s.id}"><h2>${s.heading}</h2>${markdown(s.markdown)}</section>`)}</article>`);
    $('#back').addEventListener('click', () => guides());
    if (state.section) document.getElementById('s-' + state.section)?.scrollIntoView();
    else window.scrollTo(0, 0);
    return;
  }
  guideCache ||= await api('/api/public/guides');
  mount(app, html`<h1 style="font-size:1.3rem;margin-top:8px">Survival guides</h1>
    <form id="gq" class="row" style="flex-wrap:nowrap"><input name="q" type="search" placeholder="Search or ask — e.g. cleaning water" value="${state.q || ''}"><button class="btn primary">${icon('search')}</button></form>
    <div class="row" style="margin-top:8px"><label class="check"><input type="checkbox" id="askmode" ${state.ask ? 'checked' : ''}> Ask a question instead of searching</label></div>
    <div id="gres" style="margin-top:14px"></div>`);
  const res = $('#gres');
  $('#gq').addEventListener('submit', (e) => { e.preventDefault(); guides({ q: e.target.q.value.trim(), ask: $('#askmode').checked }); });
  if (!state.q) {
    const w = await api('/api/public/wiki').catch(() => null);
    const saved = (w?.catalog || []).flatMap((c) => c.titles.filter((t) => t.saved));
    mount(res, html`<div class="card">${guideCache.map((g) => html`<a href="#" class="item-link" data-g="${g.id}" style="padding:10px 0;border-top:1px solid var(--line)"><strong>${g.title}</strong><br><small class="muted">${g.summary}</small></a>`)}</div>
      ${saved.length ? html`<h2 style="margin:18px 0 10px">Encyclopedia · ${saved.length}</h2><div class="wiki-grid">${saved.map((t) => html`<a class="wiki-card" href="#" data-w="${t.id}">${t.image ? html`<img src="/files/wiki/${t.image}" alt="" loading="lazy">` : html`<div class="wiki-noimg">${icon('book')}</div>`}<div><strong>${t.title}</strong><small>${t.summary.slice(0, 90)}…</small></div></a>`)}</div>` : ''}`);
  } else if (state.ask) {
    mount(res, html`<p class="muted">Looking it up…</p>`);
    try {
      const a = await api('/api/public/ask', { method: 'POST', body: { question: state.q } });
      const cite = (n) => `<a class="cite" href="#" data-src="${n}">${n}</a>`;
      mount(res, html`<div class="card a-card">${a.urgent ? html`<div class="urgent">${a.urgent}</div>` : ''}<div class="prose">${markdown(a.answer, { cite })}</div>
        <div class="sources">${a.sources.map((s) => html`<a class="source ${s.used ? '' : 'unused'}" href="#" ${refAttr(s.ref)}><span class="n">${s.n}</span><span><strong>${s.title}</strong> › ${s.subtitle}<p>${highlight(s.excerpt, s.highlights)}</p></span></a>`)}</div></div>`);
      $$('[data-src]', res).forEach((c) => c.addEventListener('click', (e) => { e.preventDefault(); const s = a.sources[Number(c.dataset.src) - 1]; guides(s.ref.wiki ? { wiki: s.ref.wiki, section: s.ref.section } : { guide: s.ref.guide, section: s.ref.section }); }));
    } catch (err) { mount(res, html`<div class="notice bad">${err.message}</div>`); }
  } else {
    const r = await api('/api/public/search?q=' + encodeURIComponent(state.q));
    mount(res, r.results.length ? html`${r.results.map((x) => html`<a class="result" href="#" ${refAttr(x.ref)}><div class="result-head"><span class="result-title">${x.title}</span><span class="result-sub">› ${x.subtitle}</span></div><p>${highlight(x.excerpt, x.highlights)}</p></a>`)}` : html`<div class="empty">Nothing found. Try other words.</div>`);
  }
  $$('[data-g]', res).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); guides({ guide: a.dataset.g, section: a.dataset.sec }); }));
  $$('[data-w]', res).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); guides({ wiki: a.dataset.w, section: a.dataset.sec }); }));
}

// ---------- log ----------
async function log() {
  S.log = await api('/api/group/log').catch(() => S.log);
  const KIND = { event: 'What happened', checked: 'Checked', todo: 'Still to do' };
  const list = [...S.log].reverse();
  mount(app, html`<h1 style="font-size:1.3rem;margin-top:8px">Outage log</h1>
    <form id="lf" class="card stack" style="padding:12px"><select name="kind">${Object.entries(KIND).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select><div class="row" style="flex-wrap:nowrap"><input name="text" placeholder="What happened or what did you check?" maxlength="1000" required><button class="btn primary">Add</button></div></form>
    <div class="card" style="margin-top:12px">${list.length ? list.map((e) => html`<div class="log-entry ${e.done ? 'done' : ''}"><span class="kind-icon ${e.kind}">${{ event: 'E', checked: '✓', todo: '!' }[e.kind]}</span><div><div class="log-text">${e.text}</div><small class="muted">${e.author} · ${clock(e.ts)}</small></div>${e.kind === 'todo' ? html`<label class="check"><input type="checkbox" data-done="${e.id}" ${e.done ? 'checked' : ''}></label>` : html`<span></span>`}</div>`) : html`<div class="empty">Nothing logged yet.</div>`}</div>`);
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/group/log', { method: 'POST', body: { kind: e.target.kind.value, text: e.target.text.value } }); e.target.text.value = ''; log(); } catch (err) { toast(err.message, 'bad'); }
  });
  $$('[data-done]').forEach((c) => c.addEventListener('change', () => api('/api/group/log/' + c.dataset.done, { method: 'PUT', body: { done: c.checked } }).then(log)));
}

// ---------- modals ----------
function closeModal() { mount($('#modal'), ''); }

function pingModal(m) {
  mount($('#modal'), html`<div class="modal-back"><div class="card modal stack" role="alertdialog" aria-label="Check-in request">
    <h2>${m.fromName} is checking on you</h2><p class="muted">${m.text || 'Are you OK?'}</p>
    <div class="checkin-btns" style="grid-template-columns:1fr 1fr"><button class="btn safe fill" data-r="safe">I'm safe</button><button class="btn help fill" data-r="help">I need help</button></div>
    <button class="btn ghost" id="later">Answer later</button></div></div>`);
  $$('[data-r]', $('#modal')).forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/group/messages', { method: 'POST', body: { type: b.dataset.r, text: 'Answering ' + m.fromName } }); toast('Sent'); } catch (err) { toast(err.message, 'bad'); }
    closeModal();
  }));
  $('#later').addEventListener('click', closeModal);
}

async function mapModal({ pick, view, title, type }) {
  mount($('#modal'), html`<div class="modal-back"><div class="card modal stack" style="width:min(640px,100%)">
    <div class="row between"><strong>${title}</strong><button class="icon-btn" id="mclose" aria-label="Close">${icon('x')}</button></div>
    <div id="mm" class="map" style="height:60vh"></div>
    ${pick ? html`<div class="row end"><span class="muted" id="picked">Tap the map</span><button class="btn primary" id="use" disabled>Use this spot</button></div>` : ''}
  </div></div>`);
  const { map } = await createMap($('#mm'), { maps: S.maps });
  const mp = S.snap.session.meetingPoint;
  if (mp?.lat != null) window.L.marker([mp.lat, mp.lon], { icon: pinIcon('meeting') }).addTo(map).bindTooltip('Meeting point');
  let marker = null;
  let chosen = S.place?.lat != null ? [S.place.lat, S.place.lon] : null;
  const start = view || chosen || (mp?.lat != null ? [mp.lat, mp.lon] : null);
  if (view) window.L.marker(view, { icon: msgIcon(type || 'meet') }).addTo(map);
  if (start) map.setView(start, 16);
  else if (S.maps[0]?.bounds) { const b = S.maps[0].bounds; map.fitBounds([[b[1], b[0]], [b[3], b[2]]]); }
  if (pick) {
    const place = (ll) => {
      chosen = ll;
      if (!marker) marker = window.L.marker(ll, { icon: msgIcon('meet') }).addTo(map); else marker.setLatLng(ll);
      $('#picked').textContent = fmtCoord(ll[0], ll[1]);
      $('#use').disabled = false;
    };
    if (chosen) place(chosen);
    map.on('click', (e) => place([e.latlng.lat, e.latlng.lng]));
    $('#use').addEventListener('click', () => { S.place = { ...(S.place || {}), lat: chosen[0], lon: chosen[1] }; closeModal(); render(); });
  }
  setTimeout(() => map.invalidateSize(), 60);
  $('#mclose').addEventListener('click', () => { map.remove(); closeModal(); });
}

start();
