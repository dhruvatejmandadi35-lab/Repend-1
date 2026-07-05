const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { groundTopic } = require("./grounding");
const courses = require("./courses");

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

// Output token cap for codegen. The NVIDIA Build FREE endpoint rejects requests
// above ~16384 and returns an EMPTY stream (0 chars in content AND
// reasoning_content) with no error — which silently drops every lab to the
// weaker llama fallback. 16384 is the safe ceiling; override via env only on a
// paid NIM endpoint that genuinely supports more.
const CODEGEN_MAX_TOKENS = parseInt(process.env.CODEGEN_MAX_TOKENS || "16384", 10);

// Codegen stream guards. CODEGEN_TIMEOUT_MS = hard wall-clock ceiling for ONE
// Kimi call; CODEGEN_IDLE_MS = max gap between streamed chunks before we treat
// the stream as stalled. Both abort into a retryable fallback so a hung thinking
// model never leaves the request silently dangling (the Iter 6/7 failure mode).
const CODEGEN_TIMEOUT_MS = parseInt(process.env.CODEGEN_TIMEOUT_MS || "300000", 10); // 5 min (GLM is slower than Kimi)
const CODEGEN_IDLE_MS = parseInt(process.env.CODEGEN_IDLE_MS || "45000", 10);        // 45 s

// GLM-5.1 is a hybrid reasoning model: by default it emits a long internal
// chain-of-thought (reasoning_content) BEFORE writing any HTML. But by codegen
// time we've already done all the design reasoning upstream (thinkAboutTopic →
// specFromThinking → thinkAboutLab → thinkAboutVisualPedagogy), so the model
// re-thinking from scratch is pure wasted wall-clock — often 40-60% of the call.
// Turning thinking OFF makes GLM go straight to writing the file.
//   CODEGEN_THINKING=off  (default) → disable GLM's chain-of-thought
//   CODEGEN_THINKING=on             → keep it (revert if quality drops)
// The control key for the Zhipu GLM family on NVIDIA NIM is
// chat_template_kwargs.thinking; the OpenAI SDK forwards it verbatim in the body.
const CODEGEN_THINKING = (process.env.CODEGEN_THINKING || "off").toLowerCase() === "on";

// ── INTERACTION DIRECTOR ──────────────────────────────────────────────────────
// A parallel extended-thinking call that picks the INTERACTION LANGUAGE for each
// lab — the way a game designer picks 3D for a Madden-style football game but 2D
// canvas for a platform fighter. It runs alongside thinkAboutLab/visualPedagogy
// (zero added wall-clock) and outputs a concrete "interaction contract" injected
// into codegen, so labs stop defaulting to slider-only interactivity.
// Default model: gpt-oss-20b on NVIDIA Build (a reasoning model — same family the
// course generator already uses; reasoning_effort=high gives the extended think).
//   ENABLE_INTERACTION_DIRECTOR=off  → skip entirely (pipeline identical to before)
//   INTERACTION_MODEL_ID=<id>        → any NVIDIA Build / OpenAI-compatible model
const ENABLE_INTERACTION_DIRECTOR = (process.env.ENABLE_INTERACTION_DIRECTOR || "on").toLowerCase() !== "off";
// DeepSeek V4 Flash on NVIDIA Build: a native thinking model (reasons by default,
// no reasoning_effort param needed; openaiCreateStreamed already collects its
// reasoning_content). NOTE: deepseek-r1 was DELISTED from NVIDIA Build (404
// "page not found") — verify any override against GET /v1/models first.
// If the primary is unreachable, thinkAboutInteraction retries once with
// REASON_MODEL (llama-70b) — a non-thinking contract beats no contract.
const INTERACTION_MODEL_ID = process.env.INTERACTION_MODEL_ID || "deepseek-ai/deepseek-v4-flash";

// labthink ("Thinking about how to build it") runs in the SAME parallel window as
// the interaction director. Both used to lean on llama-3.3-70b, and concurrent
// heavy calls to the ONE flaky model are exactly where the free tier burns out.
// Route labthink to a DIFFERENT DeepSeek model (v4-pro) so the two parallel heavy
// stages hit separate endpoints and neither depends on the stalling 70b. Falls
// back down the gpt-oss chain (never back to 70b). Override with THINK_MODEL_ID.
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
const REASON_MODEL = process.env.REASON_MODEL || (useNvidiaReasoning ? "meta/llama-3.3-70b-instruct" : OPENAI_MODEL);
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
  : (useNvidiaReasoning ? ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] : [OPENAI_MINI_MODEL]);
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
console.log(`[boot] visual critic: ${process.env.ENABLE_VISUAL_CRITIC === "1" ? "ON (puppeteer headless Chrome — OOM risk on small containers)" : "OFF (static guardrail only)"}`);

// Optional mockup-image model — runs on NVIDIA Build (free) via the OpenAI-
// compatible images endpoint, reusing the `nvidia` client. The mockup step is
// gated behind USE_MOCKUP=1; it is OFF by default because the text brief drives
// codegen. Swap models from env: black-forest-labs/flux.1-schnell (fast, default),
// black-forest-labs/flux.1-dev (more detail), or qwen/qwen-image (legible labels).
const IMAGE_MODEL_ID = process.env.IMAGE_MODEL_ID || "black-forest-labs/flux.1-dev";

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

