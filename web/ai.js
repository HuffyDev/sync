// On-device AI: small language models that run inside the browser on the
// computer's own graphics chip (WebGPU), via the vendored WebLLM engine.
// The model downloads once (while online) into the browser's storage and then
// works with no internet. It only ever sees passages LASTSYNC retrieved from
// the saved library, and must cite them.

export const TIERS = [
  { id: 'pocket', name: 'Pocket', model: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', size: '≈ 0.5 GB', vram: '1 GB', device: 'Phones & older laptops', blurb: 'Fastest. Short, simple answers.' },
  { id: 'field', name: 'Field', model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', size: '≈ 0.9 GB', vram: '1.5 GB', device: 'Most laptops', blurb: 'Balanced speed and quality.' },
  { id: 'command', name: 'Command', model: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', size: '≈ 1.2 GB', vram: '2 GB', device: 'PCs with a GPU', blurb: 'Best answers. Needs a real graphics card.' },
];

let lib = null;
let engine = null;
let loadedId = null;
let loading = null;

async function webllm() {
  if (!lib) lib = await import('/vendor/web-llm/index.js');
  return lib;
}

export function support() {
  if (!window.isSecureContext) return { ok: false, why: 'Needs a secure page (localhost or https).' };
  if (!navigator.gpu) return { ok: false, why: 'This browser has no WebGPU. Use a recent Chrome or Edge on a computer.' };
  return { ok: true };
}

export async function gpuInfo() {
  try {
    const a = await navigator.gpu?.requestAdapter();
    if (!a) return null;
    const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
    return { vendor: info.vendor || '', arch: info.architecture || '', desc: info.description || '', fallback: !!a.isFallbackAdapter };
  } catch { return null; }
}

export async function isCached(tier) {
  try { return await (await webllm()).hasModelInCache(tier.model); } catch { return false; }
}

export async function cachedTiers() {
  const out = [];
  for (const t of TIERS) if (await isCached(t)) out.push(t.id);
  return out;
}

export function loaded() { return loadedId ? TIERS.find((t) => t.id === loadedId) : null; }

export function preferred() {
  try { return TIERS.find((t) => t.id === localStorage.getItem('ls-ai-tier')) || null; } catch { return null; }
}
export function setPreferred(id) { try { id ? localStorage.setItem('ls-ai-tier', id) : localStorage.removeItem('ls-ai-tier'); } catch {} }

// Downloads the model if needed, then loads it onto the GPU.
export async function load(tier, onProgress) {
  if (loadedId === tier.id && engine) return engine;
  if (loading) await loading.catch(() => {});
  const { CreateMLCEngine } = await webllm();
  const progress = (r) => onProgress?.(r.progress ?? 0, r.text || '');
  loading = (async () => {
    if (engine) { await engine.reload(tier.model); engine.setInitProgressCallback?.(progress); }
    else engine = await CreateMLCEngine(tier.model, { initProgressCallback: progress });
    loadedId = tier.id;
    return engine;
  })();
  try { return await loading; } finally { loading = null; }
}

export async function remove(tier) {
  const { deleteModelAllInfoInCache } = await webllm();
  if (loadedId === tier.id) { try { await engine?.unload(); } catch {} engine = null; loadedId = null; }
  await deleteModelAllInfoInCache(tier.model);
}

const SYSTEM = 'You are LASTSYNC, an offline emergency assistant used during blackouts. Answer ONLY from the numbered sources. ' +
  'Cite every claim with its source number in square brackets, like [1] or [2]. Be brief, calm and practical: short steps first. ' +
  'If the sources do not answer the question, reply exactly: "My saved sources don\'t cover this." Never invent doses or numbers.';

export async function answer(question, sources, onToken) {
  if (!engine) throw new Error('No on-device model is loaded.');
  const ctx = sources.map((s) => `[${s.n}] ${s.title}${s.subtitle ? ' — ' + s.subtitle : ''}\n${s.text}`).join('\n\n');
  const stream = await engine.chat.completions.create({
    stream: true, temperature: 0.1, max_tokens: 700,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Sources:\n\n${ctx}\n\nQuestion: ${question}` }],
  });
  let text = '';
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta?.content || '';
    if (d) { text += d; onToken?.(text); }
  }
  return text.trim();
}
