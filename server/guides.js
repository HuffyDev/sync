// Loads bundled and pack-installed guides (markdown with a small front-matter
// block) and splits them into sections that search and Ask can point at.
import fs from 'node:fs';
import path from 'node:path';

export function parseGuide(source, fallbackId) {
  const text = source.replace(/\r\n/g, '\n');
  const meta = {};
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
    }
    body = text.slice(fm[0].length);
  }
  const id = slug(meta.id || fallbackId);
  const guide = {
    id,
    title: meta.title || id,
    topic: meta.topic || 'general',
    publisher: meta.publisher || 'Unknown publisher',
    date: meta.date || '',
    version: meta.version || '',
    sources: meta.sources || '',
    summary: meta.summary || '',
    intro: '',
    sections: [],
  };
  const parts = body.split(/^## +/m);
  guide.intro = parts.shift().trim();
  const seen = new Set();
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const content = nl === -1 ? '' : part.slice(nl + 1).trim();
    let sid = slug(heading) || 'section';
    while (seen.has(sid)) sid += '-2';
    seen.add(sid);
    guide.sections.push({ id: sid, heading, markdown: content, text: plainText(content) });
  }
  return guide;
}

export function plainText(md) {
  return md
    .replace(/^#{1,6} +/gm, '')
    .replace(/^> ?/gm, '')
    .replace(/^\s*(?:[-*]|\d+\.) +/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

// Bundled guides ship with the app; pack guides live in the data folder.
export function loadGuides(dirs) {
  const guides = new Map();
  for (const { dir, pack } of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of files) {
      try {
        const g = parseGuide(fs.readFileSync(path.join(dir, f), 'utf8'), f.replace(/\.md$/, ''));
        g.pack = pack;
        g.file = path.join(dir, f);
        guides.set(g.id, g);
      } catch (err) {
        console.warn('Could not read guide', f, err.message);
      }
    }
  }
  return guides;
}
