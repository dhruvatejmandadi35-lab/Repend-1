const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { groundTopic } = require("./grounding");
const courses = require("./courses");
const harness = require("./lab-harness");

// Load .env locally (Railway injects env vars directly, so this is a no-op there).
try { require("fs").readFileSync(path.join(__dirname, ".env"), "utf8")
  .split("\n").forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) { /* no .env file — fine in production */ }

// Placeholder keys avoid the SDK throwing at construction when a key is unset
// (it rejects empty strings too). A real request will still fail with an auth
// error if the key is genuinely missing — but the server boots.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing-openai-key" });

// NVIDIA Build client — uses the OpenAI SDK against NVIDIA's hosted endpoint.
// Set NVIDIA_API_KEY in env to enable; codegen falls back to OpenAI gpt-4o when missing.
//
// Sanitize the key at boot. A common mistake is pasting the WHOLE code snippet
// from the NVIDIA Build model card into the env var instead of just the key —
// that produces an invalid HTTP header value, the Kimi call throws, and codegen
// silently falls back to gpt-4o (which refuses → blank lab → wasted credits).
// We take only the first whitespace-delimited token (the actual nvapi- key) and
// warn loudly if it doesn't look like a key, so the failure is visible at boot.
function sanitizeNvidiaKey(raw) {
  if (!raw) return null;
  const key = String(raw).trim().split(/\s/)[0];  // first token only
  if (!key.startsWith("nvapi-")) {
    console.warn(`[boot] NVIDIA_API_KEY does not start with "nvapi-" (got "${key.slice(0, 8)}…"). ` +
      `Codegen will fall back to OpenAI. Make sure you pasted ONLY the key, not the code snippet.`);
    return null;
  }
  return key;
}
const NVIDIA_API_KEY = sanitizeNvidiaKey(process.env.NVIDIA_API_KEY);
const nvidia = new OpenAI({
  apiKey: NVIDIA_API_KEY || "missing-nvidia-key",
  baseURL: "https://integrate.api.nvidia.com/v1",
  timeout: 180000,  // 3min — generous because we stream; a hang aborts and falls back to OpenAI
  maxRetries: 0,    // we handle retries ourselves; don't let the SDK silently double the wait
});

// Codegen model selector.
// "nvidia"  → an NVIDIA Build model (id from CODEGEN_MODEL_ID) via the OpenAI-compatible endpoint
// "nemotron" is accepted as a legacy alias for "nvidia". Fallback is OpenAI gpt-4o.
const CODEGEN_MODEL = process.env.CODEGEN_MODEL || "nvidia";
// The exact NVIDIA Build model id to call. Swap this (env var, no code change)
// to switch NVIDIA Build models:
//   z-ai/glm-5.2         (default — z-ai/glm-5.1 was DELISTED from NVIDIA Build)
//   moonshotai/kimi-k2.6 (previous pick — returned empty streams on free tier)
// The id must match exactly what the NVIDIA Build model card's code snippet
// shows; confirm it exists via GET https://integrate.api.nvidia.com/v1/models
// (no auth needed) before deploying — a delisted id 404s every codegen call.
const CODEGEN_MODEL_ID = process.env.CODEGEN_MODEL_ID || "z-ai/glm-5.2";

// Output token cap for codegen. NVIDIA NIM caps GLM-5.2 output at 32768 and
// DEFAULTS to 16384 when the param is omitted — that silent default was the
// truncation bug (labs cut off mid-<script>). Always send the cap explicitly.
const CODEGEN_MAX_TOKENS = parseInt(process.env.CODEGEN_MAX_TOKENS || "32768", 10);

// Codegen stream guards. CODEGEN_TIMEOUT_MS = hard wall-clock ceiling for ONE
// Kimi call; CODEGEN_IDLE_MS = max gap between streamed chunks before we treat
// the stream as stalled. Both abort into a retryable fallback so a hung thinking
// model never leaves the request silently dangling (the Iter 6/7 failure mode).
const CODEGEN_TIMEOUT_MS = parseInt(process.env.CODEGEN_TIMEOUT_MS || "300000", 10); // 5 min (GLM is slower than Kimi)
const CODEGEN_IDLE_MS = parseInt(process.env.CODEGEN_IDLE_MS || "45000", 10);        // 45 s

// GLM-5.2 is a hybrid reasoning model: by default it emits an internal
// chain-of-thought (reasoning_content) BEFORE writing any code. Stage 1 already
// did the design reasoning, so default is OFF — GLM goes straight to writing.
//   CODEGEN_THINKING=on → keep it (try if sim-logic quality drops)
// The control key for the Zhipu GLM family on NVIDIA NIM is
// chat_template_kwargs.thinking; the OpenAI SDK forwards it verbatim in the body.
const CODEGEN_THINKING = (process.env.CODEGEN_THINKING || "off").toLowerCase() === "on";

// ── 2-STAGE PIPELINE MODELS ───────────────────────────────────────────────────
// Lesson + quiz: DeepSeek V4 Flash on NVIDIA Build — fast (~10s), native thinking
// model, already proven for JSON output. The lesson streams to the learner FIRST
// so they read while the lab builds. NOTE: deepseek-r1 was DELISTED from NVIDIA
// Build — verify any override against GET /v1/models first.
const LESSON_MODEL_ID = process.env.LESSON_MODEL_ID || process.env.INTERACTION_MODEL_ID || "deepseek-ai/deepseek-v4-flash";

// Stage 1 blueprint: DeepSeek V4 Pro — the one heavy reasoning call in the
// pipeline. Produces the JSON blueprint (mechanism, misconception, formulas,
// variables, concept_type, interaction contract) that drives everything else.
// Falls back down REASON_FALLBACK_CHAIN (gpt-oss-120b → 20b → llama-70b).
const THINK_MODEL_ID = process.env.THINK_MODEL_ID || (NVIDIA_API_KEY ? "deepseek-ai/deepseek-v4-pro" : (process.env.OPENAI_MODEL || "gpt-4o"));

// OpenAI model selectors — centralized so you can swap models from env (Railway
// variable, no code change). Two tiers:
//   OPENAI_MODEL      → heavy/quality stages: spec, visual critic, codegen fallback
//   OPENAI_MINI_MODEL → cheap stages: topic expand, reasoning, pedagogy, courses
// Defaults are gpt-4o / gpt-4o-mini (safe, still resolve). To upgrade to the
// GPT-5 line for better quality-per-dollar at Tier 1, set e.g.
//   OPENAI_MODEL=gpt-5.4-mini  OPENAI_MINI_MODEL=gpt-5.4-nano
// AFTER confirming the exact model id in your OpenAI dashboard. NOTE: streaming
// GPT-5 models requires OpenAI Organization Verification — the codegen fallback
// streams, so verify your org first or it will error on that path only.
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_MINI_MODEL = process.env.OPENAI_MINI_MODEL || "gpt-4o-mini";

