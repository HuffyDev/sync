import { $, $$, api, upload, html, mount, toast, icon, markdown, fmtBytes, ago } from './shared.js';
import { topicLabel, togglePin, isPinned, refresh } from './app.js';

const TOPICS = ['water', 'power', 'food', 'first-aid', 'shelter', 'sanitation', 'communications', 'preparedness', 'local-info', 'repair', 'medical', 'other'];

let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return pdfjs;
}

async function extractPdfText(file, onPage) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      text += item.str;
      text += item.hasEOL ? '\n' : (item.str && !item.str.endsWith(' ') ? ' ' : '');
    }
    pages.push(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
    page.cleanup();
    onPage?.(i, doc.numPages);
  }
  await doc.destroy();
  return pages;
}

export async function libraryView(el) {
  const [guides, docs] = await Promise.all([api('/api/guides'), api('/api/library')]);
  const byTopic = {};
  for (const g of guides) (byTopic[g.topic] ||= []).push(g);
  mount(el, html`
    <div class="page-head">
      <div><h1>Survival library</h1><p>Guides that ship with LASTSYNC, packs you've installed, and your own files.</p></div>
      <div class="row"><a class="btn" href="#/note/new">${icon('note')}Write a note</a><label class="btn primary">${icon('upload')}Add files<input type="file" id="files" accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain" multiple hidden></label></div>
    </div>
    <div id="uploads"></div>
    <section class="card">
      <div class="card-title"><h2>Your documents</h2><span class="muted">${docs.length} saved</span></div>
      <p class="muted" style="margin-top:-6px">Add manuals, PDFs and local info — like the nearest shelters, water points, or your building's emergency plan. Scanned PDFs (photos of pages) can be viewed but not searched.</p>
      <label class="field" style="max-width:280px"><span>Topic for new files</span><select id="topic">${TOPICS.map((t) => html`<option value="${t}">${topicLabel(t)}</option>`)}</select></label>
      ${docs.length ? html`<ul class="list" style="margin-top:10px">${docs.map((d) => html`<li class="row between">
          <a class="item-link" href="#/doc/${d.id}/1"><strong>${d.title}</strong><br><small>${d.type.toUpperCase()} · ${fmtBytes(d.size)}${d.pageCount ? ` · ${d.pageCount} pages` : ''} · ${topicLabel(d.topic)} · ${d.pack}${d.type === 'pdf' && d.textChars === 0 ? ' · ⚠ no searchable text' : ''}</small></a>
          <button class="icon-btn" data-del="${d.id}" aria-label="Delete ${d.title}">${icon('trash')}</button></li>`)}</ul>`
        : html`<div class="empty" style="margin-top:12px">No documents yet. Add PDFs or text files while you still have them.</div>`}
    </section>
    ${Object.entries(byTopic).sort().map(([t, gs]) => html`<section class="card"><h2>${topicLabel(t)}</h2><ul class="list">
      ${gs.map((g) => html`<li><a class="item-link" href="#/guide/${g.id}"><strong>${g.title}</strong><br><small>${g.summary}</small><br><small class="faint">${g.publisher} · ${g.date} · v${g.version} · ${g.sections.length} sections${g.pack !== 'Starter library' ? ' · ' + g.pack : ''}</small></a></li>`)}
    </ul></section>`)}`);

  $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => {
    const d = docs.find((x) => x.id === b.dataset.del);
    if (!confirm(`Delete “${d.title}” from this PC?`)) return;
    await api('/api/library/' + d.id, { method: 'DELETE' });
    toast('Deleted');
    refresh('library');
  }));

  $('#files').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const topic = $('#topic').value;
    const box = $('#uploads');
    for (const file of files) {
      const row = document.createElement('div');
      row.className = 'card';
      box.append(row);
      const status = (msg, p) => mount(row, html`<div class="row between"><strong>${file.name}</strong><span class="muted">${msg}</span></div><div class="progress" style="margin-top:8px"><i style="width:${Math.round((p || 0) * 100)}%"></i></div>`);
      try {
        const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
        const title = file.name.replace(/\.(pdf|txt|md|markdown)$/i, '').replace(/[_-]+/g, ' ');
        const ext = (file.name.match(/\.(txt|md|markdown)$/i) || ['.txt'])[0];
        status('Saving…', 0);
        const doc = await upload(`/api/library/upload?type=${isPdf ? 'pdf' : 'text'}&ext=${encodeURIComponent(ext)}&title=${encodeURIComponent(title)}&topic=${encodeURIComponent(topic)}`, file, (p) => status('Saving…', p * 0.5));
        if (isPdf) {
          status('Reading text for search…', 0.5);
          const pages = await extractPdfText(file, (i, n) => status(`Reading page ${i} of ${n}…`, 0.5 + (i / n) * 0.5));
          await api(`/api/library/${doc.id}/text`, { method: 'PUT', body: { pages } });
          const chars = pages.join('').trim().length;
          if (chars < 50 * pages.length) {
            mount(row, html`<div class="notice warn"><strong>${file.name}</strong> was saved, but it looks scanned (pictures of pages), so search can't read most of it. You can still open it.</div>`);
            continue;
          }
        }
        mount(row, html`<div class="notice ok"><strong>${file.name}</strong> saved and searchable.</div>`);
      } catch (err) {
        mount(row, html`<div class="notice bad"><strong>${file.name}</strong>: ${err.message}</div>`);
      }
    }
    setTimeout(() => refresh('library'), 1200);
  });
}

