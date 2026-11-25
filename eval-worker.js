// schooled-eval worker — accuracy test: Claude Haiku 5.5 vs Gemini 4 Hydrogen
// Separate from schooled-worker so the live app is never touched.
//
// Secrets to set in Cloudflare (Worker > Settings > Variables and Secrets):
//   ANTHROPIC_API_KEY  - your Claude API key
//   GEMINI_API_KEY     - your Gemini API key
//   EVAL_TOKEN         - any passcode you make up; the test page must send it

const DEFAULT_MODELS = {
  haiku: "claude-haiku-5-5",
  hydrogen: "gemini-4-hydrogen",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Eval-Token",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Pull the first {...} block out of a reply, ignoring ```json fences or chatter.
function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callHaiku(env, modelId, prompt, image, mime) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: image } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error ${res.status}`);
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

async function callHydrogen(env, modelId, prompt, image, mime) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ inline_data: { mime_type: mime, data: image } }, { text: prompt }],
        },
      ],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4000 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API error ${res.status}`);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
  const u = data.usageMetadata || {};
  return {
    text,
    inputTokens: u.promptTokenCount ?? 0,
    // Google bills thinking tokens as output, so count them.
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

export default {
  async fetch(request, env) {
    // Any unexpected crash still returns CORS headers, so the page shows the real error
    // instead of a bare "Failed to fetch".
    try {
      return await handle(request, env);
    } catch (err) {
      return json({ ok: false, error: "Worker crashed: " + String(err?.message || err) }, 500);
    }
  },
};

async function handle(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // Health check: open https://<worker>/health in a browser to confirm it's live.
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return json({
        ok: true,
        worker: "schooled-eval",
        secrets: {
          ANTHROPIC_API_KEY: !!env.ANTHROPIC_API_KEY,
          GEMINI_API_KEY: !!env.GEMINI_API_KEY,
          EVAL_TOKEN: !!env.EVAL_TOKEN,
        },
      });
    }

    if (request.method !== "POST" || url.pathname !== "/eval") {
      return json({ ok: false, error: "Use POST /eval" }, 404);
    }
    if (!env.EVAL_TOKEN || request.headers.get("X-Eval-Token") !== env.EVAL_TOKEN) {
      return json({ ok: false, error: "Wrong or missing eval passcode" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Body must be JSON" }, 400);
    }

    const { provider, image, mime = "image/jpeg", prompt } = body;
    if (!["haiku", "hydrogen"].includes(provider)) {
      return json({ ok: false, error: "provider must be 'haiku' or 'hydrogen'" }, 400);
    }
    if (!image || !prompt) return json({ ok: false, error: "image and prompt are required" }, 400);
    if (image.length > 7_000_000) return json({ ok: false, error: "Image too large" }, 413);

    const modelId =
      typeof body.model === "string" && /^[a-z0-9.\-]{3,60}$/i.test(body.model)
        ? body.model
        : DEFAULT_MODELS[provider];

    const started = Date.now();
    try {
      const out =
        provider === "haiku"
          ? await callHaiku(env, modelId, prompt, image, mime)
          : await callHydrogen(env, modelId, prompt, image, mime);
      return json({
        ok: true,
        provider,
        model: modelId,
        latencyMs: Date.now() - started,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        parsed: extractJson(out.text),
        raw: out.text,
      });
    } catch (err) {
      return json({
        ok: false,
        provider,
        model: modelId,
        latencyMs: Date.now() - started,
        error: String(err.message || err),
      });
    }
}