// Reasoning provider — routes the text/JSON stages (plan, spec, verify, pedagogy,
// classifiers, courses) to a cheaper backend while testing. Defaults to NVIDIA
// Build (openai/gpt-oss-20b, effectively free) when an NVIDIA key is present, so
// you are not paying OpenAI per token during development. Set REASONING_PROVIDER=openai
// to flip everything back to gpt-4o/gpt-4o-mini.
//   REASON_MODEL      → heavy text/JSON stages (spec, codegen fallback, critic)
//   REASON_MINI_MODEL → cheap stages (topic expand, verify, classifiers, courses)
// Vision calls (analyzeImage, visual critic) use a separate vision-capable model.
// On NVIDIA Build we use nvidia/nemotron-nano-12b-v2-vl: free-tier, OpenAI-compatible
// image_url support, and it tops the OCRBench v2 leaderboard (DocVQA 94.3, ChartQA 89.7,
// AI2D 87.3). OCR + document-layout reasoning is exactly what the critic needs to flag
// unreadable labels, blank canvases, and broken layouts. Override with VISION_MODEL_ID
// (e.g. a Qwen3-VL id). Falls back to OPENAI_MODEL when no NVIDIA key is present.
const REASONING_PROVIDER = (process.env.REASONING_PROVIDER || (NVIDIA_API_KEY ? "nvidia" : "openai")).toLowerCase();
const useNvidiaReasoning = REASONING_PROVIDER === "nvidia" && !!NVIDIA_API_KEY;
const reason = useNvidiaReasoning ? nvidia : openai;
// 2026-07-05: primary flipped off meta/llama-3.3-70b-instruct. It stalled with no
// first byte for 40s+ on the NVIDIA free tier, so EVERY heavy stage (spec, reason,
// codegen fallback, interaction backup) ate a ~40s dead-timeout before falling back —
// a guaranteed per-lab latency tax on top of the reliability hit. gpt-oss-120b is the
// fallback that has actually been producing these specs successfully, so it's now the
// primary; 70b drops to last-resort in the chain in case free-tier capacity recovers.
const REASON_MODEL = process.env.REASON_MODEL || (useNvidiaReasoning ? "openai/gpt-oss-120b" : OPENAI_MODEL);
// Mini calls (expand, think-topic, pedagogy) use a fast 8B instruct model on NVIDIA path —
// no null-content risk and much lower latency than the reasoning model.
const REASON_MINI_MODEL = process.env.REASON_MINI_MODEL || (useNvidiaReasoning ? "meta/llama-3.1-8b-instruct" : OPENAI_MINI_MODEL);
// Emergency fallback for heavy REASON_MODEL stages. 2026-07-03: llama-3.3-70b on
// NVIDIA Build queued with no first byte for 180s+ per attempt while 8b calls
// answered in seconds — every generation died at think/spec after 4×180s. After
// the first failed attempt, openaiCreate/openaiCreateStreamed retry on this model
// instead of re-queueing on the stalled one. gpt-oss-120b: verified in catalog,
// comparable quality, and the pipeline already handles gpt-oss reasoning output.
// Fallback CHAIN, tried in order on successive retry attempts. 2026-07-05: seen a
// cycle where BOTH 70b and gpt-oss-120b timed out (NVIDIA free-tier capacity crunch)
// and the run errored — so we chain a third, lighter model (gpt-oss-20b, most likely
// to have spare free-tier capacity) for one more shot before giving up. Attempts map:
// 0 = REASON_MODEL, 1 = chain[0], 2 = chain[1], 3 = chain[1] (clamped). Override the
// whole chain by setting REASON_FALLBACK_MODEL (single model) in env.
const REASON_FALLBACK_CHAIN = process.env.REASON_FALLBACK_MODEL
  ? [process.env.REASON_FALLBACK_MODEL]
  : (useNvidiaReasoning ? ["openai/gpt-oss-20b", "meta/llama-3.3-70b-instruct"] : [OPENAI_MINI_MODEL]);
const REASON_FALLBACK_MODEL = REASON_FALLBACK_CHAIN[0];
// Idle timeout for reason-stage calls (spec, quiz, expand, pedagogy, interaction).
// The openai-node client `timeout` acts as an idle timeout on streams — it resets
// on every chunk, so it only fires when a stream is SILENT this long. 40s means a
// stalled llama-70b aborts fast and swaps to REASON_FALLBACK_MODEL instead of
// dead-waiting the client's 180s default (measured: design+quiz burned 180s each
// before falling back). Healthy 8b/gpt-oss calls emit within seconds, so unaffected.
// Codegen is exempt — it passes its own CODEGEN_TIMEOUT_MS at the call site.
const REASON_STAGE_TIMEOUT_MS = parseInt(process.env.REASON_STAGE_TIMEOUT_MS || "40000", 10);
const visionClient = NVIDIA_API_KEY ? nvidia : openai;
const VISION_MODEL = process.env.VISION_MODEL_ID || (NVIDIA_API_KEY ? "nvidia/nemotron-nano-12b-v2-vl" : OPENAI_MODEL);
console.log(`[boot] reasoning provider: ${useNvidiaReasoning ? `NVIDIA Build (${REASON_MODEL}), mini: ${REASON_MINI_MODEL}, think: ${THINK_MODEL_ID}, fallback chain: ${REASON_FALLBACK_CHAIN.join(" → ")}` : `OpenAI (${REASON_MODEL})`}`);
console.log(`[boot] vision provider: ${NVIDIA_API_KEY ? `NVIDIA Build (${VISION_MODEL})` : `OpenAI (${OPENAI_MODEL})`}`);
console.log(`[boot] codegen: ${CODEGEN_MODEL_ID} (max_tokens=${CODEGEN_MAX_TOKENS}, thinking=${CODEGEN_THINKING ? "on" : "off"}) | lesson/quiz: ${LESSON_MODEL_ID}`);

const { createClient } = require("@supabase/supabase-js");
let supabase = null;
function getSupabase() {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return supabase;
}

// Reasoning calls route through the configured provider (NVIDIA Build by default
// for cheap testing; OpenAI when REASONING_PROVIDER=openai). Both expose the same
// OpenAI-compatible chat.completions API. Retries on transient 429/503 only.
// On retry attempts, heavy REASON_MODEL calls swap to REASON_FALLBACK_MODEL —
// a 180s no-first-byte timeout means the primary's queue is stalled, and three
// more attempts on it just burn 9 minutes before erroring. Mini/vision/codegen
// models keep their own params (they have separate fallback paths).
function retryParams(params, attempt, label) {
  // A call can carry its own _fallbackChain (e.g. labthink: v4-pro → gpt-oss…);
  // otherwise REASON_MODEL calls default to the shared REASON_FALLBACK_CHAIN.
  const { _fallbackChain, ...clean } = params;
  const chain = _fallbackChain || (clean.model === REASON_MODEL ? REASON_FALLBACK_CHAIN : null);
  if (attempt === 0 || !chain || chain.length === 0) return clean;
  const fb = chain[Math.min(attempt - 1, chain.length - 1)];
  if (fb === clean.model) return clean;
  console.warn(`[${label}] ${clean.model} unavailable — attempt ${attempt + 1} on fallback ${fb}`);
  return { ...clean, model: fb, ...reasonParams(fb, clean.max_tokens || 3000) };
}

