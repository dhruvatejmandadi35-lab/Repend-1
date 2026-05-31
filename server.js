const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { AnthropicVertex } = require("@anthropic-ai/vertex-sdk");

// Load .env locally (Railway injects env vars directly, so this is a no-op there).
try { require("fs").readFileSync(path.join(__dirname, ".env"), "utf8")
  .split("\n").forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) { /* no .env file — fine in production */ }

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// On Railway there's no filesystem for GOOGLE_APPLICATION_CREDENTIALS.
// Instead, paste the service account JSON contents into GOOGLE_CREDENTIALS_JSON.
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  const tmpPath = "/tmp/gcp-credentials.json";
  require("fs").writeFileSync(tmpPath, process.env.GOOGLE_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
}

const vertex = new AnthropicVertex({
  projectId: process.env.GCP_PROJECT_ID,
  // "global" endpoint: max availability, no regional pricing premium, and it
  // serves claude-sonnet-4-5@20250929 (regional endpoints like us-east5 may 404).
  region: process.env.GCP_REGION || "global",
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function topicKey(topic) {
  return topic.toLowerCase().trim().replace(/\s+/g, ' ');
}

async function getCachedLab(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/labs?topic_key=eq.${encodeURIComponent(key)}&select=lab_data&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0].lab_data : null;
  } catch (err) {
    console.warn('getCachedLab failed:', err.message);
    return null;
  }
}

async function saveLab(key, topic, labData) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/labs`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ topic_key: key, topic, lab_data: labData }),
    });
  } catch (err) {
    console.warn('saveLab failed:', err.message);
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
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: `Topic: ${topic}\n\nProduce the complete recipe JSON.` },
    ],
  });
  return JSON.parse(res.choices[0].message.content.trim());
}

function injectRecipe(recipe) {
  const serialized = JSON.stringify(recipe);
  return ENGINE_TEMPLATE.replace(
    /\/\*__RECIPE__\*\/[\s\S]*?\/\*__END__\*\//,
    `/*__RECIPE__*/ ${serialized} /*__END__*/`
  );
}

async function verify(topic, question, recipeSummary, userAnswer, labResult) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 512,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: VERIFY_SYSTEM },
      { role: "user", content:
        `Topic: ${topic}\nQuestion: ${question}\nLab summary: ${recipeSummary}\n` +
        `Engine verdict: ${labResult ? JSON.stringify(labResult) : "n/a"}\nStudent answer: ${userAnswer}` },
    ],
  });
  return JSON.parse(res.choices[0].message.content.trim());
}

async function analyzeImage(base64Image, question) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 512,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
        { type: "text", text: question || "Describe what the learner has built in this lab." },
      ],
    }],
  });
  return res.choices[0].message.content.trim();
}

// ─────────────────────────────────────────────────────────────────
// FREEFORM LAB PIPELINE — six steps (image step is optional):
//   0. expandTopic        — gpt-4o-mini: sharpens vague input to one specific concept
//   1. thinkAboutTopic    — gpt-4o-mini prose: insight, metaphor, variables + why
//   2. specFromThinking   — gpt-4o JSON: typed spec
//   3. thinkAboutLab      — gpt-4o prose brief: behavior + visuals, no UI words
//   4. mockupImage        — gpt-image-1: clean UI mockup (OPTIONAL, USE_MOCKUP=1)
//   5. codeFromImageBrief — gpt-4o vision: image + brief → final HTML
// ─────────────────────────────────────────────────────────────────

// Step 0 — turns vague topics into one specific, teachable concept.
// "ML" → "Gradient Descent: how a model finds the bottom of a loss landscape"
// "Physics" → "Newton's Second Law: why heavier objects need more force to accelerate"
// "Compound Interest" → passes through unchanged (already specific enough)
async function expandTopic(rawTopic) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You sharpen vague learning topics into one specific, teachable concept.

Return ONLY JSON:
{
  "topic": "The sharpened topic. 3-10 words. Must be a CONCEPT with a surprising insight, not a skill or activity. Examples: 'Topspin: why a spinning tennis ball curves downward faster than gravity', 'Gradient Descent: why loss curves have valleys a model can slide down', 'Newton\\'s Second Law: why doubling mass halves acceleration for the same force'.",
  "why": "One sentence: the specific aha moment this concept produces. E.g. 'The moment you see the ball curve MORE than expected is when you understand that spin changes the effective gravity on the ball.'"
}

RULES:
- If the input names a SPORT or ACTIVITY (tennis, basketball, cooking, driving): find the underlying physics concept. 'Tennis' → 'Topspin: why spin bends a ball's path'.
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
  return JSON.parse(res.choices[0].message.content.trim());
}

async function thinkAboutTopic(topic) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 700,
    messages: [
      {
        role: "system",
        content: `You are an expert at explaining how concepts should FEEL to learn. Given a topic, write a short analysis covering exactly these five things:

