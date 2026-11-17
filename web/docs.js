// Docs: one page at a time by hash, search, on-this-page list, copy address.
const pages = [...document.querySelectorAll('.dx-page')];
const links = [...document.querySelectorAll('#dx-nav a')];
const toc = document.getElementById('dx-toc');
const pager = document.getElementById('dx-pager');
const side = document.getElementById('dx-side');
const menu = document.getElementById('dx-menu');
const q = document.getElementById('dx-q');
const results = document.getElementById('dx-results');
const nav = document.getElementById('dx-nav');
document.body.classList.add('dx-js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pageOf = (id) => {
  const el = id && document.getElementById(id);
  if (!el) return null;
  return el.classList.contains('dx-page') ? el : el.closest('.dx-page');
};

function show(hash, scroll = true) {
  const id = decodeURIComponent((hash || '').replace(/^#/, ''));
  const page = pageOf(id) || pages[0];
  pages.forEach((p) => p.classList.toggle('on', p === page));
  links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + page.id));
  document.title = `${page.querySelector('h1').textContent} · LASTSYNC Docs`;

  const heads = [...page.querySelectorAll('h2[id]')];
  toc.innerHTML = heads.length ? `<p>On this page</p>${heads.map((h) => `<a href="#${h.id}">${esc(h.textContent)}</a>`).join('')}` : '';

  const i = pages.indexOf(page);
  const prev = pages[i - 1], next = pages[i + 1];
  pager.innerHTML = (prev ? `<a class="prev" href="#${prev.id}"><small>Previous</small>${esc(prev.querySelector('h1').textContent)}</a>` : '<span></span>')
    + (next ? `<a class="next" href="#${next.id}"><small>Next</small>${esc(next.querySelector('h1').textContent)}</a>` : '');

  side.classList.remove('open'); menu.setAttribute('aria-expanded', 'false');
  if (!scroll) return;
  const target = id && id !== page.id ? document.getElementById(id) : null;
  if (target) target.scrollIntoView({ block: 'start' });
  else window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => show(location.hash));
show(location.hash);

// Highlight the section being read in "On this page".
const spy = () => {
  const page = pages.find((p) => p.classList.contains('on'));
  if (!page) return;
  let cur = null;
  for (const h of page.querySelectorAll('h2[id]')) if (h.getBoundingClientRect().top < 120) cur = h.id;
  toc.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + cur));
};
window.addEventListener('scroll', spy, { passive: true });

// Search across every page.
const index = pages.map((p) => ({ id: p.id, title: p.querySelector('h1').textContent, group: p.dataset.group, text: [...p.querySelectorAll('p, li, th, td, summary, pre, h2, .dx-card, .dx-diagram div')].filter((el) => !el.parentElement.closest('li, td, .dx-card, .dx-diagram div')).map((el) => el.textContent).join(' ').replace(/\s+/g, ' ') }));
function search() {
  const term = q.value.trim().toLowerCase();
  if (!term) { results.hidden = true; nav.hidden = false; return; }
  const words = term.split(/\s+/);
  const hits = index.map((d) => {
    const t = d.text.toLowerCase();
    if (!words.every((w) => t.includes(w))) return null;
    const score = words.reduce((s, w) => s + (d.title.toLowerCase().includes(w) ? 10 : 0) + t.split(w).length - 1, 0);
    const at = t.indexOf(words[0]);
    const snip = d.text.slice(Math.max(0, at - 40), at + 90);
    return { ...d, score, snip };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  nav.hidden = true; results.hidden = false;
  const mark = (s) => esc(s).replace(new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'), '<mark>$1</mark>');
  results.innerHTML = hits.length
    ? hits.map((h) => `<a href="#${h.id}"><b>${esc(h.title)}</b><small>${esc(h.group)}</small><span>…${mark(h.snip)}…</span></a>`).join('')
    : `<p class="dx-none">No pages mention “${esc(q.value.trim())}”.</p>`;
}
q.addEventListener('input', search);
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const a = results.querySelector('a'); if (a) { location.hash = a.getAttribute('href'); q.blur(); } }
  if (e.key === 'Escape') { q.value = ''; search(); q.blur(); }
});
results.addEventListener('click', (e) => { if (e.target.closest('a')) { q.value = ''; search(); } });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
});

menu.addEventListener('click', () => {
  const open = side.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(open));
});

// Copy the contract address.
document.querySelectorAll('[data-copy-ca]').forEach((b) => b.addEventListener('click', async () => {
  const ca = b.closest('.ca-card').querySelector('[data-ca]').textContent.trim();
  try { await navigator.clipboard.writeText(ca); }
  catch {
    const r = document.createRange(); r.selectNodeContents(b.closest('.ca-card').querySelector('[data-ca]'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy');
  }
  b.textContent = 'Copied'; b.classList.add('done');
  setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1600);
}));