export async function docView(el, [id, pageArg]) {
  const d = await api('/api/library/' + encodeURIComponent(id));
  const page = Math.max(1, Number(pageArg) || 1);
  const pinned = await isPinned('doc:' + d.id);
  const tab = sessionStorage.getItem('ls-doc-tab') || (d.type === 'pdf' ? 'original' : 'text');
  mount(el, html`
    <div class="page-head">
      <div><p class="muted" style="margin:0 0 4px"><a href="#/library">Library</a> › ${topicLabel(d.topic)}</p><h1>${d.title}</h1>
        <div class="meta-line"><span>${d.type.toUpperCase()}</span><span>${fmtBytes(d.size)}</span><span>${d.pack}</span><span>Added ${ago(d.addedAt)}</span></div></div>
      <div class="row"><button class="btn" id="pin">${icon('star')}${pinned ? 'Pinned' : 'Pin'}</button>
        ${d.type === 'pdf' ? html`<a class="btn" href="/files/library/${d.id}#page=${page}" target="_blank" rel="noopener">${icon('external')}Open PDF</a>` : ''}</div>
    </div>
    ${d.type === 'pdf' ? html`<div class="tabs"><button data-tab="original" class="${tab === 'original' ? 'on' : ''}">Original (page ${page})</button><button data-tab="text" class="${tab === 'text' ? 'on' : ''}">Searchable text</button></div>` : ''}
    <div id="doc-body"></div>`);
  const body = $('#doc-body');
  const show = (t) => {
    sessionStorage.setItem('ls-doc-tab', t);
    $$('[data-tab]', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'original' && d.type === 'pdf') {
      mount(body, html`<iframe class="pdf-frame" src="/files/library/${d.id}#page=${page}" title="${d.title}"></iframe>`);
    } else {
      mount(body, html`<article class="prose">${d.pages.length ? d.pages.map((p, i) => html`<section id="p-${i + 1}"><h2>${d.type === 'pdf' ? 'Page' : 'Part'} ${i + 1}</h2>${d.type === 'pdf' ? html`<p style="white-space:pre-wrap">${p || '(no text on this page)'}</p>` : markdown(p)}</section>`) : html`<div class="empty">No searchable text was found in this file.</div>`}</article>`);
      const target = document.getElementById('p-' + page);
      if (target && page > 1) requestAnimationFrame(() => { target.scrollIntoView(); target.classList.add('section-flash'); });
    }
  };
  $$('[data-tab]', el).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  show(d.type === 'pdf' ? tab : 'text');
  $('#pin').addEventListener('click', async (e) => {
    const on = await togglePin({ kind: d.type, id: 'doc:' + d.id, title: d.title, href: '#/doc/' + d.id + '/1' });
    mount(e.currentTarget, html`${icon('star')}${on ? 'Pinned' : 'Pin'}`);
  });
}