1. THE CORE INSIGHT — what single thing, once felt in the body or seen visually, makes this concept truly click? Not a definition — the moment of understanding.

2. THE VISUAL METAPHOR — what does this concept look like IN MOTION? Use a vivid image. Examples: "money piling up faster and faster, the stack growing so tall it leans", "two curves chasing each other across a graph until they cross and lock", "a planet falling sideways forever, missing the Earth each time". Be specific to THIS topic.

3. THE KEY VARIABLES — what 2-4 things can a learner change? For each one, explain WHY it matters to the core insight (not just what it is). Example: "Rate matters because it controls how fast the pile grows — double it and the pile doesn't just grow twice as fast, it grows faster than that."

4. THE AHA MOMENT — describe the precise moment in the interaction when the learner says "oh!". What did they just see happen? What did they move or change right before it?

5. THE REAL-WORLD COST — one concrete situation where NOT understanding this concept costs someone something real (money, health, a bad decision, a failed system).

Write in plain, direct prose. Be specific to ${topic}. Do not use generic educational language. Do not suggest a lab format or interaction type.`,
      },
      { role: "user", content: `Topic: ${topic}` },
    ],
  });
  return res.choices[0].message.content.trim();
}

async function specFromThinking(topic, thinking) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You convert educational reasoning into an interactive lab spec. Read the reasoning and produce JSON.

Return ONLY JSON with this exact shape:
{
  "topic": "Display name for the topic",
  "scenario": "2-3 paragraph immersive 2nd-person scenario. Open with a CONCRETE real-world moment: a real role, place, dollar amount, failure mode. End by telling the learner exactly what they are about to manipulate and why it matters right now.",
  "verificationQuestion": "One specific question the learner can only answer correctly AFTER interacting with the lab.",
  "spec": {
    "title": "Short punchy lab title",
    "learning_goal": "One sentence using the exact words of the core insight from the reasoning.",
    "visualMetaphor": "One vivid sentence describing what the simulation looks and feels like IN MOTION. Not a chart type — a scene. E.g. 'Money piling up in stacks of gold coins, each new coin landing with a clink, the stacks growing taller until they overflow the screen.' Copy from the reasoning verbatim.",
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
- rules MUST include at least one threshold that triggers the aha moment visually
- the default state must already show interesting behavior on load — never a blank or boring starting point. The sim opens mid-phenomenon.
- reflection question must be answerable only AFTER interacting — not a definition lookup
- do NOT include interaction_type, lab_type, or any format label anywhere in the JSON`,
      },
      {
        role: "user",
        content: `Topic: ${topic}\n\nReasoning:\n${thinking}\n\nNow produce the spec JSON.`,
      },
    ],
  });
  const parsed = JSON.parse(res.choices[0].message.content.trim());
  normalizeReflection(parsed);
  return parsed;
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
async function thinkAboutLab(design) {
  const vars = (design.spec.variables || [])
    .map(v => `  • ${v.name} (${v.unit || ""}), range ${v.min}–${v.max}, default ${v.default}: ${v.why_it_matters}${v.regimes_note ? `\n    REGIMES: ${v.regimes_note}` : ""}`)
    .join("\n");

  const prompt = `You are a senior creative coder designing an interactive learning lab. You will produce a CONCRETE VISUAL BRIEF that another developer can implement directly in HTML Canvas 2D.

TOPIC: ${design.topic}
LEARNING GOAL: ${design.spec.learning_goal}
VISUAL METAPHOR: "${design.spec.visualMetaphor}"

VARIABLES:
${vars}

AHA MOMENT: ${design.spec.aha_trigger}

Write a concrete brief covering these four areas. Be specific enough that a developer can write the drawing code directly from your description — no ambiguity, no "something that represents X".

━━━ 1. WHAT DRAWS ON LOAD (before any interaction) ━━━
Describe exactly what the canvas shows at startup. Name every drawn element with its approximate position, size, color, and whether it's animated. The canvas must look interesting and alive before the user touches anything. Include: a background (gradient or pattern), at least one always-moving element, and axis/grid lines if the concept involves quantities.

Example level of detail: "A dark navy canvas (#0E1830). Faint blue grid lines every 50px. A glowing copper sine wave drawn across the full width, oscillating slowly — amplitude 80px, one full cycle visible. A white dot riding the wave, moving left to right continuously. Label 'frequency: 1 Hz' in the top-right in #8899BB."

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

RULES:
- Every element you describe must be drawable with Canvas 2D API calls (fillRect, arc, bezierCurveTo, etc.)
- Minimum 2 variables with distinct visual effects
- The PRIMARY variable must let the learner reach EVERY regime from its REGIMES note — the morphing visual across those regimes is the core of the lab
- Zone B (the canvas) takes at least 65% of the screen height
- Zone A (controls) is a compact panel — max 35% height on mobile, right-side panel on desktop
- The central visual element must be LARGE — fill the stage, not a tiny dot in an empty field
- No decorative elements that don't respond to or show the concept`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2500,
    messages: [{ role: "user", content: prompt }],
  });

  return res.choices[0].message.content.trim();
}

