// When the LASTSYNC server can't be reached (e.g. the online version with no
// internet), search the guides and encyclopedia articles this browser saved.
import { api } from './shared.js';

let corpus = null;
async function load() {
  if (corpus) return corpus;
  const units = [];
  const guides = await api('/api/guides').catch(() => api('/api/public/guides').catch(() => []));
  for (const g of guides) {
    const full = await api('/api/guides/' + g.id).catch(() => null);
    if (!full) continue;
    for (const s of full.sections) units.push({ kind: 'guide', fileType: 'guide', title: full.title, subtitle: s.heading, text: s.markdown, ref: { guide: full.id, section: s.id } });
  }
  const wiki = await api('/api/wiki').catch(() => null);
  for (const c of wiki?.catalog || []) for (const t of c.titles.filter((x) => x.saved)) {
    const a = await api('/api/wiki/article/' + t.id).catch(() => null);
    a?.sections.forEach((s, i) => units.push({ kind: 'wiki', fileType: 'wiki', title: a.title, subtitle: s.heading, text: s.text, ref: { wiki: a.id, section: i } }));
  }
  corpus = units;
  return units;
}

export async function offlineSearch(q, limit = 20) {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  if (!words.length) return [];
  const units = await load();
  return units.map((u) => {
    const hay = (u.title + ' ' + u.subtitle + ' ' + u.text).toLowerCase();
    let score = 0;
    let matched = 0;
    for (const w of words) {
      const stem = w.replace(/(ing|ed|s)$/, '');
      const n = hay.split(stem).length - 1;
      if (!n) continue;
      matched++;
      score += 1 + Math.min(n, 6) * 0.4 + (u.subtitle.toLowerCase().includes(stem) ? 3 : 0) + (u.kind === 'guide' ? 0.5 : 0);
    }
    score *= matched / words.length; // favour sections that contain every word
    return { u, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ u, score }) => {
    const plain = u.text.replace(/[#*>]/g, '').replace(/\s+/g, ' ');
    const at = Math.max(0, plain.toLowerCase().indexOf(words[0].replace(/(ing|ed|s)$/, '')) - 60);
    return { ...u, score, excerpt: (at ? '…' : '') + plain.slice(at, at + 240) + '…', highlights: [], coverage: Math.min(1, score / words.length), md: u.text };
  });
}
