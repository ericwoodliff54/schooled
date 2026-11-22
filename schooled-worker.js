// Schooled Worker: reads aquarium photos with Gemini.
// Paste this whole file into your Cloudflare Worker (schooled-worker) and click Deploy.
// Needs one secret: GEMINI_API_KEY.
// Optional plain variable: GEMINI_MODEL (to change models without editing code).

const ALLOWED_ORIGINS = ['https://ericwoodliff54.github.io'];
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-4-hydrogen';
const MAX_IMAGE_CHARS = 2800000; // about 2 MB of photo data
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

// Best-effort limit per visitor while the Worker stays warm.
// Real monthly limits come in a later stage (they need Cloudflare KV).
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 15;
const hits = new Map();

const INSTRUCTIONS =
  'You identify aquarium animals and plants from a photo for hobbyists, mostly beginners. ' +
  'Be honest about uncertainty. Never invent species that are not visible.';

const PROMPT =
  'Look at this aquarium photo. Check the whole picture, including the edges, the background, the substrate and hiding spots, ' +
  'because small or distant fish are easy to miss. List each distinct kind of fish, shrimp, snail, or plant you can see. ' +
  'For each: give the common name hobbyists use, the scientific name only if you are reasonably sure, ' +
  'the kind (fish, shrimp, snail, plant, or other), how many individuals are visible (count only what you can see), ' +
  'and a confidence from 0 to 1. ' +
  'Only use confidence 0.85 or higher when the features that tell the species apart are clearly visible. ' +
  'Many species look alike: for example neon and cardinal tetras, different corydoras (skunk, julii, panda and others), ' +
  'rasboras, rainbowfish, guppies versus endlers, and algae eaters. For look-alikes, or for fish that are small, blurry, ' +
  'far away or partly hidden, use confidence 0.5 to 0.8 and put the other likely species in "alternatives" ' +
  '(up to 3 common names, best guess first). Leave "alternatives" empty when you are sure. ' +
  'Do not name a species just because it is common. If you cannot tell, use a name like "Unidentified tetra" with low confidence. ' +
  'Set too_far to true if many fish are too small or far away to identify reliably. ' +
  'If the photo is not an aquarium, set is_aquarium to false and return no species. ' +
  'If photo quality limited your answer (glare, too far, dark), put one short tip in photo_tips, otherwise leave it empty.';

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_aquarium: { type: 'BOOLEAN' },
    species: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          common_name: { type: 'STRING' },
          scientific_name: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['fish', 'shrimp', 'snail', 'plant', 'other'] },
          count: { type: 'INTEGER' },
          confidence: { type: 'NUMBER' },
          alternatives: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['common_name', 'kind', 'count', 'confidence']
      }
    },
    too_far: { type: 'BOOLEAN' },
    photo_tips: { type: 'STRING' }
  },
  required: ['is_aquarium', 'species']
};

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (ALLOWED_ORIGINS.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // keep memory small
  return false;
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function sanitize(parsed) {
  const species = Array.isArray(parsed.species) ? parsed.species.slice(0, 30) : [];
  return {
    is_aquarium: parsed.is_aquarium !== false,
    species: species
      .map((s) => {
        const kind = ['fish', 'shrimp', 'snail', 'plant', 'other'].includes(s.kind) ? s.kind : 'other';
        const count = Math.min(999, Math.max(1, Math.round(Number(s.count) || 1)));
        const confidence = Math.min(1, Math.max(0, Number(s.confidence) || 0));
        return {
          common_name: clean(s.common_name, 60),
          scientific_name: clean(s.scientific_name, 80),
          kind,
          count,
          confidence,
          alternatives: (Array.isArray(s.alternatives) ? s.alternatives : [])
            .map((x) => clean(x, 60))
            .filter((x) => x && x.toLowerCase() !== clean(s.common_name, 60).toLowerCase())
            .slice(0, 3)
        };
      })
      .filter((s) => s.common_name),
    too_far: parsed.too_far === true,
    photo_tips: clean(parsed.photo_tips, 160)
  };
}

async function scan(request, env, origin) {
  if (!env.GEMINI_API_KEY) return json({ ok: false, error: 'server_not_configured' }, 500, origin);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) return json({ ok: false, error: 'rate_limited' }, 429, origin);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: 'bad_image' }, 400, origin);
  }

  const image = typeof body.image === 'string' ? body.image : '';
  const mime = ALLOWED_MIME.includes(body.mime) ? body.mime : '';
  if (!image || !mime || !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ ok: false, error: 'bad_image' }, 400, origin);
  if (image.length > MAX_IMAGE_CHARS) return json({ ok: false, error: 'too_large' }, 413, origin);

  const primary = env.GEMINI_MODEL || DEFAULT_MODEL;
  const models = primary === FALLBACK_MODEL ? [primary] : [primary, FALLBACK_MODEL];

  async function ask(model, withThinking) {
    const generationConfig = { responseMimeType: 'application/json', responseSchema: SCHEMA };
    if (withThinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    const payload = {
      systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: image } }] }],
      generationConfig
    };
    return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(22000)
    });
  }

  let upstream = null;
  let failure = null;
  let usedModel = '';
  for (const model of models) {
    try {
      upstream = await ask(model, true);
      if (upstream.status === 400) upstream = await ask(model, false); // model may not accept a thinking level
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      failure = { error: 'ai_busy', ai_status: 0, ai_detail: model + ': ' + (timedOut ? 'no answer after 22 seconds' : 'could not reach Google') };
      upstream = null;
      continue;
    }
    if (upstream.ok) { failure = null; usedModel = model; break; }
    let detail = '';
    try { detail = String(((await upstream.json()).error || {}).message || '').slice(0, 140); } catch (e) {}
    const busy = upstream.status === 429 || upstream.status === 503;
    failure = { error: busy ? 'ai_busy' : 'ai_error', ai_status: upstream.status, ai_detail: model + ': ' + detail };
    upstream = null;
  }
  if (!upstream) return json(Object.assign({ ok: false }, failure), 502, origin);

  let data = null;
  try {
    data = await upstream.json();
    const text = data.candidates[0].content.parts.map((p) => p.text || '').join('');
    const result = sanitize(JSON.parse(text));
    const u = data.usageMetadata || {};
    const usage = { input: Number(u.promptTokenCount) || 0, output: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) };
    return json(Object.assign({ ok: true, model: usedModel, usage }, result), 200, origin);
  } catch (err) {
    const why = data && ((data.promptFeedback && data.promptFeedback.blockReason) || (data.candidates && data.candidates[0] && data.candidates[0].finishReason)) || String(err && err.message || err);
    return json({ ok: false, error: 'ai_error', ai_status: 200, ai_detail: 'bad reply: ' + String(why).slice(0, 120) }, 502, origin);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Schooled API is running (version 8: ' + (env.GEMINI_MODEL || DEFAULT_MODEL) + ', backup ' + FALLBACK_MODEL + ')', { headers: corsHeaders(origin) });
    }

    if (request.method === 'POST' && url.pathname === '/scan') {
      // Blocks other websites from using this Worker. It is not real security
      // (anyone can fake a header), so usage limits come in a later stage.
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ ok: false, error: 'forbidden' }, 403, origin);
      return scan(request, env, origin);
    }

    return json({ ok: false, error: 'not_found' }, 404, origin);
  }
};