// Step 4 (optional) — gpt-image-1 generates a clean UI mockup.
// Returns a base64 data URL or null on failure (pipeline continues without image).
async function mockupImage(topic, visualMetaphor) {
  const prompt = `You are an educational interface designer. Produce a single clean UI mockup — like a screenshot of a finished interactive learning tool, NOT an illustration or artwork.

Subject: an interactive lab teaching "${topic}".
Core visual metaphor: ${visualMetaphor}.

Depict the tool MID-INTERACTION — show it in a state that makes clear something is being manipulated and something is responding. The viewer should be able to tell this is a live, dynamic tool, not a static diagram.

Layout: one clear focal interaction in the center. A manipulable element on one side, its live visual result on the other. Generous whitespace.

Style: flat, modern, high-contrast, minimal. Clean SaaS dashboard, not textbook. Solid dark background (#0B1220). Clear visual hierarchy. Accent colors: #3B82F6 blue, #D4A574 copper.

Do NOT include: paragraphs of text, labels with real words (use simple shapes and clean iconography instead), fake browser chrome, photorealism, 3D bevels, drop shadows, decorative clutter, watermarks, or anything that isn't part of the actual tool.

Aspect ratio: landscape, fills the frame edge to edge.`;

  try {
    const res = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1536x1024",
      n: 1,
    });
    const b64 = res.data[0].b64_json;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.warn("mockupImage failed, continuing without:", err.message);
    return null;
  }
}

