// Schooled Worker: reads aquarium photos with Gemini.
// Paste this whole file into your Cloudflare Worker (schooled-worker) and click Deploy.
// Needs one secret: GEMINI_API_KEY.
// Optional plain variable: GEMINI_MODEL (to change models without editing code).

const ALLOWED_ORIGINS = ['https://ericwoodliff54.github.io'];
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-4-hydrogen';
const LAST_RESORT_MODEL = 'gemini-3.6-flash';
const TOTAL_BUDGET_MS = 52000; // stop trying more models after this long
const MAX_IMAGE_CHARS = 2800000; // about 2 MB per photo
const MAX_IMAGES = 7; // the whole tank plus up to 6 zoomed pieces
const MAX_TOTAL_CHARS = 14000000;
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
  'Always name a specific species, strain or color morph that hobbyists use as a trade name, never a broad group. ' +
  'For example "Electric Yellow Lab" or "Red Zebra", not "African cichlid"; "Electric Blue Ram", not "dwarf cichlid"; "Cardinal Tetra", not "tetra". ' +
  'Give your single best specific guess, with lower confidence if you are unsure, and put the next most likely specific names in "alternatives". ' +
  'Fish that look clearly different from each other (different color, pattern or body shape) must be separate entries, even if each has only one or two individuals. ' +
  'Never lump different-looking fish into one entry or one count. Some cichlids are hybrids or unusual color morphs; if so, say "likely hybrid" in the name. ' +
  'Only as a last resort, when a fish is too small or blurry to guess a specific name, use "Unidentified" plus the group (for example "Unidentified tetra") with confidence below 0.4. ' +
  'Tell-apart tips: a cardinal tetra has a red stripe along the whole underside of its body, while a neon tetra has red only on the rear half. ' +
  'Corydoras: skunk cories have a black stripe along the back, julii-type have spotted or lined patterns, panda cories have black eye patches and a black tail base. ' +
  'Siamese algae eaters have a black stripe running through the eye to the tail and no barbels. ' +
  'Only list what you can actually see clearly. If the photo is very dark, blurry or reflective, list fewer things with low confidence rather than guessing; never list a plant or fish you cannot see. ' +
  'Set too_far to true if many fish are too small or far away to identify reliably. ' +
  'If the photo is not an aquarium, set is_aquarium to false and return no species. ' +
  'If photo quality limited your answer (glare, too far, dark), put one short tip in photo_tips, otherwise leave it empty.';

const ZOOM_NOTE =
  'The first image is the whole tank. The images after it are zoomed-in, overlapping pieces of that same photo, ' +
  'in reading order (left to right, top to bottom), included so you can see small and distant fish clearly. ' +
  'Use the zoomed pieces to identify species and to count. Fish near the edges of a piece may also appear in the next piece, ' +
  'so count each real fish only once. Return ONE combined list for the whole tank, with counts for the whole tank, not per piece.';

