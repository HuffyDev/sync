import { $, $$, api, html, mount, toast, icon, ago, raw, groupStream } from './shared.js';
import { refresh } from './app.js';

const STATUS = {
  queued: ['warn', 'Waiting for signal'],
  sent: ['blue', 'Broadcast'],
  confirmed: ['ok', 'Confirmed'],
  expired: ['bad', 'Expired'],
  rejected: ['bad', 'Rejected'],
  'needs-signature': ['bad', 'Not signed'],
};
const short = (s, n = 6) => (s && s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || '');

function statusOf(it) { return it.confirmed ? 'confirmed' : it.status; }

function describe(d) {
  if (d.chain === 'bitcoin') {
    return html`<table class="table relay-table"><thead><tr><th>Pays</th><th style="text-align:right">Amount</th></tr></thead><tbody>${d.outputs.map((o) => html`<tr><td class="mono">${o.address}</td><td class="mono" style="text-align:right">${o.btc} BTC</td></tr>`)}</tbody></table>
      <div class="meta-line" style="margin-top:6px"><span>${d.inputs.length} input${d.inputs.length > 1 ? 's' : ''}</span><span>${d.segwit ? 'SegWit' : 'Legacy'}</span><span>Fee is shown after broadcast (needs the previous outputs)</span></div>`;
  }
  return html`<table class="table relay-table"><tbody>${d.actions.map((a) => html`<tr>${
    a.type === 'transfer' ? html`<td>Send <b class="mono">${a.amount} SOL</b></td><td class="mono">${short(a.from)} → ${a.to}</td>`
    : a.type === 'token' ? html`<td>Send tokens <b class="mono">${a.amount ?? a.amountRaw + ' raw'}</b></td><td class="mono">${a.mint ? html`mint ${short(a.mint)} · ` : ''}to token account ${short(a.to, 8)}</td>`
    : a.type === 'memo' ? html`<td>Memo</td><td>${a.text}</td>`
    : html`<td>Program call</td><td class="mono">${a.program || a.detail}</td>`}</tr>`)}</tbody></table>
    <div class="meta-line" style="margin-top:6px"><span>Fee payer ${short(d.feePayer)}</span><span>${d.validSignatures}/${d.signers.length} signatures valid</span>${d.versioned ? html`<span>v0 transaction</span>` : ''}</div>`;
}

function preview(d) {
  return html`<div class="relay-preview ${d.signed ? '' : 'bad'}">
    <div class="row between"><span class="row" style="gap:8px"><span class="chain ${d.chain}">${d.chain === 'bitcoin' ? 'BTC' : 'SOL'}</span><strong>${d.summary}</strong></span>${d.signed ? html`<span class="badge ok">${icon('check')}Signature valid</span>` : html`<span class="badge bad">Problem</span>`}</div>
    ${describe(d)}
    ${d.problems.length ? html`<div class="notice bad" style="margin-top:8px">${d.problems.join(' ')}</div>` : ''}
    <div class="notice ${d.expires ? 'warn' : 'ok'}" style="margin-top:8px">${d.expiry}</div>
    <div class="mono faint" style="font-size:.68rem;margin-top:6px;overflow-wrap:anywhere">ID ${d.id}</div>
  </div>`;
}