// Step 5 — writes the final HTML lab.
// Takes the prose brief (source of truth for behavior) + optional mockup image (look/layout).
//
// NOTE: This step originally ran on Claude (claude-opus-4-7), then OpenAI gpt-4o,
// then Google Gemini (gemini-2.5-flash). Now uses Claude on Google Vertex AI.
// Change LAB_MODEL here to swap models.
const LAB_MODEL = "claude-sonnet-4-5@20250929";
async function codeFromImageBrief(design, labThinking, imageDataUrl) {
  const vars = (design.spec.variables || [])
    .map(v => `  • ${v.name} (${v.unit || ""}): ${v.min}–${v.max}, default ${v.default}. ${v.why_it_matters}${v.regimes_note ? `\n    REGIMES (make all reachable): ${v.regimes_note}` : ""}`)
    .join("\n");

  const formulas = design.spec.formulas
    ? Object.entries(design.spec.formulas).map(([k, v]) => `  ${k} = ${v}`).join("\n")
    : "";
  const rules = (design.spec.rules || [])
    .map(r => `  • when (${r.when}): ${r.visual_change} — show message "${r.message}"`)
    .join("\n");

  const briefText = `You are building a self-contained interactive learning lab for Repend. You MUST output a complete, working HTML file — no summaries, no outlines, no explanations, no apologies, no "this is complex" disclaimers. If you do not output a full <!doctype html> file, the platform breaks and learners see nothing. Output the HTML file directly, right now.

${imageDataUrl ? `You are given two inputs:
1. A VISUAL MOCKUP (image) — use ONLY for layout, color, spatial arrangement, overall feel.
2. A BEHAVIORAL BRIEF (below) — source of truth for what the lab actually DOES.

RULES OF PRECEDENCE:
- Image and brief conflict → the brief wins, every time.
- The image contains garbled text, fake labels, or nonsensical UI fragments → IGNORE them. Implement real, working controls with real labels derived from the brief. Never reproduce meaningless elements just because they appear in the image.
` : `You are given a behavioral brief below — the source of truth for what the lab does.`}

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

Every live readout in Zone B MUST be computed from these formulas. The learner must see the output value changing as a real number.
` : ""}
${rules ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THRESHOLD RULES — trigger these exact visual events:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${rules}

When a rule triggers: animate a golden glow burst on the key canvas element AND show the message text prominently in Zone B for 2-3 seconds.
` : ""}
SUCCESS CONDITION: ${design.spec.success_condition}
REAL-WORLD PAYOFF (show on success): "${design.spec.real_world_payoff || ""}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYOUT — TWO ZONES (non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• ZONE A — controls: compact panel. On mobile (width ≤ 500px) Zone A sits at the TOP as a horizontal strip, max 160px tall. On desktop Zone A sits on the LEFT, max 220px wide. Zone B fills all remaining space. Use CSS flex column on mobile, row on desktop. Zone A must NEVER overlap Zone B — set explicit widths/heights so they are cleanly separated.
• ZONE B — result canvas: fills all remaining space after Zone A. The canvas element's width and height attributes must be set dynamically from its actual rendered pixel size (use ResizeObserver or set after layout). Never hardcode canvas.width/height to values that differ from the element's CSS size — that causes stretched/blank output.
• Zone B must react to every Zone A change within 16ms. No submit button. No lag.
• Zone B must have at least one live text readout of the OUTPUT value (not the control value). "Surface damage: HIGH" not "Friction: 0.9". The readout names the EFFECT, not the input. Draw it ON the canvas, not as an HTML element on top.
• Nothing in Zone B is decorative. Every element either reacts to input or displays a result.
• The aha moment from the brief must be visually unmissable in Zone B — a sudden change, a shape snapping, a value jumping.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CANVAS MUST DRAW SHAPES — NOT JUST TEXT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Zone B must show a DRAWN SIMULATION — actual shapes, motion, and physics drawn with Canvas 2D primitives. It is NOT acceptable to output a canvas that only contains ctx.fillText() calls showing slider values. The canvas must contain:
• At least 3 distinct drawn shapes (fillRect, arc, lineTo, bezierCurveTo, etc.) that represent the actual concept, not labels
• At least one shape that MOVES or ANIMATES continuously even before interaction (a plate sliding, a particle oscillating, a wave propagating)
• At least one shape that CHANGES SIZE, POSITION, COLOR, or SHAPE as each slider moves
• Simulation-style visuals: cross-sections of earth, orbiting bodies, wave patterns, circuit diagrams, growing curves — not a blank grid with floating text

BAD (do not do): canvas showing only "Slip Rate: 3 cm/year\nFriction: 0.9\nSurface Damage: Low" as text on a grid
GOOD: a canvas showing two tectonic plate layers (filled rectangles) sliding in opposite directions, a glowing stress indicator building up, seismic waves radiating outward when a threshold is crossed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PEDAGOGY RULES (from research on effective learning sims — PhET):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• THE CENTRAL VISUAL MUST BE LARGE — it fills the stage. Never a tiny dot or shape floating in empty space. If the concept has a small object (a planet, a particle), the IMPORTANT thing (its path, field, or behavior) fills the canvas.
• PERSISTENT TRACE: draw a trail/path/history that stays on screen so the learner compares before-vs-now without remembering. Fade older segments. This morphing trace is usually the single most important visual — implement the one from section 5 of the brief precisely.
• MAKE THE INVISIBLE VISIBLE: draw the hidden vectors/forces/energy from section 5 of the brief — velocity arrows, force arrows, energy bars, fields. These explain WHY the behavior happens.
• LINKED REPRESENTATIONS: show the key quantity in 2+ ways at once (a number AND a bar AND the motion), all updating together.
• DEFAULT NEAR THE BOUNDARY: initialize the primary control at its default value, which sits just below the most surprising threshold — so the learner's first small nudge flips the outcome and reveals the aha. The sim opens mid-phenomenon, already showing interesting motion.
• REACH EVERY REGIME: the primary control's range must let the learner reach every regime in its REGIMES note (e.g. crash / orbit / escape). Let the learner fail safely and visibly — the failure states ARE part of the lesson, show them vividly, don't block them.
• PRESET BUTTONS: add 2-3 small preset buttons in Zone A that jump to interesting regimes (e.g. "Circular", "Comet", "Crash") plus a "Reset" button. One tap puts the learner in a meaningful state.
• IMPLICIT GUIDANCE: don't write "now drag the slider" instructions. Make the productive action obvious through layout and defaults. Controls look grabbable (clear handles, hover highlight).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TECHNICAL CONSTRAINTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• ONE complete self-contained HTML file. Inline CSS and JS.
• Vanilla JS only. NO external libraries, NO CDN links, NO import statements, NO require(). The lab runs inside sandbox="allow-scripts" which blocks all network requests — any <script src="..."> or fetch() will silently fail and break the lab. Everything must be inline in the single HTML file.
• No localStorage / sessionStorage. No fetch().
• Works in sandbox="allow-scripts".
• Zero console errors on first load.
• Responsive: usable from 360px wide to full desktop.
• Dark theme: bg #0B1220, stage #0E1830, panels #131A2A, border rgba(59,130,246,0.2). Accents: blue #3B82F6, copper #D4A574, success #22C55E, muted #8899BB.
• CANVAS SIZING — mandatory pattern to prevent stretched/blank canvas:
  const canvas = document.getElementById('mainCanvas');
  const ctx = canvas.getContext('2d');
  function resizeCanvas() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  // Then start the draw loop:
  function draw() { ctx.clearRect(0,0,canvas.width,canvas.height); /* draw everything */ requestAnimationFrame(draw); }
  draw(); // called immediately on load — never wait for user input to start drawing
  If canvas is blank on load, the lab has failed. A common cause: canvas.width/height not matching the element's CSS size.
• Zone B must show something meaningful within 100ms of page load — no waiting for interaction.
• VISUAL DEPTH — make it look alive, not flat:
  - Gradient backgrounds on canvas (createLinearGradient or createRadialGradient)
  - Glowing elements: draw a blurred shadow before the main shape (ctx.shadowBlur=20, ctx.shadowColor='#3B82F6')
  - At least one element that is always animating (wave oscillating, particle moving, value counting) even before interaction
  - Layered drawing: background grid/gradient first, then physics objects, then labels on top
• MINIMUM 2 interactive controls — never just one slider.
• A visible "Check Answer" button in Zone A.
• requestAnimationFrame for all motion. pointerdown/move/up for drag.
• On aha moment: golden glow burst (shadowBlur spike) on the key Zone B element.
• On success: green wave across canvas + real_world_payoff card slides in.
• window.parent.postMessage({ type:"labCheck", result:{ ok:true,  score:1, total:1 } }, "*") on success.
• window.parent.postMessage({ type:"labCheck", result:{ ok:false, score:0, total:1 } }, "*") on wrong.

DO NOT render any multiple-choice quiz, reflection question, or "verify your understanding" section inside this lab. The platform shows a separate quiz AFTER the lab. This lab is for HANDS-ON INTERACTION ONLY — manipulating controls and watching the result. Adding a quiz here would duplicate the platform's quiz. The "Check Answer" button checks whether the learner reached the success condition (e.g. produced the target orbit), NOT a multiple-choice answer.

Before returning, verify ALL of these — fix any that fail before responding:
1. Does Zone B contain actual drawn SHAPES (fillRect, arc, lineTo, etc.) that represent the concept — NOT just a grid with ctx.fillText() labels?
2. Is Zone B drawing something visible AND in motion immediately on load (not blank, not a tiny dot in empty space)?
3. Is the central visual LARGE — filling the stage rather than floating small in a big empty field?
4. Is Zone A on TOP (mobile) or LEFT (desktop), cleanly separated from Zone B with no overlap?
5. Does canvas.width and canvas.height match the element's actual rendered pixel size (set via offsetWidth/offsetHeight)?
6. Is there a persistent trail/trace that morphs as the primary control changes?
7. Are hidden vectors/forces/energy drawn (arrows, bars, fields)?
8. Are there at least 2 interactive controls plus preset + reset buttons?
9. Is the output readout showing the EFFECT (e.g. "Earthquake Magnitude: 7.2"), not just echoing the input value?
10. Does the canvas use gradients and glow — does it look like a polished simulation, not a flat grey box?

Output only the HTML file. Start with <!doctype html>. No markdown. No explanation. No code fences.`;

  // --- GEMINI FALLBACK (commented out) ---
  // const model = gemini.getGenerativeModel({ model: "gemini-2.5-flash" });
  // const parts = [{ text: briefText }];
  // if (imageDataUrl) {
  //   const m = imageDataUrl.match(/^data:(.+?);base64,(.*)$/);
  //   if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  // }
  // const res = await model.generateContent({
  //   contents: [{ role: "user", parts }],
  //   generationConfig: { maxOutputTokens: 12000, temperature: 0.7 },
  // });
  // let html = res.response.text().trim();
  // html = html.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // return html;
  // --- END GEMINI FALLBACK ---

  // AnthropicVertex (claude-sonnet-4-5@20250929 on Google Vertex AI)
  const messageContent = [{ type: "text", text: briefText }];
  if (imageDataUrl) {
    const m = imageDataUrl.match(/^data:(.+?);base64,(.*)$/);
    if (m) messageContent.push({
      type: "image",
      source: { type: "base64", media_type: m[1], data: m[2] },
    });
  }

  const response = await vertex.messages.create({
    model: LAB_MODEL,
    max_tokens: 12000,
    messages: [{ role: "user", content: messageContent }],
  });

  let html = response.content[0].text.trim();
  html = html.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return html;
}

