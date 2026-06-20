// courses.js — course generation backend (lesson → lab → quiz contract).
//
// SCOPE GUARD: this module does NOT touch the 3D lab generator. Labs are
// produced by server.js (codeFromImageBrief & friends) and stay exactly as-is.
// Courses wrap labs with lessons + quizzes and a hard constraint:
//   the LESSON is the source of truth; the lab and quiz may not introduce any
//   concept the lesson didn't teach.
//
// Two-phase pipeline (the caller orchestrates async timing):
//   Phase 1 (blocking): generateOutline → generateLesson per module
//   Phase 2 (async):     lab (server.js, unchanged) + generateQuiz per module
//
// Everything here is plain Node + the OpenAI SDK; no framework.

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "missing-openai-key",
});

// Course generation is pure text/JSON reasoning, so it follows the same
// REASONING_PROVIDER switch as server.js: route to NVIDIA Build (openai/gpt-oss-20b,
// effectively free) by default for cheap testing, OpenAI when REASONING_PROVIDER=openai.
// Sanitize the NVIDIA key the same way server.js does (a pasted code snippet makes
// an invalid header and would otherwise throw on every call).
const NVIDIA_API_KEY = (() => {
  const raw = process.env.NVIDIA_API_KEY;
  if (!raw) return null;
  const key = String(raw).trim().split(/\s/)[0];
  return key.startsWith("nvapi-") ? key : null;
})();
const COURSE_PROVIDER = (process.env.REASONING_PROVIDER || (NVIDIA_API_KEY ? "nvidia" : "openai")).toLowerCase();
const useNvidiaCourses = COURSE_PROVIDER === "nvidia" && !!NVIDIA_API_KEY;
const courseClient = useNvidiaCourses
  ? new OpenAI({ apiKey: NVIDIA_API_KEY, baseURL: "https://integrate.api.nvidia.com/v1", maxRetries: 0, timeout: 90000 })
  : openai;
// Phase-1 reasoning model (outline only). Defaults to gpt-oss-20b on NVIDIA, gpt-4o on OpenAI.
const COURSE_MODEL_ID = process.env.COURSE_MODEL_ID || process.env.REASON_MODEL
  || (useNvidiaCourses ? "openai/gpt-oss-20b" : "gpt-4o");
// Fast model for lesson + quiz generation — structured JSON, no deep reasoning needed.
// llama-3.1-8b is ~5× faster than gpt-oss-20b and well within Railway's timeout.
const COURSE_FAST_MODEL = process.env.COURSE_FAST_MODEL
  || (useNvidiaCourses ? "meta/llama-3.1-8b-instruct" : "gpt-4o-mini");

// The slide-type taxonomy is the guardrail that forces the model to TEACH
// instead of summarize. Keep in sync with the UI badge colors.
const SLIDE_TYPES = [
  "concept", "example", "case_study", "comparison", "myth_vs_reality",
  "process", "interactive_predict", "quick_think", "challenge",
  "real_world", "key_takeaways",
];
// Every lesson must contain at least these — enforced in prompt AND validation.
const REQUIRED_SLIDE_TYPES = ["interactive_predict", "real_world", "case_study", "challenge"];

const MODULE_MIN = 3;
const MODULE_MAX = 10;

// Tiny in-process cache so repeated identical requests on a warm instance skip
// the AI call. (DB-backed course_cache/lab_cache is a later enhancement.)
const cache = new Map();
const ckey = (...parts) => parts.join("::").toLowerCase().replace(/\s+/g, " ").trim();

// Tolerant JSON parse — strips markdown fences and extracts the first balanced
// {...}/[...] block. Needed because without json_object mode the model may wrap
// its JSON in prose or fences.
function parseLooseJSON(text) {
  const s = String(text || "").trim();
  try { return JSON.parse(s); } catch (_) {}
  let t = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(t); } catch (_) {}
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
    else if (c === close) { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error("Unbalanced JSON in model response");
}