async function openaiCreate(params, label = "reason", reqOpts = {}) {
  const opts = { timeout: REASON_STAGE_TIMEOUT_MS, ...reqOpts };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await reason.chat.completions.create(retryParams(params, attempt, label), opts);
    } catch (err) {
      lastErr = err;
      if (!isOverloadError(err)) throw err;
      if (attempt < 3) {
        const wait = 1000 * Math.pow(2, attempt);
        console.warn(`[${label}] provider overloaded (attempt ${attempt + 1}), retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// Streaming variant — keeps the NVIDIA connection alive so a slow gpt-oss-20b
// response doesn't trigger APIConnectionTimeoutError before text arrives.
// Collects both delta.content and delta.reasoning_content (gpt-oss uses the latter).
async function openaiCreateStreamed(params, label = "reason-stream", reqOpts = {}) {
  const opts = { timeout: REASON_STAGE_TIMEOUT_MS, ...reqOpts };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const stream = await reason.chat.completions.create({ ...retryParams(params, attempt, label), stream: true }, opts);
      let content = "";
      let reasoning = "";
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta || {};
        content += delta.content || "";
        reasoning += delta.reasoning_content || "";
      }
      return content || reasoning;
    } catch (err) {
      lastErr = err;
      if (!isOverloadError(err)) throw err;
      if (attempt < 3) {
        const wait = 1000 * Math.pow(2, attempt);
        console.warn(`[${label}] overloaded (attempt ${attempt + 1}), retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// Whether to send response_format:{type:"json_object"}. OpenAI honors it; many
// NVIDIA Build models (incl. gpt-oss-20b) reject it with a 400. When using the
// NVIDIA reasoning provider we omit it and rely on the prompt + parseLooseJSON.
const REASON_JSON_MODE = !useNvidiaReasoning;
function jsonFormat() {
  return REASON_JSON_MODE ? { response_format: { type: "json_object" } } : {};
}

// Tolerant JSON parse for model output. Handles markdown fences, a leading
// preamble sentence, and trailing prose by extracting the first balanced
// {...} (or [...]) block. Without json_object mode, models add chatter we must strip.
function parseLooseJSON(text) {
  const s = String(text || "").trim();
  // Fast path: already clean JSON.
  try { return JSON.parse(s); } catch (_) {}
  // Strip markdown fences.
  let t = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(t); } catch (_) {}
  // Extract the first balanced object/array block.
  const start = t.search(/[{[]/);
  if (start === -1) throw new Error("No JSON object found in model response");
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      if (--depth === 0) {
        const block = t.slice(start, i + 1);
        try { return JSON.parse(block); }
        // Models writing math/LaTeX (\frac, \times, \alpha) emit invalid JSON
        // escapes. Repair lone backslashes that aren't a valid JSON escape,
        // then retry — otherwise the whole pipeline 500s on math topics.
        catch (_) { return JSON.parse(repairJSONEscapes(block)); }
      }
    }
  }
  throw new Error("Unbalanced JSON in model response");
}

// Escape any backslash that is NOT the start of a valid JSON escape sequence
// (\" \\ \/ \b \f \n \r \t \uXXXX). Turns invalid `\frac` into `\\frac` so
// JSON.parse accepts strings containing LaTeX/Windows-path-like content.
function repairJSONEscapes(s) {
  return s.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, "\\\\");
}

// Safely read the assistant text from a chat completion. Reasoning models
// (gpt-oss) can return message.content === null (budget spent on hidden
// reasoning) and put partial output in reasoning_content. Never throw on null.
function safeContent(res) {
  const m = res && res.choices && res.choices[0] && res.choices[0].message;
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string" && c.trim()) return c;
  // Some NVIDIA gpt-oss responses expose the answer under reasoning_content.
  if (typeof m.reasoning_content === "string" && m.reasoning_content.trim()) return m.reasoning_content;
  return "";
}

// True for reasoning models (gpt-oss) that accept reasoning_effort and need
// extra token headroom so the final answer isn't truncated by the think phase.
function isReasoningModel(model) {
  return /gpt-oss|reasoning/i.test(model || "");
}

// Params to merge into a reason call: keep reasoning short (so the model emits a
// real answer, not just thinking) and floor max_tokens so the answer fits.
function reasonParams(model, maxTokens) {
  const out = { max_tokens: maxTokens };
  if (isReasoningModel(model)) {
    out.reasoning_effort = "low";
    out.max_tokens = Math.max(maxTokens, 3000); // headroom for think + answer
  }
  return out;
}

// Helper: OpenAI plain-text response
async function openaiText(prompt, maxTokens = 1000, model = REASON_MINI_MODEL) {
  const res = await openaiCreate({
    model, ...reasonParams(model, maxTokens),
    messages: [{ role: "user", content: prompt }],
  }, "text");
  const text = safeContent(res);
  if (!text) throw new Error(`${model} returned empty content`);
  return text.trim();
}

// Helper: OpenAI JSON response (json_object mode)
async function openaiJSON(prompt, maxTokens = 2500, model = REASON_MODEL) {
  const res = await openaiCreate({
    model, ...reasonParams(model, maxTokens),
    ...jsonFormat(),
    messages: [{ role: "user", content: prompt }],
  }, "json");
  return parseLooseJSON(safeContent(res));
}

// HTML codegen uses NVIDIA Build (Kimi K2.6) with OpenAI gpt-4o as fallback.

function topicKey(topic) {
  return topic.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Cache rule: unrated labs are served as-is (benefit of the doubt); labs the
// community has rated below 3★ average are treated as a MISS so they get
// regenerated by the current pipeline instead of replaying a known-bad lab.
async function getCachedLab(key) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  try {
    const sb = getSupabase();
    if (!sb) return null;
    const { data, error } = await sb
      .from('labs')
      .select('lab_data, rating_sum, rating_count')
      .eq('topic_key', key)
      .limit(1)
      .single();
    if (error || !data) return null;
    if (data.rating_count > 0 && (data.rating_sum / data.rating_count) < 3) {
      console.log(`[cache] "${key}" rated ${(data.rating_sum / data.rating_count).toFixed(1)}★ — regenerating instead of serving`);
      return null;
    }
    return data.lab_data;
  } catch (err) {
    console.warn('getCachedLab failed:', err.message);
    return null;
  }
}

// Fuzzy topic similarity: Jaccard on lowercased word sets (no API call needed).
const STOPWORDS = new Set(["a","an","the","of","in","and","or","to","how","why","what","is","are","does","do","for","on","with","by","at","its","it","be"]);
function topicWords(t) {
  return new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g,"").split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w)));
}
function jaccardSim(a, b) {
  const intersection = [...a].filter(w => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

// Look for a highly-rated cached lab similar to `topic` (Jaccard ≥ 0.35, avg rating ≥ 4.0).
// Returns null if no good match, or { topic, topicKey, rating, labData }.
async function findSimilarLab(topic) {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    // Only scan labs that have been rated (at least 2 ratings so the score means something)
    const { data, error } = await sb
      .from('labs')
      .select('topic_key, topic, rating_sum, rating_count, lab_data')
      .gte('rating_count', 2)
      .order('rating_sum', { ascending: false })
      .limit(80);
    if (error || !data || !data.length) return null;
    const qWords = topicWords(topic);
    let best = null, bestScore = 0;
    for (const row of data) {
      const avg = row.rating_sum / row.rating_count;
      if (avg < 4.0) continue;
      const sim = jaccardSim(qWords, topicWords(row.topic || row.topic_key));
      // Weight score by similarity + rating bonus
      const score = sim + (avg - 4.0) * 0.1;
      if (sim >= 0.35 && score > bestScore) { bestScore = score; best = { ...row, avg }; }
    }
    if (!best) return null;
    return {
      topic: best.topic,
      topicKey: best.topic_key,
      rating: +best.avg.toFixed(1),
      ratingCount: best.rating_count,
      labData: best.lab_data,
    };
  } catch (err) {
    console.warn('findSimilarLab failed:', err.message);
    return null;
  }
}

async function saveLab(key, topic, labData) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return;
  try {
    const sb = getSupabase();
    if (!sb) return;
    await sb
      .from('labs')
      .upsert({ topic_key: key, topic, lab_data: labData }, { onConflict: 'topic_key' });
  } catch (err) {
    console.warn('saveLab failed:', err.message);
  }
}

// Fire-and-forget: count a cache hit so popular labs can be recommended (= free reuse).
async function bumpLabPlays(key) {
  try {
    const sb = getSupabase();
    if (!sb) return;
    await sb.rpc('bump_lab_plays', { p_topic_key: key });
  } catch (err) {
    console.warn('bumpLabPlays failed:', err.message);
  }
}

// Record a 1–5 star rating against a cached lab; returns the new average.
async function rateLab(key, stars) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.rpc('rate_lab', { p_topic_key: key, p_stars: stars });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.rating_count) return { average: 0, count: 0 };
  return { average: row.rating_sum / row.rating_count, count: row.rating_count };
}

// Top cached labs by quality, then popularity — recommending these is FREE (cache hits,
// no AI call). This is the core cost-saving lever: steer learners to proven labs.
async function getRecommendedLabs(limit = 12) {
  const sb = getSupabase();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('labs')
      .select('topic_key, topic, rating_sum, rating_count, plays')
      .order('rating_sum', { ascending: false })
      .order('plays', { ascending: false })
      .limit(60);
    if (error || !data) return [];
    return data
      .map(r => ({
        topicKey: r.topic_key,
        topic: r.topic,
        plays: r.plays || 0,
        ratingCount: r.rating_count || 0,
        rating: r.rating_count ? +(r.rating_sum / r.rating_count).toFixed(1) : 0,
      }))
      // Rank: rated-good labs first (Wilson-ish: avg weighted by count), then plays.
      .sort((a, b) => (b.rating * Math.min(b.ratingCount, 5) + b.plays * 0.2)
                    - (a.rating * Math.min(a.ratingCount, 5) + a.plays * 0.2))
      .slice(0, limit);
  } catch (err) {
    console.warn('getRecommendedLabs failed:', err.message);
    return [];
  }
}

// Save a lab HTML snapshot for sharing; returns a UUID share ID
async function createShare(topic, labHtml) {
  const sb = getSupabase();
  if (!sb) {
    // No Supabase — fall back to in-memory map (lost on redeploy, good enough for demo)
    const id = Math.random().toString(36).slice(2, 10);
    shareCache.set(id, { topic, html: labHtml, ts: Date.now() });
    return id;
  }
  try {
    const { data, error } = await sb
      .from('shared_labs')
      .insert({ topic, lab_html: labHtml })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  } catch (err) {
    console.warn('createShare Supabase failed, using in-memory:', err.message);
    const id = Math.random().toString(36).slice(2, 10);
    shareCache.set(id, { topic, html: labHtml, ts: Date.now() });
    return id;
  }
}

// Get a shared lab HTML by ID
async function getShare(id) {
  // Check in-memory first (covers no-Supabase path)
  if (shareCache.has(id)) return shareCache.get(id).html;
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from('shared_labs')
      .select('lab_html')
      .eq('id', id)
      .single();
    if (error) return null;
    return data?.lab_html || null;
  } catch (err) {
    console.warn('getShare failed:', err.message);
    return null;
  }
}

// In-memory share cache (fallback when Supabase not configured or for demos)
const shareCache = new Map();

