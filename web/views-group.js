import { $, $$, api, html, mount, raw, toast, icon, ago, clock, groupStream, MSG, receiptText, fmtCoord } from './shared.js';
import { watchGroup, dismissHelp, refresh } from './app.js';
import { gps } from './views-map.js';

export function qrSvg(text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return raw(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
}

export async function groupView(el) {
  const info = await api('/api/group/info');
  if (!info.active) return startForm(el);
  const settings = await api('/api/settings');
  const [snap, invite, plan, pins] = await Promise.all([api('/api/group/state'), api('/api/group/invite'), api('/api/plan'), api('/api/pins')]);
  dismissHelp();
  let urlIdx = 0;
  const places = [
    ...plan.meetingPoints.filter((m) => m.name).map((m) => ({ key: 'mp:' + m.id, name: m.name, lat: m.lat, lon: m.lon })),
    ...pins.map((p) => ({ key: 'pin:' + p.id, name: p.name, lat: p.lat, lon: p.lon })),
  ];

  mount(el, html`
    <div class="page-head"><div><h1>${snap.session.name}</h1><p>Local group on this PC's Wi-Fi network · started ${ago(snap.session.createdAt)}</p></div>
      <div class="row"><a class="btn" href="#/log">${icon('log')}Outage log</a><button class="btn danger" id="end">End session</button></div></div>
    <div class="grid grid-2">
      <section class="card">
        <div class="card-title"><h2>Invite people</h2><button class="btn small ghost" id="newcode">New code</button></div>
        <div id="invite"></div>
      </section>
      <section class="card">
        <h2>Send a check-in</h2>
        <div class="checkin-btns" style="margin-bottom:12px">
          <button class="btn safe" data-send="safe">${icon('check')}I'm safe</button>
          <button class="btn meet" data-send="meet">${icon('pin')}Meet here</button>
          <button class="btn help" data-send="help">${icon('bell')}I need help</button>
        </div>
        <div class="grid grid-2">
          <label class="field"><span>Place (optional)</span><select id="place"><option value="">No location</option>${gps.lat != null ? html`<option value="gps">My GPS position</option>` : ''}${places.map((p) => html`<option value="${p.key}">${p.name}${p.lat == null ? ' (no map location)' : ''}</option>`)}</select></label>
          <label class="field"><span>Send to</span><select id="to"></select></label>
        </div>
        <form id="textf" class="row" style="margin-top:10px;flex-wrap:nowrap"><input id="text" placeholder="Add a message (optional for check-ins)" maxlength="500"><button class="btn">${icon('send')}Send</button></form>
        <label class="check" style="margin-top:8px"><input type="checkbox" id="setmp" checked> “Meet here” also sets the group's meeting point</label>
      </section>
    </div>
    <div class="grid grid-2" style="margin-top:14px">
      <section class="card"><div class="card-title"><h2>Status board</h2><span class="muted" id="count"></span></div><div id="board"></div><hr><div id="mp"></div></section>
      <section class="card"><div class="card-title"><h2>Messages</h2></div><div class="feed" id="feed"></div></section>
    </div>`);

  const renderInvite = () => {
    const u = invite.urls[urlIdx];
    if (!u) {
      mount($('#invite'), html`<div class="notice warn"><strong>This PC isn't on a local network.</strong><br>Connect to a Wi-Fi router (it works without internet if it has power), or turn on <strong>Mobile hotspot</strong> in Windows Settings › Network. Then reopen this page.</div><p style="margin-top:12px">Invite code: <span class="code-big">${invite.code}</span></p>`);
      return;
    }
    mount($('#invite'), html`<div class="row" style="align-items:flex-start;gap:18px">
      <div class="qr">${qrSvg(u.url)}</div>
      <div class="stack" style="flex:1;min-width:200px">
        <p style="margin:0">Phones on the same Wi-Fi: open the camera and scan the code. No app or internet needed.</p>
        <div><small class="muted">Or type this address in the phone's browser</small><br><strong class="mono" style="overflow-wrap:anywhere">http://${u.address}:${location.port || 80}/join</strong></div>
        <div><small class="muted">Invite code</small><br><span class="code-big">${invite.code}</span></div>
        ${invite.urls.length > 1 ? html`<label class="field"><span>Network</span><select id="net">${invite.urls.map((x, i) => html`<option value="${i}" ${i === urlIdx ? 'selected' : ''}>${x.name} — ${x.address}</option>`)}</select></label>` : ''}
      </div></div>`);
    $('#net')?.addEventListener('change', (e) => { urlIdx = Number(e.target.value); renderInvite(); });
  };

  const renderTo = () => {
    const sel = $('#to');
    const cur = sel.value;
    mount(sel, html`<option value="">Everyone</option>${snap.members.filter((m) => m.id !== 'host').map((m) => html`<option value="${m.id}">${m.name}</option>`)}`);
    sel.value = cur;
  };

  const renderBoard = () => {
    const members = snap.members;
    $('#count').textContent = `${members.length} ${members.length === 1 ? 'person' : 'people'}`;
    mount($('#board'), html`${members.map((m) => {
      const c = m.lastCheckIn;
      return html`<div class="member"><span class="status-dot ${c?.type || ''}"></span>
        <div class="who"><strong>${m.name}</strong>${m.id === 'host' ? html` <span class="badge">this PC</span>` : ''}
          <small>${c ? html`${MSG[c.type]?.label}${c.place ? ' at ' + c.place : ''} · ${ago(c.ts)}` : 'No check-in yet'}</small>
          <small class="faint">Last heard from ${ago(m.lastSeen)}</small></div>
        ${c?.lat != null ? html`<a class="icon-btn" href="#/map?lat=${c.lat}&lon=${c.lon}" title="Show on map">${icon('map')}</a>` : ''}
        ${m.id !== 'host' ? html`<button class="btn small" data-ping="${m.id}">Ping</button><button class="icon-btn" data-kick="${m.id}" title="Remove from group">${icon('x')}</button>` : ''}
      </div>`;
    })}`);
    $$('[data-ping]', el).forEach((b) => b.addEventListener('click', () => send('ping', { to: b.dataset.ping, text: 'Are you OK? Tap to answer.' })));
    $$('[data-kick]', el).forEach((b) => b.addEventListener('click', async () => {
      const m = snap.members.find((x) => x.id === b.dataset.kick);
      if (!confirm(`Remove ${m.name} from the group? Their phone will need the invite code to rejoin.`)) return;
      await api('/api/group/members/' + m.id, { method: 'DELETE' });
    }));
    const mp = snap.session.meetingPoint;
    mount($('#mp'), html`<div class="row between"><div><strong>Group meeting point</strong><br>${mp ? html`<span>${mp.name}</span> <small class="muted">· set by ${mp.setBy} ${ago(mp.ts)}${mp.lat != null ? ' · ' + fmtCoord(mp.lat, mp.lon) : ''}</small>` : html`<small class="muted">None set. Everyone sees it on their phone.</small>`}</div>
      <div class="row"><select id="mp-set" style="width:auto;min-height:32px;padding:4px 8px"><option value="">Set from your plan…</option>${places.map((p) => html`<option value="${p.key}">${p.name}</option>`)}</select>${mp ? html`<button class="btn small ghost" id="mp-clear">Clear</button>` : ''}</div></div>`);
    $('#mp-set').addEventListener('change', async (e) => {
      const p = places.find((x) => x.key === e.target.value);
      if (p) await api('/api/group/meeting', { method: 'POST', body: { name: p.name, lat: p.lat, lon: p.lon } });
    });
    $('#mp-clear')?.addEventListener('click', () => api('/api/group/meeting', { method: 'POST', body: { clear: true } }));
    renderTo();
  };

  const renderFeed = () => {
    const msgs = [...snap.messages].reverse();
    mount($('#feed'), msgs.length ? html`${msgs.map((m) => {
      const r = receiptText(m, snap.members, 'host');
      const to = m.to ? snap.members.find((x) => x.id === m.to)?.name || 'someone' : null;
      return html`<div class="msg ${MSG[m.type]?.cls}">
        <div class="msg-head"><strong>${m.fromName}</strong>${m.type !== 'text' ? html`<span class="badge ${m.type === 'help' ? 'bad' : m.type === 'safe' ? 'ok' : 'blue'}">${MSG[m.type].label}</span>` : ''}${to ? html`<small class="muted">to ${to}</small>` : ''}<span class="spacer"></span><small class="muted">${clock(m.ts)}</small></div>
        ${m.text ? html`<div class="msg-body">${m.text}</div>` : ''}
        ${m.place || m.lat != null ? html`<div class="msg-body"><small>📍 ${m.place || ''} ${m.lat != null ? html`<a href="#/map?lat=${m.lat}&lon=${m.lon}">${fmtCoord(m.lat, m.lon)}</a>` : ''}</small></div>` : ''}
        ${r ? html`<div class="receipt ${r.cls}">${r.cls === 'got' ? '✓✓ ' : '✓ '}${r.text}</div>` : ''}
      </div>`;
    })}` : html`<div class="empty">No messages yet. Check-ins from phones appear here.</div>`);
  };

  async function send(type, extra = {}) {
    const placeKey = $('#place').value;
    let loc = {};
    if (placeKey === 'gps' && gps.lat != null) loc = { lat: gps.lat, lon: gps.lon, place: 'GPS position' };
    else if (placeKey) { const p = places.find((x) => x.key === placeKey); if (p) loc = { lat: p.lat, lon: p.lon, place: p.name }; }
    try {
      await api('/api/group/messages', { method: 'POST', body: { type, text: $('#text').value, to: $('#to').value || null, setMeetingPoint: $('#setmp').checked, ...loc, ...extra } });
      $('#text').value = '';
      if (type !== 'ping') toast('Sent');
      else toast('Ping sent');
    } catch (err) { toast(err.message, 'bad'); }
  }

  $$('[data-send]', el).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.send === 'meet' && !$('#place').value && !$('#text').value.trim()) { toast('Pick a place or write where to meet', 'bad'); return; }
    send(b.dataset.send);
  }));
  $('#textf').addEventListener('submit', (e) => { e.preventDefault(); if ($('#text').value.trim()) send('text'); });
  $('#end').addEventListener('click', async () => {
    if (!confirm('End the group session? Everyone will be disconnected and the messages cleared from this PC.')) return;
    await api('/api/group/end', { method: 'POST' });
    await watchGroup();
    refresh('group');
  });
  $('#newcode').addEventListener('click', async () => {
    const r = await api('/api/group/code', { method: 'POST' });
    invite.code = r.code;
    invite.urls = invite.urls.map((u) => ({ ...u, url: u.url.replace(/code=\w+/, 'code=' + r.code) }));
    renderInvite();
    toast('New invite code. People already in the group stay connected.');
  });

  renderInvite(); renderBoard(); renderFeed();
  const stream = groupStream({
    message: (m) => { snap.messages.push(m); renderFeed(); },
    receipt: (r) => { const m = snap.messages.find((x) => x.id === r.id); if (m) { m.receipts[r.memberId] = r.ts; renderFeed(); } },
    members: (list) => { snap.members = list; renderBoard(); renderFeed(); },
    session: (s) => { if (s) { snap.session = { ...snap.session, ...s }; renderBoard(); } },
    ended: () => refresh('group'),
  });
  const tick = setInterval(() => { renderBoard(); }, 30000);
  return () => { stream.close(); clearInterval(tick); };
}

