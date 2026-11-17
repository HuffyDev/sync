// Ask LASTSYNC: answers questions from the saved library and links every
// claim to the passage it came from. The built-in answerer works with no
// model at all. If a model is configured (a local one through Ollama,
// LM Studio or llama.cpp, or OpenAI while online) it writes the answer from
// the same passages, and LASTSYNC falls back to the built-in answerer if the
// model can't be reached.
import { tokenize, expandQuery } from './search.js';

const URGENT = /\b(not breathing|stopped breathing|unconscious|unresponsive|no pulse|severe bleeding|bleeding (?:heavily|a lot|won'?t stop)|chest pain|heart attack|stroke|seizure|overdose|poison|choking|anaphyla|carbon monoxide|suicid)/i;

export const URGENT_NOTE =
  'If someone may be in danger, call your emergency number (911 / 112 / 999) if any phone works. Texting 911 works in many US areas when calls fail.';

export function retrieve(index, question, { filter, limit = 6 } = {}) {
  const { results } = index.search(question, { filter, limit: limit * 3 });
  const byId = new Map(index.units.map((u) => [u.id, u]));
  const primary = [...expandQuery(question)].filter(([, w]) => w === 1).map(([t]) => t);
  // A section whose heading names what was asked is almost always the right
  // one ("bleach" -> "Disinfecting with household bleach").
  const reranked = results.map((r) => {
    const heading = new Set(tokenize(`${r.subtitle || ''}`).map((t) => t.term));
    const hits = primary.filter((t) => heading.has(t)).length;
    // Vetted field guides outrank encyclopedia text for practical answers.
    return { ...r, rank: r.score + hits * 2.5 + r.coverage * 2 + (r.kind === 'guide' ? 1.5 : 0) };
  }).sort((a, b) => b.rank - a.rank);
  const strong = reranked.filter((r) => r.coverage >= 0.5 || r.score >= 2.5);
  return strong.slice(0, limit).map((r) => {
    const u = byId.get(r.id) || {};
    return { ...r, text: u.text || '', md: u.md || null };
  });
}

// Without a model, LASTSYNC never stitches sentences from different places
// together: mixing a dose meant for one thing into instructions for another
// is exactly the mistake that hurts people. It quotes the best-matching
// section as written and lists the other matches as related reading.
export function builtinAnswer(question, passages) {
  const primary = [...expandQuery(question)].filter(([, w]) => w === 1);
  if (!passages.length || !primary.length) {
    return {
      covered: false,
      answer: "Your saved library doesn't cover this question. Try different words, or add a guide or PDF on this topic while you still can.",
      used: [],
    };
  }
  const top = passages[0];
  if (top.coverage < 0.5) {
    const near = passages.slice(0, 3);
    return {
      covered: false,
      answer: ["Your saved library doesn't cover this question.", '', '**Closest matches, in case they help:**',
        ...near.map((p, i) => `- ${p.title} — ${p.subtitle} [${i + 1}]`)].join('\n'),
      used: near.map((_, i) => i),
      format: 'markdown',
    };
  }
  const body = trimBlocks(top.md || top.text, 1600);
  const lines = [`**From ${top.title} — ${top.subtitle}** [1]`, '', body];
  const related = passages.slice(1).filter((p) => p.coverage >= 0.5).slice(0, 4);
  if (related.length) {
    lines.push('', '**Also see:**');
    for (const p of related) lines.push(`- ${p.title} — ${p.subtitle} [${passages.indexOf(p) + 1}]`);
  }
  return { covered: top.coverage >= 0.5, answer: lines.join('\n'), used: [0, ...related.map((p) => passages.indexOf(p))], format: 'markdown' };
}

function trimBlocks(text, max) {
  const blocks = String(text).split(/\n{2,}/);
  let out = '';
  for (const b of blocks) {
    if (out && out.length + b.length > max) { out += '\n\n*…open the source to read the rest.*'; break; }
    out += (out ? '\n\n' : '') + b;
  }
  return out;
}

export async function modelAnswer(settings, question, passages, { signal } = {}) {
  const base = String(settings.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('No model address set');
  const sources = passages
    .map((p, i) => `[${i + 1}] ${p.title}${p.subtitle ? ' — ' + p.subtitle : ''}\n${p.text.slice(0, 2400)}`)
    .join('\n\n');
  const system =
    'You are LASTSYNC, an offline emergency assistant used during blackouts. Answer ONLY from the numbered sources. ' +
    'Cite every claim with its source number in square brackets, like [1] or [2][3]. Be brief, calm and practical: ' +
    'short steps first. If the sources do not answer the question, reply exactly: "My saved sources don\'t cover this." ' +
    'and nothing else. Never invent doses, numbers or medical instructions that are not in the sources.';
  const headers = { 'content-type': 'application/json' };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: settings.model || 'llama3.2',
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Sources:\n\n${sources}\n\nQuestion: ${question}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Model returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Model returned an empty answer');
  const covered = !/saved sources don.t cover this/i.test(text);
  const used = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1))].filter(
    (i) => i >= 0 && i < passages.length,
  );
  return { covered, answer: text, used };
}

export async function ask(index, settings, question, { filter } = {}) {
  const q = String(question || '').trim().slice(0, 500);
  const passages = retrieve(index, q, { filter });
  const urgent = URGENT.test(q) ? URGENT_NOTE : null;
  let result;
  let engine = 'builtin';
  let note = null;
  const ai = settings?.ai || {};
  if (ai.provider === 'openai' && passages.length) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (Number(ai.timeoutSec) || 90) * 1000);
    try {
      result = await modelAnswer(ai, q, passages, { signal: ctrl.signal });
      engine = ai.model || 'model';
    } catch (err) {
      note = `The AI model couldn't be reached (${err.name === 'AbortError' ? 'timed out' : err.message}). Showing the built-in answer instead.`;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!result) result = builtinAnswer(q, passages);
  return {
    question: q,
    engine,
    note,
    urgent,
    covered: result.covered,
    answer: result.answer,
    format: result.format || 'markdown',
    sources: passages.map((p, i) => ({
      n: i + 1,
      used: result.used.includes(i),
      id: p.id,
      kind: p.kind,
      title: p.title,
      subtitle: p.subtitle,
      ref: p.ref,
      excerpt: p.excerpt,
      highlights: p.highlights,
    })),
  };
}
