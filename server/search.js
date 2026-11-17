// Local search engine: BM25 ranking over guide sections, document pages,
// notes, map pins and plan items, with light stemming and survival-specific
// synonyms so "cleaning water" also finds "disinfecting water".

const STOP = new Set(`a an and are as at be but by can do does for from how i if in into is it its me my
no not of on or our so than that the their them then there these they this to too up us was we what when
where which who why will with you your should would could get got have has had
make need want know tell about please`.split(/\s+/));

const SYNONYM_GROUPS = [
  ['clean', 'purify', 'purification', 'disinfect', 'disinfection', 'treat', 'sterilize', 'safe', 'boil'],
  ['bleach', 'chlorine', 'hypochlorite'],
  ['drink', 'drinking', 'potable', 'water'],
  ['bleed', 'bleeding', 'blood', 'wound', 'cut', 'tourniquet'],
  ['cpr', 'resuscitation', 'compression', 'unresponsive', 'breathing'],
  ['choke', 'choking', 'heimlich'],
  ['generator', 'carbon', 'monoxide', 'co'],
  ['toilet', 'sanitation', 'waste', 'sewage', 'poop', 'bathroom'],
  ['radio', 'communication', 'walkie', 'ham', 'frs', 'gmrs', 'signal'],
  ['cold', 'warm', 'warmth', 'freeze', 'freezing', 'hypothermia', 'frostbite', 'heat', 'heating'],
  ['hot', 'heatstroke', 'heatwave', 'cool', 'cooling'],
  ['food', 'fridge', 'refrigerator', 'freezer', 'spoil', 'spoiled'],
  ['phone', 'battery', 'charge', 'charging', 'power'],
  ['outage', 'blackout', 'power'],
  ['kit', 'bag', 'supplies', 'checklist', 'pack'],
  ['medicine', 'medication', 'insulin', 'drug', 'prescription'],
  ['burn', 'burns', 'scald'],
  ['shelter', 'evacuate', 'evacuation', 'leave'],
];

export function stem(word) {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ied') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (/(ches|shes|xes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 5) return undouble(w.slice(0, -3));
  if (w.endsWith('ed') && w.length > 4) return undouble(w.slice(0, -2));
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

function undouble(w) {
  return /([bdfgmnprt])\1$/.test(w) ? w.slice(0, -1) : w;
}

const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

export function tokenize(text) {
  const out = [];
  for (const m of String(text).matchAll(TOKEN_RE)) {
    const raw = m[0].toLowerCase().replace(/['’]s$/, '');
    if (STOP.has(raw)) continue;
    out.push({ term: stem(raw), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) {
  const stems = group.map(stem);
  for (const s of stems) {
    const set = SYNONYMS.get(s) || new Set();
    for (const o of stems) if (o !== s) set.add(o);
    SYNONYMS.set(s, set);
  }
}

export function expandQuery(query) {
  const terms = new Map();
  for (const t of tokenize(query)) terms.set(t.term, 1);
  for (const t of [...terms.keys()]) {
    for (const syn of SYNONYMS.get(t) || []) if (!terms.has(syn)) terms.set(syn, 0.35);
  }
  return terms;
}

export class SearchIndex {
  constructor(units = []) {
    this.build(units);
  }

  build(units) {
    this.units = units;
    this.df = new Map();
    this.docs = units.map((u) => {
      const tf = new Map();
      const body = tokenize(u.text);
      const title = tokenize(`${u.title} ${u.subtitle || ''}`);
      for (const t of body) tf.set(t.term, (tf.get(t.term) || 0) + 1);
      for (const t of title) tf.set(t.term, (tf.get(t.term) || 0) + 3);
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) || 0) + 1);
      return { tf, len: body.length + title.length * 3 };
    });
    const total = this.docs.reduce((s, d) => s + d.len, 0);
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
  }

  idf(term) {
    const n = this.docs.length;
    const df = this.df.get(term) || 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(query, { filter, limit = 20 } = {}) {
    const terms = expandQuery(query);
    if (!terms.size) return { results: [], facets: emptyFacets(), terms: [] };
    const k1 = 1.2;
    const b = 0.75;
    const scored = [];
    this.units.forEach((u, i) => {
      if (filter && !filter(u)) return;
      const d = this.docs[i];
      let score = 0;
      let matchedPrimary = 0;
      for (const [term, weight] of terms) {
        const f = d.tf.get(term);
        if (!f) continue;
        if (weight === 1) matchedPrimary++;
        score += weight * this.idf(term) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
      }
      if (score > 0) scored.push({ unit: u, score, matchedPrimary });
    });
    const primaryCount = [...terms.values()].filter((w) => w === 1).length;
    // Results that contain every word the person typed go first.
    scored.sort((a, b2) => (b2.matchedPrimary === primaryCount) - (a.matchedPrimary === primaryCount) || b2.score - a.score);
    const facets = emptyFacets();
    for (const s of scored) {
      bump(facets.topic, s.unit.topic);
      bump(facets.pack, s.unit.pack);
      bump(facets.type, s.unit.fileType);
    }
    const results = scored.slice(0, limit).map((s) => ({
      ...publicUnit(s.unit),
      score: Number(s.score.toFixed(3)),
      coverage: primaryCount ? s.matchedPrimary / primaryCount : 0,
      ...excerpt(s.unit.text, terms),
    }));
    return { results, facets, terms: [...terms.keys()] };
  }
}

function emptyFacets() {
  return { topic: {}, pack: {}, type: {} };
}

function bump(obj, key) {
  if (!key) return;
  obj[key] = (obj[key] || 0) + 1;
}

function publicUnit(u) {
  const { text, md, ...rest } = u;
  return rest;
}

// Picks the stretch of text with the most distinct matching words and
// returns it with character ranges to highlight.
export function excerpt(text, terms, width = 42) {
  const toks = tokenize(text);
  if (!toks.length) return { excerpt: text.slice(0, 240), highlights: [] };
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < toks.length; i++) {
    if (!terms.has(toks[i].term)) continue;
    const seen = new Set();
    let s = 0;
    for (let j = i; j < Math.min(toks.length, i + width); j++) {
      const w = terms.get(toks[j].term);
      if (w && !seen.has(toks[j].term)) { seen.add(toks[j].term); s += w; }
    }
    if (s > bestScore) { bestScore = s; best = i; }
  }
  const startTok = Math.max(0, best - 6);
  const endTok = Math.min(toks.length - 1, startTok + width);
  let start = startTok === 0 ? 0 : toks[startTok].start;
  let end = endTok === toks.length - 1 ? text.length : toks[endTok].end;
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const slice = text.slice(start, end).replace(/\n/g, ' ');
  const highlights = [];
  for (const t of toks) {
    if (t.start >= start && t.end <= end && terms.get(t.term) === 1) {
      highlights.push([t.start - start + prefix.length, t.end - start + prefix.length]);
    }
  }
  return { excerpt: prefix + slice + suffix, highlights };
}