async function startForm(el) {
  const [settings, status] = await Promise.all([api('/api/settings'), api('/api/status')]);
  mount(el, html`
    <div class="page-head"><div><h1>Group</h1><p>Keep in touch with your household when the internet and cell network are down.</p></div></div>
    <div class="grid grid-2">
      <form class="card stack" id="startf">
        <h2>Start a local group</h2>
        <p class="muted">This PC hosts a private, invite-only session over local Wi-Fi. People join by scanning a QR code with their phone's camera — no app, account or internet. They can send <strong>I'm safe</strong>, <strong>Meet here</strong> and <strong>I need help</strong>, see the status board, and read the survival guides. They can't see your notes, plan or files.</p>
        <label class="field"><span>Group name</span><input name="name" value="Household" maxlength="60" required></label>
        <label class="field"><span>Your name</span><input name="hostName" value="${settings.hostName}" maxlength="40" placeholder="e.g. Sam" required></label>
        <button class="btn primary">${icon('group')}Start group</button>
      </form>
      <section class="card stack">
        <h2>How phones connect</h2>
        ${status.lan.length ? html`<div class="notice ok">This PC is on a local network (${status.lan.map((a) => a.address).join(', ')}). Phones on the same Wi-Fi can join.</div>` : html`<div class="notice warn">This PC isn't on a local network right now.</div>`}
        <ol class="muted" style="padding-left:1.2em;margin:0">
          <li>A Wi-Fi router keeps working without internet as long as it has power — a small UPS or power bank can run one for hours.</li>
          <li>No router? Turn on <strong>Mobile hotspot</strong> in Windows Settings › Network & internet, and have phones join that Wi-Fi.</li>
          <li>If Windows asks whether to allow LASTSYNC on private networks, choose <strong>Allow</strong>.</li>
          <li>Phones may warn the Wi-Fi “has no internet” — tell them to stay connected anyway.</li>
        </ol>
      </section>
    </div>`);
  $('#startf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.hostName.value !== settings.hostName) await api('/api/settings', { method: 'PUT', body: { hostName: f.hostName.value } });
      await api('/api/group/start', { method: 'POST', body: { name: f.name.value, hostName: f.hostName.value } });
      await watchGroup();
      refresh('group');
    } catch (err) { toast(err.message, 'bad'); }
  });
}

// ---------- outage log ----------
const KINDS = { event: { label: 'What happened', short: 'E' }, checked: { label: 'Checked', short: '✓' }, todo: { label: 'Still to do', short: '!' } };

export async function logView(el, _args, query) {
  let entries = await api('/api/log');
  const info = await api('/api/group/info');
  let filter = query.get('f') || 'all';
  mount(el, html`
    <div class="page-head"><div><h1>Outage log</h1><p>Write down what happened, what you've checked, and what still needs doing — so someone else can take over.${info.active ? ' Shared live with your group.' : ''}</p></div><button class="btn" data-print>${icon('print')}Print</button></div>
    <form class="card" id="logf"><div class="row" style="flex-wrap:nowrap">
      <select name="kind" style="width:auto">${Object.entries(KINDS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select>
      <input name="text" placeholder="e.g. Power went out at 6:40 pm — whole street dark" maxlength="1000" required>
      <button class="btn primary">Add</button></div></form>
    <div class="tabs no-print" style="margin-top:16px">${['all', 'todo', 'checked', 'event'].map((f) => html`<button data-f="${f}" class="${filter === f ? 'on' : ''}">${f === 'all' ? 'Everything' : KINDS[f].label}</button>`)}</div>
    <div id="open"></div>
    <section class="card"><div id="entries"></div></section>`);
  const render = () => {
    const open = entries.filter((e) => e.kind === 'todo' && !e.done);
    mount($('#open'), open.length && filter === 'all' ? html`<div class="notice warn" style="margin-bottom:14px"><strong>${open.length} open task${open.length > 1 ? 's' : ''}:</strong> ${open.map((e) => e.text).join(' · ')}</div>` : '');
    const list = entries.filter((e) => filter === 'all' || e.kind === filter).slice().reverse();
    mount($('#entries'), list.length ? html`${list.map((e) => html`<div class="log-entry ${e.done ? 'done' : ''}">
      <span class="kind-icon ${e.kind}" title="${KINDS[e.kind].label}">${KINDS[e.kind].short}</span>
      <div><div class="log-text">${e.text}</div><small class="muted">${e.author} · ${clock(e.ts)}${e.done ? ` · done by ${e.doneBy || '?'} ${ago(e.doneAt)}` : ''}</small></div>
      <div class="row">${e.kind === 'todo' ? html`<label class="check"><input type="checkbox" data-done="${e.id}" ${e.done ? 'checked' : ''}> Done</label>` : ''}<button class="icon-btn no-print" data-del="${e.id}" aria-label="Delete">${icon('trash')}</button></div>
    </div>`)}` : html`<div class="empty">Nothing logged yet.</div>`);
    $$('[data-done]', el).forEach((c) => c.addEventListener('change', async () => {
      const upd = await api('/api/log/' + c.dataset.done, { method: 'PUT', body: { done: c.checked } });
      entries = entries.map((x) => (x.id === upd.id ? upd : x)); render();
    }));
    $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this entry?')) return;
      await api('/api/log/' + b.dataset.del, { method: 'DELETE' });
      entries = entries.filter((x) => x.id !== b.dataset.del); render();
    }));
  };
  render();
  $$('[data-f]', el).forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; $$('[data-f]', el).forEach((x) => x.classList.toggle('on', x === b)); render(); }));
  $('#logf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const entry = await api('/api/log', { method: 'POST', body: { kind: f.kind.value, text: f.text.value } });
      if (!entries.find((x) => x.id === entry.id)) entries.push(entry);
      f.text.value = '';
      render();
    } catch (err) { toast(err.message, 'bad'); }
  });
  if (!info.active) return null;
  const stream = groupStream({ log: (entry) => {
    const i = entries.findIndex((x) => x.id === entry.id);
    if (i >= 0) entries[i] = entry; else entries.push(entry);
    render();
  } });
  return () => stream.close();
}