function qrModal(it) {
  const box = document.createElement('div');
  document.body.append(box);
  let svg;
  try {
    const q = window.qrcode(0, 'L');
    q.addData(it.raw);
    q.make();
    svg = q.createSvgTag({ cellSize: 3, margin: 3, scalable: true });
  } catch { svg = null; }
  mount(box, html`<div class="modal-back"><div class="card modal stack" style="width:min(520px,100%)">
    <div class="row between"><strong>Pass this transaction to another device</strong><button class="icon-btn" id="qx" aria-label="Close">${icon('x')}</button></div>
    ${svg ? html`<div class="qr relay-qr">${raw(svg)}</div><p class="muted" style="margin:0">Scan it on the other device's Crypto relay page (Scan QR). It holds the signed transaction only — no keys.</p>` : html`<div class="notice warn">This transaction is too large for one QR code. Use Copy and move it another way (USB, a pack, or the group).</div>`}
    <div class="row"><button class="btn" id="qcopy">${icon('note')}Copy transaction</button></div>
  </div></div>`);
  const close = () => box.remove();
  $('#qx', box).addEventListener('click', close);
  $('.modal-back', box).addEventListener('click', (e) => { if (e.target.classList.contains('modal-back')) close(); });
  $('#qcopy', box).addEventListener('click', () => navigator.clipboard?.writeText(it.raw).then(() => toast('Copied'), () => toast('Copy failed', 'bad')));
}

async function scanQr() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot scan QR codes. Paste the transaction instead.');
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  const box = document.createElement('div');
  document.body.append(box);
  mount(box, html`<div class="modal-back"><div class="card modal stack" style="width:min(520px,100%)"><div class="row between"><strong>Scan a transaction QR code</strong><button class="icon-btn" id="sx" aria-label="Close">${icon('x')}</button></div><video id="sv" playsinline muted style="width:100%;border-radius:6px;background:#000"></video></div></div>`);
  const video = $('#sv', box);
  video.srcObject = stream;
  await video.play();
  return new Promise((resolve, reject) => {
    let done = false;
    const stop = () => { done = true; stream.getTracks().forEach((t) => t.stop()); box.remove(); };
    $('#sx', box).addEventListener('click', () => { stop(); reject(new Error('cancelled')); });
    const loop = async () => {
      if (done) return;
      try { const codes = await detector.detect(video); if (codes[0]?.rawValue) { stop(); resolve(codes[0].rawValue); return; } } catch {}
      setTimeout(loop, 250);
    };
    loop();
  });
}

export async function relayView(el) {
  let data = await api('/api/relay');
  const info = await api('/api/group/info').catch(() => ({ active: false }));
  mount(el, html`
    <div class="relay-hero">
      <div>
        <p class="kicker">Offline crypto relay</p>
        <h1>Send crypto with no internet.</h1>
        <p>Sign a transaction in your own wallet — offline is fine. LASTSYNC checks it, holds it, passes it across your group over local Wi-Fi or a QR code, and broadcasts it the moment any device finds a signal.</p>
        <div class="chips" style="margin-top:12px"><span class="chip on">Bitcoin</span><span class="chip on">Solana · durable nonce</span><span class="chip">Your keys never touch LASTSYNC</span></div>
      </div>
      <div class="relay-flow" aria-hidden="true">
        <div class="rf-node"><span>${icon('kit')}</span><b>Your wallet</b><small>signs offline</small></div>
        <div class="rf-wire"><i></i></div>
        <div class="rf-node"><span>${icon('chip')}</span><b>LASTSYNC</b><small>checks &amp; holds</small></div>
        <div class="rf-wire"><i></i></div>
        <div class="rf-node"><span>${icon('group')}</span><b>Any device</b><small>finds signal</small></div>
        <div class="rf-wire"><i></i></div>
        <div class="rf-node ok"><span>${icon('check')}</span><b>Network</b><small>confirmed</small></div>
      </div>
    </div>
    <div class="stat-row" id="relay-stats"></div>
    <div class="grid grid-2">
      <section class="card stack">
        <div class="card-title"><h2>Add a signed transaction</h2>${'BarcodeDetector' in window ? html`<button class="btn small" id="scan">${icon('gps')}Scan QR</button>` : ''}</div>
        <textarea id="txin" rows="5" placeholder="Paste a signed transaction — Bitcoin raw hex, or Solana base64 / base58" spellcheck="false" class="mono" style="font-size:.78rem"></textarea>
        <div id="txprev"></div>
        <div class="row"><input id="txnote" placeholder="Note (optional), e.g. Rent to Sam" maxlength="140"><button class="btn primary" id="txadd" disabled>${icon('send')}Add to relay</button></div>
      </section>
      <section class="card stack">
        <h2>How offline sending works</h2>
        <ol class="steps">
          <li><span><strong>Sign it offline</strong> in your own wallet and export the signed transaction. Bitcoin: Sparrow or Electrum can sign with no internet and export the raw transaction. Solana: sign with a <em>durable nonce</em> so it doesn't expire.</span></li>
          <li><span><strong>Bring it here</strong> — paste it, scan its QR code, or have a phone in your group add it.</span></li>
          <li><span><strong>It goes out on the first signal.</strong> This ${info.active ? 'PC and every phone in your group' : 'device'} can broadcast it; whoever gets a connection first sends it, and LASTSYNC tracks it to confirmation.</span></li>
        </ol>
        <p class="muted" style="margin:0;font-size:.86rem">LASTSYNC only ever handles transactions that are already signed. It never asks for a seed phrase or private key, and it can't change a transaction — any change breaks the signature, which LASTSYNC checks.</p>
      </section>
    </div>
    <section class="card"><div class="card-title"><h2>Relay queue</h2><span class="muted mono" id="relay-net" style="font-size:.72rem"></span></div><div id="queue"></div></section>`);

  const renderStats = () => {
    const c = data.counts;
    mount($('#relay-stats'), html`
      <div class="stat"><div class="label">Waiting for signal</div><div class="v ${c.queued ? 'warn' : ''}">${c.queued}</div></div>
      <div class="stat"><div class="label">Broadcast</div><div class="v">${c.sent}</div></div>
      <div class="stat"><div class="label">Confirmed</div><div class="v ok">${c.confirmed}</div></div>
      <div class="stat"><div class="label">Uplink</div><div class="v ${data.online ? 'ok' : data.online === false ? 'bad' : ''}">${data.online ? 'ONLINE' : data.online === false ? 'OFFLINE' : '—'}</div></div>`);
    $('#relay-net').textContent = data.online === false ? 'NO SIGNAL — QUEUED TRANSACTIONS GO OUT AUTOMATICALLY WHEN IT RETURNS' : '';
  };
  const renderQueue = () => {
    mount($('#queue'), data.items.length ? html`${data.items.map((it) => {
      const st = STATUS[statusOf(it)] || ['', it.status];
      return html`<div class="relay-item">
        <span class="chain ${it.chain}">${it.chain === 'bitcoin' ? 'BTC' : 'SOL'}</span>
        <div class="ri-main"><strong>${it.note || it.summary}</strong>${it.note ? html`<small class="muted">${it.summary}</small>` : ''}
          <small class="faint mono">added by ${it.by} ${ago(it.addedAt)}${it.sentBy ? ` · broadcast by ${it.sentBy} ${ago(it.sentAt)}` : ''}${it.attempts ? ` · ${it.attempts} attempt${it.attempts > 1 ? 's' : ''}` : ''}</small>
          ${it.lastError && it.status !== 'sent' ? html`<small style="color:${it.status === 'queued' ? 'var(--warn)' : 'var(--help)'}">${it.lastError}</small>` : ''}
          ${it.expires && it.status === 'queued' ? html`<small style="color:var(--warn)">Uses a recent blockhash — it may expire before a signal is found.</small>` : ''}</div>
        <div class="ri-side"><span class="badge ${st[0]}">${st[1]}</span>
          <div class="row" style="gap:4px;justify-content:flex-end">
            ${it.explorer ? html`<a class="icon-btn" href="${it.explorer}" target="_blank" rel="noopener" title="View on explorer">${icon('external')}</a>` : ''}
            <button class="icon-btn" data-qr="${it.qid}" title="Show QR">${icon('expand')}</button>
            ${['rejected', 'expired'].includes(it.status) && it.signed ? html`<button class="icon-btn" data-retry="${it.qid}" title="Try again">${icon('route')}</button>` : ''}
            <button class="icon-btn" data-del="${it.qid}" title="Remove">${icon('trash')}</button>
          </div></div>
      </div>`;
    })}` : html`<div class="empty">Nothing in the relay yet. Signed transactions you add show up here until they're confirmed.</div>`);
    $$('[data-qr]', el).forEach((b) => b.addEventListener('click', () => qrModal(data.items.find((x) => x.qid === b.dataset.qr))));
    $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Remove this transaction from the relay? (If it was already broadcast, this does not cancel it.)')) return; await api('/api/relay/' + b.dataset.del, { method: 'DELETE' }); load(); }));
    $$('[data-retry]', el).forEach((b) => b.addEventListener('click', async () => { await api(`/api/relay/${b.dataset.retry}/retry`, { method: 'POST' }); load(); }));
  };
  const load = async () => { data = await api('/api/relay').catch(() => data); if ($('#queue')) { renderStats(); renderQueue(); } };
  renderStats(); renderQueue();

  let timer = null;
  const input = $('#txin');
  const check = async () => {
    const v = input.value.trim();
    $('#txadd').disabled = true;
    if (!v) { mount($('#txprev'), ''); return; }
    try {
      const d = await api('/api/relay/decode', { method: 'POST', body: { tx: v } });
      mount($('#txprev'), preview(d));
      $('#txadd').disabled = !d.signed;
    } catch (err) { mount($('#txprev'), html`<div class="notice bad">${err.message}</div>`); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 250); });
  $('#txadd').addEventListener('click', async () => {
    try {
      await api('/api/relay', { method: 'POST', body: { tx: input.value, note: $('#txnote').value } });
      input.value = ''; $('#txnote').value = ''; mount($('#txprev'), ''); $('#txadd').disabled = true;
      toast('Added — it goes out as soon as there is a signal');
      load();
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('#scan')?.addEventListener('click', async () => {
    try { input.value = await scanQr(); check(); } catch (err) { if (err.message !== 'cancelled') toast(err.message, 'bad'); }
  });

  const poll = setInterval(load, 8000);
  const stream = info.active ? groupStream({ relay: () => load() }) : null;
  return () => { clearInterval(poll); clearTimeout(timer); stream?.close(); };
}

export { refresh };
