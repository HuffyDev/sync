// Offline encyclopedia: a curated set of survival-relevant Wikipedia articles,
// downloaded while you still have internet and kept on disk for reading,
// search and Ask. Text is CC BY-SA 4.0; each article keeps its source link,
// revision date and the lead image's credit.
import fs from 'node:fs';
import path from 'node:path';
import { slug } from './guides.js';

const API = process.env.LASTSYNC_WIKI_API || 'https://en.wikipedia.org/w/api.php';
const UA = 'LASTSYNC/1.0 (offline survival app; https://github.com/HuffyDev/sync)';

export const WIKI_CATALOG = [
  { topic: 'first-aid', label: 'Medicine & first aid', titles: ['First aid', 'Cardiopulmonary resuscitation', 'Bleeding', 'Tourniquet', 'Burn', 'Hypothermia', 'Frostbite', 'Heat stroke', 'Dehydration', 'Oral rehydration therapy', 'Shock (circulatory)', 'Bone fracture', 'Sprain', 'Choking', 'Carbon monoxide poisoning', 'Anaphylaxis', 'Wound', 'Diarrhea'] },
  { topic: 'water', label: 'Water', titles: ['Water purification', 'Portable water purification', 'Water chlorination', 'Solar water disinfection', 'Boiling', 'Rainwater harvesting'] },
  { topic: 'food', label: 'Food', titles: ['Food preservation', 'Food storage', 'Canning', 'Food drying', 'Foodborne illness', 'Botulism'] },
  { topic: 'sanitation', label: 'Sanitation & disease', titles: ['Sanitation', 'Hand washing', 'Latrine', 'Cholera', 'Pandemic'] },
  { topic: 'shelter', label: 'Shelter & fire', titles: ['Wilderness survival', 'Bushcraft', 'Fire triangle', 'Fire extinguisher', 'Smoke inhalation', 'Space blanket'] },
  { topic: 'power', label: 'Power', titles: ['Power outage', 'Engine-generator', 'Solar panel', 'Lithium-ion battery', 'Lead–acid battery', 'Uninterruptible power supply'] },
  { topic: 'navigation', label: 'Navigation & comms', titles: ['Compass', 'Celestial navigation', 'Orienteering', 'Amateur radio', 'Citizens band radio', 'Family Radio Service', 'NOAA Weather Radio', 'Morse code', 'SOS'] },
  { topic: 'hazards', label: 'Disasters', titles: ['Flood', 'Tornado', 'Earthquake', 'Tropical cyclone', 'Wildfire', 'Heat wave', 'Blizzard', 'Tsunami'] },
];
export const WIKI_TITLES = WIKI_CATALOG.flatMap((c) => c.titles.map((t) => ({ title: t, topic: c.topic })));
const SKIP_SECTIONS = /^(see also|references|external links|further reading|notes|bibliography|sources|citations|gallery|footnotes|explanatory notes)$/i;