async function _aiJSONWith(model, isReasoning, prompt, maxTokens, label) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await courseClient.chat.completions.create({
        model,
        ...(isReasoning
          ? { reasoning_effort: "low", max_tokens: Math.max(maxTokens, 3000) }
          : { max_tokens: maxTokens, ...(useNvidiaCourses ? {} : { response_format: { type: "json_object" } }) }),
        messages: [{ role: "user", content: prompt }],
      });
      // Reasoning models can return content:null with output in reasoning_content.
      const m = res?.choices?.[0]?.message || {};
      const content = (typeof m.content === "string" && m.content.trim())
        ? m.content
        : (m.reasoning_content || "");
      return parseLooseJSON(content);
    } catch (err) {
      lastErr = err;
      const transient = err?.status === 429 || err?.status === 503
        || /overload|rate.?limit/i.test(err?.message || "")
        || err?.name === "APIConnectionTimeoutError" || err?.name === "APIConnectionError"
        || err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT";
      if (!transient || attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// Reasoning model (for outline — needs structural thinking)
async function aiJSON(prompt, maxTokens = 2500, label = "course") {
  return _aiJSONWith(COURSE_MODEL_ID, useNvidiaCourses, prompt, maxTokens, label);
}
// Fast instruction model (for lesson + quiz — structured JSON, no deep reasoning)
async function aiJSONFast(prompt, maxTokens = 2500, label = "course-fast") {
  return _aiJSONWith(COURSE_FAST_MODEL, false, prompt, maxTokens, label);
}

// ── Phase 1a — Course outline ────────────────────────────────────────────
// AI picks 3–10 modules by topic complexity; the user may force a count.
// Each module carries the constraint lists (key_concepts / key_variables) that
// downstream lesson, lab, and quiz generation must stay inside.
async function generateOutline(subject, category = "General", moduleCount = null, sourceMaterial = null, sourceFocus = null) {
  const forced = moduleCount != null
    ? Math.max(MODULE_MIN, Math.min(MODULE_MAX, parseInt(moduleCount, 10) || 0))
    : null;
  const key = ckey("outline", subject, category, forced || "auto", sourceMaterial ? "src" + sourceMaterial.length : "nosrc");
  if (cache.has(key)) return cache.get(key);

  const countRule = forced
    ? `Produce EXACTLY ${forced} modules (the user requested this count).`
    : `Choose the RIGHT number of modules between ${MODULE_MIN} and ${MODULE_MAX} based on the topic's complexity — a simple topic gets ${MODULE_MIN}, a deep one gets up to ${MODULE_MAX}. Do not pad.`;

  const sourceCtx = sourceMaterial ? `
THE LEARNER UPLOADED THEIR OWN MATERIAL (e.g. a PDF/notes)${sourceFocus ? ` and wants the course to focus on "${sourceFocus}"` : ""}. Build the ENTIRE course FROM this material: derive the modules from its actual structure/sections, use its real examples, terminology, figures, and numbers. Each module should map to a real part of their material. Do NOT introduce topics the material doesn't cover.
THEIR MATERIAL (excerpt):
"""
${sourceMaterial.slice(0, 9000)}
"""
` : "";

  const outline = await aiJSON(`You are a curriculum designer building an interactive course where each module is a teach → practice → assess loop (a lesson, a hands-on 3D lab, then a quiz).

SUBJECT: "${subject}"
SUGGESTED CATEGORY: ${category}
${sourceCtx}

First confirm the BEST-FITTING category from exactly this list (do not invent new ones):
"Physics", "Biology", "Sports & Skills", "Money & Econ", "Math & Data", "Everyday Science", "Language & Humanities", "General".
Use "Language & Humanities" for languages, history, literature, art, philosophy, writing. Use "General" only when nothing else fits.

${countRule}

Return JSON exactly like this:
{
  "title": "Course title (short, punchy)",
  "tagline": "One sentence: what the learner will be able to DO after this course",
  "category": "the category you picked",
  "modules": [
    {
      "order": 1,
      "title": "Module title",
      "topic": "Specific interactive lab topic, concrete enough to build a 3D lab (e.g. 'Newton's Second Law: F=ma on an ice rink', NOT 'Forces')",
      "why": "One sentence: why this module comes here / what it unlocks",
      "learning_objectives": ["3-5 specific, observable things the learner can do after this module"],
      "key_concepts": ["the EXACT set of concepts/vocabulary this module teaches — this is the CONSTRAINT LIST: the lab and quiz may use NOTHING outside it"],
      "key_variables": ["the specific quantities/inputs the lab lets the learner manipulate — must all be introduced by the lesson"]
    }
  ]
}

Rules:
- Order modules foundational → advanced; each builds on the previous (no concept used before it is taught).
- key_concepts is the single most important field — it is the contract the lesson must fully teach and the lab/quiz may never exceed. 3-7 concise concept names per module.
- key_variables must be a subset of what key_concepts covers (you can't manipulate what wasn't taught).
- No duplicate concepts across modules; each concept is taught in exactly one module.
- The final module should be an applied/real-world challenge that combines earlier concepts.
- Topics must be specific and lab-buildable. Never vague.`, 1600, "outline");

  // Normalize / clamp.
  outline.modules = (outline.modules || []).slice(0, MODULE_MAX).map((m, i) => ({
    order: m.order || i + 1,
    title: m.title || m.topic || `Module ${i + 1}`,
    topic: m.topic || m.title || subject,
    why: m.why || "",
    learning_objectives: Array.isArray(m.learning_objectives) ? m.learning_objectives : [],
    key_concepts: Array.isArray(m.key_concepts) ? m.key_concepts : [],
    key_variables: Array.isArray(m.key_variables) ? m.key_variables : [],
  }));
  cache.set(key, outline);
  return outline;
}

// ── Phase 1b — Lesson (the source of truth) ──────────────────────────────
// Markdown split into one-idea slides by \n---\n, each tagged with a type via
// a leading HTML comment (markdown-invisible, and crucially NOT '---' so it
// never collides with the slide separator).
async function generateLesson(module, courseTitle = "", category = "General", sourceMaterial = null, sourceFocus = null) {
  const key = ckey("lesson", courseTitle, module.title, (module.key_concepts || []).join(","), sourceMaterial ? "src" + sourceMaterial.length : "nosrc");
  if (cache.has(key)) return cache.get(key);

  const concepts = (module.key_concepts || []).join(", ") || module.topic;
  const objectives = (module.learning_objectives || []).map(o => `- ${o}`).join("\n") || "- Understand the core idea";

  const sourceCtx = sourceMaterial ? `
TEACH FROM THE LEARNER'S OWN UPLOADED MATERIAL${sourceFocus ? ` (focus: "${sourceFocus}")` : ""}. Ground every slide in THIS content — use its real examples, terminology, figures, and numbers for THIS module. Do not contradict it or invent facts outside it.
THEIR MATERIAL (excerpt):
"""
${sourceMaterial.slice(0, 7000)}
"""
` : "";

  const lesson = await aiJSONFast(`You are an expert teacher writing ONE lesson for an interactive course. The lesson is the SOURCE OF TRUTH: the lab and quiz that follow may use NOTHING you don't teach here.

COURSE: ${courseTitle}
MODULE: ${module.title}
CATEGORY: ${category}
LEARNING OBJECTIVES:
${objectives}
KEY CONCEPTS YOU MUST TEACH (and must NOT exceed): ${concepts}
${sourceCtx}

GOAL OF EVERY LESSON: build a mental model, not test recall. Every slide answers "why does this matter?" Repend does not help users pass tests — it helps them understand through explanation, experimentation, and application.

OUTPUT a JSON object:
{
  "slides": [
    { "type": "<one of: ${SLIDE_TYPES.join(" | ")}>", "title": "Short slide title", "body": "Markdown body. ONE idea only. Operator voice — direct, concrete, no textbook tone, no LinkedIn thought-leader fluff." }
  ]
}

HARD RULES:
- Exactly 6 slides. ONE concept per slide.
- Include one slide of EACH of these types: interactive_predict, real_world, case_study, challenge. Fill remaining with concept/example.
- Order: concept → example → interactive_predict → case_study → real_world → challenge.
- interactive_predict: pose "What do you think happens if…" then reveal the answer.
- case_study: REAL verifiable scenario — real company/event/number. Never fabricate.
- Cover EVERY key concept. No vocabulary outside the key concepts list.
- Body: 2-4 sentences MAX per slide. Tight, direct, no fluff. Markdown bold for key terms only.

Return ONLY valid JSON, no markdown fences.`, 2000, "lesson");

  const slides = (lesson.slides || []).map(s => ({
    type: SLIDE_TYPES.includes(s.type) ? s.type : "concept",
    title: (s.title || "").trim(),
    body: (s.body || "").trim(),
  })).filter(s => s.body);

  // Serialize to the markdown contract: <!-- type --> header per slide, joined by \n---\n.
  const markdown = slides
    .map(s => `<!-- type: ${s.type}; title: ${s.title.replace(/-->/g, "→")} -->\n${s.title ? `## ${s.title}\n\n` : ""}${s.body}`)
    .join("\n\n---\n\n");

  const out = { slides, markdown };
  cache.set(key, out);
  return out;
}

// ── Phase 2 — Quiz (assess; constrained to key_concepts) ─────────────────
async function generateQuiz(module, lessonMarkdown = "", category = "General") {
  const key = ckey("quiz", module.title, (module.key_concepts || []).join(","));
  if (cache.has(key)) return cache.get(key);

  const concepts = (module.key_concepts || []).join(", ") || module.topic;
  const quiz = await aiJSONFast(`You write the assessment quiz for one course module. It ASSESSES retention with delayed feedback — it must trade in pattern-matching, not definition recall.

MODULE: ${module.title}
KEY CONCEPTS (the ONLY things you may ask about): ${concepts}
${lessonMarkdown ? `\nLESSON CONTENT (the source of truth — every answer must be derivable from this):\n"""\n${lessonMarkdown.slice(0, 6000)}\n"""\n` : ""}

Return JSON:
{
  "pass_threshold": 0.7,
  "questions": [
    {
      "question": "Scenario-based question testing application of a key concept",
      "options": ["A ...", "B ...", "C ...", "D ..."],
      "correct_index": 0,
      "concept": "which key concept this question assesses (must be one of the key concepts above)",
      "explanation": "Why the correct answer is right and the others are wrong — shown only AFTER the learner submits."
    }
  ]
}

RULES:
- 4 to 6 questions. Each has exactly 4 options and exactly one correct_index (0-3).
- Every question's answer MUST be derivable from the lesson — reject anything requiring outside info.
- Every question's "concept" MUST be one of the key concepts listed above. Do not test anything outside that list.
- Prefer application/scenario questions over "what is the definition of X".
- No fabricated statistics or companies in stems or options.

Return ONLY the JSON.`, 2500, "quiz");

  quiz.pass_threshold = quiz.pass_threshold || 0.7;
  quiz.questions = (quiz.questions || []).map(q => ({
    question: (q.question || "").trim(),
    options: Array.isArray(q.options) ? q.options.slice(0, 4) : [],
    correct_index: Number.isInteger(q.correct_index) ? q.correct_index : 0,
    concept: (q.concept || "").trim(),
    explanation: (q.explanation || "").trim(),
  })).filter(q => q.question && q.options.length === 4);

  cache.set(key, quiz);
  return quiz;
}

// ── Parsing + validation ─────────────────────────────────────────────────
// Split lesson markdown back into typed slides (used by the UI and validator).
function parseSlides(markdown) {
  if (!markdown) return [];
  return markdown.split(/\n-{3,}\n/).map(chunk => {
    const m = chunk.match(/<!--\s*type:\s*([a-z_]+)\s*(?:;\s*title:\s*([^>]*?))?\s*-->/i);
    const type = m && SLIDE_TYPES.includes(m[1]) ? m[1] : "concept";
    const title = m && m[2] ? m[2].trim() : "";
    const body = chunk.replace(/<!--[\s\S]*?-->/, "").trim();
    return { type, title, body };
  }).filter(s => s.body);
}

// Post-generation quality gate. Returns { ok, errors, warnings }.
// errors = contract violations (block); warnings = things to review.
function validateCourse(course) {
  const errors = [];
  const warnings = [];
  const modules = (course && course.modules) || [];

  if (modules.length < MODULE_MIN || modules.length > MODULE_MAX) {
    errors.push(`Course has ${modules.length} modules; must be ${MODULE_MIN}-${MODULE_MAX}.`);
  }

  for (const mod of modules) {
    const label = `Module ${mod.order || "?"} (${mod.title || mod.topic || "untitled"})`;
    const concepts = mod.key_concepts || [];
    if (!concepts.length) { errors.push(`${label}: no key_concepts (the constraint list is required).`); }

    // Lesson must cover every key concept.
    const slides = mod.slides || parseSlides(mod.lesson_markdown || "");
    if (slides.length) {
      const lessonText = slides.map(s => `${s.title} ${s.body}`).join(" ").toLowerCase();
      for (const c of concepts) {
        const head = String(c).toLowerCase().split(/[(:,]/)[0].trim();
        // Covered if the whole phrase appears, or any significant word of it does
        // (forgiving so "exponential decay" still matches "decay is exponential").
        const words = head.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
        const covered = (head && lessonText.includes(head)) || words.some(w => lessonText.includes(w));
        if (head && !covered) {
          errors.push(`${label}: lesson never teaches key concept "${c}".`);
        }
      }
      // Engagement minimums.
      const present = new Set(slides.map(s => s.type));
      for (const req of REQUIRED_SLIDE_TYPES) {
        if (!present.has(req)) errors.push(`${label}: lesson missing required slide type "${req}".`);
      }
      if (slides.length < 6) warnings.push(`${label}: only ${slides.length} slides (aim for 6-9).`);
    } else if (concepts.length) {
      warnings.push(`${label}: no lesson generated yet — cannot verify concept coverage.`);
    }

    // Quiz may only assess taught concepts.
    const qs = (mod.quiz && mod.quiz.questions) || [];
    const conceptHeads = concepts.map(c => String(c).toLowerCase().split(/[(:,]/)[0].trim()).filter(Boolean);
    for (const q of qs) {
      const tagged = (q.concept || "").toLowerCase();
      const matches = conceptHeads.some(h => tagged.includes(h) || h.includes(tagged.split(/[(:,]/)[0].trim()));
      if (tagged && conceptHeads.length && !matches) {
        errors.push(`${label}: quiz question tests "${q.concept}", which is outside this module's key_concepts.`);
      }
    }

    // Cheap fabricated-stat smell test (warning only — humans confirm).
    const allText = [
      ...slides.map(s => s.body),
      ...qs.map(q => `${q.question} ${q.options.join(" ")}`),
    ].join(" ");
    if (/\b\d{1,3}(\.\d+)?\s?%/.test(allText) || /\$\s?\d/.test(allText)) {
      warnings.push(`${label}: contains specific stats/figures — verify they are real, not fabricated.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
  generateOutline,
  generateLesson,
  generateQuiz,
  parseSlides,
  validateCourse,
  SLIDE_TYPES,
  REQUIRED_SLIDE_TYPES,
  MODULE_MIN,
  MODULE_MAX,
};