// Save or update a user's progress on a lab (called from /api/progress endpoint)
async function saveProgress(userId, key, topic, { completed = false, score = 0 } = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return;
  try {
    const sb = getSupabase();
    if (!sb) return;
    const { data: existing } = await sb
      .from('lab_progress')
      .select('attempts')
      .eq('user_id', userId)
      .eq('topic_key', key)
      .single();
    await sb.from('lab_progress').upsert({
      user_id: userId,
      topic_key: key,
      topic,
      completed,
      score,
      attempts: (existing ? existing.attempts : 0) + 1,
      last_attempt_at: new Date().toISOString(),
    }, { onConflict: 'user_id,topic_key' });
  } catch (err) {
    console.warn('saveProgress failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// OLD RECIPE ENGINE (kept for /plan + /simulate routes)
// ─────────────────────────────────────────────────────────────────

const PLAN_SYSTEM = `You are an expert educational lab designer. Return ONLY valid JSON matching this schema exactly.

{
  "topic": "Display name",
  "scenario": "2-3 paragraph immersive second-person scenario. Open with a concrete real-world moment (a real job, decision, failure mode, news story). Name roles, places, dollar amounts, consequences. End by stating what the learner will manipulate.",
  "verificationQuestion": "Specific question the learner can ONLY answer by interacting with the lab.",
  "recipe": {
    "title": "Lab title",
    "instructions": "1-2 sentences: what to click/drag and what the goal is.",
    "stage": { "width": 900, "height": 540 },
    "background": { "type": "svg", "markup": "<!-- 15+ SVG elements drawing the actual subject -->" },
    "objects": [],
    "winCondition": { "type": "states-match", "target": {} },
    "hint": "One actionable hint.",
    "successMessage": "Affirmation shown when correct.",
    "insight": "One deeper insight dropped after success."
  }
}

OBJECT TYPES for objects[]:
- NODE: { "id":"node-heart","kind":"node","x":300,"y":220,"shape":"circle","size":32,"label":"Heart","states":["off","on"],"initial":"off","stateStyles":{"off":{"fill":"transparent","stroke":"#fff"},"on":{"fill":"#3B82F6","stroke":"#3B82F6"}} }
- DRAGGABLE: { "id":"lbl-heart","kind":"draggable","x":80,"y":460,"width":140,"height":36,"label":"Heart","color":"#1E3A8A" }
- TARGET: { "id":"zone-heart","kind":"target","x":540,"y":220,"width":140,"height":36,"label":"Pumps blood","accepts":["lbl-heart"] }
- SLIDER: { "id":"slider-mass","kind":"slider","label":"Mass","unit":"kg","min":1,"max":50,"step":1,"initial":10,"bind":{"selector":"#ball","attr":"r","scale":0.5,"offset":5} }
- LABEL: { "id":"lbl-gen1","kind":"label","x":60,"y":100,"text":"Generation I","size":12,"color":"rgba(212,165,116,0.9)" }

WIN CONDITIONS: states-match | snaps-correct | values-equal
RULES: min 6 interactive objects, real names/values, rich background SVG. Return ONLY the JSON.`;

const VERIFY_SYSTEM = `You are a learning coach. Return ONLY JSON:
{ "correct": true, "feedback": "2-3 sentences. If correct: affirm with precision and one deeper insight. If wrong: name the specific misread and what to look for next." }`;

const ENGINE_TEMPLATE = fs.readFileSync(path.join(__dirname, "engine.html"), "utf8");

async function plan(topic) {
  const res = await reason.chat.completions.create({
    model: REASON_MODEL,
    ...reasonParams(REASON_MODEL, 4096),
    ...jsonFormat(),
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: `Topic: ${topic}\n\nProduce the complete recipe JSON.` },
    ],
  });
  return parseLooseJSON(safeContent(res));
}

function injectRecipe(recipe) {
  const serialized = JSON.stringify(recipe);
  return ENGINE_TEMPLATE.replace(
    /\/\*__RECIPE__\*\/[\s\S]*?\/\*__END__\*\//,
    `/*__RECIPE__*/ ${serialized} /*__END__*/`
  );
}

async function verify(topic, question, recipeSummary, userAnswer, labResult) {
  const res = await reason.chat.completions.create({
    model: REASON_MINI_MODEL,
    ...reasonParams(REASON_MINI_MODEL, 512),
    ...jsonFormat(),
    messages: [
      { role: "system", content: VERIFY_SYSTEM },
      { role: "user", content:
        `Topic: ${topic}\nQuestion: ${question}\nLab summary: ${recipeSummary}\n` +
        `Engine verdict: ${labResult ? JSON.stringify(labResult) : "n/a"}\nStudent answer: ${userAnswer}` },
    ],
  });
  return parseLooseJSON(safeContent(res));
}

async function analyzeImage(base64Image, question) {
  const res = await visionClient.chat.completions.create({
    model: VISION_MODEL,
    max_tokens: 512,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
        { type: "text", text: question || "Describe what the learner has built in this lab." },
      ],
    }],
  });
  return safeContent(res).trim();
}

// ─────────────────────────────────────────────────────────────────
// REPEND THEME — shared palette for platform UI and generated labs
// ─────────────────────────────────────────────────────────────────

const CATEGORY_GUIDANCE = {
  "Physics": "NASA mission-control lab: spacecraft, planetary bodies, orbital mechanics, 3D vector fields, telemetry HUD with ice-blue readouts, starfield backdrop, realistic scale models",
  "Biology": "Microscopic 3D cell world: organic membranes, glowing molecules, ribosomes, DNA helices — subsurface-scattering materials, bioluminescent accents, depth-of-field on cellular structures",
  "Sports & Skills": "Full video-game sports sim: real court/field/arena with stadium floodlights, scoreboard, mission targets, keyboard/touch steering, trajectory replays, crowd ambience particles, near-miss feedback like an arcade sports title",
  "Money & Econ": "3D trading floor or vault: coin stacks, holographic price surfaces, market ticker HUD, animated currency flows between sectors",
  "Math & Data": "3D data landscape: terrain from mathematical functions, holographic axes rising from the ground, glowing scatter points, D3-style curves as 3D ribbons",
  "Everyday Science": "Photorealistic real-world 3D environments — kitchen, sky dome, road, human body cross-section — with accurate lighting and recognizable everyday objects",
  "Language & Humanities": "A 3D world built from the SUBJECT ITSELF — never space. For language: large legible 3D letters/characters/words the learner drags, matches, and assembles; audio-waveform ribbons; speech-bubble panels; floating translation cards that snap together. For history/literature/art: timelines you walk along, 3D artifacts/scenes/maps, document panels. Warm museum/library lighting, NOT a starfield. The scene must literally show the words, characters, or artifacts being learned.",
  "General": "Build the scene OUT OF THE TOPIC ITSELF — depict the actual subject literally, never a default space/Mars scene. A lab about Telugu shows Telugu letters and words; a lab about cooking shows a kitchen; a lab about chess shows a board; a lab about an Archimedean spiral shows a coiled rope or a vinyl record. Use cinematic WebGL polish (good lighting, soft fog, glass HUD, particle depth) as production QUALITY, but the CONTENT of the 3D world is always the literal topic — only use planets/space if the topic is actually about space.",
};

function categoryGuidance(category) {
  return CATEGORY_GUIDANCE[category] || CATEGORY_GUIDANCE.General;
}


