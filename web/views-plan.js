import { $, $$, api, html, mount, toast, icon, createMap, pinIcon, fmtCoord } from './shared.js';
import { gps } from './views-map.js';

const SECTIONS = {
  grab: { title: 'What to grab', hint: 'Things to take if you have to leave.' },
  go: { title: 'Where to go', hint: 'Steps in order — e.g. “If the street floods, go to the school gym.”' },
  check: { title: 'Who to check on', hint: 'Neighbors, relatives or pets who need a visit or a call.' },
};
const SUGGESTED = {
  grab: ['Water (1 gallon / 4 L per person per day)', 'Medications for 7 days', 'Phone, charger and power bank', 'Flashlight and spare batteries', 'Battery or hand-crank radio', 'First aid kit', 'Copies of IDs and insurance papers', 'Cash in small bills', 'Warm clothes and sturdy shoes', 'This printed sheet'],
  go: ['Check on everyone at home', 'Leave a note on the door saying where you went', 'Go to the first meeting point', 'If that is unsafe, go to the second meeting point'],
  check: ['Elderly neighbor', 'Relatives who live alone', 'Pets'],
};

const uid = () => Math.random().toString(36).slice(2, 10);

export async function planView(el) {
  const [plan, pins] = await Promise.all([api('/api/plan'), api('/api/pins')]);
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    $('#plan-status').textContent = 'Saving…';
    timer = setTimeout(async () => {
      try { await api('/api/plan', { method: 'PUT', body: plan }); $('#plan-status').textContent = 'All changes saved'; }
      catch (err) { $('#plan-status').textContent = 'Not saved: ' + err.message; }
    }, 600);
  };

  const render = () => {
    mount(el, html`
      <div class="page-head">
        <div><h1>Household plan</h1><p>Who to contact, where to meet, who does what. Saved on this PC as you type.</p></div>
        <div class="row"><span class="muted" id="plan-status"></span><a class="btn primary" href="#/print">${icon('print')}Printable sheet</a></div>
      </div>

      <section class="card">
        <div class="card-title"><h2>Contacts</h2><button class="btn small" data-add="contacts">${icon('plus')}Add contact</button></div>
        ${plan.contacts.length ? html`<div class="table-scroll"><table class="table"><thead><tr><th>Name</th><th>Relation</th><th>Phone</th><th>Radio / channel</th><th>Note</th><th title="Include on the printed sheet">Print</th><th></th></tr></thead><tbody>
          ${plan.contacts.map((c, i) => html`<tr>
            <td><input data-l="contacts" data-i="${i}" data-k="name" value="${c.name}" placeholder="Name" aria-label="Name"></td>
            <td><input data-l="contacts" data-i="${i}" data-k="relation" value="${c.relation}" placeholder="e.g. Out-of-area contact" aria-label="Relation"></td>
            <td><input data-l="contacts" data-i="${i}" data-k="phone" value="${c.phone}" type="tel" placeholder="Phone" aria-label="Phone"></td>
            <td><input data-l="contacts" data-i="${i}" data-k="radio" value="${c.radio}" placeholder="e.g. FRS ch. 3" aria-label="Radio"></td>
            <td><input data-l="contacts" data-i="${i}" data-k="note" value="${c.note}" aria-label="Note"></td>
            <td><input type="checkbox" data-l="contacts" data-i="${i}" data-k="print" ${c.print ? 'checked' : ''} aria-label="Print"></td>
            <td><button class="icon-btn" data-del="contacts" data-i="${i}" aria-label="Remove">${icon('trash')}</button></td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">Add family members, an <strong>out-of-area contact</strong> (often easier to reach than local numbers during an outage), neighbors and doctors.</p>`}
      </section>

      <section class="card">
        <div class="card-title"><h2>Meeting points</h2><button class="btn small" data-add="meetingPoints">${icon('plus')}Add meeting point</button></div>
        ${plan.meetingPoints.length ? plan.meetingPoints.map((m, i) => html`<div class="grid grid-2" style="padding:12px 0;border-top:1px solid var(--line)">
            <label class="field"><span>Name</span><input data-l="meetingPoints" data-i="${i}" data-k="name" value="${m.name}" placeholder="e.g. Oak Street library steps"></label>
            <label class="field"><span>Address or directions</span><input data-l="meetingPoints" data-i="${i}" data-k="address" value="${m.address}"></label>
            <label class="field"><span>When to go there</span><input data-l="meetingPoints" data-i="${i}" data-k="when" value="${m.when}" placeholder="e.g. If we can't get home"></label>
            <label class="field"><span>Note</span><input data-l="meetingPoints" data-i="${i}" data-k="note" value="${m.note}"></label>
            <div class="row" style="grid-column:1/-1">
              <span class="muted">${m.lat != null ? html`📍 <span class="mono">${fmtCoord(m.lat, m.lon)}</span>` : 'No location set'}</span>
              <select data-mp-pin="${i}" style="width:auto;min-height:32px;padding:4px 8px"><option value="">Set location from a pin…</option>${pins.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select>
              ${gps.lat != null ? html`<button class="btn small" data-mp-gps="${i}">${icon('gps')}Use GPS position</button>` : ''}
              ${m.lat != null ? html`<a class="btn small" href="#/map?lat=${m.lat}&lon=${m.lon}">${icon('map')}Show</a>` : html`<a class="btn small ghost" href="#/map">Add a pin on the map first</a>`}
              <label class="check"><input type="checkbox" data-l="meetingPoints" data-i="${i}" data-k="print" ${m.print ? 'checked' : ''}> Print</label>
              <span class="spacer"></span><button class="icon-btn" data-del="meetingPoints" data-i="${i}" aria-label="Remove">${icon('trash')}</button>
            </div></div>`)
          : html`<p class="muted">Pick one place near home and one outside your neighborhood, in case home isn't safe.</p>`}
      </section>

      <section class="card">
        <div class="card-title"><h2>Responsibilities</h2><button class="btn small" data-add="responsibilities">${icon('plus')}Add</button></div>
        ${plan.responsibilities.length ? html`<table class="table"><thead><tr><th style="width:30%">Who</th><th>Does what</th><th></th></tr></thead><tbody>${plan.responsibilities.map((r, i) => html`<tr>
            <td><input data-l="responsibilities" data-i="${i}" data-k="person" value="${r.person}" placeholder="Name" aria-label="Who"></td>
            <td><input data-l="responsibilities" data-i="${i}" data-k="task" value="${r.task}" placeholder="e.g. Picks up the kids from school" aria-label="Task"></td>
            <td><button class="icon-btn" data-del="responsibilities" data-i="${i}" aria-label="Remove">${icon('trash')}</button></td></tr>`)}</tbody></table>`
          : html`<p class="muted">Decide now who gets the kids, who checks the neighbors, who handles the water.</p>`}
      </section>

      <div class="grid grid-3" style="margin-top:14px">
        ${Object.entries(SECTIONS).map(([key, sec]) => {
          const items = plan.checklist.map((c, i) => ({ ...c, i })).filter((c) => c.section === key);
          return html`<section class="card">
            <div class="card-title"><h3>${sec.title}</h3><button class="btn small" data-add-check="${key}">${icon('plus')}</button></div>
            <p class="muted" style="font-size:0.88rem">${sec.hint}</p>
            <ul class="list checklist">${items.map((c) => html`<li class="${c.done ? 'done' : ''}"><input type="checkbox" class="check" data-l="checklist" data-i="${c.i}" data-k="done" ${c.done ? 'checked' : ''} aria-label="Done"><input data-l="checklist" data-i="${c.i}" data-k="text" value="${c.text}" aria-label="Item"><button class="icon-btn" data-del="checklist" data-i="${c.i}" aria-label="Remove">${icon('x')}</button></li>`)}</ul>
            ${!items.length ? html`<button class="btn small ghost" data-suggest="${key}">Add suggestions</button>` : ''}
          </section>`;
        })}
      </div>`);
    bind();
  };

  function bind() {
    $$('[data-l]', el).forEach((inp) => {
      const ev = inp.type === 'checkbox' ? 'change' : 'input';
      inp.addEventListener(ev, () => {
        const item = plan[inp.dataset.l][Number(inp.dataset.i)];
        item[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (inp.dataset.k === 'done') inp.closest('li')?.classList.toggle('done', inp.checked);
        save();
      });
    });
    $$('[data-add]', el).forEach((b) => b.addEventListener('click', () => {
      const l = b.dataset.add;
      const blank = { contacts: { name: '', relation: '', phone: '', radio: '', note: '', print: true }, meetingPoints: { name: '', address: '', when: '', note: '', lat: null, lon: null, print: true }, responsibilities: { person: '', task: '' } }[l];
      plan[l].push({ id: uid(), ...blank });
      render(); save();
      const inputs = $$(`[data-l="${l}"][data-k]`, el).filter((x) => x.type !== 'checkbox');
      inputs[inputs.length - (l === 'contacts' ? 4 : l === 'meetingPoints' ? 4 : 2)]?.focus();
    }));
    $$('[data-del]', el).forEach((b) => b.addEventListener('click', () => {
      plan[b.dataset.del].splice(Number(b.dataset.i), 1);
      render(); save();
    }));
    $$('[data-add-check]', el).forEach((b) => b.addEventListener('click', () => {
      plan.checklist.push({ id: uid(), text: '', section: b.dataset.addCheck, done: false });
      render(); save();
      const last = $$(`[data-l="checklist"][data-k="text"]`, el).filter((x) => plan.checklist[Number(x.dataset.i)].section === b.dataset.addCheck).pop();
      last?.focus();
    }));
    $$('[data-suggest]', el).forEach((b) => b.addEventListener('click', () => {
      for (const t of SUGGESTED[b.dataset.suggest]) plan.checklist.push({ id: uid(), text: t, section: b.dataset.suggest, done: false });
      render(); save();
    }));
    $$('[data-mp-pin]', el).forEach((s) => s.addEventListener('change', () => {
      const p = pins.find((x) => x.id === s.value);
      if (!p) return;
      const m = plan.meetingPoints[Number(s.dataset.mpPin)];
      Object.assign(m, { lat: p.lat, lon: p.lon });
      if (!m.name) m.name = p.name;
      render(); save();
    }));
    $$('[data-mp-gps]', el).forEach((b) => b.addEventListener('click', () => {
      Object.assign(plan.meetingPoints[Number(b.dataset.mpGps)], { lat: gps.lat, lon: gps.lon });
      render(); save();
    }));
  }
  render();
  $('#plan-status').textContent = '';
}

export async function printView(el) {
  const [plan, settings, maps] = await Promise.all([api('/api/plan'), api('/api/settings'), api('/api/maps')]);
  const contacts = plan.contacts.filter((c) => c.print && c.name);
  const mps = plan.meetingPoints.filter((m) => m.print && m.name);
  const located = mps.filter((m) => m.lat != null);
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  mount(el, html`
    <div class="page-head no-print">
      <div><h1>Printable survival sheet</h1><p>One page to keep on the fridge or in your bag, in case the laptop runs out of power. Choose what's included on the <a href="#/plan">plan page</a>.</p></div>
      <button class="btn primary" id="print">${icon('print')}Print</button>
    </div>
    <div class="sheet">
      <div class="row between" style="align-items:flex-start"><div><h1>Household emergency sheet</h1><div>${settings.hostName ? settings.hostName + ' · ' : ''}Printed ${today}</div></div><div style="text-align:right;font-size:11px">Emergency: <strong>911 / 112 / 999</strong><br>Text if calls fail</div></div>
      <h2>Contacts</h2>
      ${contacts.length ? html`<table><thead><tr><th>Name</th><th>Relation</th><th>Phone</th><th>Radio</th><th>Note</th></tr></thead><tbody>${contacts.map((c) => html`<tr><td><strong>${c.name}</strong></td><td>${c.relation}</td><td>${c.phone}</td><td>${c.radio}</td><td>${c.note}</td></tr>`)}</tbody></table>` : html`<p>No contacts yet.</p>`}
      <h2>Meeting points</h2>
      ${mps.length ? html`<table><thead><tr><th>Where</th><th>When</th><th>Location</th></tr></thead><tbody>${mps.map((m, i) => html`<tr><td><strong>${i + 1}. ${m.name}</strong>${m.address ? html`<br>${m.address}` : ''}${m.note ? html`<br><em>${m.note}</em>` : ''}</td><td>${m.when}</td><td style="font-family:monospace;font-size:11px">${fmtCoord(m.lat, m.lon)}</td></tr>`)}</tbody></table>` : html`<p>No meeting points yet.</p>`}
      ${located.length ? html`<div class="sheet-map" id="sheet-map"></div>` : ''}
      <div class="cols">
        <div>
          ${plan.responsibilities.length ? html`<h2>Who does what</h2><table><tbody>${plan.responsibilities.filter((r) => r.person || r.task).map((r) => html`<tr><td><strong>${r.person}</strong></td><td>${r.task}</td></tr>`)}</tbody></table>` : ''}
          ${['go', 'check'].map((k) => { const items = plan.checklist.filter((c) => c.section === k && c.text); return items.length ? html`<h2>${SECTIONS[k].title}</h2>${items.map((c) => html`<div><span class="box"></span>${c.text}</div>`)}` : ''; })}
        </div>
        <div>
          ${(() => { const items = plan.checklist.filter((c) => c.section === 'grab' && c.text); return items.length ? html`<h2>What to grab</h2>${items.map((c) => html`<div><span class="box"></span>${c.text}</div>`)}` : ''; })()}
          <div class="sheet-sos"><strong>Quick facts</strong><br>
            • Boil water at a rolling boil for 1 minute (3 minutes above 6,500 ft / 2,000 m).<br>
            • Or add unscented 6% bleach: 8 drops per gallon (2 per litre); wait 30 minutes.<br>
            • Never run a generator, grill or camp stove indoors or in a garage.<br>
            • Closed fridge: about 4 hours. Full freezer: about 48 hours.<br>
            • Text instead of calling. Three whistle blasts = I need help.</div>
        </div>
      </div>
      <div class="foot">Made with LASTSYNC — the offline survival kit. Quick facts are from the bundled guides (CDC, US EPA, USDA, Ready.gov). Check them against local instructions.</div>
    </div>`);
  $('#print').addEventListener('click', async () => {
    window.print();
    try { await api('/api/plan/printed', { method: 'POST' }); } catch {}
  });
  let map = null;
  if (located.length) {
    ({ map } = await createMap($('#sheet-map'), { maps, interactive: false }));
    located.forEach((m, i) => window.L.marker([m.lat, m.lon], { icon: pinIcon('meeting') }).addTo(map).bindTooltip(String(i + 1), { permanent: true, direction: 'right' }));
    if (located.length === 1) map.setView([located[0].lat, located[0].lon], 15);
    else map.fitBounds(located.map((m) => [m.lat, m.lon]), { padding: [30, 30], maxZoom: 16 });
  }
  return () => map?.remove();
}