export class Wiki {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'articles'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
    this.job = { running: false, done: 0, total: 0, current: null, errors: [] };
    this.version = 0; // bumps whenever saved articles change
  }

  indexFile() { return path.join(this.dir, 'index.json'); }
  index() {
    try { return JSON.parse(fs.readFileSync(this.indexFile(), 'utf8')); } catch { return {}; }
  }
  saveIndex(idx) {
    const tmp = this.indexFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx));
    fs.renameSync(tmp, this.indexFile());
  }

  article(id) {
    if (!/^[\w-]{1,100}$/.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'articles', id + '.json'), 'utf8')); } catch { return null; }
  }

  imagePath(file) {
    if (!/^[\w-]{1,100}\.(jpg|jpeg|png|webp|gif)$/i.test(file)) return null;
    const p = path.join(this.dir, 'img', file);
    return fs.existsSync(p) ? p : null;
  }

  status() {
    const idx = this.index();
    let bytes = 0;
    for (const a of Object.values(idx)) bytes += a.bytes || 0;
    return {
      catalog: WIKI_CATALOG.map((c) => ({ topic: c.topic, label: c.label, titles: c.titles.map((t) => ({ title: t, id: slug(t), saved: !!idx[slug(t)], savedAt: idx[slug(t)]?.savedAt || null, image: idx[slug(t)]?.image || null, summary: idx[slug(t)]?.summary || '' })) })),
      saved: Object.keys(idx).length,
      total: WIKI_TITLES.length,
      bytes,
      job: this.job,
    };
  }

  remove(id) {
    const idx = this.index();
    const a = idx[id];
    if (!a) return;
    fs.rmSync(path.join(this.dir, 'articles', id + '.json'), { force: true });
    if (a.image) fs.rmSync(path.join(this.dir, 'img', a.image), { force: true });
    delete idx[id];
    this.saveIndex(idx);
    this.version++;
  }

  // Download every catalog article (or just `titles`) that isn't saved yet.
  start(titles, { refresh = false } = {}) {
    if (this.job.running) return this.job;
    const idx = this.index();
    const wanted = (titles?.length ? WIKI_TITLES.filter((t) => titles.includes(t.title)) : WIKI_TITLES)
      .filter((t) => refresh || !idx[slug(t.title)]);
    this.job = { running: true, done: 0, total: wanted.length, current: null, errors: [], startedAt: new Date().toISOString() };
    (async () => {
      for (const t of wanted) {
        this.job.current = t.title;
        try { await this.fetchOne(t.title, t.topic); }
        catch (err) { this.job.errors.push(`${t.title}: ${err.message}`); }
        this.job.done++;
        await new Promise((r) => setTimeout(r, 250)); // be gentle with Wikipedia
      }
      this.job.running = false;
      this.job.current = null;
      this.version++;
    })();
    return this.job;
  }

  async get(params) {
    const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    const res = await fetch(url, { headers: { 'user-agent': UA, 'api-user-agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Wikipedia returned ${res.status}`);
    return res.json();
  }

  async fetchOne(title, topic) {
    const data = await this.get({
      action: 'query', prop: 'extracts|pageimages|info|revisions', explaintext: '1', exsectionformat: 'wiki',
      titles: title, redirects: '1', piprop: 'thumbnail|name', pithumbsize: '800', inprop: 'url', rvprop: 'timestamp|ids',
    });
    const page = data?.query?.pages?.[0];
    if (!page || page.missing || !page.extract) throw new Error('not found');
    const sections = parseExtract(page.extract);
    if (!sections.length) throw new Error('empty article');
    const id = slug(title);
    let image = null;
    let imageCredit = null;
    if (page.thumbnail?.source && /^https:\/\/upload\.wikimedia\.org\//.test(page.thumbnail.source)) {
      try {
        const ext = (page.thumbnail.source.match(/\.(jpe?g|png|webp|gif)(?:$|\?)/i)?.[1] || 'jpg').toLowerCase();
        const res = await fetch(page.thumbnail.source, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.ok && buf.length < 3 * 1024 * 1024) {
          image = `${id}.${ext}`;
          fs.writeFileSync(path.join(this.dir, 'img', image), buf);
          if (page.pageimage) imageCredit = await this.credit(page.pageimage);
        }
      } catch { image = null; }
    }
    const rev = page.revisions?.[0];
    const art = {
      id, title: page.title, topic, url: page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
      revid: rev?.revid || page.lastrevid, revisedAt: rev?.timestamp || page.touched, savedAt: new Date().toISOString(),
      image, imageCredit, sections, license: 'CC BY-SA 4.0',
    };
    const json = JSON.stringify(art);
    fs.writeFileSync(path.join(this.dir, 'articles', id + '.json'), json);
    const idx = this.index();
    idx[id] = { id, title: art.title, topic, savedAt: art.savedAt, image, bytes: json.length + (image ? fs.statSync(path.join(this.dir, 'img', image)).size : 0), summary: sections[0].text.slice(0, 220) };
    this.saveIndex(idx);
    this.version++;
  }

  async credit(fileName) {
    try {
      const d = await this.get({ action: 'query', prop: 'imageinfo', iiprop: 'extmetadata', titles: 'File:' + fileName });
      const meta = d?.query?.pages?.[0]?.imageinfo?.[0]?.extmetadata || {};
      const strip = (s) => String(s?.value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return { artist: strip(meta.Artist) || 'Unknown author', license: strip(meta.LicenseShortName) || 'see Wikimedia Commons', file: fileName };
    } catch { return { artist: 'Unknown author', license: 'see Wikimedia Commons', file: fileName }; }
  }
}

// "== Heading ==" plain-text extract -> [{ heading, text }]
export function parseExtract(extract) {
  const out = [];
  let cur = { heading: 'Overview', text: [] };
  let skipping = false;
  for (const line of String(extract).split('\n')) {
    const h2 = /^==\s*([^=].*?)\s*==$/.exec(line.trim());
    const h3 = /^={3,}\s*(.*?)\s*={3,}$/.exec(line.trim());
    if (h2) {
      if (cur.text.join('').trim()) out.push({ heading: cur.heading, text: cur.text.join('\n').trim() });
      skipping = SKIP_SECTIONS.test(h2[1]);
      cur = { heading: h2[1], text: [] };
      continue;
    }
    if (skipping) continue;
    if (h3) { if (h3[1]) cur.text.push('', '### ' + h3[1], ''); continue; }
    cur.text.push(line);
  }
  if (!skipping && cur.text.join('').trim()) out.push({ heading: cur.heading, text: cur.text.join('\n').trim() });
  return out.map((s) => ({ heading: s.heading, text: s.text.replace(/\n{3,}/g, '\n\n').slice(0, 40000) })).filter((s) => s.text.replace(/###.*$/gm, '').trim().length > 40);
}