// ─────────────────────────────────────────────────────────────────
// SERVER
// /plan-lab uses SSE to stream progress stages to the frontend
// ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }

  if (req.method === "GET" && req.url === "/engine.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "engine.html")));
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

          // Stream progress via SSE
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          const send = (stage, msg, data) => {
            res.write(`data: ${JSON.stringify({ stage, msg, data })}\n\n`);
          };

          const rawTopic = data.topic.trim();

          send("expand", `Sharpening topic…`);
          const expanded = await expandTopic(rawTopic);
          const topic = expanded.topic;
          const key = topicKey(topic);
          send("expanded", `Building lab for: ${topic}`, { topic, why: expanded.why });

          // ── Cache hit: serve instantly, zero AI cost ──────────────────
          const cached = await getCachedLab(key);
          if (cached) {
            send("done", "Lab ready.", { ...cached, source: "cached" });
            res.end();
            return;
          }

          // ── Cache miss: run full pipeline then save ───────────────────
          send("think", `Reasoning about "${topic}"…`);
          const thinking = await thinkAboutTopic(topic);

          send("design", "Translating insight into lab spec…");
          const design = await specFromThinking(topic, thinking);

          send("labthink", "Thinking about how to build it…");
          const labThinking = await thinkAboutLab(design);

          let imageDataUrl = null;
          if (process.env.USE_MOCKUP === "1") {
            send("image", "Sketching a visual mockup…");
            imageDataUrl = await mockupImage(design.topic, design.spec.visualMetaphor);
          }

          send("code", "Writing your lab…");
          const html = await codeFromImageBrief(design, labThinking, imageDataUrl);

          const labData = {
            topic: design.topic,
            scenario: design.scenario,
            verificationQuestion: design.verificationQuestion,
            learningGoal: design.spec.learning_goal,
            realWorldPayoff: design.spec.real_world_payoff,
            reflection: design.spec.reflection || null,
            labHtml: html,
          };

          send("done", "Lab ready.", { ...labData, source: "generated" });
          res.end();

          // Fire-and-forget save — don't block the response
          saveLab(key, design.topic, labData);

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
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || "Something went wrong" }));
        } else {
          // SSE already started — send error event then close
          res.write(`data: ${JSON.stringify({ stage: "error", msg: err.message || "Something went wrong" })}\n\n`);
          res.end();
        }
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`Repend running at http://0.0.0.0:${PORT}`));