// Build a prompt block describing the full course this lab belongs to, so the
// single course lab weaves in EVERY module's topic + key concepts rather than
// teaching just one. Returns "" when this is a standalone lab.
function courseContextBlock(courseContext) {
  if (!courseContext || !Array.isArray(courseContext.modules) || !courseContext.modules.length) return "";
  const mods = courseContext.modules.map((m, i) => {
    const concepts = Array.isArray(m.key_concepts) && m.key_concepts.length ? ` — key concepts: ${m.key_concepts.join(", ")}` : "";
    return `  ${i + 1}. ${m.topic || m.title}${concepts}`;
  }).join("\n");
  return `
━━━ THIS IS THE SINGLE LAB FOR A WHOLE COURSE — it must cover ALL of these modules ━━━
COURSE: "${courseContext.title || ""}"${courseContext.tagline ? ` — ${courseContext.tagline}` : ""}
This one lab is the capstone for the entire course. It must let the learner experience EVERY module's core idea in a single connected interactive experience — do NOT narrow to just one module. Find the through-line that ties these modules together and build the lab around it, surfacing each module's key concepts as the learner progresses:
${mods}
Design the lab so each module's concept becomes a stage, mode, or layer the learner unlocks/explores — the whole course's mental model assembled in one place.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
}


function isOverloadError(err) {
  const msg = String(err && err.message || err);
  // Quota/billing exhaustion is a 429 too, but retrying won't help — treat
  // it as a hard error so we surface a clear billing message instead.
  if (/insufficient_quota|exceeded your current quota|billing/i.test(msg)) return false;
  // EngineCore is NVIDIA's backend inference engine — "EngineCore encountered an
  // issue" is a transient server-side crash that usually clears on retry. Also
  // catch generic connection/timeout blips so a single network hiccup doesn't
  // abort the whole pipeline.
  // "Request timed out." is the OpenAI SDK's APIConnectionTimeoutError message
  // (client-side timeout, not the ETIMEDOUT socket code) — without it a single
  // slow NVIDIA response threw straight through Promise.all and killed the
  // whole generation instead of retrying.
  return /\b(503|429|500|overloaded|high demand|Service Unavailable|rate limit|EngineCore|ECONNRESET|ETIMEDOUT|socket hang up|Connection error|Request timed out|APIConnectionTimeout)\b/i.test(msg);
}

// True when a usable OpenAI key is configured (not the boot placeholder). Used
// to decide whether a truly-independent last-resort fallback to OpenAI gpt-4o is
// possible when the NVIDIA Build endpoint is wholly down.
function hasOpenAIKey() {
  const k = process.env.OPENAI_API_KEY;
  return !!k && k !== "missing-openai-key";
}

function isQuotaError(err) {
  const msg = String(err && err.message || err);
  return /insufficient_quota|exceeded your current quota|billing/i.test(msg);
}


// ── KIMI CONCURRENCY LOCK ─────────────────────────────────────────────────────
// The NVIDIA Build FREE tier accepts ONE Kimi request at a time. When two lab
// generations run concurrently, both queue on NVIDIA's side, both sit idle for
// ~47-49s, and both return empty streams (content:0 reasoning:0 finish_reason:null).
// This lock serialises all Kimi calls so concurrent requests wait in line rather
// than hammering the endpoint in parallel.
let _kimiLock = Promise.resolve();
function withKimiLock(fn) {
  const run = _kimiLock.then(fn, fn);
  _kimiLock = run.catch(() => {});
  return run;
}

// One GLM streaming call with wall-clock + idle-stall timeouts. Returns the raw
// model output (the three-fragment block) or throws a retryable error. Fragment
// extraction + validation happen in the caller via lab-harness.
async function _runKimiStream(briefText, onProgress) {
  const ac = new AbortController();
  const startedAt = Date.now();
  let idleTimer = null;
  const hardTimer = setTimeout(() => ac.abort(new Error("codegen hard timeout")), CODEGEN_TIMEOUT_MS);
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(new Error("codegen idle stall")), CODEGEN_IDLE_MS);
  };
  const stream = await nvidia.chat.completions.create({
    model: CODEGEN_MODEL_ID,
    max_tokens: CODEGEN_MAX_TOKENS,
    temperature: 0.7,
    stream: true,
    chat_template_kwargs: { thinking: CODEGEN_THINKING },
    messages: [{ role: "user", content: briefText }],
  }, { signal: ac.signal });
  let raw = "", reasoning = "", lastReport = 0, finishReason = null;
  try {
    resetIdle();
    for await (const chunk of stream) {
      resetIdle();
      const choice = chunk.choices?.[0] || {};
      const delta = choice.delta || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (delta.content) raw += delta.content;
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      const seen = raw.length + reasoning.length;
      if (onProgress && seen - lastReport >= 2000) {
        lastReport = seen;
        try { onProgress(seen); } catch (_) {}
      }
    }
  } finally {
    clearTimeout(hardTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
  console.log(`[codegen/nvidia] stream done: content=${raw.length} reasoning=${reasoning.length} finish=${finishReason} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
  if (raw.length === 0 && reasoning.length === 0) {
    const e = new Error(`${CODEGEN_MODEL_ID} returned empty stream (finish_reason:${finishReason})`);
    e.status = 503;
    throw e;
  }
  // GLM sometimes puts the fragments in reasoning_content when content is empty.
  return raw.trim() ? raw : reasoning;
}

// ─────────────────────────────────────────────────────────────────
// 2-STAGE PIPELINE
// lesson (flash, ~10s, pushed first) → Stage 1 blueprint (pro) →
// deterministic node select → GLM codegen ∥ quiz (flash) →
// static validate → regenerate ONCE with failure reasons → save
// ─────────────────────────────────────────────────────────────────

// Lesson — fires FIRST so the learner reads while the lab builds. Fast model,
// no dependency on the blueprint (the topic alone is enough for prose).
async function generateLessonV2(topic, category, courseContext) {
  const prompt = `Write a short, punchy lesson about "${topic}" (category: ${category}).${courseContextBlock(courseContext)}
Return ONLY valid JSON (no markdown fences):
{
  "summary": "1-2 sentence hook — why this matters in the real world",
  "slides": [
    { "title": "slide title", "bullets": ["bullet 1", "bullet 2", "bullet 3"] }
  ]
}
Rules: exactly 4 slides. Slide 1 = the hook (a concrete real-world moment). Slides 2-3 = the core mechanism, built up step by step. Slide 4 = the common misconception and why it's wrong. 3-4 bullets per slide, ≤18 words per bullet. Plain English — no LaTeX, no backslash escapes.`;
  const res = await openaiCreate({
    model: LESSON_MODEL_ID,
    max_tokens: 2000,
    temperature: 0.5,
    _fallbackChain: REASON_FALLBACK_CHAIN,
    messages: [{ role: "user", content: prompt }],
  }, "lesson");
  return parseLooseJSON(safeContent(res));
}

// Stage 1 — the ONE heavy reasoning call. Produces the blueprint that drives
// node selection, codegen, and the quiz. Every field is load-bearing:
// concept_type routes libraries, interaction_contract shapes the sim,
// formulas trigger the KaTeX panel, misconception drives the predict gate.
async function stageOneBlueprint(topic, category, groundingText, courseContext, levelBackground, levelGoal, sourceMaterial, sourceFocus) {
  const personal = [
    levelBackground ? `LEARNER BACKGROUND: ${levelBackground}` : "",
    levelGoal ? `LEARNER GOAL: ${levelGoal}` : "",
    sourceFocus ? `FOCUS: ${sourceFocus}` : "",
    sourceMaterial ? `SOURCE MATERIAL (derive the lab from THIS):\n${sourceMaterial}` : "",
  ].filter(Boolean).join("\n");
  const prompt = `You are designing an interactive lab that teaches "${topic}" (category: ${category}).
${groundingText ? `VERIFIED FACTS (use these, do not contradict them):\n${groundingText}\n` : ""}${personal ? personal + "\n" : ""}${courseContextBlock(courseContext)}
Think hard about the ONE mechanism that, once seen moving, makes this topic click — and the ONE wrong belief most learners carry in.

Return ONLY valid JSON:
{
  "topic": "sharpened display title for the lab",
  "scenario": "2-3 sentence second-person hook: a concrete real-world moment where this mechanism decides an outcome",
  "mechanism": "the core cause→effect chain the sim must make VISIBLE, stated precisely",
  "misconception": "the specific wrong belief the lab must confront (this becomes the predict question)",
  "aha_moment": "the exact on-screen event where the misconception visibly breaks",
  "payoff": "one sentence: what the learner can now do/see in the real world",
  "formulas": [ { "latex": "F = ma", "symbols": { "F": "force (N)", "m": "mass (kg)", "a": "acceleration (m/s²)" } } ],
  "variables": [ { "name": "mass", "symbol": "m", "unit": "kg", "min": 1, "max": 50, "default": 10, "why": "what changing it reveals" } ],
  "concept_type": "one of: dynamic-physical | emergent | quantitative | probabilistic | spatial-2D | spatial-3D | sequential | abstract | network | ml-concept",
  "interaction_contract": {
    "primaryInteraction": "the main verb (drag the ball, perturb the flock, step the algorithm...)",
    "secondaryInteraction": "a second meaningful verb",
    "objectsMove": true,
    "feedbackLoop": "what visibly changes within 100ms of the learner acting",
    "cameraResponds": false,
    "requiresPhysics": false,
    "playerAgency": "what the learner is free to break/explore beyond the guided path",
    "successCondition": "the observable state that means they've got it (drives Lab.check)"
  },
  "verificationQuestion": "a question answerable ONLY by having interacted with the lab"
}
concept_type guide: dynamic-physical = motion/forces over time; emergent = many agents, local rules; quantitative = formula/curve relationships; probabilistic = randomness converging; spatial-2D = geometric invariants; spatial-3D = ONLY if depth itself carries the insight; sequential = ordered process/algorithm; abstract = categories/definitions; network = stocks, flows, graphs; ml-concept = learning algorithms.
formulas: [] if the topic has no natural equation. requiresPhysics: true ONLY for collisions/gravity/constraints needing a physics engine.`;
  const res = await openaiCreate({
    model: THINK_MODEL_ID,
    max_tokens: 6000,
    temperature: 0.6,
    _fallbackChain: REASON_FALLBACK_CHAIN,
    messages: [{ role: "user", content: prompt }],
  }, "blueprint");
  const bp = parseLooseJSON(safeContent(res));
  if (!bp || !bp.mechanism || !bp.misconception) {
    throw new Error("Stage 1 blueprint missing mechanism/misconception — cannot build a lab from it");
  }
  return bp;
}