const KNOWN_NOTE = (names) =>
  'The person says this tank already contains: ' + names.join(', ') + '. ' +
  'Most fish in the picture are probably from that list, so when a fish could be one of them, or a lookalike of one of them ' +
  '(for example a neon tetra versus a cardinal tetra), use the name from the list unless you can clearly see it is a different species. ' +
  'Never add a fish from the list that you cannot see. Still report any fish that is clearly NOT on the list.';

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

  const mime = ALLOWED_MIME.includes(body.mime) ? body.mime : '';
  const list = Array.isArray(body.images) ? body.images : (typeof body.image === 'string' ? [body.image] : []);
  if (!mime || !list.length || list.length > MAX_IMAGES) return json({ ok: false, error: 'bad_image' }, 400, origin);
  let total = 0;
  for (const item of list) {
    if (typeof item !== 'string' || !item || !/^[A-Za-z0-9+/=]+$/.test(item)) return json({ ok: false, error: 'bad_image' }, 400, origin);
    if (item.length > MAX_IMAGE_CHARS) return json({ ok: false, error: 'too_large' }, 413, origin);
    total += item.length;
  }
  if (total > MAX_TOTAL_CHARS) return json({ ok: false, error: 'too_large' }, 413, origin);

  const mode = ['single', 'zoom'].includes(body.mode) ? body.mode : (list.length > 1 ? 'zoom' : 'single');
  // Names of what the person already keeps in this tank. Cleaned hard, because it goes into the prompt.
  const known = (Array.isArray(body.known) ? body.known : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.replace(/[^\p{L}\p{N} '.()\/-]/gu, '').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 40);
  function buildParts(withRes) {
    const parts = [];
    list.forEach((data, i) => {
      if (mode === 'zoom' && list.length > 1) parts.push({ text: i === 0 ? 'Whole tank:' : 'Zoomed piece ' + i + ' of ' + (list.length - 1) + ':' });
      const part = { inline_data: { mime_type: mime, data } };
      if (withRes && mode === 'single') part.media_resolution = { level: 'MEDIA_RESOLUTION_ULTRA_HIGH' };
      parts.push(part);
    });
    return parts;
  }
  const promptText = (mode === 'zoom' ? PROMPT + ' ' + ZOOM_NOTE : PROMPT) + (known.length ? ' ' + KNOWN_NOTE(known) : '');

  const primary = env.GEMINI_MODEL || DEFAULT_MODEL;
  const models = [primary, FALLBACK_MODEL, LAST_RESORT_MODEL].filter((m, i, all) => all.indexOf(m) === i);
  const started = Date.now();

  async function ask(model, withThinking, ms, withRes) {
    const generationConfig = { responseMimeType: 'application/json', responseSchema: SCHEMA };
    if (withThinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    const payload = {
      systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [{ text: promptText }].concat(buildParts(withRes)) }],
      generationConfig
    };
    return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ms)
    });
  }

  let upstream = null;
  const problems = [];
  let lastError = 'ai_busy';
  let lastStatus = 0;
  let usedModel = '';
  for (const model of models) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (left < 6000) break;
    const ms = Math.min(24000, left);
    let res = null;
    try {
      res = await ask(model, true, ms, true);
      // A model may not accept the per-image resolution or thinking settings: retry with fewer extras.
      if (res.status === 400) res = await ask(model, true, Math.max(4000, TOTAL_BUDGET_MS - (Date.now() - started)), false);
      if (res.status === 400) res = await ask(model, false, Math.max(4000, TOTAL_BUDGET_MS - (Date.now() - started)), false);
      if ((res.status === 503 || res.status === 429) && TOTAL_BUDGET_MS - (Date.now() - started) > 12000) {
        await new Promise((r) => setTimeout(r, 1200)); // one quick retry when Google says "busy"
        res = await ask(model, true, Math.min(20000, TOTAL_BUDGET_MS - (Date.now() - started)), true);
      }
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      problems.push(model + ': ' + (timedOut ? 'too slow' : 'could not reach Google'));
      lastError = 'ai_busy';
      lastStatus = 0;
      continue;
    }
    if (res.ok) { upstream = res; usedModel = model; break; }
    const busy = res.status === 429 || res.status === 503;
    problems.push(model + ': ' + (busy ? 'busy' : 'error ' + res.status));
    lastError = busy ? 'ai_busy' : 'ai_error';
    lastStatus = res.status;
  }
  if (!upstream) {
    return json({ ok: false, error: lastError, ai_status: lastStatus, ai_detail: problems.join('; ').slice(0, 200) }, 502, origin);
  }

  let data = null;
  try {
    data = await upstream.json();
    const text = data.candidates[0].content.parts.map((p) => p.text || '').join('');
    const result = sanitize(JSON.parse(text));
    const u = data.usageMetadata || {};
    const usage = { input: Number(u.promptTokenCount) || 0, output: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) };
    return json(Object.assign({ ok: true, model: usedModel, usage, mode }, result), 200, origin);
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
      return new Response('Schooled API is running (version 13: ' + (env.GEMINI_MODEL || DEFAULT_MODEL) + ', backup ' + FALLBACK_MODEL + ')', { headers: corsHeaders(origin) });
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