// Extract an HTML document from a raw model response.
// Models sometimes wrap the output in markdown fences or add a preamble sentence.
// We find the first occurrence of <!doctype or <html (case-insensitive) and return
// everything from there, stripping any trailing markdown fence.
function extractHtml(raw) {
  const s = String(raw || "");
  const idx = s.search(/<!doctype\s+html|<html[\s>]/i);
  if (idx === -1) return null;
  let html = s.slice(idx).trim();
  // Strip trailing ``` fence if present
  html = html.replace(/```\s*$/, "").trim();
  return html.length > 200 ? html : null;
}

// Static, dependency-free liveness check on a generated lab. Encodes the
// "a lab must be live, manipulable, and winnable" contract as cheap structural
// assertions so blank / dead / truncated labs are caught BEFORE they ship — no
// headless browser, so it runs ALWAYS (even when the visual critic is disabled).
// It only ever triggers a regeneration; it never hard-rejects a lab, so a quirky
// but valid lab can't be turned into an error by a regex miss.
function validateLabHtml(html, interactionContract = null) {
  const s = String(html || "");
  const issues = [];
  if (!/<\/html\s*>/i.test(s))
    issues.push("HTML is truncated (no closing </html>) — it likely hit the output token cap; output the COMPLETE file.");
  else if (!/<\/script\s*>/i.test(s))
    issues.push("The script is cut off (no closing </script>) — finish the JavaScript and close every tag.");
  if (!/THREE\s*\.\s*(WebGLRenderer|Scene)/.test(s))
    issues.push("No Three.js renderer/scene is created — build a THREE.WebGLRenderer and THREE.Scene so the 3D world actually renders.");
  if (!/requestAnimationFrame/.test(s))
    issues.push("No requestAnimationFrame loop — add an animation loop so the scene is live and changes are visible, not a frozen frame.");
  const hasListener = /addEventListener\s*\(\s*['"`](pointer|mouse|click|input|change|key|touch|wheel|drag)/i.test(s);
  const hasControl = /<input\b/i.test(s) || /<button\b/i.test(s);
  if (!hasListener && !hasControl)
    issues.push("No interaction wiring — add pointer/key/drag listeners (or input/button controls) so the learner can manipulate the scene.");
  if (!/labCheck/.test(s) || !/postMessage/.test(s))
    issues.push("No labCheck win signal — call window.parent.postMessage({type:'labCheck', result:{ok:true,score,total}}, '*') when the learner succeeds, so the lab is winnable.");
  // Interaction-contract check (only when a director contract demanded direct
  // manipulation — never fires on the legacy path, so no new regen risk there).
  // A lab whose only wiring is <input> 'input'/'change' listeners is slider-only:
  // require at least one direct-manipulation listener (pointer/mouse/touch/key/
  // drag/wheel) so the primary interaction from the contract can actually exist.
  if (interactionContract && interactionContract.primary_interaction) {
    const hasDirect = /addEventListener\s*\(\s*['"`](pointerdown|pointermove|mousedown|mousemove|touchstart|keydown|keyup|drag|wheel)/i.test(s);
    if (!hasDirect)
      issues.push(`Slider-only lab — the interaction contract requires "${interactionContract.primary_interaction.style}" as the PRIMARY interaction (${interactionContract.primary_interaction.binding || ""}). Wire pointer/key listeners on the play area so the learner directly manipulates the scene; sliders may only be secondary.`);
  }
  return { ok: issues.length === 0, issues };
}

// Turn liveness failures into a corrective note fed back into the SAME codegen
// call (reuses codeFromImageBrief's existing critiqueNotes input — no new model,
// no new flow, no extra dependency).
function labCheckNotes(issues) {
  return "AUTOMATED QA FOUND BLOCKERS IN YOUR PREVIOUS OUTPUT. Regenerate the COMPLETE corrected HTML file and fix ALL of these:\n"
    + issues.map(i => `- ${i}`).join("\n")
    + "\nThe file MUST end with </script></body></html>.";
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

async function getCachedLab(key) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  try {
    const sb = getSupabase();
    if (!sb) return null;
    const { data, error } = await sb
      .from('labs')
      .select('lab_data')
      .eq('topic_key', key)
      .limit(1)
      .single();
    if (error) return null;
    return data ? data.lab_data : null;
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
const REPEND_THEME = {
  void: "#050508",
  bg: "#0c0c14",
  fog: "#1a0800",
  mars: "#E85D04",
  mars2: "#C44A00",
  dust: "#8B4513",
  copper: "#D4A574",
  ice: "#4CC9F0",
  muted: "#8899BB",
  green: "#22C55E",
  glass: "rgba(10,15,30,0.75)",
  border: "rgba(232,93,4,0.25)",
};

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

// Preferred archetypes per course category — AI should pick from these first
const CATEGORY_ARCHETYPE_HINTS = {
  "Physics": "physics-sim, wave-interference, threshold",
  "Biology": "molecular-builder, agent-social-sim, process-flow, threshold",
  "Sports & Skills": "sports-game (always preferred for this category)",
  "Money & Econ": "accumulation, tradeoff, budget-allocation, agent-social-sim",
  "Math & Data": "data-sampling, accumulation, tradeoff",
  "Everyday Science": "physics-sim, experiment-bench, wave-interference",
  "Language & Humanities": "structure-puzzle, process-flow, branching-decision, threshold",
  "General": "structure-puzzle, process-flow, branching-decision, threshold, physics-sim",
};

const LAB_ARCHETYPES = [
  "physics-sim", "threshold", "accumulation", "process-flow", "tradeoff",
  "structure-puzzle", "branching-decision", "bias-trap", "budget-allocation", "agent-social-sim",
  "sports-game", "wave-interference", "molecular-builder", "data-sampling", "experiment-bench",
];

function categoryArchetypeHints(category) {
  return CATEGORY_ARCHETYPE_HINTS[category] || CATEGORY_ARCHETYPE_HINTS.General;
}

// ─────────────────────────────────────────────────────────────────
// FREEFORM LAB PIPELINE — six steps (image step is optional):
//   0. expandTopic        — gpt-4o-mini: sharpens vague input to one specific concept
//   1. thinkAboutTopic    — gpt-4o-mini prose: insight, metaphor, variables + why
//   2. specFromThinking   — gpt-4o JSON: typed spec
//   3. thinkAboutLab      — gpt-4o prose brief: behavior + visuals, no UI words
//   4. mockupImage        — GPT writes a purpose-aware prompt → FLUX.1-schnell on NVIDIA (OPTIONAL, USE_MOCKUP=1)
//   5. codeFromImageBrief — gpt-4o vision: image + brief → final HTML
// ─────────────────────────────────────────────────────────────────

// Step 0 — turns vague topics into one specific, teachable concept.
// "ML" → "Gradient Descent: how a model finds the bottom of a loss landscape"
// "Physics" → "Newton's Second Law: why heavier objects need more force to accelerate"
// "Compound Interest" → passes through unchanged (already specific enough)
async function expandTopic(rawTopic, category = "General", sourceMaterial = null, sourceFocus = null) {
  const sourceCtx = sourceMaterial ? `

THE LEARNER UPLOADED THEIR OWN MATERIAL. Derive the sharpened concept FROM this material${sourceFocus ? ` (they want to focus on: "${sourceFocus}")` : ""}. Pick the single most important teachable concept in it that has a surprising, drawable insight. The topic name should reflect what their material is actually about.

THEIR MATERIAL (excerpt):
"""
${sourceMaterial.slice(0, 4000)}
"""` : "";

  const res = await reason.chat.completions.create({
    model: REASON_MINI_MODEL,
    ...reasonParams(REASON_MINI_MODEL, 200),
    ...jsonFormat(),
    messages: [
      {
        role: "system",
        content: `You sharpen vague learning topics into one specific, teachable concept.
Course category: ${category}. ${categoryGuidance(category)}${sourceCtx}

Return ONLY JSON:
{
  "topic": "The sharpened topic. 3-10 words. Must be a CONCEPT with a surprising insight, not a skill or activity. Examples: 'Free-throw shooting arc: how release angle and power control make probability', 'Gradient Descent: why loss curves have valleys a model can slide down', 'Newton\\'s Second Law: why doubling mass halves acceleration for the same force'.",
  "why": "One sentence: the specific aha moment this concept produces. E.g. 'The moment you see the ball curve MORE than expected is when you understand that spin changes the effective gravity on the ball.'"
}

RULES:
- If the input names a SPORT or SKILL (basketball, tennis, golf, soccer, swimming): sharpen to the SPECIFIC SKILL MECHANIC the 3D lab will simulate — keep the real sport environment. 'Basketball' → 'Free-throw shooting arc: how release angle, power, and distance determine make probability'. 'Tennis' → 'Topspin serve: how racket angle and swing speed bend the ball's flight'. NEVER replace a sport with abstract physics-only framing — the lab must feel like that sport.
- If the input names a non-sport ACTIVITY (cooking, driving, music): find the underlying mechanism but keep the real-world setting (kitchen, road, instrument).
- If the input names a MUSICAL INSTRUMENT or MUSIC concept (violin, guitar, piano, sound, music): pick the underlying wave/physics concept that is visually drawable. 'Violin' → 'Standing Waves: why pressing a string at different points produces different pitches'. 'Sound' → 'Wave Interference: why two sound waves can cancel each other out'. Always pick something with a visible waveform or physical motion.
- If the input is a broad FIELD (ML, physics, biology, history): pick the sub-concept with the clearest aha moment.
- If the input is already a specific CONCEPT (compound interest, Ohm's law, mitosis): return it nearly unchanged.
- NEVER pick abstract/unmeasurable concepts like 'resonance', 'harmony', 'feel', 'balance', 'energy flow' — these cannot be drawn. Always pick something with a concrete visual output (a wave, a trajectory, a curve, a collision, a graph with a kink).
- NEVER pick a concept where all the learner does is set inputs with no surprising output.
- Never return a skill, definition, or procedure. Return the INSIGHT.`,
      },
      { role: "user", content: rawTopic },
    ],
  });
  return parseLooseJSON(safeContent(res));
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

async function thinkAboutTopic(topic, category = "General", levelBackground = null, levelGoal = null, sourceMaterial = null, sourceFocus = null, grounding = null, courseContext = null) {
  const levelCtx = levelBackground ? `
LEARNER CONTEXT:
- Background: ${levelBackground === "beginner" ? "Complete beginner — never touched this topic" : levelBackground === "some" ? "Some familiarity — has heard of it but doesn't deeply get it" : "Pretty solid — wants to go deeper or apply it"}
- Goal: ${levelGoal === "understand" ? "Get the 'aha' moment — conceptual clarity" : levelGoal === "apply" ? "Apply it in the real world — practical use" : "Master it deeply — be able to explain it to anyone"}
Tune the lab complexity and scenario accordingly. Beginners need simpler controls and more scaffolding. Advanced learners need edge cases and real-world stakes.` : "";

  const sourceCtx = sourceMaterial ? `
THE LEARNER UPLOADED THEIR OWN MATERIAL${sourceFocus ? ` and wants to focus on "${sourceFocus}"` : ""}. Ground your analysis, scenario, and the lab's specifics in THIS material — use its examples, terminology, and framing so the lab feels built from their content.
THEIR MATERIAL (excerpt):
"""
${sourceMaterial.slice(0, 6000)}
"""
` : "";

  const groundCtx = grounding ? `
━━━ VERIFIED FACTS (ground your analysis in these — do NOT contradict them, do NOT invent numbers that conflict) ━━━
${grounding}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : "";

  const courseCtx = courseContextBlock(courseContext);

  return openaiText(`You are an expert at designing immersive 3D interactive learning experiences for ANY topic — STEM, sports, history, economics, psychology, arts.

COURSE CATEGORY: ${category}
CATEGORY AESTHETIC: ${categoryGuidance(category)}
${levelCtx}${sourceCtx}${groundCtx}${courseCtx}
Write a short analysis of "${topic}" covering exactly these six things:

STEP 0 — INTERACTION CLASSIFIER: Classify this topic and pick the interaction type.
Preferred archetypes for ${category}: ${categoryArchetypeHints(category)}

  • If the concept has motion/forces → physics-sim (planets, fluids, projectiles)
  • If behavior jumps suddenly at a boundary → threshold (phase transitions, action potentials, tipping points)
  • If things compound/accumulate over time → accumulation (interest, climate, debt, skill)
  • If something flows through stages → process-flow (supply chains, photosynthesis, legislation)
  • If two forces optimize against each other → tradeoff (supply/demand, risk/return)
  • If it's a static structure to assemble → structure-puzzle (circuits, timelines, food webs)
  • If the learner makes sequential choices with branching consequences → branching-decision (history counterfactuals, ethics dilemmas, medical diagnosis, strategy)
  • If the learner must EXPERIENCE a bias or social phenomenon firsthand → bias-trap (anchoring, sunk cost, groupthink, prisoner's dilemma)
  • If learner allocates a fixed resource across competing priorities → budget-allocation (government budgets, personal finance, nutrition, time management)
  • If emergent social/collective behavior appears from simple individual rules → agent-social-sim (segregation, epidemic spread, market prices, opinion dynamics)
  • If it's a SPORT or physical skill with aim/release/steer mechanics → sports-game (basketball arc, golf swing, soccer curve, tennis topspin — full video-game sports sim)
  • If waves, sound, light, or interference/superposition are central → wave-interference (standing waves, Doppler, noise cancellation, string instruments)
  • If atoms, molecules, bonds, or molecular structure are central → molecular-builder (DNA base pairing, enzyme active sites, chemical bonding, protein folding simplified)
  • If probability, sampling, statistics, or distributions are central → data-sampling (CLT, Bayes, birthday paradox, regression — run many trials, histogram builds live)
  • If mixing reagents, temperature, or lab-bench chemistry → experiment-bench (titration, pH, reaction rates, microwaves heating food, catalyst effects)
For SPORTS/SKILLS category: use sports-game, NOT physics-sim.
State: "INTERACTION TYPE: [chosen type] because [one sentence reason]."

1. THE CORE INSIGHT — what single thing, once experienced interactively, makes this concept truly click? Not a definition — the moment of understanding.
2. THE 3D VISUAL/INTERACTIVE METAPHOR — what immersive Three.js world does this concept live in? Be vivid and TOPIC-SPECIFIC. Basketball = night court under stadium lights, ball leaving hands toward rim. Mars geology = crater rim with rover. Be specific to ${topic} — never a generic grid. NEVER use a generic "space" or "planet" background unless the topic is astronomy. The metaphor must be NEAT and ANIMATED: things should bob, rotate, or pulse gently when idle.
3. THE KEY VARIABLES or CHOICES — what 2-4 things can a learner change or decide? For each, explain WHY it matters to the insight.
4. THE AHA MOMENT — the precise moment when the learner says "oh!". What did they just see or experience?
5. THE REAL-WORLD COST — one concrete situation where not understanding this costs something real (money, health, justice, a relationship, a historical outcome).

Write in plain direct prose. Be specific to ${topic}.`, 1000, REASON_MINI_MODEL);
}

async function specFromThinking(topic, thinking, category = "General", grounding = null, courseContext = null) {
  const raw = await openaiCreateStreamed({
    model: REASON_MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "system",
        content: `You convert educational reasoning into an interactive lab spec. Read the reasoning and produce JSON.
Course category: ${category}. ${categoryGuidance(category)}
Preferred archetypes for this category: ${categoryArchetypeHints(category)}

Return ONLY JSON with this exact shape:
{
  "topic": "Display name for the topic",
  "scenario": "2-3 paragraph immersive 2nd-person scenario. Open with a CONCRETE real-world moment: a real role, place, dollar amount, failure mode. End by telling the learner exactly what they are about to manipulate and why it matters right now.",
  "verificationQuestion": "One specific question the learner can only answer correctly AFTER interacting with the lab.",
  "spec": {
    "title": "Short punchy lab title",
    "course_category": "${category}",
    "lab_archetype": "Exactly one of: ${LAB_ARCHETYPES.join(" | ")}. Choose the ONE whose interaction mechanic best exposes the core insight:\n  physics-sim = continuous motion/forces (orbital mechanics, waves, projectile, fluid dynamics)\n  threshold = behavior jumps suddenly at a boundary (states of matter, action potential, tipping points, viral spread)\n  accumulation = things compound over time (compound interest, debt, climate CO2, skill building)\n  process-flow = something moves through stages (photosynthesis, digestion, supply chain, legislation passage)\n  tradeoff = two competing forces find an optimum (supply/demand, risk/return, specialization/flexibility)\n  structure-puzzle = click to arrange/mark a static structure (circuits, genetics pedigree, food web, historical timeline)\n  branching-decision = learner makes sequential choices that lead to different outcomes (historical counterfactual, ethical dilemma, business strategy, medical diagnosis)\n  bias-trap = learner EXPERIENCES a cognitive bias first-hand (anchoring, confirmation bias, groupthink, sunk cost)\n  budget-allocation = learner allocates a fixed resource across competing priorities with live tradeoffs\n  agent-social-sim = many autonomous agents follow simple rules; emergent patterns appear (segregation, epidemic spread, market prices)\n  sports-game = playable sports video game with real venue, aim/release/steer controls, scoreboard, ghost replay (basketball, golf, soccer, tennis, swimming, baseball)\n  wave-interference = superposition of waves in 3D; phase, frequency, amplitude control constructive/destructive interference (sound, light, strings, Doppler, noise cancellation)\n  molecular-builder = drag-and-snap 3D atoms/molecules; bond formation, geometry, active sites (DNA, enzymes, chemical bonding, protein structure simplified)\n  data-sampling = run many randomized trials; live histogram/distribution builds; sample size and bias visible (CLT, Bayes, birthday paradox, correlation, regression)\n  experiment-bench = 3D lab bench; pour/mix reagents, adjust temperature/concentration, observe reaction thresholds and color/state changes (chemistry, pH, reaction rates, catalysis)",
    "learning_goal": "One sentence using the exact words of the core insight from the reasoning.",
    "visualMetaphor": "One vivid sentence describing what the simulation looks and feels like IN MOTION. Not a chart type — a scene. E.g. 'Money piling up in stacks of gold coins, each new coin landing with a clink, the stacks growing taller until they overflow the screen.' Copy from the reasoning verbatim.",
    "entry_misconception": "A specific wrong belief the learner likely holds — e.g. 'heavier objects fall faster' not 'they don't understand gravity'",
    "first_move": "The concrete action the learner should try first that surprises them within 10 seconds and challenges the entry_misconception",
    "direct_manipulation": "What canvas/3D object the learner grabs with mouse/finger — NOT a slider. E.g. 'Drag the basketball launch point to change release angle' or 'Steer the rover with arrow keys'",
    "interaction_palette": [
      { "type": "draggable", "element": "name of grabbable object", "effect": "what changes when dragged" },
      { "type": "toggle-button", "element": "name of toggle", "effect": "what flips visually" },
      { "type": "keyboard-steer", "element": "movable object name", "effect": "arrow keys / WASD control" }
    ],
    "variables": [
      {
        "name": "variable name",
        "unit": "unit string or empty",
        "min": 0,
        "max": 100,
        "default": 10,
        "why_it_matters": "REQUIRED — one sentence explaining why THIS variable matters to the core insight. Not what it is — why changing it reveals something. E.g. 'Rate matters because doubling it doesn\\'t double the outcome — it compounds, so small rate differences explode over time.'",
        "regimes_note": "REQUIRED for the PRIMARY variable — describe the distinct regimes this variable spans across its range, and set min/max/default so ALL regimes are reachable. E.g. for orbital velocity: 'Below 6 = spirals in and crashes; 6-8 = stable circular/elliptical orbit; above 8 = escapes off-screen. min 3, max 11, default 6.5 (just below circular so a small nudge reveals the ellipse).' Set default NEAR the most surprising boundary so a tiny move flips the outcome."
      }
    ],
    "formulas": {
      "output_name": "exact math expression using variable names from the variables array. Use JS-style syntax. E.g. 'emitted_wavelength': '1240 / (bandgap * Math.pow(dotSize, 2))', 'interest_total': 'principal * Math.pow(1 + rate/100, years)'"
    },
    "rules": [
      {
        "when": "exact JS condition using variable names, e.g. 'dotSize < 3'",
        "visual_change": "what visually changes on canvas at this threshold",
        "message": "short insight text shown to learner, e.g. 'Quantum confinement regime — size controls color!'"
      }
    ],
    "reflection": {
      "question": "One specific question testable only after interacting with the lab. E.g. 'What happens to emitted wavelength when dot size is halved?'",
      "options": ["A: it doubles", "B: it quadruples", "C: it halves", "D: nothing changes"],
      "correct": "B: it quadruples",
      "explanation": "Because wavelength ∝ 1/size², halving size means wavelength × 4."
    },
    "stage_description": "Detailed paragraph: what is drawn on screen, what moves, what colors. Reference the visualMetaphor directly. Specific positions, sizes, what animates.",
    "interaction_description": "What the learner does step by step. What they touch first. What changes visually on each interaction. What the aha moment looks like on screen.",
    "aha_trigger": "The exact visual event that marks the aha moment. Be specific: what threshold, what visual change, what the learner sees right before vs. right after.",
    "success_condition": "Exact programmatic rule for completion.",
    "real_world_payoff": "One sentence: the real-world consequence the learner now understands."
  }
}

RULES:
- visualMetaphor must be a vivid scene description, never a chart type or UI pattern name
- every variable MUST have why_it_matters — if you can't explain why it matters, remove the variable
- the PRIMARY variable (the one that produces the aha) MUST have regimes_note describing the distinct outcomes across its range, with min/max/default chosen so EVERY regime is reachable and the default sits just below the most surprising boundary
- formulas MUST be real math — look up the actual equation for this concept. Every output shown in Zone B must have a formula entry.
- PHYSICAL TRUTH: every variable MUST appear in at least one formula expression. If a variable affects no formula, it is fake — DELETE it. Never invent decorative variables that sound topical but don't drive the physics (e.g. "contact surface" for Newton's third law). Three honest variables beat four where one is a lie — the learner WILL move it and learn something false.
- UNITS ARE REAL: every variable unit and every readout is a real physical/financial unit (N, m/s, kg, %, $, years). NEVER pixels, NEVER unitless numbers. If the canvas measures something spatially, define a scale (e.g. 50 px = 1 m) and display the converted value.
- DIMENSIONALITY: ALWAYS 3D IMMERSIVE. Every lab is a full Three.js WebGL scene — cinematic camera, real depth, environmental lighting, particles/fog. The visualMetaphor MUST describe a 3D world the learner enters (a basketball court at night, a Mars crater, a molecular space, an orbital vista). Even graph/economics topics get a 3D data landscape or holographic terrain — never flat 2D canvas-only.
- TOPIC FIDELITY: variables, environment, and mission MUST match the exact topic. Basketball → court, hoop, ball arc, release angle°, power N, distance m. Compound interest → 3D coin stacks growing in a vault. Supply/demand → 3D market floor with animated price surfaces. Never generic placeholders. NEVER use a generic "space" or "planet" background unless the topic is astronomy.
- NEATNESS & ANIMATION: the scene must feel alive and polished. Specify idle animations (bobbing, pulsing, slow rotation) for key objects.
- LABELS: every object the learner sees must be nameable in one word. If a variable or object can't be given a clear one-word on-screen label, it's probably too abstract — reconsider it.
- rules MUST include at least one threshold that triggers the aha moment visually
- the default state must already show interesting behavior on load — never a blank or boring starting point. The sim opens mid-phenomenon.
- reflection question must be answerable only AFTER interacting — not a definition lookup
- lab_archetype MUST be one of the fifteen listed — choose the one that best reveals the concept through interaction. Category hints: Physics → physics-sim/wave-interference; Biology → molecular-builder/agent-social-sim; Sports & Skills → sports-game (required); Money & Econ → accumulation/tradeoff; Math & Data → data-sampling/accumulation; Everyday Science → experiment-bench/physics-sim. History/ethics → branching-decision; psychology → bias-trap; nutrition/gov finance → budget-allocation; sociology/epidemiology → agent-social-sim
- entry_misconception MUST be a specific wrong belief, not a vague gap — "they think heavier objects fall faster" not "they don't understand gravity"
- first_move MUST describe a concrete action that surprises the learner within 10 seconds and directly challenges the entry_misconception
- direct_manipulation MUST describe a 3D object the learner grabs with their finger/mouse or steers with keys — not a slider. The primary variable is controlled by interacting with the 3D world.
- interaction_palette MUST include at least 3 entries: one "draggable" or "keyboard-steer", one "toggle-button", and one "slider" or "click-spawn" — the lab needs multiple interaction types
- For Sports & Skills category: lab_archetype MUST be sports-game; interaction_palette MUST include "keyboard-steer"; visualMetaphor MUST describe a real sport venue
- do NOT include interaction_type or any format label anywhere in the JSON

Now produce the spec JSON.`
      },
      { role: "user", content: `Topic: ${topic}\nCategory: ${category}\n\nReasoning:\n${thinking}\n${grounding ? `\nVERIFIED FACTS — formulas, constants, units, and real numbers MUST be consistent with these (use the real equation and real magnitudes, never fabricated ones):\n${grounding}\n` : ""}${courseContextBlock(courseContext)}\nNow produce the spec JSON.` }
    ],
  }, "spec");
  const parsed = parseLooseJSON(raw);
  normalizeReflection(parsed);
  normalizeSpec(parsed);
  return parsed;
}

// Fill critical interactivity fields when the spec model leaves them empty.
// These fields are interpolated into the design brief (thinkAboutLab) and the
// codegen prompt; an empty value used to collapse whole interaction/purpose
// sections to a blank line — or print "undefined" — which is a leading cause of
// mechanically inert "weak" labs. Fallbacks are neutral and topic-derived, never
// fabricated specifics, so they can only improve a thin spec, never mislead.
function normalizeSpec(design) {
  const sp = design && design.spec;
  if (!sp) return;
  const topic = (design.topic || sp.title || "this concept").toString().trim() || "this concept";
  const fill = (v, fallback) => ((typeof v === "string" && v.trim()) ? v.trim() : fallback);
  sp.learning_goal       = fill(sp.learning_goal,       `Build an intuition for ${topic} by manipulating it directly and watching what changes.`);
  sp.entry_misconception = fill(sp.entry_misconception, `Learners often predict ${topic} will behave one way; the lab shows what actually happens.`);
  sp.first_move          = fill(sp.first_move,          `Grab and move the primary 3D object (or adjust the main control) to see the effect immediately.`);
  sp.direct_manipulation = fill(sp.direct_manipulation, sp.first_move);
  sp.aha_trigger         = fill(sp.aha_trigger,         `The moment the visible result diverges from what the learner expected.`);
  sp.success_condition   = fill(sp.success_condition,   sp.aha_trigger);
  sp.real_world_payoff   = fill(sp.real_world_payoff,   `Connect ${topic} to a concrete real-world situation where it matters.`);
  sp.visualMetaphor      = fill(sp.visualMetaphor,      `A clear, legible 3D scene that makes ${topic} directly visible.`);
  if (!Array.isArray(sp.variables)) sp.variables = [];
  if (!Array.isArray(sp.interaction_palette)) sp.interaction_palette = [];
}

// Guard the reflection quiz so Step 3 never lands in a broken state.
// The frontend matches the picked option to `correct` by exact string equality,
// so `correct` MUST be one of `options` verbatim. If the model drifts (extra
// whitespace, a paraphrase, a missing letter prefix), repair it or drop the
// quiz entirely so the frontend falls back to the AI text-verify path.
function normalizeReflection(design) {
  const r = design && design.spec && design.spec.reflection;
  if (!r) return;
  const opts = Array.isArray(r.options) ? r.options.map(o => String(o).trim()) : [];
  r.options = opts;
  if (opts.length < 2 || !r.question) { design.spec.reflection = null; return; }

  const correct = String(r.correct == null ? "" : r.correct).trim();
  if (opts.includes(correct)) { r.correct = correct; return; }

  // Try a forgiving match: ignore case, punctuation, and any "A:" style prefix.
  const strip = s => s.toLowerCase().replace(/^[a-d]\s*[:.)-]\s*/i, "").replace(/[^a-z0-9 ]/g, "").trim();
  const target = strip(correct);
  const hit = opts.find(o => strip(o) === target) || (target && opts.find(o => strip(o).includes(target)));
  if (hit) { r.correct = hit; return; }

  // No reliable match — drop the quiz rather than show a question with no
  // correct answer. Frontend falls back to free-text verify.
  design.spec.reflection = null;
}

// Step 3 — reasons concretely about what to draw and how.
// Output is a structured visual brief the coder can follow exactly.
// Generate lesson slides (text-only, fast mini model) from the design spec.
// Returns { slides: [{title, bullets:[]}], summary } or null on failure.
async function generateLesson(design) {
  const spec = design.spec || {};
  const prompt = `You are a curriculum writer. Given this lab topic and spec, write a short lesson that prepares the learner to understand and use the interactive lab.

TOPIC: ${design.topic}
LEARNING GOAL: ${spec.learning_goal || ""}
ENTRY MISCONCEPTION: ${spec.entry_misconception || ""}
REAL WORLD PAYOFF: ${spec.real_world_payoff || ""}
KEY VARIABLES: ${(spec.variables || []).map(v => `${v.name} (${v.unit || ""}): ${v.why_it_matters}`).join("; ")}
AHA TRIGGER: ${spec.aha_trigger || ""}

Return ONLY valid JSON (no markdown, no fences):
{
  "summary": "1-2 sentence hook that makes the learner excited for the lab",
  "slides": [
    { "title": "slide title", "bullets": ["bullet 1", "bullet 2", "bullet 3"] }
  ]
}

Rules:
- Exactly 3 slides
- Slide 1: The core concept (what it is and why it matters)
- Slide 2: The key variables and how they relate (use the real variable names)
- Slide 3: The real-world payoff + what they'll discover in the lab
- Each slide: 3-4 bullets, max 15 words each
- Address the entry misconception head-on in slide 1 or 2
- No filler, no "in this lesson we will learn" — start every bullet with a concrete fact or action verb`;

  try {
    const resp = await reason.chat.completions.create({
      model: REASON_MINI_MODEL,
      max_tokens: 800,
      temperature: 0.4,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = resp.choices?.[0]?.message?.content || "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in lesson response");
    return JSON.parse(m[0]);
  } catch (e) {
    console.warn("[lesson] generation failed:", e.message);
    return null;
  }
}

// Generate quiz questions (fast mini model) from the design spec.
// Returns { questions: [{q, options:[4], answer:0-based-index, explanation}] } or null.
async function generateQuiz(design) {
  const spec = design.spec || {};
  const prompt = `You are a curriculum writer. Create a short quiz that tests whether the learner understood the key insight from this interactive lab.

TOPIC: ${design.topic}
LEARNING GOAL: ${spec.learning_goal || ""}
VERIFICATION QUESTION: ${design.verificationQuestion || ""}
AHA TRIGGER: ${spec.aha_trigger || ""}
REAL WORLD PAYOFF: ${spec.real_world_payoff || ""}
KEY VARIABLES: ${(spec.variables || []).map(v => `${v.name}: ${v.why_it_matters}`).join("; ")}

Return ONLY valid JSON (no markdown, no fences):
{
  "questions": [
    {
      "q": "question text",
      "options": ["option A", "option B", "option C", "option D"],
      "answer": 0,
      "explanation": "1 sentence why this is correct and what the others miss"
    }
  ]
}

Rules:
- Exactly 4 questions
- Question 1: conceptual (tests the core insight, not memorization)
- Question 2: application (a scenario where they apply the concept)
- Question 3: the verification question from the lab itself (reuse it verbatim)
- Question 4: real-world payoff (what would they do differently now?)
- Each question: 4 options, exactly one correct (answer = 0-based index of correct option)
- Wrong options should be plausible misconceptions, not obviously silly
- Explanation: punchy, 1 sentence, reinforces the aha moment`;

  try {
    const resp = await reason.chat.completions.create({
      model: REASON_MINI_MODEL,
      max_tokens: 1000,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = resp.choices?.[0]?.message?.content || "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in quiz response");
    return JSON.parse(m[0]);
  } catch (e) {
    console.warn("[quiz] generation failed:", e.message);
    return null;
  }
}

async function thinkAboutLab(design, category = "General", courseContext = null) {
  const cat = design.spec.course_category || category;
  const courseCtx = courseContextBlock(courseContext);
  const vars = (design.spec.variables || [])
    .map(v => `  • ${v.name} (${v.unit || ""}), range ${v.min}–${v.max}, default ${v.default}: ${v.why_it_matters}${v.regimes_note ? `\n    REGIMES: ${v.regimes_note}` : ""}`)
    .join("\n");

  const prompt = `You are a senior 3D creative technologist designing an immersive interactive learning lab inspired by NASA Mars Exploration interactive experiences (Pablo Coronel style: cinematic WebGL, geometry-rich environments, smooth motion UX, HUD overlays, atmospheric depth). You will produce a CONCRETE 3D VISUAL BRIEF that a developer implements with Three.js r128+.

COURSE CATEGORY: ${cat}
CATEGORY AESTHETIC: ${categoryGuidance(cat)}
COLOR PALETTE (must match Repend platform exactly): void ${REPEND_THEME.void}, fog ${REPEND_THEME.fog}, Mars rust ${REPEND_THEME.mars}, copper ${REPEND_THEME.copper}, ice HUD ${REPEND_THEME.ice}, muted ${REPEND_THEME.muted}
${courseCtx}
━━━ THE PURPOSE OF THIS LAB — design every element to serve these five things ━━━
TOPIC: ${design.topic}
LEARNING GOAL: ${design.spec.learning_goal}
ENTRY MISCONCEPTION (the wrong belief this lab must CORRECT):
  "${design.spec.entry_misconception || ""}"
  → The DEFAULT SCENE must INVITE this misconception — on first glance, a learner who doesn't interact yet should find this belief plausible. Describe what makes the starting scene feel like the misconception is true.
FIRST MOVE (what they do first, that surprises them and cracks the misconception):
  "${design.spec.first_move || ""}"
  → Design the scene so this action is OBVIOUS without reading instructions. Describe what visual affordance (glow, arrow, label) points the learner to it.
AHA TRIGGER (the exact visual event that delivers the insight — NOT just a number changing):
  "${design.spec.aha_trigger || ""}"
  → This must be an UNMISSABLE visual event: a sudden shape change, collision, phase flip, curve bending, threshold crossed with a burst of color. Describe it in cinematic terms.
REAL-WORLD PAYOFF (shown on win — must appear verbatim):
  "${design.spec.real_world_payoff || ""}"
VISUAL METAPHOR: "${design.spec.visualMetaphor}"
DIRECT MANIPULATION: "${design.spec.direct_manipulation || ""}"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VARIABLES:
${vars}

AHA MOMENT: ${design.spec.aha_trigger}

Write a concrete brief covering these areas. Be specific enough that a developer can write the Three.js code directly from your description — no ambiguity, no "something that represents X".

━━━ 0. VISIBILITY FIRST (before aesthetics) ━━━
A beautiful brief is worthless if the scene is black. Every Three.js lab MUST:
• AmbientLight(0xffffff, 0.7) + DirectionalLight at (5,10,7) + PointLight rim — ALL THREE, always
• Camera at a position where the interactive objects are within view at startup (e.g. position (0,4,10) looking at origin)
• All interactive meshes: MeshStandardMaterial with emissive + emissiveIntensity≥0.3 so they glow slightly even in low light
• Objects spawn within x:[-3,3], y:[-2,2], z:[0] by default — never off-screen, never inside each other
• Scene must show something the learner can grab within the first 100ms of load — describe exactly what they see

━━━ 0b. TOPIC REALISM (non-generic) ━━━
The lab content must depict "${design.topic}" literally — NEVER a default space/planet scene unless the topic is actually about space.
• REAL 3D OBJECTS: build recognizable meshes for every topic element (basketball=SphereGeometry, rim=TorusGeometry, allele=labeled SphereGeometry with distinct color, language card=BoxGeometry with texture text)
• MATERIALS: MeshStandardMaterial with roughness/metalness, emissive accents on interactive elements
• ATMOSPHERE: FogExp2 scene depth, dust particles, slow camera idle drift — applied to the topic's real environment
• LIGHTING: warm DirectionalLight (sun/lamp) + cool PointLight (rim) + AmbientLight — shadows via renderer.shadowMap
• HUD: glass panels with backdrop-filter blur, ${REPEND_THEME.ice} readouts, ${REPEND_THEME.mars} accent borders — NASA mission-control aesthetic
• For sports-game archetype: treat as a VIDEO GAME — scoreboard, attempt counter, stadium lights, crowd particle ambience, keyboard/touch controls, replay ghost of previous shot, combo/streak feedback
• For wave-interference: two+ 3D wave sources with visible superposition; color-code constructive/destructive regions
• For molecular-builder: colored atom spheres with snap-to-bond drag; show geometry angles live
• For data-sampling: 3D histogram bars grow trial-by-trial; ghost curve shows true distribution
• For experiment-bench: beakers on lab bench, pour animation, burner glow, live pH/temp readouts

━━━ 1. WHAT DRAWS ON LOAD (before any interaction) ━━━
Describe exactly what the Three.js scene shows at startup. Name every 3D object (meshes, lights, particles), camera position/angle, environment (skybox/fog/color), and what's animated. The scene must feel cinematic and alive before interaction — slow camera drift, dust particles, emissive accents, volumetric fog.

Example: "Full-screen WebGL. Camera at (0, 2.5, 8) looking at origin. Mars-dust orange fog (FogExp2, #1a0a00). A regulation basketball court floor (PlaneGeometry, wood texture tone #8B4513) with painted lines. A glowing orange basketball (SphereGeometry r=0.12) hovering at release point. A rim 4.5m away (TorusGeometry). Starfield Points in background. Ambient + directional light with warm rim light. HUD overlay: 'Release angle: 52°' top-left."

━━━ 2. HOW EACH VARIABLE CHANGES THE CANVAS ━━━
For each variable, describe the EXACT canvas change when its value changes. Name the specific drawing operations: what shape changes size/position/color/shape, what equation drives it, what the visual looks like at min vs max value.

Example: "Frequency (1–10 Hz): the sine wave's horizontal compression changes — at 1Hz one full wave spans the canvas, at 10Hz ten waves are crammed in. The white dot's speed increases proportionally. The label updates to 'frequency: N Hz'."

━━━ 3. THE AHA MOMENT VISUAL ━━━
Describe the specific canvas state right before and right after the aha moment. What threshold triggers it? What visual event makes it unmissable? Use a concrete trigger: a value crossing a number, a wave doing something specific, two lines intersecting.

Example: "When frequency crosses 5Hz, the wave peaks start overlapping with the reflected wave — destructive interference appears as the amplitude suddenly drops to near-zero. A golden ring pulses around the wave for 1 second. Label flashes 'Destructive interference!' in #D4A574."

━━━ 4. LIVE READOUTS IN ZONE B ━━━
List every text label that updates live on the canvas as values change. Each readout must show the OUTPUT of the concept (what the concept produces), not just the input value. Format: "Label text: [formula or description], position on canvas, color."

Example: "• 'Wavelength: X m' — top-left, #8899BB, updates as frequency changes (wavelength = speed/frequency)
• 'Interference: constructive / destructive' — center-top, color shifts green→red based on phase overlap"

━━━ 5. MAKE THE INVISIBLE VISIBLE ━━━
This is the most important section. Real understanding comes from SEEING the hidden mechanism, not just the surface. Describe:
- The TRACE/TRAIL: what path or history persists on screen so the learner compares "before vs now" without remembering? (e.g. the orbit trail that morphs circle→ellipse→escape as velocity changes; the ghost of the previous curve faded behind the current one). This morphing trace is usually the single most important visual — describe it precisely.
- The HIDDEN VECTORS/FORCES: what arrows, fields, or quantities that you can't see in reality should be drawn? (velocity arrow, gravity-force arrow pointing inward, energy bars). Name each, its color, what it attaches to, how it changes.
- The LINKED REPRESENTATIONS: the same quantity shown two+ ways at once that update together (a number AND a bar AND the physical motion). Name which quantity and which representations.

Example: "A continuously drawn orbital trail (copper, fading older segments to 20% alpha) traces the satellite's path — at default velocity it's a near-circle, drop velocity and the trail spirals inward to a crash, raise it and the trail opens into an ellipse then a hyperbola that flies off-screen. A blue velocity arrow extends from the satellite in its direction of motion, length ∝ speed. A red gravity arrow always points from satellite to planet, length ∝ 1/r². An energy bar (top-left) splits kinetic (blue) vs potential (orange) and shifts live."

━━━ G. THE MISSION ━━━
Design the lab as a playable challenge, not a free-form sandbox. Describe:
- THE GOAL: one concrete, visible objective the learner must achieve by exploiting the concept (e.g. "park the satellite in the green target ring and keep it there for 3 seconds", "breed a population that survives the drought", "deliver 100W to the bulb without melting the wire"). The goal must be impossible to hit by luck — succeeding requires using the mechanism the lab teaches.
- DIRECT MANIPULATION: what the learner grabs, drags, or steers IN the play area itself — a draggable launch point, a steerable object via arrow keys, an aim-and-release gesture. Prefer touching the world over panel sliders whenever the concept allows it.
- THE TARGET VISUAL: how the goal is drawn on canvas (a target zone, a finish line, a threshold marker) and how progress toward it is shown live (a meter filling, the zone glowing as you get close).
- WIN/FAIL FEEDBACK: what plays on success (celebration burst, the win text) and what a near-miss looks like, so failing teaches WHY it failed in the concept's own terms.

━━━ H. FORMULA PANEL ━━━
The spec provides formulas{}. The lab must TEACH the formula, not just animate the result.
Describe how to render a formula panel in Zone A (or pinned to the top of Zone B):
- Show the governing equation written out symbolically (e.g. "R = v²·sin(2θ) / g").
- For each variable the learner controls, name the symbol it maps to in the equation.
- When the learner moves a control, that term in the equation should be visually highlighted (color flash, bold, or glow) AND the computed result updates live next to the equation.
- The learner sees the arc, the equation, and the number update together — concept + formula + animation are three linked representations of the same thing.
Describe the panel's position, which equation to show, which term each control highlights, and what computed value to display.

━━━ I. REAL-WORLD LINE ━━━
The spec provides real_world_payoff. In the Reveal step, this must land as one concrete sentence the learner reads AFTER they've hit the aha moment — not a generic topic sentence but a direct connection to what they just did.
Write that sentence here. Format: "[What you just saw] is why [real-world consequence]."
Example: "The steep drop angle you just found is why basketball coaches teach the high arc — a ball dropping steeply hits a 30% wider effective target."

━━━ J. REAL SCENARIO TO MATCH ━━━
Learning flows backward when the equation comes first. Instead, open with REALITY and let the learner discover the rule by matching it:
- Name ONE real, specific instance of this concept with real numbers — a documented basketball shot arc, the actual growth of $1,000 at 7% from 1990–2020, Darwin's finch beak-size shift after the 1977 drought, a real city's epidemic curve. Real names, real units, real magnitudes (approximate is fine; invented-but-plausible is acceptable if no famous dataset exists).
- This real instance is drawn on the canvas from the start as a fixed TARGET — a ghost curve, a dotted trajectory, a faded historical line — clearly labeled as the real thing ("Curry's 2016 shot", "S&P 500 actual").
- The learner's controls drive THEIR model's curve/behavior, drawn live on the same axes. Their goal: tune the parameters until their model lies on top of reality. Show a live match readout ("Match: 84%").
- When the match crosses ~95%: that's the moment the equation is EARNED — reveal/highlight the formula with the learner's discovered parameter values plugged in ("You found it: A = 1000·(1.07)^t").
This section applies whenever the concept produces a measurable output (most topics). If the topic is truly non-quantitative (e.g. a logical fallacy), say so and skip it — the mission from section G carries the lab instead.

RULES:
- Every element must be implementable in Three.js (Mesh, Group, Line, Points, CSS2D labels for HUD)
- Minimum 2 variables with distinct 3D visual effects (ball trajectory changes, environment shifts, object morphs)
- The PRIMARY variable must let the learner reach EVERY regime from its REGIMES note
- The 3D viewport fills at least 75% of screen height — immersive, edge-to-edge feel
- Controls are a floating glass HUD panel (bottom or right) — semi-transparent, minimal, NASA-mission-control aesthetic
- The central 3D subject must be LARGE and hero-framed — cinematic close-ups on interaction
- Topic-specific environment is mandatory: basketball = court+hoop, orbit = planet+satellite, biology = 3D cell space
- Include camera choreography: smooth lerp/GSAP transitions when variables cross thresholds
- No flat 2D-only canvas labs — WebGL is the primary stage
- For Sports & Skills: describe video-game features — score display, attempt counter, on-screen touch buttons (◀▲▼▶), keyboard steering, near-miss slow-motion replay, mission target ring glowing when close
- For wave-interference: describe each wave source position, frequency, phase, and how superposition colors the mesh
- For molecular-builder: name each atom type, bond rules, snap distances, and target structure
- For data-sampling: describe trial mechanics, bin layout, and what changes when sample size increases
- For experiment-bench: describe each beaker, reagent, pour gesture, and reaction threshold visuals`;

  const text = await openaiCreateStreamed({
    model: THINK_MODEL_ID,
    max_tokens: 1200,
    ...(isReasoningModel(THINK_MODEL_ID) ? { reasoning_effort: "low" } : {}),
    // Never fall back to the flaky 70b for labthink — walk the gpt-oss chain.
    _fallbackChain: REASON_FALLBACK_CHAIN,
    messages: [{ role: "user", content: prompt }],
  }, "labthink");
  if (!text) throw new Error(`labthink (${THINK_MODEL_ID}) returned empty content`);
  return text.trim();
}

// Step 4 (optional) — gpt-image-1 generates a clean UI mockup.
// Returns a base64 data URL or null on failure (pipeline continues without image).
// GPT turns the lab's PURPOSE (not just its looks) into an image-gen prompt, so
// the mockup depicts what the lab teaches — the misconception it kills, what the
// learner manipulates, and what the "aha" moment looks like — not a generic scene.
async function mockupPromptFromSpec(design) {
  const s = design.spec || {};
  const brief = [
    `Topic: ${design.topic}`,
    `Learning goal: ${s.learning_goal || ""}`,
    `Misconception it corrects: ${s.entry_misconception || ""}`,
    `What the learner manipulates: ${s.direct_manipulation || s.first_move || ""}`,
    `The "aha" visual moment: ${s.aha_trigger || ""}`,
    `Visual metaphor: ${s.visualMetaphor || ""}`,
  ].join("\n");

  return openaiText(`You write a single text-to-image prompt for a mockup of an interactive learning lab. The image must visually communicate the lab's PURPOSE — show the exact moment of insight and what the learner controls, not just a pretty scene.

LAB:
${brief}

Write ONE vivid image prompt (max 100 words). Requirements:
- Depict the concept's core insight literally (e.g. an exponential curve pulling away from a straight line = the compounding gap IS the lesson).
- Include the labeled controls the learner uses and a live readout.
- Cinematic dark theme: near-black #050508 background, teal #4CC9F0 accents, glassmorphic HUD, volumetric rim light, 16:9 landscape.
- No paragraphs of body text, no browser chrome, no watermark.
Return ONLY the prompt text.`, 300, REASON_MINI_MODEL);
}

// Renders the mockup on NVIDIA Build (free) via the OpenAI-compatible images
// endpoint, reusing the `nvidia` client. Fail-open: never blocks lab generation.
async function mockupImage(design) {
  if (!NVIDIA_API_KEY) return null;
  try {
    const prompt = await mockupPromptFromSpec(design);
    const res = await nvidia.images.generate({
      model: IMAGE_MODEL_ID,
      prompt,
      response_format: "b64_json",
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.warn(`mockupImage (${IMAGE_MODEL_ID}) failed, continuing without:`, err.message);
    return null;
  }
}

// Step 5 — writes the final HTML lab.
// Takes the prose brief (source of truth for behavior) + optional mockup image (look/layout).
//

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

// Step 3b — per-topic visual pedagogy: how THIS specific concept is best taught in a WebGL 3D scene.
async function thinkAboutVisualPedagogy(topic, archetype, category) {
  const prompt = `You are an expert in visual pedagogy and interactive learning design. Your job is to reason specifically about how the concept "${topic}" (archetype: ${archetype}, category: ${category}) should be taught in an interactive WebGL/Three.js 3D scene.

Answer these five questions concisely (2-4 sentences each):

1. OBJECT IDENTITY: What are the key objects/entities in this concept that the learner must distinguish? What one-word labels should appear on each so the learner never wonders "what is this thing"?

2. WIN STATE: What specific, observable thing must happen in the 3D world for the learner to know they've "got it"? Describe it as a visual event (not a score), e.g. "the tRNA anticodon snaps into the ribosome A-site and the polypeptide chain extends by one bead."

3. CORE MECHANIC: What is the ONE action the learner performs that IS the learning — not earns points for learning, but where doing the action correctly requires understanding the concept? It must be a direct 3D manipulation (drag, steer, place, aim), not reading or watching.

4. FEEDBACK DESIGN: When the learner makes a wrong move, what should happen within 300ms to teach WHY it was wrong in the concept's own terms? Be specific about what text appears and on which object in the scene.

5. ANTI-BROCCOLI CHECK: How does this design avoid "chocolate-covered broccoli" (where the game and the learning are separate layers)? Confirm the mechanic = the learning or describe the fix.

Be specific to "${topic}". Do not give generic answers. Do not repeat the archetype patterns verbatim.`;

  return openaiText(prompt, 800, REASON_MINI_MODEL);
}

// Step 3c — INTERACTION DIRECTOR (parallel extended-thinking call).
// Picks the interaction language the way a human game designer would: the medium
// and mechanics must fit the genre. Football sim → 3D field with aim/steer/release.
// Card probability → drag-and-flip. Ethics dilemma → branching choices you click
// through and can rewind. The current pipeline always lands on "3D scene + HUD
// sliders"; this step forces a deliberate choice of PRIMARY direct manipulation
// and demotes sliders to secondary. Additive: on any failure it returns null and
// the pipeline behaves exactly as before.
const INTERACTION_PALETTE = [
  "grab-and-drag-3d (raycast: pick up objects in the scene, move them, drop them — placement IS the answer)",
  "aim-and-release (pull back / set angle+power, release, watch consequence — projectile, investment timing, immune response)",
  "steer (WASD/arrow keys or on-screen joystick: drive an entity through the space in real time)",
  "drag-and-snap-assembly (drag parts that snap into valid configurations — molecules, circuits, timelines, food webs)",
  "pour-mix-heat (run an experiment: combine amounts, apply conditions, cross a reaction threshold)",
  "scrub-time (drag a timeline scrubber to move the whole system through time; discover rates by feeling them)",
  "draw-a-path (sketch a trajectory/boundary/curve with the pointer; the sim tests whether the drawn hypothesis survives reality)",
  "place-bets-then-reveal (commit a prediction FIRST — click/drag a marker — then run reality and confront the gap)",
  "click-sequence-choices (make sequential decisions at branch points; backtrack and explore alternate universes)",
  "swarm-perturbation (poke/attract/scatter many agents with the pointer and watch emergent order re-form)",
  "orbit-inspect-probe (orbit camera around a structure, click hotspots to probe/measure — anatomy, machines, geology)",
  "chase-and-collect (move to catch/avoid moving targets under the topic's real rules — timed, arcade-feel)",
];

async function thinkAboutInteraction(design, category = "General", courseContext = null) {
  if (!ENABLE_INTERACTION_DIRECTOR) return null;
  const cat = design.spec.course_category || category;
  const vars = (design.spec.variables || []).map(v => `${v.name} (${v.min}–${v.max} ${v.unit || ""})`).join(", ");
  const prompt = `You are the INTERACTION DIRECTOR for an interactive learning lab. Think like a game designer choosing the medium for a genre: a football sim earns a 3D field with aim/steer/release controls; a platform fighter earns 2D canvas with keyboard combat; a card-odds game earns draggable cards on a table. The interaction style must FIT the concept — not default to one house pattern.

THE HOUSE PATTERN TO BREAK: our labs currently all converge on "3D scene + sliders in a HUD panel". Sliders are fine as a SECONDARY tuning control, but the PRIMARY interaction must be direct manipulation inside the play area, chosen to fit this specific topic.

TOPIC: ${design.topic}
CATEGORY: ${cat}
ARCHETYPE: ${design.spec.lab_archetype || "physics-sim"}
LEARNING GOAL: ${design.spec.learning_goal}
FIRST MOVE: ${design.spec.first_move || ""}
AHA TRIGGER: ${design.spec.aha_trigger || ""}
DIRECT MANIPULATION (from spec): ${design.spec.direct_manipulation || ""}
VARIABLES: ${vars}${courseContext ? `\nCOURSE CONTEXT: part of a course — keep controls consistent with a learning sequence.` : ""}

INTERACTION PALETTE (choose from these, or invent a better one if the topic demands it):
${INTERACTION_PALETTE.map(p => `• ${p}`).join("\n")}

Reason it through: (1) What does UNDERSTANDING this concept feel like as a physical action? (2) Which palette entry makes that action the gameplay itself — not chocolate-covered broccoli? (3) What can the learner EXPLORE beyond the win path — what open-ended "what if I…" moves should be possible and rewarded?

Then return ONLY a JSON object (no markdown, no prose) with exactly this shape:
{
  "primary_interaction": {
    "style": "<one palette style name>",
    "binding": "<exact controls: what the pointer/keys do, e.g. 'drag the electron with pointer; hold Shift to slow time'>",
    "why_it_is_the_learning": "<one sentence: doing this action correctly REQUIRES understanding the concept>"
  },
  "secondary_interaction": { "style": "<different style or 'sliders'>", "binding": "<controls>" },
  "slider_policy": "<which variables (if any) stay on sliders, and why they are tuning knobs rather than the core action>",
  "exploration_moments": ["<2-3 open-ended discoveries: things a curious learner can try that are NOT required to win but produce a visible, honest consequence>"],
  "surprise_variation": "<one unpredictable element that makes each session feel alive (randomized scenario flavor, a second hidden regime, an entity with autonomous behavior) — must not change WHAT is taught>",
  "controls_legend": "<one line shown in the HUD, e.g. 'DRAG planet · SCROLL zoom · SPACE pause · R reset'>"
}`;

  // Primary model first, then REASON_MODEL (known-good llama-70b) — so a
  // delisted/unreachable INTERACTION_MODEL_ID degrades to a non-thinking
  // contract instead of no contract at all.
  const candidates = [INTERACTION_MODEL_ID];
  if (REASON_MODEL !== INTERACTION_MODEL_ID) candidates.push(REASON_MODEL);
  for (const model of candidates) {
    try {
      const raw = await openaiCreateStreamed({
        model,
        max_tokens: 4000,
        // Extended thinking: gpt-oss reasoning models take reasoning_effort; high =
        // real deliberation. Non-reasoning models simply ignore the field.
        ...(isReasoningModel(model) ? { reasoning_effort: "high" } : {}),
        messages: [{ role: "user", content: prompt }],
      }, "interaction-director");
      const contract = parseLooseJSON(raw);
      if (!contract || !contract.primary_interaction || !contract.primary_interaction.style) {
        console.warn(`[interaction] director (${model}) returned unusable JSON`);
        continue;
      }
      console.log(`[interaction] primary=${contract.primary_interaction.style} (via ${model})`);
      return contract;
    } catch (err) {
      console.warn(`[interaction] director (${model}) failed:`, err.message);
    }
  }
  console.warn("[interaction] all director models failed — continuing without contract");
  return null;
}

// Render the interaction contract as a codegen prompt section. Empty string when
// the director is disabled or failed — codegen prompt is then byte-identical to
// the pre-director pipeline.
function interactionContractBlock(ic) {
  if (!ic) return "";
  const explore = (ic.exploration_moments || []).map(m => `  • ${m}`).join("\n");
  return `
━━━ INTERACTION CONTRACT (from the interaction director — BINDING) ━━━
The primary interaction below was chosen specifically for this topic. Sliders may exist only in the role the slider_policy allows — a lab whose only interaction is sliders VIOLATES this contract.

PRIMARY INTERACTION (this is the gameplay AND the learning):
  STYLE: ${ic.primary_interaction.style}
  CONTROLS: ${ic.primary_interaction.binding}
  WHY: ${ic.primary_interaction.why_it_is_the_learning || ""}
SECONDARY: ${ic.secondary_interaction ? `${ic.secondary_interaction.style} — ${ic.secondary_interaction.binding}` : "none"}
SLIDER POLICY: ${ic.slider_policy || "sliders are secondary tuning knobs only"}
EXPLORATION MOMENTS (implement all — each must produce a visible, honest consequence):
${explore || "  • (none specified)"}
SURPRISE VARIATION: ${ic.surprise_variation || ""}
CONTROLS LEGEND (render verbatim in the HUD): "${ic.controls_legend || ""}"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
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

// One Kimi streaming call with wall-clock + idle-stall timeouts. Returns the
// extracted HTML or throws a retryable error.
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
  const html = extractHtml(raw) || extractHtml(reasoning);
  if (!html) throw new Error(`${CODEGEN_MODEL_ID} returned non-HTML content (content:${raw.length} reasoning:${reasoning.length} chars, finish_reason:${finishReason})`);
  return html;
}

async function codeFromImageBrief(design, labThinking, pedagogy, imageDataUrl, category = "General", onProgress = null, critiqueNotes = null, interactionContract = null) {
  const cat = design.spec.course_category || category;
  const vars = (design.spec.variables || [])
    .map(v => `  • ${v.name} (${v.unit || ""}): ${v.min}–${v.max}, default ${v.default}. ${v.why_it_matters}${v.regimes_note ? `\n    REGIMES (make all reachable): ${v.regimes_note}` : ""}`)
    .join("\n");

  const formulas = design.spec.formulas
    ? Object.entries(design.spec.formulas).map(([k, v]) => `  ${k} = ${v}`).join("\n")
    : "";
  const rules = (design.spec.rules || [])
    .map(r => `  • when (${r.when}): ${r.visual_change} — show message "${r.message}"`)
    .join("\n");

  const archetype = design.spec.lab_archetype || "physics-sim";

  // Archetype-specific Three.js architecture patterns injected into codegen
  const archetypeArchitecture = {
    "physics-sim": `
━━━ ARCHITECTURE: PHYSICS SIMULATION (Three.js) ━━━
Build on requestAnimationFrame with Three.js scene. State object holds positions/velocities. Physics integrates every frame. Trail stored as TubeGeometry or Line geometry updating live.
const state = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), trail: [], t: 0 };
function update(dt) { /* integrate forces on state.pos/state.vel */ state.trail.push(state.pos.clone()); if(state.trail.length>200) state.trail.shift(); updateTrailMesh(); }
function animate() { update(dt); renderer.render(scene, camera); requestAnimationFrame(animate); }
// Raycast for draggable 3D objects; keyboard-steer for movable entities`,

    "threshold": `
━━━ ARCHITECTURE: THRESHOLD (Three.js) ━━━
One primary slider drives the 3D simulation. Scene shows continuous change PLUS a sudden visual jump at threshold (GSAP camera shake, emissive flash, particle burst).
const state = { value: defaultVal, threshold: X, crossed: false };
// At threshold: trigger golden particle burst + emissive pulse on key mesh + HUD message`,

    "accumulation": `
━━━ ARCHITECTURE: ACCUMULATION (D3 + minimal Three.js chrome) ━━━
This archetype is fundamentally a TIME-SERIES CHART — force 3D on it and the data becomes unreadable (dark meshes block the axes). Use D3 for the chart itself; Three.js chrome (particles, glow) is optional decoration only.

D3 CHART (required):
• Full-viewport SVG with labeled axes: X = years (0–40), Y = balance ($).
• TWO live curves drawn as D3 paths, both visible at once:
  - Faded/dotted: linear expectation (no compounding).
  - Bright solid: actual compound curve (the learner's values).
• Ghost target line labeled with the mission goal (e.g. "$500k by 30 yrs").
• As learner drags sliders, both curves redraw instantly via D3 transition (200ms ease).
• Area between the two curves filled with a semi-transparent accent color so the compounding gap is visceral.
• Tooltip on hover showing exact year + balance.

STATE:
const state = { principal:1000, rate:0.07, monthly:100, years:30, won:false };
// recompute both curves on every slider input, redraw via d3.select(path).datum(data).attr("d", line)

INTERACTION: HUD sliders for Principal ($), Monthly Contribution ($), Interest Rate (%), Years. Each updates state.* then redraws immediately.
WIN: when compound curve crosses the target line → golden glow on the crossing point + "MISSION COMPLETE" card.`,

    "process-flow": `
━━━ ARCHITECTURE: PROCESS FLOW (Three.js) ━━━
Each stage is a labeled 3D region (BoxGeometry platforms). Particles (Points or small Spheres) flow between stages along CatmullRomCurve3 paths.
const stages = [{position, label, rate},...]; const particles = [];
// Particles transform color/size at each stage; bottleneck = particles pile up before slow stage`,

    "tradeoff": `
━━━ ARCHITECTURE: TRADEOFF (Three.js) ━━━
Two opposing 3D surfaces or curves in the scene. Learner drags a 3D cursor/marker. Show current values of both curves + total on HUD.
// Optimum point marked with glowing emissive sphere — pulses when cursor within 5%`,

    "structure-puzzle": `
━━━ ARCHITECTURE: STRUCTURE PUZZLE (Three.js) ━━━
3D nodes as clickable meshes in the scene. Raycast on click to toggle state. No continuous physics — state changes on interaction.
const nodes = [{mesh, state:'unset'},...];
// Raycaster for click detection; evaluate() checks if config matches correct pattern; GSAP for hover glow`,

    "branching-decision": `
━━━ ARCHITECTURE: BRANCHING DECISION (Three.js) ━━━
3D tree of consequence nodes connected by glowing TubeGeometry edges. Current node large in center, choices as HUD buttons.
const tree = { id:'root', text:'...', choices:[...] };
// Visited nodes = solid emissive; unvisited = faded; GSAP camera transitions between nodes`,

    "bias-trap": `
━━━ ARCHITECTURE: BIAS TRAP (Three.js + D3 overlay) ━━━
Phase 1: learner makes judgments via 3D HUD panels. Phase 2: reveal as 3D histogram bars (BoxGeometry heights) with learner's dot highlighted.
// Show bias name ONLY after trials complete — the reveal is a 3D data visualization`,

    "budget-allocation": `
━━━ ARCHITECTURE: BUDGET ALLOCATION (Three.js) ━━━
Fixed total resource distributed via HUD sliders. 3D stacked bar (BoxGeometry segments) shows allocation. Each category has a 3D icon that morphs with allocation level.
const TOTAL = 1000;
// Constraint: sum always equals TOTAL; live outcome score computed from formula`,

    "agent-social-sim": `
━━━ ARCHITECTURE: AGENT SOCIAL SIM (Three.js) ━━━
Many autonomous agent Spheres in 3D space follow local rules. Emergent patterns appear naturally.
const agents = Array.from({length:100}, () => ({ position: new THREE.Vector3(), type, state }));
// Live aggregate chart as 3D ribbon or HUD D3 overlay; convergence triggers win`,

    "sports-game": `
━━━ ARCHITECTURE: SPORTS VIDEO GAME (Three.js) ━━━
Full playable sports sim — NOT a passive physics demo. Real venue, game loop, scoreboard.
const state = { attempts:0, makes:0, streak:0, ball:new THREE.Vector3(), vel:new THREE.Vector3(), phase:'aim' };
// Venue: PlaneGeometry court/field + stadium PointLights + crowd Points ambience
// Scoreboard HUD: attempts/makes/streak/mission target; JetBrains Mono numbers
// Controls: raycast drag for aim angle + power OR keyboard-steer (held keys Set) + touch buttons ◀▲▼▶
// Ghost replay: faded TubeGeometry of previous attempt trajectory
// Physics loop: integrate projectile with gravity/spin; collision with hoop/target zone
// Near-miss: HUD shows WHY in sport terms for 2s; instant retry
// Win: mission target hit → golden particle burst + camera GSAP zoom + labCheck postMessage`,

    "wave-interference": `
━━━ ARCHITECTURE: WAVE INTERFERENCE (Three.js) ━━━
Two or more wave sources in 3D; superposition visible as rippling PlaneGeometry or TubeGeometry waves.
const sources = [{ freq, amp, phase, pos }, ...]; const t = 0;
// Displace PlaneGeometry vertices each frame: sum of sin(k·r - ωt + φ) from each source
// Color mesh by amplitude (constructive=green emissive, destructive=red/dim)
// Controls: frequency, amplitude, phase sliders → highlight terms in wave equation panel
// Standing wave mode: reflect at boundary; show nodes/antinodes as glowing markers
// Aha: phase shift crosses π → destructive interference valley appears`,

    "molecular-builder": `
━━━ ARCHITECTURE: MOLECULAR BUILDER (Three.js) ━━━
3D atoms as colored Spheres with element labels; bonds as CylinderGeometry between snap points.
const atoms = [{ element, pos, mesh }, ...]; const bonds = [];
// Raycast drag: snap atom to valid bond distance on release; invalid = red flash + bounce back
// Bond angles update live; show VSEPR-style geometry or base-pair matching rules
// evaluate(): check if current structure matches target (DNA pair, enzyme-substrate, Lewis structure)
// Electron clouds: transparent SphereGeometry shells with emissive pulse on correct bonds`,

    "data-sampling": `
━━━ ARCHITECTURE: DATA SAMPLING (Three.js + D3) ━━━
Run many trials; each trial spawns a small Sphere that lands in a bin. Histogram builds as 3D BoxGeometry bars.
const trials = []; let sampleSize = 10; let running = false;
// "Run Trial" / "Run 100" buttons; each trial draws from the true distribution
// Live histogram: bar heights = count per bin; overlay true distribution as ghost curve (D3 or TubeGeometry)
// Controls: sample size slider, population parameter slider — watch CLT converge as N increases
// Highlight learner's sample mean vs population mean; show standard error shrinking with N
// Win: learner identifies bias or reaches target confidence interval`,

    "experiment-bench": `
━━━ ARCHITECTURE: EXPERIMENT BENCH (Three.js) ━━━
3D lab bench (BoxGeometry table) with beakers (CylinderGeometry + transparent material), burners, thermometers.
const reagents = [{ name, volume, color, temp }, ...]; let reactionState = 'idle';
// Pour: click beaker → drag to flask → volume transfers with animated fluid level (scaled CylinderGeometry height)
// Temperature slider → burner flame intensity (PointLight + emissive) → reaction rate changes
// Threshold: color shift + particle burst when pH/temp/concentration crosses reaction point
// Safety/readouts: live thermometer, pH meter, color indicator on HUD
// Win: achieve target product state (color, pH, gas bubbles) by tuning variables`,
  };

  const briefText = `━━━ REPEND MISSION ━━━
Repend is an exploration engine that teaches any topic through hands-on interaction. Before generating ANYTHING, ask: "What is the most engaging way to make this concept click — through a simulation, a game, a decision tree, a social experiment, or a visual puzzle?" Default to the format that lets the learner FEEL the concept, not just read about it. A good lab produces an "aha" moment the learner couldn't get from a textbook. Passive explanations, static charts, and reading-only interfaces are rejected — every element must respond to the learner's action.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ GOLD-STANDARD HARNESS — COPY THIS EXACT 11-SECTION STRUCTURE ━━━
The file proof-lab.html is a HAND-WRITTEN gold standard. Every generated lab must follow its exact 11-section skeleton. DO NOT invent a different structure. Fill in the topic-specific objects/logic inside each section while keeping every section present and in order.

SECTION 1 — Renderer + scene + camera
  • THREE.WebGLRenderer with antialias, pixelRatio, ACESFilmicToneMapping, toneMappingExposure 1.15
  • renderer.domElement appended to a position:fixed #app div (NOT body)
  • CSS2DRenderer ALSO appended — same size, position:fixed, pointerEvents:'none'
  • Camera positioned so ALL objects are in view on the first frame (never at origin)

SECTION 2 — Lighting (UNCONDITIONAL — add these three lights with no if-checks, no conditions)
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 1.25); key.position.set(5,10,7); scene.add(key);
  const rim = new THREE.PointLight(0x4CC9F0, 0.9, 60); rim.position.set(-6,4,-4); scene.add(rim);
  Plus ambient dust particles (THREE.Points, ~240 pts, slow drift) for depth.

SECTION 3 — Palette + topic objects (FILL THIS IN for the topic — the meshes, geometries, labels)
  • Use the spec's palette colors for all materials: purple #9B59B6, white #f2f2f2, orange #E85D04, ice #4CC9F0, green #22C55E
  • Build the main topic-specific environment first (the stage/grid/court/lab-bench/vault) before placing interactive objects
  • Every mesh has a meaningful name label via CSS2DObject (never an unlabeled shape)
  • IDLE ANIMATION: key objects must bob, pulse, or rotate gently when the learner isn't interacting — the scene must feel alive on load, never frozen

SECTION 4 — HUD (position:fixed, glass-panel style, top-left)
  #hud { position:fixed; top:18px; left:18px; padding:16px 20px; width:280px; max-width:280px;
    background:rgba(10,15,30,.75); backdrop-filter:blur(10px);
    border:1px solid rgba(232,93,4,.3); border-radius:14px; z-index:10; }
  Contains: topic title, subtitle/goal, progress meter (bar + count), ratio/result line.
  Legend fixed bottom-left (max-width:220px). Reset button fixed bottom-right. Hint strip fixed bottom-center.
  CRITICAL: HUD is NOT inside the Three.js canvas. It is a plain HTML div with higher z-index.

  PANEL LAYOUT — HARD RULES (the #1 source of overlapping UI):
  The viewport has FIVE reserved corners. ONE panel per corner, NEVER two:
    top-left(0,0)→(320,∞)   = #hud  (title + goal + progress)
    top-right(∞,0)→(320,∞)  = controls/sliders panel OR score — pick ONE
    bottom-left               = legend (collapsible, max 180px wide)
    bottom-right              = reset button only (not a full panel)
    bottom-center             = hint strip (single line, no taller than 40px)
  If you have MORE than one secondary panel (e.g. Controls + Live Metrics + Formula),
  STACK THEM VERTICALLY inside the SAME top-right column (display:flex; flex-direction:column; gap:8px)
  rather than placing each in a different position. They must never overlap #hud.

  COLLAPSIBLE SECONDARY PANELS — MANDATORY when total panel height > 60% of viewport:
  Every secondary panel (Controls, Live Metrics, Formula, Legend) MUST have a collapse toggle:
    <div class="panel">
      <div class="panel-header" onclick="this.parentElement.classList.toggle('collapsed')" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
        <span>Controls</span><span class="chevron">▲</span>
      </div>
      <div class="panel-body">...sliders...</div>
    </div>
    .panel.collapsed .panel-body { display:none; }
    .panel.collapsed .chevron { transform:rotate(180deg); }
  The #hud (top-left goal/progress panel) is ALWAYS fully visible and cannot be collapsed.
  All other panels start EXPANDED but collapse to their header bar on one click — giving the
  learner a clear stage to work in.

  SELF-TEST before returning: open the lab at 1280×800. Mentally drag every fixed panel's
  bounding box onto the viewport grid. If ANY two boxes overlap by more than 4px, the layout
  is BROKEN — move panels or collapse them until there is zero overlap.
  NO TEXT OVERLAP — each fixed panel sits in its OWN screen corner and must not collide:
    • top-left = #hud, bottom-left = legend, bottom-right = reset, bottom-center = hint strip, top-right = score/timer.
    • Give each panel a max-width (≤320px) so long text wraps INSIDE its panel instead of spilling across the screen.
    • Use normal block flow inside a panel (stacked divs / line-height ≥1.4) — never absolutely-position two text lines at the same top offset.
    • CSS2D labels must use a small font and an opaque/blurred background chip so they stay readable when several overlap in 3D; offset labels above their mesh, never centered on it.
    • Leave ≥16px gap between any two fixed panels; if two would touch on a narrow viewport, the lower-priority one collapses to an icon.

SECTION 5 — Drag / interaction
  • Raycaster for 3D drag: pointerdown → find intersected object → pointerup → snap/reject
  • For 2D labs: addEventListener('input'/'click') on every control writing to a shared state object
  • canvas pointer-events must NOT block HUD clicks — set CSS2DRenderer layer to pointer-events:none and confirm HUD divs are above the canvas in z-order.

SECTION 6 — Place / win logic (topic-specific)
  • Correct drop/match/target → tweenTo snap + offspring bloom + burst(x,y,color) + increment counter
  • Wrong → flashWrong (red emissive flash 260ms + hint text 1.8s) then tweenTo back to home
  • When complete: update ratio display, setTimeout 500ms then show #win overlay + 6 staggered bursts + postMessage

SECTION 7 — Win overlay + postMessage (MANDATORY, copy verbatim)
  <div id="win" style="position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:rgba(5,5,8,.6);backdrop-filter:blur(3px);z-index:5">
    <div class="grade">[grade]</div><div class="msg">[win message]</div><div class="sub2">[payoff sentence]</div>
  </div>
  try { window.parent.postMessage({ type:'labCheck', result:{ ok:true, score:1, total:1 } }, '*'); } catch(_){}

SECTION 8 — Tween system (copy verbatim — this is what makes motion smooth, not CSS transitions)
  const tweens = [];
  function ease(t){ return t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2; }
  function tweenTo(obj, to, dur, done){ tweens.push({obj,kind:'pos',from:obj.position.clone(),to:to.clone(),t:0,dur,done}); }
  function tweenScale(obj, to, dur, done){ tweens.push({obj,kind:'scale',from:obj.scale.x,to,t:0,dur,done}); }
  function updateTweens(dt){ for(let i=tweens.length-1;i>=0;i--){ const tw=tweens[i]; tw.t+=dt/tw.dur;
    const k=ease(Math.min(tw.t,1)); if(tw.kind==='pos') tw.obj.position.lerpVectors(tw.from,tw.to,k);
    else tw.obj.scale.setScalar(tw.from+(tw.to-tw.from)*k); if(tw.t>=1){if(tw.done)tw.done();tweens.splice(i,1);} } }

SECTION 9 — Particle bursts (copy verbatim)
  const bursts = [];
  function burst(x,y,color){ const n=70,g=new THREE.BufferGeometry(),pos=new Float32Array(n*3),vel=[];
    for(let i=0;i<n;i++){ pos[i*3]=x;pos[i*3+1]=y;pos[i*3+2]=0.8;
      const a=Math.random()*Math.PI*2,s=2+Math.random()*4;
      vel.push(new THREE.Vector3(Math.cos(a)*s,Math.sin(a)*s,(Math.random()-.5)*3)); }
    g.setAttribute('position',new THREE.BufferAttribute(pos,3));
    const p=new THREE.Points(g,new THREE.PointsMaterial({color,size:0.16,transparent:true,opacity:1,blending:THREE.AdditiveBlending}));
    scene.add(p); bursts.push({p,vel,life:0}); }
  function updateBursts(dt){ for(let i=bursts.length-1;i>=0;i--){ const b=bursts[i];b.life+=dt;
    const arr=b.p.geometry.attributes.position.array;
    for(let j=0;j<b.vel.length;j++){arr[j*3]+=b.vel[j].x*dt;arr[j*3+1]+=b.vel[j].y*dt-2*dt*b.life;arr[j*3+2]+=b.vel[j].z*dt;}
    b.p.geometry.attributes.position.needsUpdate=true;b.p.material.opacity=Math.max(0,1-b.life/1.3);
    if(b.life>1.3){scene.remove(b.p);bursts.splice(i,1);} } }

SECTION 10 — THE ANIMATION LOOP (THE only place rendering ever happens — copy this structure verbatim)
  const clock = new THREE.Clock();
  function animate(){
    requestAnimationFrame(animate);           // always reschedules itself
    const dt = clock.getDelta();             // called EXACTLY ONCE per frame
    const t  = clock.elapsedTime;
    updateTweens(dt);
    updateBursts(dt);
    // [topic-specific per-frame updates here: move meshes, rotate objects, advance physics]
    // CRITICAL: Every mesh/object accessed in animate() MUST be declared at the top scope
    // and initialized BEFORE animate() is called. NEVER access .position/.x/.y/.z on
    // a variable that could be null/undefined. Use: if (myMesh) myMesh.position.x = ...
    // idle life: objects bob/rotate; dust drifts; camera.position.x = Math.sin(t*0.15)*0.5; camera.lookAt(0,0.3,0)
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  animate(); // ← called ONCE to start the loop

SECTION 11 — Resize + reset (copy verbatim structure)
  addEventListener('resize', ()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth,innerHeight); labelRenderer.setSize(innerWidth,innerHeight); });
  document.getElementById('reset').onclick = () => { /* restore all objects to home positions, clear placed/won state */ };

CDN URLS (use EXACTLY these — no other versions):
  Three.js r128:  https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js
  CSS2DRenderer:  https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/renderers/CSS2DRenderer.js
  GSAP 3.12.5:    https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js
  D3 v7.9.0:      https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js
  KaTeX 0.16.11:  https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js
                  https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css
  Google Fonts:   https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@500;700&display=swap
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ THE THREE PILLARS — judge the whole lab on these before anything else ━━━
A lab that nails the visuals but misses any pillar below is a FAILED lab. These outrank every other instruction:

  1. SPECIFIED INTERACTIVITY — the learner DRIVES, never watches.
     • The primary action happens IN the 3D play area: grab/drag, aim-and-release, or steer with held arrow keys (+ mirrored on-screen ◀▲▼▶ touch buttons). Sliders are secondary only.
     • Every single control produces an immediate, visible, meaningful change (<100ms). No inert controls, no decorative motion, no "press play and watch."
     • Within 3 seconds of the sim appearing, there is something obvious to grab and the learner already knows what to do without reading instructions.

  2. GAMIFIED EXPERIENCE — it is a GAME the learner plays to WIN, not a sandbox to poke.
     • A concrete WIN GOAL drawn on the canvas (target ring / finish zone / threshold line) with LIVE progress toward it (meter fills, target glows brighter, counter counts up).
     • Score / streak / attempts / match-% HUD that reacts to every action; 2–4 live consequence bars that animate fast so the learner waits to see where they land.
     • NEAR-MISS FEEDBACK that teaches in the concept's own words on every failed attempt, then instant retry.
     • A WIN STATE winnable ONLY by using the concept's real mechanism → golden-burst celebration + S/A/B/C/D grade + labCheck postMessage. Auto-detect the win the instant it happens.

  3. REAL-WORLD CONNECTION — the concept must visibly operate in the actual world.
     • Open on a CONCRETE real instance (a real role/place/dollar amount/news moment) and, when quantitative, draw the real target (ghost curve / dotted trajectory / historical line, labeled with real name + units) the learner reverse-engineers.
     • The REVEAL lands the real_world_payoff as one concrete sentence: "[What you just did] is why [real-world consequence]." — not a generic topic summary.
     • Real units on every readout (N, m/s², $, %, °). The learner should leave seeing this concept in their savings account, the ISS overhead, the bridge they drive over — not just on a screen.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ TOPIC-SPECIFIC VISUAL PEDAGOGY (apply these rules above all generic patterns) ━━━
The following analysis was written specifically for "${design.topic}" — use it to override any generic instruction that conflicts:

${pedagogy}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${interactionContractBlock(interactionContract)}
You are building a single self-contained interactive learning lab. LAB ARCHETYPE: ${archetype.toUpperCase()}. You MUST output a complete, working HTML file right now — no summaries, no explanations. You must not redesign the harness; use its structure exactly and only replace the domain-specific contents.

${imageDataUrl ? `You are given two inputs:
1. A VISUAL MOCKUP (image) — use ONLY for layout, color, spatial arrangement.
2. A BEHAVIORAL BRIEF (below) — source of truth for what the lab DOES. Brief wins over image always.
` : `You are given a behavioral brief below — the source of truth for what the lab does.`}

GOAL: the learner enters a cinematic 3D world, manipulates topic-specific variables, watches the mechanism unfold in real-time, and earns understanding through immersive interaction.

COURSE CATEGORY: ${cat}
CATEGORY AESTHETIC: ${categoryGuidance(cat)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REPEND COLOR PALETTE — use EXACTLY these colors in ALL CSS and Three.js materials (matches platform UI):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Background/void: ${REPEND_THEME.void}
• Scene fog: ${REPEND_THEME.fog}
• Mars rust accent: ${REPEND_THEME.mars} (buttons, borders, emissive highlights)
• Mars deep: ${REPEND_THEME.mars2}
• Dust/secondary: ${REPEND_THEME.dust}
• Copper/gold: ${REPEND_THEME.copper} (trails, celebration bursts)
• Ice HUD: ${REPEND_THEME.ice} (readouts, labels, telemetry)
• Muted text: ${REPEND_THEME.muted}
• Success: ${REPEND_THEME.green}
• HUD glass: ${REPEND_THEME.glass} with border ${REPEND_THEME.border}
• Fonts: 'Inter' for UI, 'JetBrains Mono' for numbers/readouts

${cat === "Sports & Skills" || archetype === "sports-game" ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SPORTS VIDEO-GAME MODE (required for this category):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This lab is a PLAYABLE SPORTS VIDEO GAME, not a passive sim:
• Real venue: full 3D court/field/pool with accurate markings, stadium floodlights, crowd particle ambience
• Scoreboard HUD: attempts, makes, streak counter, mission target
• Controls: keyboard-steer (arrow keys/WASD) + on-screen touch buttons (◀ ▲ ▼ ▶) for mobile
• Gameplay loop: aim → release/steer → watch physics → near-miss feedback → instant retry
• Ghost replay: faded TubeGeometry trail of previous attempt for comparison
• Win condition: hit mission target (make the shot, reach the zone, beat the par)
• Celebration: golden particle burst + camera zoom on success
` : ""}

${archetypeArchitecture["physics-sim"] ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THREE.JS BASE ARCHITECTURE (implement this skeleton, then fill with topic-specific meshes):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x1a0800, 0.04);
const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 800);
const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
// Ambient + warm directional + rim point light; starfield Points; dust particles
// Build topic-specific Group (court, planet, molecules, etc.)
// HUD: position:fixed glass overlay for sliders/readouts
// Physics loop in animate(): integrate projectile/orbit/etc., update TubeGeometry arc trail
// GSAP: camera transitions on threshold crossings
window.addEventListener('resize', () => { camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

ARCHETYPE PATTERN (${archetype}):
${archetypeArchitecture[archetype] || archetypeArchitecture["physics-sim"]}
` : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


LABEL EVERYTHING, ONE WORD (PhET: one-word labels are read correctly without over-guiding):
• Every distinct object on the canvas carries a one-word label drawn ON or beside it — "Box A", "Earth", "Buyer". The learner must never see a shape and wonder what it is. In your Newton's-third-law example the two circles were unlabeled — that is the failure to fix: label them ("Hand", "Wall" / "Cart A", "Cart B") and draw the force arrow pointing FROM each onto the other.
• Provide a small legend (top of play area) only for color/encoding meaning ("● red = negative charge"). Keep it to encodings, not instructions.

SPATIAL CONTIGUITY (Mayer, effect size d≈1.09 — strongest in the literature): put each label/readout immediately ADJACENT to the thing it describes, never in a far-off panel. A value that names an object's state is drawn next to that object, not in a side list.

COHERENCE — STRIP THE EXTRANEOUS (Mayer d≈0.97; PhET removes wire colors etc.): every element either reacts to input or displays a result. No decorative motion, no ornamental shapes, no element that doesn't encode meaning. If deleting it loses no understanding, delete it.

SIGNALING (Mayer d≈0.38): when a control changes a value, briefly highlight the affected element/term (color flash or glow) so attention goes to what changed.

PHYSICAL TRUTH — NO FAKE VARIABLES: every control must map to a real term in a formula and visibly change a real output. Never invent a topical-sounding-but-inert variable (the "Contact Surface" slider on Newton's third law was exactly this bug — it affects nothing in F = -F and must not exist). If a variable drives no formula, delete it. Three honest controls beat four with one lie — the learner WILL move it and learn something false.

REAL UNITS ONLY — NEVER PIXELS, NEVER BARE NUMBERS: every readout is a named quantity with a real unit (N, m/s², kg, m, %, $, °). Declare a world scale (e.g. const PX_PER_M = 50) and convert: show "Separation: 3.1 m", never "154 px"; show "Acceleration: 3.2 m/s²", never "Resulting Motion: 7.12".

SOLID OBJECTS CANNOT OVERLAP (the intertwining-circles bug): if two bodies are drawn as solid, they must collide, not pass through each other. Use circle-circle resolution every frame, including during drag:
  const dx=B.x-A.x, dy=B.y-A.y, dist=Math.hypot(dx,dy)||0.0001, minDist=A.r+B.r;
  if (dist < minDist) {
    const nx=dx/dist, ny=dy/dist, overlap=(minDist-dist);
    // push each out by half the overlap (or push only the non-dragged one if one is grabbed)
    A.x-=nx*overlap/2; A.y-=ny*overlap/2; B.x+=nx*overlap/2; B.y+=ny*overlap/2;
  }
  When the learner drags one body into another, the dragged one stops at contact (clamp it to minDist along the normal) — they touch and exert force, they never interpenetrate.

DRAGGABLE AFFORDANCES (Norman/Shneiderman): every grabbable object signals it — cursor 'grab' on hover, 'grabbing' while dragging, plus a subtle hover glow/shadow. Hit radius ≥ 24px for touch. Position updates synchronously with the pointer (no lag).

━━━ SCENE CONTENT = THE LITERAL TOPIC (this overrides every aesthetic note below) ━━━
The 3D world must DEPICT "${design.topic}" literally. The "NASA / cinematic" references below describe RENDERING QUALITY ONLY (good lighting, fog, glass HUD, smooth camera) — they are NOT instructions to build a space scene. Do NOT add planets, orbits, spacecraft, "Voyager", rovers, or starfields unless the topic is GENUINELY about astronomy/space.
• Language lab (e.g. Telugu, Spanish): the scene is built from large legible 3D LETTERS/CHARACTERS/WORDS the learner drags and matches, audio-waveform ribbons, translation cards that snap together — NOT planets.
• History/literature/art lab: timelines, 3D artifacts, document panels, scenes — NOT planets.
• If you catch yourself drawing an unlabeled sphere called "Body" or a generic orbit, STOP — that means you defaulted to space instead of depicting the real topic. Build the real subject instead.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHOOSE THE RIGHT MEDIUM — 3D IS NOT ALWAYS CORRECT:

Pick 2D (D3/SVG/canvas) or 3D (Three.js) based on what the topic actually IS — never default to 3D out of habit:
- Use 2D (D3 chart/SVG as the PRIMARY visual) when the concept is fundamentally a chart, curve, distribution, or dataset the learner reads on axes: compound interest, supply & demand, sampling distributions, population growth curves, budget tradeoffs, any "value over time/inputs" topic. A 3D mesh sitting on top of axes makes data unreadable — never let geometry occlude a chart.
- Use 3D (Three.js as the PRIMARY visual) when the concept is spatial, physical, or about objects in space: projectile motion, orbital mechanics, molecular structure, anatomy, pendulums, vectors, anything the learner manipulates as a literal 3D object.
- Either is fine for emergent/agent-based or sequential-process topics — pick whichever depicts the literal topic most legibly; Three.js may render flat/orthographic if that reads better than perspective.
- If you chose 2D, Three.js becomes OPTIONAL decorative chrome only (subtle particles, ambient glow) — it must NEVER block, underlap z-order, or compete with the chart/data layer. When in doubt, leave Three.js out entirely; a clean D3/SVG lab beats a cluttered hybrid.

WHEN 3D IS THE PRIMARY VISUAL (cinematic WebGL production quality: geometry-rich worlds, atmospheric fog, smooth camera motion, glass HUD overlays, particle dust, emissive accents — applied to the LITERAL TOPIC, never a space scene unless the topic is space):

- Load: <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
- Also load GSAP for cinematic camera/object transitions; OrbitControls (from three/examples) for optional orbit
- Scene fills the viewport — dark UI palette: bg #050508, fog #1a0800, accent #E85D04, copper #D4A574, ice HUD #4CC9F0 (these are the app's THEME COLORS, not a space setting)
- Environment: fog (FogExp2), particle dust (Points), animated rim light, and a backdrop that FITS THE TOPIC (a classroom, a board, a map, a stage — a starfield ONLY for space topics)
- Camera: cinematic — slow idle drift, smooth lerp on changes, dramatic zoom on aha moments
- HUD: floating glass panels (backdrop-filter blur) for controls/readouts — NASA mission-control aesthetic
- TOPIC FIDELITY: 3D world MUST match the topic literally. Basketball = court, hoop, ball arc (TubeGeometry trail), release angle°, power, distance m. Waves = 3D ripple surface. NEVER generic empty grid.
- VISUAL REFERENCE — cinematic production quality (Pablo Coronel craft level): MeshStandardMaterial with emissive accents, FogExp2 atmosphere, dust particles, warm directional + cool rim PointLight, ACESFilmicToneMapping, toneMappingExposure 1.2. Labs must feel like a real, polished place built FROM THE TOPIC — NOT flat UI mockups, NOT placeholder cubes, and NOT a generic space scene.
- REAL OBJECTS: build recognizable 3D meshes for EVERY topic element. Use procedural textures via CanvasTexture where needed (wood court grain, pebbled basketball, grass field). Never use untextured gray boxes as stand-ins.
- Sports/projectile: show optimal arc as ghost reference line; learner adjusts angle/power/distance; ball flies in real-time physics
- Interaction: raycasting, 3D aim handles, HUD sliders updating meshes/materials live

WHEN 2D IS THE PRIMARY VISUAL (D3/SVG production quality — this is NOT a fallback, it is the correct choice for chart-shaped topics):

- Full-viewport SVG with clearly labeled axes (units in the axis label, not just numbers).
- Two visually distinct curves/series when comparing (target vs learner's model): bright solid for the learner's live result, faded/dotted for a reference/target.
- Smooth D3 transitions (150-300ms ease) on every redraw — never a hard jump-cut when a slider moves.
- Same dark theme/accent colors as the 3D path (bg #050508, accent #E85D04, ice HUD #4CC9F0) so the lab still feels like one product.
- Optional: a thin decorative Three.js/CSS particle layer BEHIND the SVG (lower z-index, low opacity) for ambience — never in front of, or touching, the data.

FIXED LAYOUT SKELETON — every lab (2D or 3D) uses the same zones so nothing is ad-hoc or confusing:
- Title bar (top): topic name + one-line goal.
- Zone B — main stage (center, largest area): the primary visual (3D scene OR D3 chart). This is the only place complex visuals live.
- Zone A — controls/HUD (docked left or right, fixed width): sliders/buttons/toggles, never floating loose over Zone B.
- Readout panel (pinned within Zone A or a thin strip under the title): live numeric/categorical results, formula/principle panel.
- HARD RULE — NO OVERLAP: Zone A must never visually cover Zone B. No control, panel, or decorative mesh may sit on top of the chart/3D stage such that any axis, curve, mesh, or label becomes hard to read. If a panel must float over the stage (e.g. a modal win-card), it appears only momentarily and dismisses, never persists during normal interaction.

CLICK-LAYERING CONTRACT — "nothing is clickable" is the #1 fatal bug; prevent it EXACTLY like this:
A full-viewport Three.js/canvas renderer sits ON TOP of your HUD in the stacking order by default and SILENTLY SWALLOWS every click meant for a slider/button — the controls look fine but do nothing. You MUST layer explicitly:
  • Canvas/renderer.domElement: position:fixed; inset:0; z-index:0;  (the bottom layer)
  • Every HUD/control container (Zone A, readouts, mission bar, buttons): position:relative or fixed with z-index:10 AND pointer-events:auto.
  • If the canvas itself needs NO direct interaction (all input comes from DOM sliders/buttons), set the canvas pointer-events:none so clicks pass straight to the HUD.
  • If the canvas DOES need interaction (dragging a 3D object via raycaster), keep canvas pointer-events:auto but ensure every HUD element has a HIGHER z-index so it still receives its own clicks.
SELF-TEST before returning: mentally click each slider and button — does a DOM element with pointer-events:auto and a z-index above the canvas sit under the cursor? If the canvas is on top with pointer-events:auto and no HUD layer above it, the lab is BROKEN.

WIRING CONTRACT — "it's static / nothing happens" is just as fatal:
Every control MUST have an event listener that writes to state, and the animate() loop MUST read state every frame (see ANIMATION-LOOP CONTRACT below). A slider with no 'input' listener, or a sim whose animate() never started (animate() not called once at the end), produces exactly this dead screen. Before returning: every slider has addEventListener('input',...), every button has addEventListener('click',...), and animate() is invoked once to start the loop.

ANIMATION POLISH — motion must read as professional, not janky:
- Durations: small UI transitions 150-200ms, larger/full-stage transitions 300-400ms. Exits are shorter than entrances.
- Easing: entrances use ease-out (fast start, gentle settle); exits use ease-in; everything else uses ease-in-out. Never linear easing for discrete UI motion (linear is fine only for continuous idle motion like a slow ambient rotation).
- Stagger related elements entering together by ~20-50ms each — never move a whole group in perfect unison, it looks cheap.
- CSS animations: animate ONLY transform and opacity (never top/left/width/height — those cause layout reflow/jank).
- Three.js camera moves: use GSAP tweens (gsap.to(camera.position, {...duration, ease:"power2.out"})) or a damped lerp scaled by dt — never an instant snap cut and never a raw per-frame lerp that ignores dt (that runs at different speeds on different frame rates).

CONTROL-BOUNDS CONTRACT — controls must obey the physics of the topic, not be wide-open:
"A slider that goes anywhere / a button that does anything" makes the lab feel broken and lets the learner reach nonsense states. Every control MUST be constrained to values that are MEANINGFUL for THIS topic:
  • Sliders: set min, max AND step to the real domain. e.g. probability 0–1 step 0.01; pH 0–14 step 0.1; interest rate 0–20(%) step 0.25; an angle 0–90° step 1. Never leave a slider at the default 0–100 if the concept's real range is different.
  • Clamp in code too: in the 'input' handler, clamp state to the valid range so keyboard/edge cases can't escape it (state.x = Math.min(max, Math.max(min, +e.target.value))).
  • Disable controls that don't apply in the current mode: btn.disabled = true and visually dim them (opacity:.4; cursor:not-allowed) rather than letting them do nothing silently. Re-enable when they become relevant.
  • Discrete choices (an allele, an element, a phase) must be a fixed set of buttons/options — never a free slider that can land between valid values.
  • If a value is physically impossible (negative mass, >100% efficiency), the control must not be able to produce it — bound it.

AFFORDANCE & ROLE CONTRACT — the learner must instantly know WHAT each control does and HOW it impacts the system:
Every interactive element carries an explicit, visible role. Unlabeled sliders/objects are rejected.
  • Each control gets a text label naming (a) the action verb, (b) the thing acted on, and (c) the effect. Format: "<verb> <noun> → <what changes>". e.g. "Drag the ball → changes launch angle", "Slide Rate → faster growth", "Click an allele → place it in the Punnett square".
  • Draggable canvas objects show a grab cursor (cursor:grab → grabbing) AND a small floating CSS2D hint ("drag me") on first load that fades after the first interaction.
  • Every control sits next to a LIVE readout of its current value and its consequence, so cause→effect is never a mystery (e.g. "Rate: 5% → doubles in ~14 yrs").
  • Use the verb set deliberately and match the implementation: DRAG (pointer move on canvas), MOVE/SLIDE (range input), CLICK/PLACE (discrete action), TOGGLE (boolean), DECIDE/CHOOSE (pick one of a set). The label's verb MUST equal the actual interaction wired up.

MANDATORY CONTROLS LEGEND — this is REQUIRED and is the #1 thing labs keep missing; build it EXACTLY:
A persistent, always-visible panel (docked in Zone A, titled "Controls" or "How to play") that ENUMERATES every interactive element as its own line. This is a structural DOM element, not optional inline hints. Each line is:
    <icon/swatch>  <NAME> — <VERB> it → <the exact effect on the sim>
e.g.
    🎚️  Launch Angle — SLIDE → raises/lowers the arc of the shot
    🟠  The Ball — DRAG on the court → sets where you shoot from
    🔘  Slow-Mo — TOGGLE → replays the last shot frame-by-frame
RULES for the legend:
  • There must be exactly ONE legend line per interactive element in interaction_palette — no control may exist on screen without a corresponding legend line, and no legend line may describe a control that isn't wired.
  • State the GOAL as the first line of this panel ("GOAL: sink 3 shots in a row"), then list the controls.
  • Keep each line ≤ 8 words after the verb. Concrete effect, not vague ("changes the graph" is BANNED — say "steepens the growth curve").
  • The legend stays visible during play (it may collapse to an icon the learner can re-open, but the goal line stays). Never hide all instructions after load.
SELF-TEST: count the interactive elements on screen, then count the legend lines. If they don't match 1:1, the lab is INCOMPLETE — add the missing lines.

ONBOARDING CONTRACT — the learner must never face a blank, unexplained lab:
  • A short "How this works" strip is visible on load (max 2 lines): what the lab shows + the very first thing to try (use design.spec.first_move). It may auto-dismiss after the first interaction or sit pinned in the title area — but it is ALWAYS present at t=0.
  • The GOAL is stated in one line at the top ("Match the offspring ratio to 3:1") and a progress/mission meter shows how close they are — so there is always a clear objective, never aimless poking.
  • LEARNING OBJECTIVES — render a small "🎯 Objectives" panel (collapsible, in a HUD corner) with EXACTLY 2-3 outcome-based bullets describing what the learner will be able to DO after this lab, phrased as observable skills, not topics. Start each with an action verb (Predict, Compare, Explain, Derive, Identify, Trade off) and tie it to the actual manipulation, e.g. "Predict how nanoparticle size shifts emission color" — NOT "Learn about quantum dots". Each objective must map to something the learner physically does in THIS lab and to the aha_trigger. Use design.spec.learning_goal + the key variables to write them. Keep each bullet under 12 words. These objectives are the contract for what the lab teaches — make them sharp, specific, and measurable.
  • A legend names every distinct visual element on the stage (what each color/shape/mesh represents). No unexplained symbols.
  • INTRO OVERLAY RULE — if you use a full-screen "Start Exploring" or "Begin" overlay, its dismiss button MUST be wired: use a plain inline onclick on the element itself (e.g. <button onclick="document.getElementById('intro').style.display='none'">Start Exploring</button>) AND add a separate addEventListener('click',...) as a backup — never rely on z-index alone. The overlay div must have z-index≥100 AND pointer-events:auto so it can receive the click. PREFERRED pattern (no JS wiring issues): skip the overlay entirely and use the 2-line hint strip pinned at the bottom-center of the HUD instead — it is always visible and never blocks interaction.
  • SELF-TEST before returning: a first-time user with zero instructions from you should know, within 3 seconds, (1) what they're looking at, (2) what to touch first, and (3) what success looks like. If any of the three is unclear, add the missing label/strip.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VISIBILITY CONTRACT — a black scene is a broken lab
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The most common Three.js failure is a scene that renders nothing because lighting is missing or objects spawn off-camera. Prevent it with this mandatory setup:

LIGHTING — always include ALL THREE, copy exactly:
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);   // bright ambient so nothing is pitch black
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);
  const rimLight = new THREE.PointLight(0x4CC9F0, 0.8, 30);    // ice-blue rim
  rimLight.position.set(-5, 3, -5);
  scene.add(rimLight);

CAMERA — position it so objects at the origin are visible:
  camera.position.set(0, 4, 10);   // or topic-appropriate, but NEVER at origin looking at origin
  camera.lookAt(0, 0, 0);

MATERIALS — never use MeshStandardMaterial without emissive when in doubt; use MeshLambertMaterial or add emissive:
  new THREE.MeshStandardMaterial({ color: 0x9B59B6, emissive: 0x4A1070, emissiveIntensity: 0.4 })
  Every mesh must be visible under the ambient light above — if it's black, increase emissiveIntensity.

STARTUP CHECK — the very first frame must show something the learner can grab. Place all interactive objects within camera view at (x:0±3, y:0±2, z:0) by default. Never spawn objects at (0,0,0) if that's inside another mesh, and never off-screen.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE ANIMATION-LOOP CONTRACT (this is why labs feel dead — follow it EXACTLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A Three.js scene only moves when state is mutated inside a self-rescheduling per-frame loop. Most broken labs render once and freeze, or wire a slider straight to a render call. Build it like this, with NO exceptions:

1. ONE shared mutable state object holds everything that can change:
     const state = { /* positions, velocities, target, score, matchPct, won:false, ...topic values */ };
   ⚠️ CONST vs LET — THE #1 CAUSE OF "Assignment to constant variable" CRASHES:
   • const means the binding cannot change — NEVER use it for values you mutate in update() or event handlers.
   • All numeric counters, scores, positions, angles, velocities, and flags that animate() or update() writes to
     MUST be either (a) properties on the shared state object (state.score += 1 is correct) or (b) declared with let.
   • NEVER do:  const score = 0; ... score++;   — this throws "Assignment to constant variable" every frame.
   • ALWAYS do: let score = 0;   or put it in state:   const state = { score: 0 }; ... state.score++;
   SELF-TEST: scan your output for any const variable that appears on the LEFT-HAND side of =, +=, -=,
   ++, --, or inside a for-loop body that reassigns it. If you find one, change it to let or move it into state.
2. ONE animation function is the ONLY place rendering happens:
     const clock = new THREE.Clock();
     function animate(){
       requestAnimationFrame(animate);
       const dt = clock.getDelta();              // call getDelta EXACTLY ONCE per frame
       update(dt);                                // mutate meshes FROM state, scaled by dt
       if (controls) controls.update();           // damped OrbitControls are DEAD without this
       checkWin();                                // auto-detect win every frame
       renderer.render(scene, camera);
       if (labelRenderer) labelRenderer.render(scene, camera);
     }
     animate();
3. EVERY UI control writes ONLY to state — it must NEVER render directly:
     slider.addEventListener('input', e => { state.velocity = +e.target.value; });   // loop reacts next frame
     Drag/keyboard handlers also only set state.* . The loop is what moves the meshes.
4. update(dt) must produce VISIBLE motion every frame the input is non-neutral: move a mesh.position, rotate, scale, lerp a material color, advance a progress meter. If moving a control changes no mesh on screen, the lab is BROKEN — wire it or delete it.
5. checkWin(): when state hits the target (e.g. state.matchPct >= 95), set state.won=true ONCE, fire a particle burst + gsap.to(camera) zoom + show a grade + postMessage labCheck. The mission meter must be REACHABLE: verify there exist control values that drive it to 100%. A mission stuck at 0% no matter what the learner does is the #1 failure — make the win mathematically achievable and show progress climbing as they get closer.
6. LABEL every interactive/important mesh with CSS2DRenderer + CSS2DObject (or a Sprite) showing its real name/value ("Codon", "tRNA", "$4,820") — NEVER an unnamed "Body" sphere. Import: CSS2DRenderer from the three addons; new CSS2DObject(div); mesh.add(label).
7. Frame-rate independence: all motion uses dt (e.g. mesh.position.x += state.v * dt). Never bare per-frame increments.
8. Output ONE complete, runnable HTML file — no "// ..." placeholders, no TODO. Use Three.js r128 from the CDN exactly as given (do NOT invent version strings like r165).

CONCRETE-FIRST (PhET + Nicky Case, proven): the learner's FIRST action is hands-on within 3 seconds — drag/aim/place something — BEFORE any explanation. Don't describe the system; let them run it and watch it react. The core action they repeat must BE the concept itself (intrinsic integration — drag the right anticodon = IS learning translation), not a points wrapper around a quiz.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TOPIC: ${design.topic}
CONCEPT TYPE: ${archetype}
ENTRY MISCONCEPTION: "${design.spec.entry_misconception || ""}"
FIRST MOVE (what to try first — it should surprise them): "${design.spec.first_move || ""}"
LEARNING GOAL: ${design.spec.learning_goal}
VISUAL METAPHOR: "${design.spec.visualMetaphor}"
${design.spec.direct_manipulation ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIMARY DIRECT MANIPULATION (NOT a slider — the learner grabs this on the canvas):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${design.spec.direct_manipulation}
` : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED INTERACTIONS — implement every one of these:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${(design.spec.interaction_palette || []).map(p => `  [${p.type}] ${p.element} → ${p.effect}`).join("\n") || `  [draggable] at least one canvas object the learner grabs and drags
  [click-spawn] clicking the canvas creates a visible effect
  [toggle-button] at least one toggle that flips a boolean and changes the visual`}

INTERACTION CODE PATTERNS — copy these exact patterns for each type:

[draggable] Grab and drag a canvas object (with grab/grabbing cursor + solid-collision clamp):
  let drag = null;
  const HIT = Math.max(28, state.obj.r); // ≥24px touch target
  canvas.addEventListener('pointerdown', e => {
    const {mx, my} = canvasPt(e);
    if (Math.hypot(mx - state.obj.x, my - state.obj.y) < HIT) {
      drag = { ox: state.obj.x - mx, oy: state.obj.y - my };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointermove', e => {
    const {mx,my}=canvasPt(e);
    if (drag) {
      state.obj.x = mx + drag.ox; state.obj.y = my + drag.oy;
      // SOLID COLLISION: if obj would overlap another solid body, clamp it to contact (no interpenetration)
      for (const other of state.solids) {
        if (other === state.obj) continue;
        const dx=state.obj.x-other.x, dy=state.obj.y-other.y, d=Math.hypot(dx,dy)||0.0001, min=state.obj.r+other.r;
        if (d < min) { const nx=dx/d, ny=dy/d; state.obj.x=other.x+nx*min; state.obj.y=other.y+ny*min; }
      }
    } else {
      canvas.style.cursor = Math.hypot(mx-state.obj.x,my-state.obj.y)<HIT ? 'grab' : 'default'; // hover affordance
    }
  });
  canvas.addEventListener('pointerup', () => { drag=null; canvas.style.cursor='default'; });
  function canvasPt(e) { const r=canvas.getBoundingClientRect(); return { mx:(e.clientX-r.left)*(canvas.width/r.width), my:(e.clientY-r.top)*(canvas.height/r.height) }; }
  // Touch: set CSS touch-action:none on the canvas so dragging doesn't scroll the page.

STEP 0 — Classify the concept. Decide which type "${design.topic}" is:

- Quantitative/functional (output varies with continuous inputs — e.g. compound interest, supply & demand)
- Dynamic physical system (evolves over time by physical law — pendulum, orbit)
- Emergent/agent-based (macro pattern from many interacting entities — natural selection, diffusion, traffic)
- Sequential process/mechanism (ordered causal chain — photosynthesis, cell division)
- Spatial/geometric (invariants in space — vectors, transformations)
- Probabilistic/statistical (variation over many trials — sampling distributions, CLT)
- Abstract/relational (relations with no spatial form — logical fallacies, tradeoffs)
- Network/feedback (loops, accumulation, delay — climate feedback, market equilibrium)

[keyboard-steer] Arrow keys / WASD steer the main object like a game — REQUIRED whenever the concept has a movable object (rocket, particle, organism, cursor). Track HELD keys in a Set so holding a key produces continuous action every frame:
  const held = new Set();
  window.addEventListener('keydown', e => {
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','KeyW','KeyA','KeyS','KeyD'].includes(e.code)) {
      held.add(e.code); e.preventDefault();
    }
  });
  window.addEventListener('keyup', e => held.delete(e.code));
  // Inside update(dt), every frame:
  //   if (held.has('ArrowUp')||held.has('KeyW'))    applyThrust(dt);   // continuous while held
  //   if (held.has('ArrowLeft')||held.has('KeyA'))  steerLeft(dt);
  //   if (held.has('Space')) controls.paused is toggled on keydown only, not here
  Show a small hint chip on the canvas: "← → ↑ ↓ to steer (click the play area first)" — the iframe needs focus before keys register.
  ALWAYS mirror every keyboard action with on-screen touch buttons (◀ ▲ ▼ ▶ in a corner of Zone B, pointerdown=press, pointerup=release, feeding the same held Set) so phones get the identical game.

- Quantitative/functional → slider(s) + a live linked chart AND a concrete real-world referent (money stacks growing, not just a curve)
- Dynamic physical → learner-controlled canvas animation (requestAnimationFrame) + a live linked graph; draggable starting conditions
- Emergent/agent-based → a canvas with MANY visible individual entities following local rules + controls to perturb the environment; show the macro pattern emerging from the entities. NEVER a single slider on an aggregate curve.
- Sequential process → a learner-paced step-through ("next" button), each step highlighting the one thing that changes. NEVER autoplay-only.
- Spatial/geometric → draggable objects with live measurements that expose what stays invariant
- Probabilistic → animate individual trials accumulating into a building histogram; learner sets sample size and runs many trials
- Abstract/relational → sort-into-bins with feedback, or side-by-side contrasting cases; for tradeoffs, a slider that visibly gives up one thing to gain another
- Network/feedback → stocks that visibly fill/drain and flows the learner adjusts + a linked time graph

STEP 2 — Open straight into the interactive sim. The learner's first action is hands-on within 3 seconds — no gate, no modal, no question before they can touch it.
- Manipulate: the full interactive visual is live immediately on load. Every control produces immediate, visible, meaningful change.
- Reveal: an explanation of what happened and why — landing as a visible event in the sim, not a paragraph.

STEP 3 — Make it transfer to real life. Tie the concept to a concrete real-world instance the learner can picture (the money in their savings account; the actual orbit of the ISS; a real population of animals). The "aha" should make them see the concept operating in the world, not just on screen.

HARD RULES:
- The visual must externalize the core mechanism. If you could delete it and lose no understanding, it's decoration — remove it.
- Strip everything that doesn't encode meaning. No ornamental images, no decorative motion. Color and motion must carry the concept.
- Any continuous animation gets play/pause/step + speed controls. Open in a near-still state with one obviously-grabbable element.
- Max ~3 groups of ~3 controls. Labels 1–3 words. Play area visually separate from controls.
- Single self-contained HTML file, Three.js + GSAP required, zero console errors on first load, works from 360px wide up.

${imageDataUrl ? `You are also given a VISUAL MOCKUP (image) — use ONLY for layout, color, spatial arrangement, overall feel. The behavioral brief below is the source of truth for what the lab DOES. If the image and brief conflict, the brief wins. If the image contains garbled text, fake labels, or nonsensical UI fragments, IGNORE them — implement real, working controls with real labels derived from the brief.
` : ``}
TOPIC: ${design.topic}
LEARNING GOAL: ${design.spec.learning_goal}
VISUAL METAPHOR: "${design.spec.visualMetaphor}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEHAVIORAL BRIEF (build exactly this behavior):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${labThinking}

VARIABLES THE LEARNER CONTROLS:
${vars}

${formulas ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMULAS — implement these EXACTLY in JS (no approximations):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${formulas}

Every live readout in the play area MUST be computed from these formulas. The learner must see the output value changing as a real number.
` : ""}
${rules ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THRESHOLD RULES — trigger these exact visual events:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${rules}

When a rule triggers: animate a golden glow burst on the key canvas element AND show the message text prominently in the play area for 2-3 seconds.
` : ""}
SUCCESS CONDITION: ${design.spec.success_condition}
REAL-WORLD PAYOFF: "${design.spec.real_world_payoff || ""}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRUTH — nothing on screen may be false or meaningless:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${formulas ? `• Every readout shows a NAMED quantity with a REAL unit: "Acceleration: 3.2 m/s²", "Balance: $4,820". NEVER a bare number ("Resulting Motion: 7.12") and NEVER pixels ("Separation: 154 px") — define a world scale (e.g. 50 px = 1 m) and always display converted physical values.
• Every control must visibly change an output through one of the formulas. If moving a control changes nothing the learner can see, DELETE the control — a dead or fake control teaches something false.
• Only implement variables that appear in the formulas. If the brief or spec includes a variable that drives no formula, drop it.` : `• This is a NON-QUANTITATIVE topic — do NOT fabricate units (m/s², kg), a numeric "score", or a fake formula. Readouts are CATEGORICAL/qualitative and meaningful: "Tense: past", "Register: formal", "Argument: valid ✓", "Key: A minor".
• Every control must visibly change a real, observable OUTCOME (the word changes, the argument reassembles, the chord resolves, the translation matches). If moving a control changes nothing the learner can see, DELETE it — a dead control teaches something false.
• Every label must be true to the domain. Never show a meaningless number; if a value isn't a real quantity in this subject, express it as a category, state, or correctness mark instead.`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPLAIN EVERYTHING ON SCREEN (non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every entity, dot, shape, color, or symbol MUST be explained with a visible legend or inline label BEFORE or AS the learner first sees it.
• Show a compact legend at the top of the play area before the sim starts — e.g. "● = one organism  |  color = trait  |  size = fitness"
• As the sim runs, show ONE live mechanic line just below the legend that narrates what's happening RIGHT NOW — e.g. "High-fitness organisms reproducing faster…" or "Escape velocity not yet reached — orbit decaying"
• The learner must never see a moving element without knowing what it represents.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMMEDIATE INTERACTION → REVEAL (non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DO NOT show any modal, gate, prediction screen, or "Commit & Start" before the sim. The lab is fully interactive the moment it loads. No blocking UI of any kind before the learner can touch it.

MANIPULATE:
• The full interactive visual is live immediately — no intro screen, no prediction step.
• Every control produces immediate, visible, meaningful change.

REVEAL (triggered by hitting the aha moment or success condition):
• Flash a card explaining what happened and why — the real concept stated plainly.
• State the REAL-WORLD PAYOFF as one concrete sentence: "[What you just saw] is why [real-world consequence]."
• This card appears as a visible event in the sim (slides in, overlays briefly), not as a paragraph below the canvas.
• After 4 seconds the card fades and the learner can keep exploring.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIVE CONSEQUENCE BARS — make cause→effect visceral (non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every lab must show 2–4 live metric bars as horizontal progress bars (0→max) in a panel in Zone A.
Each metric must be something a real operator in this domain actually tracks (e.g. Revenue, Customer Trust, Carbon Emissions, Reaction Rate — NOT "score" or "progress").
Every user action (slider move, drag, click) must update the bars IMMEDIATELY with smooth CSS transitions (<300ms).
Under each bar, show a one-line consequence string that updates to explain WHY the bar moved (e.g. "Higher temperature breaks more molecular bonds → rate spikes"). This text is the pedagogical payload.
At success/win: compute a verdict tier (S/A/B/C/D) from the final metric values vs real-world thresholds and show it prominently — "Grade: A — You optimized for both growth and sustainability."
This is the most important engagement mechanism: the bar animating fast makes the learner wait to see where it lands. Do not skip it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${formulas ? `FORMULA PANEL — teach the rule, not just the animation (QUANTITATIVE topic):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The formulas below are the governing equations. The learner must see them, not just watch the result.
Render a formula panel (pinned inside Zone A or at the top of Zone B):
• Show the governing equation symbolically (e.g. R = v²·sin(2θ) / g).
• Each slider/control maps to a symbol in the equation — label that mapping clearly (e.g. "θ → angle slider").
• When the learner moves a control, HIGHLIGHT the corresponding term in the equation (color flash or bold) AND update the computed result live beside the equation.
• The learner sees: the animation, the equation, and the result number — all changing together as linked representations of the same thing.
• Render equations with the renderFormula helper (KaTeX + plain-text fallback) so they look like a textbook, never like code.

HIGHLIGHTABLE TERMS — copy this exact pattern (this is the #1 source of broken labs showing raw "<span..." text instead of a rendered formula):
  KaTeX cannot highlight a piece of an equation by itself, so wrap EACH highlightable variable in its OWN renderFormula call placed inline with plain text/HTML around it — never hand-build a span tag as a string and dump it into the same element KaTeX renders into.
  <div id="formula-row">
    <span id="term-v"></span><span> · sin(2</span><span id="term-theta"></span><span>) / </span><span id="term-g"></span>
  </div>
  <script>
    renderFormula(document.getElementById('term-v'), 'v^2', 'v²');
    renderFormula(document.getElementById('term-theta'), '\\\\theta', 'θ');
    renderFormula(document.getElementById('term-g'), 'g', 'g');
    function highlightTerm(id){ const el=document.getElementById(id); el.classList.add('flash'); setTimeout(()=>el.classList.remove('flash'), 400); }
    // on slider input: highlightTerm('term-v');
  </script>
  CRITICAL: set HTML content with .innerHTML, never .textContent, when the string contains tags — .textContent prints the literal tag characters on screen instead of rendering them. If you are not inserting any tags (just a plain number/string), use .textContent. Never hand-assemble a template string containing "<span...>" and assign it with .textContent — that is exactly the bug that produces visible raw tag text.
FORMULAS (implement exactly, highlight live):
${formulas}` : `PRINCIPLE PANEL — teach the rule, not just the animation (NON-QUANTITATIVE / humanities topic):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This topic has NO formula — do NOT invent a fake equation, fake units, or fake numeric "score". Forcing math onto a language, history, art, ethics, music, or literature topic is a FAILURE. Instead:
• Render a PRINCIPLE panel stating the governing rule in plain words (e.g. "Spanish adjectives agree with the noun's gender and number", "A counterargument concedes a point, then refutes it", "Minor keys are built on the natural minor scale: W-H-W-W-H-W-W").
• Each control/choice the learner makes maps to a part of that rule — HIGHLIGHT the relevant clause of the principle (color flash/bold) the moment their action engages it, so they see WHICH part of the rule they just exercised.
• Readouts are CATEGORICAL or qualitative, not numeric units: "Tense: past", "Tone: formal", "Match: correct ✓", "Mood: minor". Never "3.2 m/s²" for a humanities topic, and never a bare number with no meaning.
• The "result" the learner watches change is the conjugated word, the assembled argument, the resolved chord, the matched translation — a concrete linguistic/historical/artistic OUTCOME, not a plotted curve.`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REAL SCENARIO MATCHING — reality first, equation earned:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If the brief's section J provides a real scenario (it almost always does), build the lab around matching it:
• Draw the real instance as a fixed TARGET on the canvas from the moment the sim appears — a ghost curve, dotted trajectory, or faded historical line, labeled with its real name and units. D3 is the right tool when this is data on axes.
• The learner's controls drive THEIR model, drawn live on the same axes/space as the target. Both visible at once, visually distinct (target = faded/dotted, model = bright).
• Show a live MATCH readout (e.g. "Match: 84%") computed from the gap between model and target. The match readout can double as the mission progress meter.
• When the match crosses the threshold: the equation reveal IS the celebration — highlight the formula with the learner's discovered values plugged in ("You found it: A = 1000·(1.07)^t"), fire the win state and labCheck postMessage.
• This replaces "equation first, animation second" — the learner reverse-engineers reality, and the formula arrives as the answer they earned.
If section J was skipped (non-quantitative topic), the mission from the brief's section G carries the lab instead — do not force a fake dataset.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MISSION GAMEPLAY — the lab is a game the learner plays to WIN, not a sandbox to poke at:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implement the mission from section G of the brief exactly. Requirements:
• THE TARGET IS DRAWN IN ZONE B: a visible goal state on the canvas itself — a glowing target ring, a finish zone, a threshold line the learner must reach or stay inside. Not just text in the banner.
• LIVE PROGRESS toward the goal: the target glows brighter / a progress meter fills as the learner gets close. A timer or counter where the mission requires holding a state ("hold the orbit for 3 s" → show 0.0/3.0 s counting).
• STEER OR GRAB, don't just slide: the learner's primary action is IN the play area — dragging the object, aiming and releasing, or steering with arrow keys via the [keyboard-steer] pattern. Panel sliders are for secondary quantities only.
• NEAR-MISS FEEDBACK: when an attempt fails, the canvas shows WHY in the concept's own terms ("too fast — escaped gravity", "not enough current — bulb stayed dark") for 2 s, then lets them retry instantly. Failing must teach.
• WIN STATE = SUCCESS CONDITION: completing the mission triggers the celebration (golden burst, "MISSION COMPLETE"), the real-world payoff card, and the labCheck postMessage with ok:true. The mission must be winnable ONLY by actually using the concept's mechanism — never by random fiddling or waiting.
• AUTO-DETECT the win — the moment the mission is achieved, celebrate immediately. The "Check Answer" button is a fallback that evaluates the same condition on demand.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLATFORM CONSTRAINTS (the lab runs inside a sandboxed iframe — these are non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• ONE complete self-contained HTML file. Inline CSS and JS.
• CDN libraries (load from jsDelivr; include inline fallback check):
  - Three.js r128 — load ONLY if you chose 3D as the primary visual, or want a thin decorative chrome layer behind a 2D chart. Chart-shaped topics (compound interest, supply/demand, sampling distributions, etc.) should skip Three.js and use D3 as the primary engine instead — see "CHOOSE THE RIGHT MEDIUM" above. ALWAYS include the addons if using Three.js:
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/renderers/CSS2DRenderer.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
    <script>if(typeof THREE==='undefined'){document.body.innerHTML='<p style="color:#E85D04;padding:2rem">Three.js failed to load</p>';}</script>
  • WEBGL FALLBACK (REQUIRED when using Three.js): the user's device may not support WebGL (old phones, disabled hardware acceleration, locked-down machines). NEVER let the lab show a silent black screen. Detect support BEFORE creating the renderer and wrap renderer creation in try/catch. On failure, render a centered, friendly message on a dark panel — not a blank canvas — e.g.:
    function webglOK(){try{const c=document.createElement('canvas');return !!(window.WebGLRenderingContext&&(c.getContext('webgl')||c.getContext('experimental-webgl')));}catch(e){return false;}}
    if(!webglOK()){document.body.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#120800;color:#E85D04;font:16px system-ui;text-align:center;padding:2rem">This 3D lab needs WebGL. Try enabling hardware acceleration in your browser settings, or open it on a different device/browser.</div>';}
    else{ try{ /* create WebGLRenderer + run the lab here */ }catch(e){ document.body.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#120800;color:#E85D04;font:16px system-ui;text-align:center;padding:2rem">Couldn\\'t start the 3D view on this device. Try another browser or enable hardware acceleration.</div>'; } }
  - GSAP — ALWAYS REQUIRED for cinematic transitions:
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
  - p5.js for animated many-entity sims ONLY if layering 2D overlay on Three.js scene:
    <script src="https://cdn.jsdelivr.net/npm/p5@1.9.4/lib/p5.min.js"></script>
    <script>if(typeof p5==='undefined'){document.write('<p style="color:red">p5.js failed to load — check network</p>');}</script>
  - GSAP for smooth polished transitions (things glide, not snap):
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
    <script>if(typeof gsap==='undefined'){/* fallback: define gsap.to as a no-op so the lab still runs */ window.gsap={to:(el,opts)=>{if(opts.onComplete)setTimeout(opts.onComplete,(opts.duration||0.5)*1000);}}; }</script>
  - Matter.js for physics with collisions, gravity, forces:
    <script src="https://cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js"></script>
    <script>if(typeof Matter==='undefined'){document.write('<p style="color:red">Matter.js failed to load — check network</p>');}</script>
  - D3.js for data-bound visuals: real datasets, labeled axes with meaningful units, scales, smooth curve transitions. Use it whenever the lab plots real-world data the learner must match:
    <script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
    <script>if(typeof d3==='undefined'){document.write('<p style="color:red">D3 failed to load — check network</p>');}</script>
  - KaTeX for textbook-quality math notation in the formula panel (real fractions, Greek letters, superscripts — never ASCII math like v^2*sin(2*theta)/g):
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
    <script>function renderFormula(el, tex, plain){ if(typeof katex!=='undefined'){ katex.render(tex, el, {throwOnError:false}); } else { el.textContent = plain; } }</script>
    Always call renderFormula with BOTH the TeX string and a plain-text fallback — if KaTeX fails to load, the formula still shows as readable text and the lab keeps working.
    ⚠️ BACKSLASH ESCAPING — THE #1 CAUSE OF BROKEN EQUATIONS (missing Greek letters / "= 1/( · ²)" garbage):
      A normal JS string EATS backslashes: "\frac" becomes a formfeed+"rac", "\lambda" becomes "lambda", "\eta" becomes "eta". KaTeX then renders nonsense, and because throwOnError:false it does so SILENTLY.
      RULE: write EVERY TeX command with String.raw OR a doubled backslash. Use ONE of:
        renderFormula(el, String.raw\`E = \\frac{hc}{\\lambda}\`, 'E = hc/λ');   // ← PREFERRED: raw template literal (backtick-quoted, no extra escaping needed)
        renderFormula(el, "E = \\\\frac{hc}{\\\\lambda}", 'E = hc/λ');           // ← or double every backslash in a normal "..." string
      NEVER write renderFormula(el, "\\frac{hc}{\\lambda}", ...) with SINGLE backslashes — they are gone before KaTeX ever sees them.
      The plain-text fallback should use real Unicode symbols (λ η E ² ·) so it's still readable if KaTeX is unavailable.
      SELF-TEST: scan your output for any TeX command (\\frac, \\lambda, \\eta, \\sqrt, \\cdot, etc.) sitting inside a normal "..." or '...' string passed to renderFormula. If you find one with a single backslash, it is BROKEN — convert that string to a String.raw template literal or double every backslash.
  - Google Fonts — ALWAYS include this one (typography is the cheapest polish; if it fails to load, system fonts take over automatically — zero risk):
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
    Use: body { font-family: 'Inter', -apple-system, sans-serif; } for all UI text; font-family: 'JetBrains Mono', monospace; for every number, readout, match %, and formula fallback text — tabular numbers make live values feel precise and stable.
  - Plain vanilla JS is fine for simple cases — don't load a library you don't use (Google Fonts is the only always-on item).
• No localStorage / sessionStorage. No fetch().
• Works in sandbox="allow-scripts".
• Zero console errors on first load.
• Responsive: usable from 360px wide to full desktop.
• Dark cinematic THEME COLORS (the app's palette — NOT a space setting; the scene content is the literal topic): bg #050508, scene fog #1a0800, HUD glass rgba(10,15,30,0.75), border rgba(232,93,4,0.25). Accents: rust #E85D04, copper #D4A574, ice blue #4CC9F0, success #22C55E, muted #8899BB.
• CANVAS SIZING — mandatory pattern to prevent a stretched/blank canvas:
  const canvas = document.getElementById('mainCanvas');
  const ctx = canvas.getContext('2d');
  function resizeCanvas() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  Set canvas.width/height from the element's actual rendered size (offsetWidth/offsetHeight or ResizeObserver) — never hardcode values that differ from the CSS size. Something meaningful must be drawn within 100ms of load; a blank canvas on load means the lab has failed.
• If the lab animates over time, use requestAnimationFrame with delta-time (never hardcoded pixel offsets like x += 2), read control values inside the update loop every frame, and include play/pause/step + speed controls per the hard rules above.
• Pointer events (pointerdown/move/up) for any dragging — works for both mouse and touch.
• INTERACTIVE CHOICE OBJECTS MUST BE SELF-IDENTIFYING. If the learner must pick, drag, or match the CORRECT object among several candidates (e.g. "drag the correct tRNA", "select the right resistor", "match the codon"), EACH candidate must visibly display the decision-relevant attribute that makes the choice informed — its anticodon, value, name, charge, or carried payload — as a persistent text label anchored to that object (a Three.js Sprite/CSS2D billboard for 3D objects, or an HTML overlay tracking the object's screen position). Also label the TARGET the learner is matching against (e.g. the ribosome's "Current codon: AUG" → which anticodon fits). A pile of identical unlabeled blobs the learner must guess between is a FAILED lab — the learner must always be able to read what each object IS and why one is correct before they act.
• Implement the formulas above EXACTLY in JS. Live readouts must name the EFFECT ("Earthquake Magnitude: 7.2"), not echo the input ("Friction: 0.9").
• Include a Reset button.
• SUCCESS REPORTING — when the learner reaches the success condition (use a visible "Check Answer" button to evaluate it):
  window.parent.postMessage({ type:"labCheck", result:{ ok:true,  score:1, total:1 } }, "*") on success
  window.parent.postMessage({ type:"labCheck", result:{ ok:false, score:0, total:1 } }, "*") on failure
  On success also show the real-world payoff card.
• DO NOT render any multiple-choice quiz, prediction modal, "Commit & Start" gate, or "verify your understanding" section — the platform shows its own quiz after the lab. The lab opens fully interactive with zero blocking UI.

Before returning, verify ALL of these — fix any that fail before responding:
1. Does Zone B contain actual drawn SHAPES that represent the concept — NOT just text on a grid?
2. Is there a legend or key visible BEFORE the sim runs, labeling every entity/color/symbol?
3. Is there a live ONE-LINE mechanic narrator updating as the sim runs?
4. Does the lab open FULLY INTERACTIVE with zero blocking UI — no prediction modal, no "Commit & Start" gate, no intro screen? The learner must be able to grab/drag/steer within 3 seconds of load.
5. QUANTITATIVE topics: is the formula panel present, each control mapped to a symbol, terms highlighted on change, result live? NON-QUANTITATIVE topics: is a plain-words PRINCIPLE panel present instead (NO fake equation/units), with the relevant clause highlighted as the learner acts?
6. Does the REVEAL card (triggered on win) state what happened and why, plus the real_world_payoff as one concrete sentence?
7. Is Zone B in motion on load, with the central visual LARGE (not a small dot in empty space)?
8. Does canvas.width/height match the element's actual rendered pixel size?
9. Is there a persistent trail/trace + hidden vectors/force arrows drawn?
10. Are there at least 2 interactive controls plus preset + reset buttons?
11. Is the mission's TARGET drawn on the canvas with live progress, and does achieving it auto-trigger the win celebration + labCheck postMessage?
12. If the concept has a movable object: can the learner steer it with held arrow keys + mirrored touch buttons?
13. Did you load a CDN library only if the concept genuinely needs it (p5/GSAP/Matter/D3/KaTeX — don't load what you don't use)?
14. Does the canvas use gradients and glow — polished simulation, not a flat grey box?
15. If the brief gave a real scenario: is the real target drawn from the start (labeled, with units), is there a live match % readout, and does crossing the match threshold reveal the equation with the learner's values plugged in?
16. QUANTITATIVE topics: are formulas rendered via renderFormula (KaTeX with plain-text fallback) — never raw ASCII math? NON-QUANTITATIVE topics: is there NO invented formula/units (a plain-words principle panel instead)?
17. Does EVERY object on the canvas have a one-word label drawn on/beside it, with labels/readouts placed adjacent to what they describe (not in a far panel)?
18. Does EVERY control visibly change a real output — a formula term (quantitative) or a real domain outcome like a conjugated word / reassembled argument / resolved chord (non-quantitative)? (No inert, topical-sounding fake variables.)
19. Are readouts truthful — real units with a declared world scale for quantitative topics, OR categorical/qualitative labels ("Tense: past", "valid ✓") for non-quantitative topics? Zero pixel or meaningless bare-number readouts either way; zero fabricated units on humanities topics.
20. If two objects are drawn as solid, do they collide instead of overlapping/intertwining — including while being dragged?
21. Do draggable objects show grab/grabbing cursors + a hover affordance, with hit radius ≥24px and touch-action:none?
21b. If the learner must choose/drag/match the CORRECT object among several candidates, does EACH candidate display its decision-relevant identity (anticodon, value, name, payload) as a label anchored to it, AND is the target it matches against labeled too — so the choice is never a blind guess?
22. If 3D was the right medium for this topic: is it a full Three.js WebGL scene with fog, particles, cinematic camera, and topic-specific environment? If 2D was the right medium (chart-shaped topic): is the D3/SVG chart the unobstructed primary visual, with Three.js (if used at all) only decorative chrome that never occludes the data?
23. (branching-decision only) Does the tree render visually as a graph? Can the learner backtrack and explore alternate paths? Does each leaf reveal a concrete consequence?
24. (bias-trap only) Does the learner complete trials WITHOUT knowing the bias first? Is the reveal shown as a distribution plot with the learner's own data highlighted?
25. (budget-allocation only) Is the total always constrained (sum=TOTAL)? Does each allocation show live consequences, not just a number change?
26. (agent-social-sim only) Do agents follow LOCAL rules only — no hard-coded macro pattern? Is there a live D3 aggregate chart showing the emergent trend over time?
27. (sports-game only) Is there a scoreboard, ghost replay trail, keyboard + touch controls, and a winnable mission target in a real sport venue?
28. (wave-interference only) Are two+ wave sources superposed visibly with constructive/destructive regions color-coded? Does phase/frequency control the pattern live?
29. (molecular-builder only) Can atoms be dragged and snapped into bonds? Does evaluate() check the structure against a target?
30. (data-sampling only) Can the learner run many trials and watch a histogram build? Does sample size visibly affect the distribution shape (CLT)?
31. (experiment-bench only) Is there a 3D lab bench with pourable beakers, live readouts (pH/temp/color), and a threshold reaction the learner must trigger?

━━━ PURPOSE MANDATE — the lab must teach THIS specific insight, not just look nice ━━━
These five fields are the soul of the lab. Every structural element must serve them. Check each before returning:

  ENTRY MISCONCEPTION: "${design.spec.entry_misconception || ""}"
  → The lab's DEFAULT STATE must INVITE this misconception (so fixing it is meaningful).
    The starting visual should make the wrong belief feel plausible — a learner who just glances and doesn't interact should be tempted to think the misconception is true.
    Within 10 seconds of their first move, the misconception should start to crack.

  FIRST MOVE: "${design.spec.first_move || ""}"
  → This is the FIRST THING the learner does. It must be instantly obvious from the UI
    (a highlighted draggable, a blinking prompt, or an on-screen arrow pointing to it).
    Doing it must produce a SURPRISING result that challenges the entry misconception.
    A lab where the first move isn't obvious, or doesn't surprise, fails this mandate.

  AHA TRIGGER: "${design.spec.aha_trigger || ""}"
  → This is a SPECIFIC VISUAL EVENT — not a number changing, not text appearing.
    It must be unmissable: a curve suddenly bending, a phase changing, a collision,
    a threshold crossed with a visual jump (particle burst, color shift, sudden motion).
    The learner must SEE it happen without being told to look — it should be impossible to miss.
    If the only "aha" is a number in a readout changing, this mandate fails.

  LEARNING GOAL: "${design.spec.learning_goal || ""}"
  → This exact insight must be STATED EXPLICITLY in the lab (not just implied):
    as a goal line in the controls panel ("GOAL: discover why X causes Y"),
    and as the reveal text when the aha trigger fires or the win condition is met.
    The learner should be able to read the learning goal back from the screen.

  REAL-WORLD PAYOFF: "${design.spec.real_world_payoff || ""}"
  → This MUST appear as visible text on the win screen / reveal card.
    Format: "[What you just saw] is why [real-world consequence]."
    It must name something in the learner's world (their savings account, the ISS, a bridge).
    A vague "now you understand X" does not count — it must be THIS specific sentence.

PURPOSE SELF-TEST (answer YES to all before returning):
□ Default state invites the entry misconception?
□ First move is instantly obvious AND produces a surprising result?
□ Aha trigger fires as an unmissable VISUAL EVENT (not just a number change)?
□ Learning goal stated as text on screen (goal line + reveal)?
□ Real-world payoff appears verbatim on the win screen?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ FINAL PILLAR GATE — if any answer is NO, fix it before returning ━━━
P1. INTERACTIVITY: Is the learner's PRIMARY action a direct grab/aim/steer in the play area (not just sliders), with every control producing an immediate visible change?
P2. GAMIFICATION: Is there a win goal drawn on the canvas, live progress toward it, near-miss feedback, a score/streak/match HUD, and an auto-detected win → celebration + grade + labCheck?
P3. REAL-WORLD: Does the lab open on a concrete real instance and close with the real_world_payoff sentence, with real units throughout?
${critiqueNotes ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A PREVIOUS ATTEMPT AT THIS LAB WAS RENDERED AND REVIEWED — FIX THESE EXACT PROBLEMS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A reviewer looked at a screenshot of the lab you (or a previous attempt) generated and found real problems. Regenerate the FULL lab from scratch, keeping everything that already works, but make sure every issue below is actually fixed in the new output — these are not suggestions, they are required corrections:
${critiqueNotes}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : ""}
OUTPUT BUDGET — you have a hard ~16000-token output limit and the file MUST be COMPLETE and end with </script></body></html>. Write efficiently: no verbose comments, no repeated boilerplate, reuse helper functions, keep CSS/JS concise. Target 600–900 lines total. A complete, working, smaller lab beats a richer one that gets cut off mid-script. Prioritize finishing over adding extra flourish. If you are approaching the limit, skip optional polish and close all tags.

Output only the HTML file. Start with <!doctype html>. No markdown. No explanation. No code fences.`;

  // ── CODEGEN DISPATCH ──────────────────────────────────────────────────────
  // CODEGEN_MODEL=nvidia → CODEGEN_MODEL_ID on NVIDIA Build (Kimi K2.6, etc.)
  // Fallback → OpenAI gpt-4o (also handles mockup imageDataUrl via vision).
  const useNvidia = (CODEGEN_MODEL === "nvidia" || CODEGEN_MODEL === "nemotron")
    && !!NVIDIA_API_KEY
    && !imageDataUrl;   // NVIDIA Build text-only

  if (useNvidia) {
    console.log(`[codegen] routing to NVIDIA Build model: ${CODEGEN_MODEL_ID}`);
    // Serialize all Kimi calls — the NVIDIA Build FREE tier accepts one request
    // at a time. When two lab generations run concurrently, both queue on NVIDIA's
    // side, both time out at ~47-49s, and both return empty streams (finish_reason:null).
    // The lock makes concurrent requests wait in line instead of hammering in parallel.
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const html = await withKimiLock(() => _runKimiStream(briefText, onProgress));
        return html;
      } catch (err) {
        lastErr = err;
        if (err && (/abort/i.test(err.name || "") || /abort|timeout|idle stall/i.test(err.message || ""))) {
          err.status = err.status || 503;
          console.warn(`[codegen/nvidia] aborted: ${err.message} — will retry/fall back`);
        }
        const status = err && (err.status || err.statusCode);
        const retryable = status === 429 || status === 503 || status === 500;
        if (retryable && attempt < 4) {
          const wait = Math.pow(2, attempt) * 1000;
          console.warn(`[codegen/nvidia] attempt ${attempt}/4 status ${status} — retrying in ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          break;
        }
      }
    }
    const isNetworkError = lastErr && (lastErr.status === 429 || lastErr.status === 503 || lastErr.status === 500 || !lastErr.status);
    if (!isNetworkError) {
      throw new Error("Lab generation failed: the AI returned an unexpected response. Please retry — a different phrasing usually works.");
    }
    console.warn(`[codegen/nvidia] ${CODEGEN_MODEL_ID} failed, falling back to OpenAI:`, lastErr && lastErr.message);
  }

  // ── CODEGEN FALLBACK ──────────────────────────────────────────────────────
  // Reached when NVIDIA Build (Kimi) is unavailable or CODEGEN_MODEL is not "nvidia".
  // Routes through the reasoning provider (NVIDIA gpt-oss-20b by default, OpenAI
  // when REASONING_PROVIDER=openai) with streaming so the connection stays alive.
  console.log(`[codegen] routing to reasoning fallback ${REASON_MODEL}`);
  const messages = [{ role: "user", content: briefText }];
  if (imageDataUrl && !useNvidiaReasoning) {
    // Vision is only available on the OpenAI path — gpt-oss-20b is text-only.
    messages[0].content = [
      { type: "text", text: briefText },
      { type: "image_url", image_url: { url: imageDataUrl } },
    ];
  }

  let oaLastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const stream = await openaiCreate({
        model: REASON_MODEL,
        max_tokens: CODEGEN_MAX_TOKENS,
        temperature: 0.7,
        stream: true,
        messages,
      }, "codegen/fallback", { timeout: CODEGEN_TIMEOUT_MS });
      let raw = "";
      let reasoning = "";
      let lastReport = 0;
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.content) raw += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        const seen = raw.length + reasoning.length;
        if (onProgress && seen - lastReport >= 2000) {
          lastReport = seen;
          try { onProgress(seen); } catch (_) {}
        }
      }
      const html = extractHtml(raw) || extractHtml(reasoning);
      if (!html) {
        throw new Error(`${REASON_MODEL} returned non-HTML content (content:${raw.length} reasoning:${reasoning.length} chars)`);
      }
      return html;
    } catch (err) {
      oaLastErr = err;
      const status = err && (err.status || err.statusCode);
      const retryable = status === 429 || status === 503 || status === 500;
      if (retryable && attempt < 4) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`[codegen/openai] attempt ${attempt}/4 (${err.message}) — retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        break;
      }
    }
  }
  console.error("[codegen/openai] lab generation failed:", oaLastErr && oaLastErr.message);

  // LAST-RESORT INDEPENDENT FALLBACK — when the reasoning provider is NVIDIA
  // Build, both Kimi (primary) and llama-3.3-70b (fallback above) live on the
  // SAME endpoint. If NVIDIA's EngineCore is down, both fail and the learner gets
  // a bare network error. So if a real OpenAI key is configured, make one final
  // attempt against OpenAI gpt-4o — a genuinely separate provider — before giving up.
  if (useNvidiaReasoning && hasOpenAIKey()) {
    console.warn("[codegen] NVIDIA Build exhausted — trying independent OpenAI gpt-4o last-resort");
    if (onProgress) { try { onProgress(null, "Switching to backup model…"); } catch (_) {} }
    try {
      const oaMessages = imageDataUrl
        ? [{ role: "user", content: [{ type: "text", text: briefText }, { type: "image_url", image_url: { url: imageDataUrl } }] }]
        : [{ role: "user", content: briefText }];
      const stream = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        max_tokens: CODEGEN_MAX_TOKENS,
        temperature: 0.7,
        stream: true,
        messages: oaMessages,
      });
      let raw = "", reasoning = "", lastReport = 0;
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.content) raw += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        const seen = raw.length + reasoning.length;
        if (onProgress && seen - lastReport >= 2000) { lastReport = seen; try { onProgress(seen); } catch (_) {} }
      }
      const html = extractHtml(raw) || extractHtml(reasoning);
      if (html) return html;
      console.error(`[codegen/openai-lastresort] ${OPENAI_MODEL} returned non-HTML (content:${raw.length} reasoning:${reasoning.length})`);
    } catch (e) {
      console.error("[codegen/openai-lastresort] failed:", e && e.message);
    }
  }

  throw oaLastErr;
}

// ─────────────────────────────────────────────────────────────────
// VISUAL CRITIC LOOP
// Renders the generated lab headlessly, screenshots it, and asks
// GPT-4o vision to critique it against a fixed rubric. If the critic
// finds blockers, we feed a structured fix-list back into Nemotron and
// regenerate (capped retries so cost/latency stay bounded).
// ─────────────────────────────────────────────────────────────────

let _puppeteerBrowser = null;
async function getBrowser() {
  if (_puppeteerBrowser) return _puppeteerBrowser;
  const puppeteer = require("puppeteer");
  _puppeteerBrowser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      // WebGL via SwiftShader (software renderer) — Railway has no GPU, so without
      // these every Three.js lab screenshots as a BLACK canvas, which makes the
      // vision critic flag a false "blank canvas" blocker and triggers needless
      // Kimi regenerations. SwiftShader renders WebGL in software, headless.
      "--use-gl=angle", "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
      "--enable-webgl", "--enable-accelerated-2d-canvas",
      // Memory reduction — the headless Chrome + SwiftShader stack OOM-kills small
      // Railway containers (process SIGKILLed → SSE drops → "network error" with
      // NOTHING logged). Trim every non-essential subsystem and cap the V8 heap.
      "--no-zygote", "--renderer-process-limit=1", "--disable-extensions",
      "--disable-background-networking", "--disable-default-apps", "--mute-audio",
      "--disable-features=site-per-process,Translate,BackForwardCache",
      "--js-flags=--max-old-space-size=256",
    ],
  });
  // If Chrome dies (OOM / crash), drop the cached handle so the next call relaunches
  // instead of reusing a dead browser and throwing on every subsequent lab.
  _puppeteerBrowser.on("disconnected", () => { _puppeteerBrowser = null; });
  return _puppeteerBrowser;
}

// Serialize screenshotLab — two concurrent headless renders double the memory
// footprint and are the most common trigger for the OOM kill. A simple promise
// chain forces renders to run one at a time.
let _screenshotLock = Promise.resolve();
function withScreenshotLock(fn) {
  const run = _screenshotLock.then(fn, fn);
  // Keep the chain alive even if fn rejects, but don't leak the rejection.
  _screenshotLock = run.catch(() => {});
  return run;
}

// Renders the lab HTML in headless Chrome, screenshots it, AND probes it for
// liveness — a single screenshot can't tell a frozen/dead lab from a working
// one. We instrument the page BEFORE its scripts run to count animation-loop
// frames (requestAnimationFrame) and interaction wiring (addEventListener), which
// is far more reliable than pixel-diffing (moving a slider thumb changes pixels
// on its own and would mask a dead sim).
// Returns { screenshot, jsError, isAnimated, hasInputWiring, controlCount }.
async function screenshotLab(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let jsError = null;
  page.on("pageerror", (e) => { if (!jsError) jsError = e.message; });
  try {
    await page.setViewport({ width: 1280, height: 800 });
    // Inject instrumentation as the very first script in the document so it runs
    // before the lab's own scripts (evaluateOnNewDocument doesn't survive setContent).
    const probeScript = `<script>(function(){window.__rafCount=0;var _raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=function(cb){window.__rafCount++;return _raf(cb);};window.__wiring=0;var _add=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(t){if(/^(input|change|click|pointer|mouse|touch|key)/.test(t))window.__wiring++;return _add.apply(this,arguments);};})();</script>`;
    const instrumented = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + probeScript)
      : /<html[^>]*>/i.test(html)
      ? html.replace(/<html[^>]*>/i, (m) => m + probeScript)
      : probeScript + html;
    await page.setContent(instrumented, { waitUntil: "load", timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000)); // let the animate() loop draw a settled frame

    // ANIMATION CHECK — sample the rAF counter twice; if it climbs, a loop is running.
    const raf1 = await page.evaluate(() => window.__rafCount || 0);
    await new Promise(r => setTimeout(r, 500));
    const raf2 = await page.evaluate(() => window.__rafCount || 0);
    const isAnimated = raf2 > raf1 + 2;

    const stats = await page.evaluate(() => ({
      wiring: window.__wiring || 0,
      controlCount: document.querySelectorAll('input, button, select, [draggable="true"]').length,
    }));
    const hasInputWiring = stats.wiring > 0;

    const screenshot = (await page.screenshot({ type: "png" })).toString("base64");
    return { screenshot, jsError, isAnimated, hasInputWiring, controlCount: stats.controlCount };
  } catch (err) {
    return { screenshot: null, jsError: jsError || err.message, isAnimated: false, hasInputWiring: false, controlCount: 0 };
  } finally {
    await page.close();
  }
}

const CRITIC_RUBRIC = `You are reviewing a screenshot of an auto-generated interactive educational lab (a self-contained HTML/Three.js/D3 webpage). Score it against this rubric and return ONLY valid JSON, no markdown:

{
  "score": <0-100 overall quality>,
  "accept": <true if score >= 70 AND no blockers, else false>,
  "issues": [
    { "severity": "blocker" | "minor", "area": "occlusion" | "legibility" | "topic_fidelity" | "interactivity" | "visual_hierarchy" | "purpose" | "clarity" | "affordance", "problem": "<what's wrong, specifically>", "fix": "<concrete instruction the code generator can act on>" }
  ]
}

Rubric dimensions:
- occlusion: is any chart, axis, control, or readout blocked/overlapped by another element (e.g. a 3D mesh sitting on top of a 2D chart, a panel covering data)? This is always a blocker if present.
- legibility: is all text actually rendered and readable (not raw HTML tags showing as literal text, not low-contrast text on the dark background, not tiny/cut-off labels)? Raw tag text like "<span..." visible on screen is always a blocker.
- topic_fidelity: does the visual literally depict the stated topic (not a generic/space scene unless the topic is space)?
- interactivity: are controls (sliders, buttons, draggable objects) visually obvious and is there a clear primary action?
- visual_hierarchy: is the main visual (chart or 3D scene) the clear focal point, not crowded out by chrome?
- purpose: does every visible element appear to serve the learning goal, or is there obvious decorative clutter with no purpose?
- clarity: would a first-time learner know, within 3 seconds and with no outside instructions, (a) what they're looking at, (b) what to touch first, and (c) what success looks like? Missing goal line, missing "how this works" / first-move hint, or an unexplained stage is a blocker.
- affordance: is every control labeled with its ROLE — the action verb + the thing it acts on + the effect (e.g. "Drag the ball → launch angle", "Slide Rate → faster growth")? Is there a visible "Controls"/"How to play" legend panel that lists EVERY interactive element (one line each: name — verb → effect) plus the goal? A missing legend panel, an unlabeled slider/button/draggable, or a control with no visible live readout of its consequence, is a blocker. Also flag controls that look unbounded or able to reach nonsensical values for the topic.
- purpose_execution: does the lab visually encode its PURPOSE — the specific entry_misconception it must correct, the aha_trigger visual event, and the real_world_payoff? Judge: (a) Is the entry_misconception something a learner COULD hold after looking at this lab's default state (i.e. the default state should INVITE the misconception so overcoming it is meaningful)? (b) Is there a visible, unmissable visual event that matches the aha_trigger description — NOT just a slider that changes a number? (c) Is the real_world_payoff shown explicitly (as text or a labeled scene element) when the learner wins, NOT just implied? A lab that looks nice but fails to stage the misconception, deliver the aha, or land the payoff is a blocker on this dimension.

Be concrete in "fix" — name the exact element and the exact correction, so a code generator with no other context can apply it.`;

async function critiqueLab(imageBase64, design) {
  const s = design.spec || {};
  const purposeCtx = [
    `Topic: "${design.topic}"`,
    `Learning goal: "${s.learning_goal || ""}"`,
    `Entry misconception to CORRECT: "${s.entry_misconception || ""}"`,
    `First move (what surprises them within 10s): "${s.first_move || ""}"`,
    `Aha trigger (the exact visual event): "${s.aha_trigger || ""}"`,
    `Real-world payoff (shown on win): "${s.real_world_payoff || ""}"`,
  ].join("\n");
  try {
    // Vision call — uses visionClient (NVIDIA qwen2.5-vl when NVIDIA_API_KEY is set,
    // otherwise OpenAI). Both support image_url in the OpenAI-compatible format.
    const resp = await visionClient.chat.completions.create({
      model: VISION_MODEL,
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${CRITIC_RUBRIC}\n\n${purposeCtx}` },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
          ],
        },
      ],
    });
    return parseLooseJSON(safeContent(resp));
  } catch (err) {
    console.warn("[critic] failed, skipping critique:", err.message);
    return { score: 100, accept: true, issues: [] }; // fail open — never block lab delivery on critic errors
  }
}

function issuesToNotes(issues) {
  return issues
    .filter(i => i.severity === "blocker" || i.severity === "minor")
    .map(i => `- [${i.severity.toUpperCase()}] (${i.area}) ${i.problem} → FIX: ${i.fix}`)
    .join("\n");
}

// Deterministic interaction probe → blocker issues the vision model can't see
// from a single still frame (frozen sim, dead controls, JS crash).
function probeIssues(probe) {
  const issues = [];
  if (probe.jsError) {
    issues.push({ severity: "blocker", area: "interactivity",
      problem: `The lab threw a JavaScript error on load: "${probe.jsError}". This usually means the sim never started.`,
      fix: "Fix the JS error. Ensure all referenced DOM ids/variables exist before use, libraries are loaded before they're called, and animate() runs without throwing." });
  }
  if (probe.controlCount > 0 && !probe.hasInputWiring && !probe.jsError) {
    issues.push({ severity: "blocker", area: "interactivity",
      problem: "The lab has controls (sliders/buttons) but NOT A SINGLE input/click/pointer event listener was registered — the controls are dead, nothing happens when the learner uses them.",
      fix: "Wire every control with addEventListener('input'/'click'/'pointerdown', ...) writing to a shared state object that animate() reads each frame. Set the full-viewport canvas to pointer-events:none (or give every HUD element a higher z-index) so clicks reach the controls." });
  }
  if (probe.controlCount > 0 && probe.hasInputWiring && !probe.isAnimated && !probe.jsError) {
    issues.push({ severity: "blocker", area: "interactivity",
      problem: "No animation loop is running (requestAnimationFrame is never called repeatedly) — the sim is frozen, so even wired controls produce no visible motion.",
      fix: "Add a self-rescheduling animate(){ requestAnimationFrame(animate); update(dt); renderer.render(...) } loop that reads the shared state every frame, and call animate() once to start it. Controls must write to state; the loop is what moves the visuals." });
  }
  if (probe.controlCount === 0 && !probe.jsError) {
    issues.push({ severity: "blocker", area: "interactivity",
      problem: "No interactive controls (sliders/buttons) and no draggable response were detected at all — the lab is not interactive.",
      fix: "Add the controls from the interaction palette: sliders/buttons that change the sim, or a draggable canvas object, each producing immediate visible change." });
  }
  return issues;
}

// Wraps codeFromImageBrief with a render → probe + vision-critique → regenerate
// loop. Regenerates when EITHER the deterministic probe finds a dead/static lab
// OR the vision critic finds a visual blocker. Capped retries bound cost/latency.
async function codeFromImageBriefWithCritique(design, labThinking, pedagogy, imageDataUrl, category, onProgress, interactionContract = null, maxRetries = 2) {
  let html = await codeFromImageBrief(design, labThinking, pedagogy, imageDataUrl, category, onProgress, null, interactionContract);

  // ── ALWAYS-ON static guardrail (cheap regex, no headless browser) ──────────
  // Catches the failure modes that ship blank/dead/truncated labs — truncated
  // HTML, no Three.js scene, no animation loop, no interaction, no win hook —
  // and regenerates via the SAME codegen call with a corrective note. Runs even
  // when the heavier (OOM-prone) visual critic below is disabled. This is the
  // primary defense against empty/weak labs in the default deployment.
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const check = validateLabHtml(html, interactionContract);
    if (check.ok) break;
    console.warn(`[labcheck] attempt ${attempt} blockers: ${check.issues.join(" | ")}`);
    if (onProgress) { try { onProgress(null, `Reviewing and fixing your lab… (${check.issues.length} issue${check.issues.length > 1 ? "s" : ""})`); } catch (_) {} }
    html = await codeFromImageBrief(design, labThinking, pedagogy, imageDataUrl, category, onProgress, labCheckNotes(check.issues), interactionContract);
  }

  // The render→critique loop launches headless Chromium (puppeteer). On a
  // memory-limited Railway container, SwiftShader software-WebGL rendering can
  // OOM-kill the whole process (→ 502). So it's OFF by default and only runs when
  // ENABLE_VISUAL_CRITIC=1 (e.g. a box with enough RAM). Without it, Kimi's output
  // ships directly — the deterministic extractHtml + final HTML guard still protect
  // against blank labs; we just skip the screenshot-based visual QA.
  if (process.env.ENABLE_VISUAL_CRITIC !== "1") {
    return html;
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let probe, critique;
    try {
      probe = await withScreenshotLock(() => screenshotLab(html));
      critique = probe.screenshot
        ? await critiqueLab(probe.screenshot, design)
        : { score: 0, accept: false, issues: [] };
    } catch (err) {
      console.warn("[critic] render/critique pipeline failed, shipping as-is:", err.message);
      break;
    }

    const allIssues = [...probeIssues(probe), ...(critique.issues || [])];
    const blockers = allIssues.filter(i => i.severity === "blocker");
    console.log(`[critic] attempt ${attempt}: score=${critique.score} animated=${probe.isAnimated} wired=${probe.hasInputWiring} controls=${probe.controlCount} jsError=${!!probe.jsError} blockers=${blockers.length}`);
    if (blockers.length === 0) break;

    if (onProgress) { try { onProgress(null, `Reviewing and improving your lab… (fixing ${blockers.length} issue${blockers.length > 1 ? "s" : ""})`); } catch (_) {} }
    const notes = issuesToNotes(allIssues);
    html = await codeFromImageBrief(design, labThinking, pedagogy, imageDataUrl, category, onProgress, notes, interactionContract);
  }

  return html;
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
Rules: lesson has exactly 3 slides (3-4 bullets each, ≤15 words per bullet). Quiz has exactly 4 questions (1 correct, 3 plausible distractors). Be concrete, not vague.`;

        const resp = await reason.chat.completions.create({
          model: REASON_MINI_MODEL,
          max_tokens: 1400,
          temperature: 0.4,
          messages: [{ role: "user", content: prompt }],
        });
        const raw = resp.choices?.[0]?.message?.content || "";
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error("no JSON");
        const result = JSON.parse(m[0]);
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

          let topic, expanded;
          if (courseContext) {
            topic = rawTopic;                 // the course title/subject — keep full scope
            expanded = { topic, why: "" };
          } else {
            send("expand", `Sharpening topic…`);
            expanded = await expandTopic(rawTopic, category, sourceMaterial, sourceFocus);
            topic = expanded.topic;
          }
          const key = topicKey(topic);
          send("expanded", `Building lab for: ${topic}`, { topic, why: expanded.why, category });

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

          // ── Cache miss (or level-tuned/source-based): run full pipeline then save ──
          // Ground the topic in verified facts (Wikipedia/Wikidata/Tavily) in parallel
          // with topic reasoning — grounding is a network call (~1-3s) while thinking
          // is an LLM call (~5-10s). groundingText feeds specFromThinking downstream.
          send("ground", "Checking the facts…");
          send("think", `Reasoning about "${topic}"…`);
          let groundingText = null;
          const [thinking] = await Promise.all([
            thinkAboutTopic(topic, category, levelBackground, levelGoal, sourceMaterial, sourceFocus, null, courseContext),
            groundTopic(topic, category)
              .then(g => { if (g) groundingText = g.text; })
              .catch(e => console.warn("[grounding] failed, continuing ungrounded:", e.message)),
          ]);

          send("design", "Translating insight into lab spec…");
          const design = await specFromThinking(topic, thinking, category, groundingText, courseContext);

          send("labthink", "Thinking about how to build it…");
          // Fire lesson + quiz generation in parallel with labthink — they use the fast
          // mini model (~10s) while labthink + codegen takes minutes. Badges light up fast.
          let lessonResult = null, quizResult = null;
          // Interaction director runs in the same parallel window as labthink —
          // an extended-thinking call (gpt-oss, reasoning_effort=high) that picks
          // the interaction language for this topic. Adds zero wall-clock.
          const [labThinking, pedagogy, interactionContract] = await Promise.all([
            thinkAboutLab(design, category, courseContext),
            thinkAboutVisualPedagogy(design.topic, design.spec.lab_archetype || "physics-sim", category),
            thinkAboutInteraction(design, category, courseContext),
            generateLesson(design).then(r => {
              lessonResult = r;
              if (r) send("lesson", "Lesson ready.", { lesson: r });
            }).catch(() => {}),
            generateQuiz(design).then(r => {
              quizResult = r;
              if (r) send("quiz", "Quiz ready.", { quiz: r });
            }).catch(() => {}),
          ]);

          let imageDataUrl = null;
          if (process.env.USE_MOCKUP === "1") {
            send("image", "Sketching a visual mockup…");
            imageDataUrl = await mockupImage(design);
          }

          send("code", "Writing your lab…");
          const html = await codeFromImageBriefWithCritique(design, labThinking, pedagogy, imageDataUrl, category,
            (chars, msg) => send("code", msg || `Writing your lab… (${Math.round(chars / 1000)}k chars)`),
            interactionContract);

          // Final guard: never ship a blank/broken iframe. If codegen produced
          // empty or non-HTML output, surface a real error instead of a blank lab
          // so the user isn't charged for an invisible result.
          const htmlOk = typeof html === "string" &&
            /^\s*<!doctype|^\s*<html/i.test(html) && html.length > 200;
          if (!htmlOk) {
            throw new Error("Lab generation returned empty or invalid HTML — not charging you for a blank lab. Please retry.");
          }

          const labData = {
            topicKey: key,
            topic: design.topic,
            scenario: design.scenario,
            verificationQuestion: design.verificationQuestion,
            learningGoal: design.spec.learning_goal,
            realWorldPayoff: design.spec.real_world_payoff,
            reflection: design.spec.reflection || null,
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
            Promise.resolve(saveLab(key, design.topic, labData)).catch(() => {});
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

module.exports = {
  expandTopic,
  thinkAboutTopic,
  specFromThinking,
  thinkAboutLab,
  thinkAboutVisualPedagogy,
  codeFromImageBrief,
};