// Quiz — runs in PARALLEL with codegen, off the Stage 1 JSON (not the lesson),
// so it tests the mechanism the lab actually teaches.
async function generateQuizV2(blueprint, category) {
  const prompt = `Write a quiz for a lab that teaches this mechanism (category: ${category}):
MECHANISM: ${blueprint.mechanism}
MISCONCEPTION IT CONFRONTS: ${blueprint.misconception}
AHA MOMENT: ${blueprint.aha_moment || ""}
VARIABLES: ${JSON.stringify((blueprint.variables || []).map(v => v.name))}

Return ONLY valid JSON:
{ "questions": [ { "q": "question", "options": ["A","B","C","D"], "answer": 0, "explanation": "why correct" } ] }
Rules: exactly 5 questions. Q1 targets the misconception directly. At least 2 questions require having SEEN the sim behavior (not recall). 1 correct + 3 plausible distractors each. Plain English, no LaTeX.`;
  const res = await openaiCreate({
    model: LESSON_MODEL_ID,
    max_tokens: 2500,
    temperature: 0.4,
    _fallbackChain: REASON_FALLBACK_CHAIN,
    messages: [{ role: "user", content: prompt }],
  }, "quiz");
  return parseLooseJSON(safeContent(res));
}

// Build the GLM codegen prompt from blueprint + selected node. On retry,
// `failures` carries the validator's reasons so GLM fixes them specifically.
function codegenPrompt(blueprint, node, category, failures) {
  const libs = node.libs.length ? node.libs.join(", ") : "none — vanilla JS only";
  return `You are an elite creative coder building an interactive learning lab.

TOPIC: ${blueprint.topic}
SCENARIO: ${blueprint.scenario}
MECHANISM TO MAKE VISIBLE: ${blueprint.mechanism}
MISCONCEPTION TO BREAK: ${blueprint.misconception}
AHA MOMENT: ${blueprint.aha_moment}
CATEGORY AESTHETIC: ${categoryGuidance(category)}
VARIABLES: ${JSON.stringify(blueprint.variables || [])}
${node.hasFormulas ? `FORMULAS (register via Lab.formula.set, update live): ${JSON.stringify(blueprint.formulas)}` : "No formulas — do NOT call Lab.formula.*"}
INTERACTION CONTRACT (non-negotiable):
${JSON.stringify(blueprint.interaction_contract || {}, null, 2)}

LIBRARIES AVAILABLE (already loaded as script tags — use them directly, do NOT add CDN tags): ${libs}
VISUAL RULES FOR THIS LAB TYPE: ${node.visualRules}

${harness.HARNESS_API_DOC}

REQUIREMENTS:
1. Call Lab.predict.setup() FIRST with a predict question built from the misconception above.
2. Boot the sim inside Lab.onStart().
3. Register every on-screen color/entity with Lab.legend.add().
4. Wire Lab.playback.attach() if anything animates continuously.
5. Call Lab.check(true, detail) when the interaction contract's successCondition is reached.
6. Call Lab.reveal.show() at the end state, referencing the learner's prediction.
7. The aha moment must be a VISIBLE on-screen event, not text.
${failures && failures.length ? `\nYOUR PREVIOUS ATTEMPT FAILED VALIDATION. Fix ALL of these:\n${failures.map(f => `- ${f}`).join("\n")}\n` : ""}
Output the three fragments EXACTLY as specified (style, lab-stage div, script). No markdown fences, no explanation, no <html> wrapper.`;
}

// Codegen with validation + ONE regeneration. Returns { html, fragments, node }.
async function generateLabCode(blueprint, category, onProgress) {
  const node = harness.selectNode(blueprint);
  console.log(`[node-selector] concept_type=${node.conceptType} libs=[${node.libs.join(",")}]`);
  let failures = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = codegenPrompt(blueprint, node, category, failures);
    const raw = await withKimiLock(() => _runKimiStream(prompt, onProgress));
    const fragments = harness.extractFragments(raw);
    const verdict = harness.validateLab(fragments, node, raw);
    if (verdict.ok) {
      const html = harness.buildLabHTML({ title: blueprint.topic, blueprint, node, fragments });
      return { html, fragments, node, attempts: attempt + 1 };
    }
    failures = verdict.failures;
    console.warn(`[codegen] attempt ${attempt + 1} failed validation: ${failures.join(" | ")}`);
  }
  throw new Error(`Lab failed validation twice: ${failures.join(" | ")}`);
}