export async function notesView(el) {
  const notes = (await api('/api/notes')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  mount(el, html`
    <div class="page-head"><div><h1>Notes</h1><p>Your own notes are searchable alongside the guides.</p></div><a class="btn primary" href="#/note/new">${icon('plus')}New note</a></div>
    ${notes.length ? html`<div class="grid grid-3">${notes.map((n) => html`<a class="card item-link" href="#/note/${n.id}"><strong>${n.title || 'Untitled note'}</strong><p class="muted" style="margin:6px 0 0;font-size:0.9rem">${(n.body || '').slice(0, 140)}${(n.body || '').length > 140 ? '…' : ''}</p><small class="faint">${n.pack ? n.pack + ' · ' : ''}${ago(n.updatedAt)}</small></a>`)}</div>`
      : html`<div class="empty">No notes yet. Write down things like where the water shut-off valve is, medication lists, or which neighbor has a generator.</div>`}`);
}

export async function noteView(el, [id]) {
  const isNew = id === 'new';
  const n = isNew ? { title: '', body: '', topic: '' } : (await api('/api/notes')).find((x) => x.id === id);
  if (!n) { mount(el, html`<div class="empty">Note not found. <a href="#/notes">All notes</a></div>`); return; }
  const pinned = isNew ? false : await isPinned('note:' + n.id);
  mount(el, html`
    <div class="page-head"><div><p class="muted" style="margin:0 0 4px"><a href="#/notes">Notes</a></p><h1>${isNew ? 'New note' : n.title || 'Untitled note'}</h1></div>
      <div class="row">${isNew ? '' : html`<button class="btn" id="pin">${icon('star')}${pinned ? 'Pinned' : 'Pin'}</button><button class="btn danger" id="del">${icon('trash')}Delete</button>`}</div></div>
    <form id="nf" class="card stack">
      <label class="field"><span>Title</span><input name="title" value="${n.title}" maxlength="120" required placeholder="e.g. Water shut-off and fuse box"></label>
      <label class="field"><span>Topic</span><select name="topic"><option value="">—</option>${TOPICS.map((t) => html`<option value="${t}" ${n.topic === t ? 'selected' : ''}>${topicLabel(t)}</option>`)}</select></label>
      <label class="field"><span>Note</span><textarea name="body" rows="14" placeholder="Write anything. Lines starting with “- ” become bullet points.">${n.body}</textarea></label>
      <div class="row end"><span class="muted" id="saved"></span><button class="btn primary">Save note</button></div>
    </form>`);
  const f = $('#nf');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { title: f.title.value, body: f.body.value, topic: f.topic.value };
    try {
      const saved = isNew ? await api('/api/notes', { method: 'POST', body }) : await api('/api/notes/' + n.id, { method: 'PUT', body });
      toast('Note saved');
      if (isNew) location.hash = '#/note/' + saved.id;
      else $('#saved').textContent = 'Saved ' + new Date().toLocaleTimeString();
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('#del')?.addEventListener('click', async () => {
    if (!confirm('Delete this note?')) return;
    await api('/api/notes/' + n.id, { method: 'DELETE' });
    location.hash = '#/notes';
  });
  $('#pin')?.addEventListener('click', async (e) => {
    const on = await togglePin({ kind: 'note', id: 'note:' + n.id, title: n.title || 'Note', href: '#/note/' + n.id });
    mount(e.currentTarget, html`${icon('star')}${on ? 'Pinned' : 'Pin'}`);
  });
}