// ─────────────────────────────────────────────────────────────────
// SERVER
// /plan-lab uses SSE to stream progress stages to the frontend
// ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "GET" && url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "landing.html")));
    return;
  }

  if (req.method === "GET" && url === "/learn") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "learn.html")));
    return;
  }

  if (req.method === "GET" && url === "/achievements") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "achievements.html")));
    return;
  }

  if (req.method === "GET" && url === "/repend.css") {
    res.writeHead(200, { "Content-Type": "text/css" });
    res.end(fs.readFileSync(path.join(__dirname, "repend.css")));
    return;
  }

  if (req.method === "GET" && url === "/repend-game.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(fs.readFileSync(path.join(__dirname, "repend-game.js")));
    return;
  }

  // Brand assets (logo icon, wordmark, favicon)
  if (req.method === "GET" && /^\/[\w.-]+\.(png|svg|ico)$/.test(url)) {
    const name = path.basename(url);
    const file = path.join(__dirname, name);
    if (fs.existsSync(file)) {
      const ext = name.split(".").pop();
      const types = { png: "image/png", svg: "image/svg+xml", ico: "image/x-icon" };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "public, max-age=86400" });
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(404); res.end("Not found");
    }
    return;
  }

  if (req.method === "GET" && url === "/engine.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "engine.html")));
    return;
  }

  // Reject non-JSON POST bodies early — bots POST XML/plaintext to random paths
  // which causes JSON.parse to throw and return a noisy 500.
  if (req.method === "POST") {
    const ct = req.headers["content-type"] || "";
    if (!ct.includes("application/json")) {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Content-Type must be application/json" }));
      return;
    }
  }

  // POST /plan-course — generate a course outline (title + ordered modules)
  if (req.method === "POST" && req.url === "/plan-course") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { subject, category = "General", moduleCount = null, sourceMaterial = null, sourceFocus = null } = JSON.parse(body);
        if (!subject) { res.writeHead(400); res.end(JSON.stringify({ error: "subject required" })); return; }
        // New course contract: 3-10 modules (AI-picked or user-forced), each with
        // key_concepts/key_variables constraint lists. Backward-compatible — modules
        // still carry topic/why for the existing lab flow. When sourceMaterial is
        // present (uploaded PDF/notes), the whole course is derived from it.
        const src = typeof sourceMaterial === "string" ? sourceMaterial.slice(0, 12000) : null;
        const outline = await courses.generateOutline(subject, category, moduleCount, src, sourceFocus);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(outline));
      } catch (e) {
        console.error("plan-course error:", e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /generate-lesson — Phase 1b. Body: { module, courseTitle?, category? }
  // Returns { slides, markdown } — the lesson is the course's source of truth.
  if (req.method === "POST" && req.url === "/generate-lesson") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { module, courseTitle = "", category = "General", sourceMaterial = null, sourceFocus = null } = JSON.parse(body);
        if (!module || !module.title) { res.writeHead(400); res.end(JSON.stringify({ error: "module (with title) required" })); return; }
        const src = typeof sourceMaterial === "string" ? sourceMaterial.slice(0, 12000) : null;
        const lesson = await courses.generateLesson(module, courseTitle, category, src, sourceFocus);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(lesson));
      } catch (e) {
        console.error("generate-lesson error:", e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /generate-quiz — Phase 2. Body: { module, lessonMarkdown?, category? }
  // Quiz is constrained to the module's key_concepts (assess, don't introduce).
  if (req.method === "POST" && req.url === "/generate-quiz") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { module, lessonMarkdown = "", category = "General" } = JSON.parse(body);
        if (!module || !module.title) { res.writeHead(400); res.end(JSON.stringify({ error: "module (with title) required" })); return; }
        const quiz = await courses.generateQuiz(module, lessonMarkdown, category);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(quiz));
      } catch (e) {
        console.error("generate-quiz error:", e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /validate-course — quality gate. Body: { course }
  // Returns { ok, errors, warnings } enforcing the lesson-is-source-of-truth contract.
  if (req.method === "POST" && req.url === "/validate-course") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { course } = JSON.parse(body);
        if (!course) { res.writeHead(400); res.end(JSON.stringify({ error: "course required" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(courses.validateCourse(course)));
      } catch (e) {
        console.error("validate-course error:", e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /publish-course — save a course to Supabase published_courses
  if (req.method === "POST" && req.url === "/publish-course") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { title, tagline, category, modules } = JSON.parse(body);
        if (!title || !modules) { res.writeHead(400); res.end(JSON.stringify({ error: "title and modules required" })); return; }
        const db = getSupabase();
        if (!db) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: "mock-" + Date.now() })); return; }
        const { data, error } = await db.from("published_courses").insert([{ title, tagline, category, modules: JSON.stringify(modules), upvotes: 0 }]).select("id").single();
        if (error) throw error;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: data.id }));
      } catch (e) {
        console.error("publish-course error:", e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/public-courses — fetch published courses ordered by upvotes
  if (req.method === "GET" && req.url === "/api/public-courses") {
    try {
      const db = getSupabase();
      if (!db) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify([])); return; }
      const { data, error } = await db.from("published_courses").select("id,title,tagline,category,modules,upvotes").order("upvotes", { ascending: false }).limit(20);
      if (error) throw error;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data || []));
    } catch (e) {
      console.error("public-courses error:", e.message);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify([]));
    }
    return;
  }

  // POST /upvote-course/:id — increment upvotes
  if (req.method === "POST" && req.url.startsWith("/upvote-course/")) {
    const id = req.url.replace("/upvote-course/", "");
    try {
      const db = getSupabase();
      if (!db) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ upvotes: 0 })); return; }
      const { data: row, error: fetchErr } = await db.from("published_courses").select("upvotes").eq("id", id).single();
      if (fetchErr) throw fetchErr;
      const newCount = (row.upvotes || 0) + 1;
      const { error: updateErr } = await db.from("published_courses").update({ upvotes: newCount }).eq("id", id);
      if (updateErr) throw updateErr;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ upvotes: newCount }));
    } catch (e) {
      console.error("upvote-course error:", e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/gen-lesson-quiz — generate lesson+quiz for a course module (fast mini model)
  if (req.method === "POST" && url === "/api/gen-lesson-quiz") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { topic, subject, category } = JSON.parse(body || "{}");
        if (!topic) { res.writeHead(400); res.end('{"error":"missing topic"}'); return; }
        const prompt = `You are a curriculum writer. Write a short lesson + quiz for the module "${topic}" in a course about "${subject || topic}" (category: ${category || "General"}).

Return ONLY valid JSON (no markdown):
{
  "lesson": {
    "summary": "1-2 sentence hook that excites the learner",
    "slides": [
      { "title": "slide title", "bullets": ["bullet 1", "bullet 2", "bullet 3"] }
    ]
  },
  "quiz": {
    "questions": [
      { "q": "question", "options": ["A","B","C","D"], "answer": 0, "explanation": "why correct" }
    ]
  }
}
Rules: lesson has exactly 3 slides (3-4 bullets each, ≤15 words per bullet). Quiz has exactly 4 questions (1 correct, 3 plausible distractors). Be concrete, not vague. Write ALL text in plain English — no LaTeX, no backslashes, no code escapes (write "x squared", not "\\(x^2\\)").`;

        const resp = await reason.chat.completions.create({
          model: REASON_MINI_MODEL,
          max_tokens: 1400,
          temperature: 0.4,
          messages: [{ role: "user", content: prompt }],
        });
        const raw = safeContent(resp);
        // Use the tolerant parser: strips fences/preamble AND repairs invalid
        // backslash escapes (\frac, regex, Windows paths) that a raw JSON.parse
        // chokes on with "Bad escaped character in JSON". Cybersecurity/math
        // modules hit this constantly.
        const result = parseLooseJSON(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.warn("[gen-lesson-quiz] error:", e.message);
        res.writeHead(500); res.end('{"error":"generation failed"}');
      }
    });
    return;
  }

  // GET /api/recommended-labs — top-rated cached labs (free to replay, no AI cost)
  if (req.method === "GET" && url === "/api/recommended-labs") {
    try {
      const labs = await getRecommendedLabs(12);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(labs));
    } catch (e) {
      console.error("recommended-labs error:", e.message);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify([]));
    }
    return;
  }

  // POST /rate-lab — { topic_key, stars (1-5) }; records rating so good labs get recommended
  if (req.method === "POST" && req.url === "/rate-lab") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { topic_key, stars } = JSON.parse(body);
        const s = Math.max(1, Math.min(5, parseInt(stars, 10) || 0));
        if (!topic_key || !s) { res.writeHead(400); res.end(JSON.stringify({ error: "topic_key and stars (1-5) required" })); return; }
        const result = await rateLab(topicKey(topic_key), s);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result || { average: 0, count: 0 }));
      } catch (e) {
        console.error("rate-lab error:", e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /share — save lab HTML snapshot, return share ID
  if (req.method === "POST" && req.url === "/share") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { topic, labHtml } = JSON.parse(body);
        if (!labHtml) { res.writeHead(400); res.end(JSON.stringify({ error: "labHtml required" })); return; }
        const id = await createShare(topic || "Lab", labHtml);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /s/:id — serve a shared lab HTML directly
  if (req.method === "GET" && /^\/s\/[\w-]+$/.test(url)) {
    const id = url.split("/s/")[1];
    const html = await getShare(id);
    if (!html) { res.writeHead(404); res.end("Lab not found or expired."); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // POST /api/progress — record lab completion for authenticated user
  if (req.method === "POST" && req.url === "/api/progress") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { topic_key, topic, completed, score, user_token } = JSON.parse(body);
        if (!topic_key || !user_token) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "topic_key and user_token are required" }));
          return;
        }
        // Verify the user token and get user_id
        const sb = getSupabase();
        if (!sb) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Progress tracking is not configured" }));
          return;
        }
        const { data: { user }, error } = await sb.auth.getUser(user_token);
        if (error || !user) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid token" }));
          return;
        }
        await saveProgress(user.id, topic_key, topic, { completed, score });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET /api/progress?token=... — fetch all progress for authenticated user
  if (req.method === "GET" && req.url.startsWith("/api/progress")) {
    try {
      const token = new URL(req.url, "http://x").searchParams.get("token");
      if (!token) { res.writeHead(401); res.end(JSON.stringify({ error: "token required" })); return; }
      const sb = getSupabase();
      if (!sb) { res.writeHead(503); res.end(JSON.stringify({ error: "Progress tracking is not configured" })); return; }
      const { data: { user }, error } = await sb.auth.getUser(token);
      if (error || !user) { res.writeHead(401); res.end(JSON.stringify({ error: "Invalid token" })); return; }
      const { data: rows } = await sb
        .from("lab_progress")
        .select("topic_key, topic, completed, score, attempts, last_attempt_at")
        .eq("user_id", user.id)
        .order("last_attempt_at", { ascending: false });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rows || []));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);

        if (req.url === "/plan-lab") {
          if (!data.topic?.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Topic is required" }));
            return;
          }

          // Stream progress via SSE.
          // IMPORTANT: do NOT set Connection or Transfer-Encoding here — they are
          // hop-by-hop headers forbidden in HTTP/2. Railway terminates HTTP/2 at its
          // edge, and a manual Transfer-Encoding conflicts with Node's automatic
          // chunked encoding for streamed responses → the edge rejects the upstream
          // framing and returns 502 Bad Gateway. Let Node handle chunking itself.
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",   // tells Railway/Nginx not to buffer SSE
          });
          // Flush headers immediately so the browser opens the stream.
          if (typeof res.flushHeaders === "function") res.flushHeaders();

          // ── STAGE TIMING (measure before optimizing) ─────────────────────
          // Each send() marks a stage boundary; we record how long the PREVIOUS
          // stage ran. The full breakdown is logged once per generation and
          // attached to the final "done" payload (additive field — existing
          // consumers ignore it). This is the ground truth for where the
          // pipeline actually spends time — retries and validation included.
          const stageTimings = {};
          let _curStage = null, _curStageStart = Date.now(), _pipelineStart = Date.now();
          const markStage = (stage) => {
            if (_curStage && stage !== _curStage) {
              stageTimings[_curStage] = (stageTimings[_curStage] || 0) + (Date.now() - _curStageStart);
              _curStageStart = Date.now();
            }
            if (stage !== _curStage) _curStage = stage;
          };
          const send = (stage, msg, data) => {
            markStage(stage);
            if (stage === "done" || stage === "error") {
              stageTimings.total = Date.now() - _pipelineStart;
              console.log(`[timing] ${JSON.stringify(stageTimings)}`);
              data = { ...(data || {}), timings: stageTimings };
            }
            res.write(`data: ${JSON.stringify({ stage, msg, data })}\n\n`);
            if (typeof res.flush === "function") res.flush();
          };

          // Heartbeat: keeps Railway's HTTP/2 proxy from closing idle SSE connections.
          // Railway drops streams after ~10s of silence, so we ping every 5s.
          // Exempt this SSE response from the default server socket timeout
          res.socket?.setTimeout(0);
          req.socket?.setTimeout(0);

          const heartbeat = setInterval(() => {
            try {
              res.write(`: ping\n\n`);
              if (typeof res.flush === "function") res.flush();
            } catch (_) { clearInterval(heartbeat); }
          }, 5000);
          res.on("close", () => clearInterval(heartbeat));

          const rawTopic = data.topic.trim();
          const category = data.category?.trim() || "General";
          const levelBackground = data.levelBackground || null;
          const levelGoal = data.levelGoal || null;
          const sourceMaterial = typeof data.sourceMaterial === "string" ? data.sourceMaterial.slice(0, 8000) : null;
          const sourceFocus = data.sourceFocus || null;
          const skipSimilar = !!data.skipSimilar; // set true by frontend when user chose "Generate fresh"
          // Course context: when present, this is the SINGLE capstone lab for a whole
          // course and must weave in EVERY module topic. We skip topic-sharpening
          // (don't narrow a course to one concept) and skip cache/similar reuse.
          const courseContext = (data.courseContext && Array.isArray(data.courseContext.modules) && data.courseContext.modules.length)
            ? data.courseContext : null;

          // 2-stage pipeline: no separate topic-expansion call — Stage 1 sharpens
          // the display title itself. Cache is keyed on the raw input topic.
          const topic = rawTopic;
          const key = topicKey(topic);
          send("lesson", `Building lab for: ${topic}`, { topic, category });

          // ── Cache hit: serve instantly (bypass for personalised/source-based/course labs) ──
          if (!levelBackground && !levelGoal && !sourceMaterial && !courseContext) {
            const cached = await getCachedLab(key);
            if (cached) {
              clearInterval(heartbeat);
              send("done", "Lab ready.", { ...cached, topicKey: cached.topicKey || key, source: "cached", category });
              res.end();
              Promise.resolve(bumpLabPlays(key)).catch(() => {}); // fire-and-forget
              return;
            }
          }

          // ── Fuzzy similar-lab check: surface a rated-good lab if topic is close ──
          // Only when no personalisation flags and user hasn't already dismissed the prompt
          if (!skipSimilar && !levelBackground && !levelGoal && !sourceMaterial && !courseContext) {
            const similar = await findSimilarLab(topic);
            if (similar) {
              // Send a non-terminal event — frontend shows "Use this or Generate fresh?"
              // The pipeline pauses here; frontend either accepts (sends /plan-lab again with
              // useSimilar:true skipping this block) or ignores (we continue below).
              send("similar_found", `Found a similar highly-rated lab`, {
                similarTopic: similar.topic,
                similarTopicKey: similar.topicKey,
                rating: similar.rating,
                ratingCount: similar.ratingCount,
                labData: similar.labData,
                category,
              });
              clearInterval(heartbeat);
              res.end();
              return;
            }
          }

          // ── Cache miss: run the 2-stage pipeline then save ──
          // LESSON fires immediately (flash, ~10s) and is pushed the moment it
          // resolves so the learner reads while everything else builds. Grounding
          // (Wikipedia/Wikidata/Tavily, ~1-3s network) runs in the same window and
          // feeds the Stage 1 blueprint.
          send("lesson", "Writing your lesson…");
          let lessonResult = null;
          const lessonPromise = generateLessonV2(topic, category, courseContext)
            .then(r => {
              lessonResult = r;
              if (r) send("lesson", "Lesson ready.", { lesson: r });
            })
            .catch(e => console.warn("[lesson] failed, lab continues without it:", e.message));

          let groundingText = null;
          await groundTopic(topic, category)
            .then(g => { if (g) groundingText = g.text; })
            .catch(e => console.warn("[grounding] failed, continuing ungrounded:", e.message));

          // ── STAGE 1: the one heavy reasoning call ──
          send("reasoning", `Reasoning about "${topic}"…`);
          const blueprint = await stageOneBlueprint(topic, category, groundingText, courseContext,
            levelBackground, levelGoal, sourceMaterial, sourceFocus);

          // ── STAGE 2: GLM codegen ∥ quiz (both off the Stage 1 JSON) ──
          send("building", "Building your lab…");
          let quizResult = null;
          const quizPromise = generateQuizV2(blueprint, category)
            .then(r => {
              quizResult = r;
              if (r) send("quiz", "Quiz ready.", { quiz: r });
            })
            .catch(e => console.warn("[quiz] failed, lab continues without it:", e.message));

          const { html, node, attempts } = await generateLabCode(blueprint, category,
            (chars) => send("building", `Building your lab… (${Math.round(chars / 1000)}k chars)`));
          console.log(`[codegen] validated on attempt ${attempts} (concept_type=${node.conceptType})`);

          await Promise.all([lessonPromise, quizPromise]);

          const labData = {
            topicKey: key,
            topic: blueprint.topic || topic,
            scenario: blueprint.scenario,
            verificationQuestion: blueprint.verificationQuestion,
            learningGoal: blueprint.mechanism,
            realWorldPayoff: blueprint.payoff,
            blueprint,
            labHtml: html,
            lesson: lessonResult || undefined,
            quiz: quizResult || undefined,
          };

          clearInterval(heartbeat);
          send("done", "Lab ready.", { ...labData, source: "generated" });
          res.end();

          // Fire-and-forget save — don't block the response.
          // Skip caching personalised/source-based/course labs (they're learner- or course-specific).
          if (!levelBackground && !levelGoal && !sourceMaterial && !courseContext) {
            Promise.resolve(saveLab(key, labData.topic, labData)).catch(() => {});
          }

        } else if (req.url === "/plan") {
          if (!data.topic?.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Topic is required" }));
            return;
          }
          const result = await plan(data.topic.trim());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));

        } else if (req.url === "/simulate") {
          const { recipe } = data;
          if (!recipe) throw new Error("Missing recipe");
          const html = injectRecipe(recipe);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);

        } else if (req.url === "/verify") {
          const { topic, question, recipeSummary, userAnswer, labResult } = data;
          const result = await verify(topic, question, recipeSummary, userAnswer, labResult);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));

        } else if (req.url === "/analyze-image") {
          const { image, question } = data;
          const result = await analyzeImage(image, question);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ description: result }));

        } else {
          res.writeHead(404); res.end("Not found");
        }
      } catch (err) {
        console.error(err);
        // Turn cryptic provider 503s into a clear, actionable message.
        const friendly = isQuotaError(err)
          ? "An AI provider API quota or billing limit was reached. Check the OpenAI account billing — the key is valid but out of quota."
          : isOverloadError(err)
          ? "Our lab-building models are overloaded right now (high demand). This is temporary — please try again in a minute."
          : (err.message || "Something went wrong");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: friendly }));
        } else {
          // SSE already started — send error event then close
          res.write(`data: ${JSON.stringify({ stage: "error", msg: friendly })}\n\n`);
          res.end();
        }
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// Process-level safety net: a stray async error (e.g. a fire-and-forget save
// rejecting) must NOT crash the whole server and 502 every in-flight request.
// Log it and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && (reason.stack || reason.message || reason));
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && (err.stack || err.message || err));
});

const PORT = process.env.PORT || 3000;
server.timeout = 900_000;       // 15 min — Kimi codegen + optional visual critic
server.keepAliveTimeout = 905_000;

// Crash visibility — when a lab dies with NOTHING logged, we can't tell a silent
// hang from a process kill. These handlers log the cause before the process exits
// so the next failure leaves a fingerprint instead of pure silence. We log and
// keep running on unhandledRejection (a single bad lab shouldn't take down the
// server); uncaughtException is logged then re-thrown to let the platform restart.
process.on("unhandledRejection", (reason) => {
  console.error("[process] UNHANDLED REJECTION:", reason && (reason.stack || reason.message || reason));
});
process.on("uncaughtException", (err) => {
  console.error("[process] UNCAUGHT EXCEPTION:", err && (err.stack || err.message || err));
});
process.on("SIGTERM", () => { console.error("[process] received SIGTERM (platform stop/redeploy/OOM)"); process.exit(0); });
process.on("warning", (w) => { if (w && w.name === "MaxListenersExceededWarning") console.warn("[process] warning:", w.message); });

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => console.log(`Repend running at http://0.0.0.0:${PORT}`));
}

// Export the http.Server itself so serverless platforms (Vercel) that import
// this module get a valid entrypoint — they require the default export to be a
// request handler or a server instance, not a plain object. The
// `require.main === module` guard above means importing never calls .listen(),
// so Railway/Render (which run `node server.js` directly) are unaffected.
//
// Pipeline helpers stay reachable via destructuring — `const { topicKey } =
// require("./server.js")` still works — by hanging them off the server object.
Object.assign(server, {
  generateLessonV2,
  stageOneBlueprint,
  generateQuizV2,
  generateLabCode,
  topicKey,
});

module.exports = server;
