const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// OpenAI also returns transient 429/503s under load. Retry with exponential
// backoff (~1s/2s/4s/8s) on overload errors only; rethrow real bugs.
async function openaiCreate(params, label = "openai") {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await openai.chat.completions.create(params);
    } catch (err) {
      lastErr = err;
      if (!isOverloadError(err)) throw err;
      if (attempt < 3) {
        const wait = 1000 * Math.pow(2, attempt);
        console.warn(`[${label}] OpenAI overloaded (attempt ${attempt + 1}), retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// Helper: OpenAI plain-text response
async function openaiText(prompt, maxTokens = 1000, model = "gpt-4o-mini") {
  const res = await openaiCreate({
    model, max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  }, "text");
  return res.choices[0].message.content.trim();
}

// Helper: OpenAI JSON response (json_object mode)
async function openaiJSON(prompt, maxTokens = 2500, model = "gpt-4o") {
  const res = await openaiCreate({
    model, max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  }, "json");
  return JSON.parse(res.choices[0].message.content.trim());
}

// The HTML codegen + repair steps call gemini.getGenerativeModel directly (see
// codeFromImageBrief and repairLab) — that is the only place Gemini is used.

function topicKey(topic) {
  return topic.toLowerCase().trim().replace(/\s+/g, ' ');
}

async function getCachedLab(key) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  try {
    const { data, error } = await supabase
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

async function saveLab(key, topic, labData) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return;
  try {
    await supabase
      .from('labs')
      .upsert({ topic_key: key, topic, lab_data: labData }, { onConflict: 'topic_key' });
  } catch (err) {
    console.warn('saveLab failed:', err.message);
  }
}

// Save or update a user's progress on a lab (called from /api/progress endpoint)
async function saveProgress(userId, key, topic, { completed = false, score = 0 } = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return;
  try {
    const { data: existing } = await supabase
      .from('lab_progress')
      .select('attempts')
      .eq('user_id', userId)
      .eq('topic_key', key)
      .single();
    await supabase.from('lab_progress').upsert({
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
  return openaiText(`You are an expert at designing interactive learning experiences for ANY topic — STEM, history, economics, psychology, ethics, arts, everyday life. Write a short analysis of "${topic}" covering exactly these six things:

STEP 0 — INTERACTION CLASSIFIER: Before anything else, classify this topic and pick the interaction type that will make it click:
  • If the concept has motion/forces → physics-sim (planets, fluids, waves, projectiles)
  • If behavior jumps suddenly at a boundary → threshold (phase transitions, action potentials, tipping points)
  • If things compound/accumulate over time → accumulation (interest, climate, debt, skill)
  • If something flows through stages → process-flow (supply chains, photosynthesis, legislation)
  • If two forces optimize against each other → tradeoff (supply/demand, risk/return)
  • If it's a static structure to assemble → structure-puzzle (circuits, timelines, food webs)
  • If the learner makes sequential choices with branching consequences → branching-decision (history counterfactuals, ethics dilemmas, medical diagnosis, strategy)
  • If the learner must EXPERIENCE a bias or social phenomenon firsthand → bias-trap (anchoring, sunk cost, groupthink, prisoner's dilemma)
  • If learner allocates a fixed resource across competing priorities → budget-allocation (government budgets, personal finance, nutrition, time management)
  • If emergent social/collective behavior appears from simple individual rules → agent-social-sim (segregation, epidemic spread, market prices, opinion dynamics)
State: "INTERACTION TYPE: [chosen type] because [one sentence reason]."

1. THE CORE INSIGHT — what single thing, once experienced interactively, makes this concept truly click? Not a definition — the moment of understanding.
2. THE VISUAL/INTERACTIVE METAPHOR — what does this concept look, feel, or play like? Be vivid. For non-quantitative topics: describe the branching tree, the bias reveal moment, the budget constraint, or the emergent pattern — not a chart.
3. THE KEY VARIABLES or CHOICES — what 2-4 things can a learner change or decide? For each, explain WHY it matters to the insight.
4. THE AHA MOMENT — the precise moment when the learner says "oh!". What did they just see or experience?
5. THE REAL-WORLD COST — one concrete situation where not understanding this costs something real (money, health, justice, a relationship, a historical outcome).

Write in plain direct prose. Be specific to ${topic}.`, 1000, "gpt-4o-mini");
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
    "lab_archetype": "Exactly one of: physics-sim | threshold | accumulation | process-flow | tradeoff | structure-puzzle | branching-decision | bias-trap | budget-allocation | agent-social-sim. Choose the ONE whose interaction mechanic best exposes the core insight:\n  physics-sim = continuous motion/forces (orbital mechanics, waves, projectile, fluid dynamics)\n  threshold = behavior jumps suddenly at a boundary (states of matter, action potential, tipping points, viral spread)\n  accumulation = things compound over time (compound interest, debt, climate CO2, skill building)\n  process-flow = something moves through stages (photosynthesis, digestion, supply chain, legislation passage)\n  tradeoff = two competing forces find an optimum (supply/demand, risk/return, specialization/flexibility)\n  structure-puzzle = click to arrange/mark a static structure (circuits, genetics pedigree, food web, historical timeline)\n  branching-decision = learner makes sequential choices that lead to different outcomes (historical counterfactual, ethical dilemma, business strategy, medical diagnosis) — show a branching tree of consequences, the learner navigates it by choosing at each fork\n  bias-trap = learner EXPERIENCES a cognitive bias or social phenomenon first-hand (anchoring, confirmation bias, groupthink, sunk cost) — the learner makes a series of real judgments, sees their own pattern revealed, then compares to the research\n  budget-allocation = learner drags sliders to allocate a fixed resource (budget, time, calories, votes, risk) across competing priorities — tradeoffs emerge when the total is fixed and each allocation has consequences shown live\n  agent-social-sim = many autonomous agents follow simple rules and emergent social patterns appear (segregation, market price discovery, epidemic spread, language evolution) — learner adjusts the rules and watches collective behavior change",
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
- PHYSICAL TRUTH: every variable MUST appear in at least one formula expression. If a variable affects no formula, it is fake — DELETE it. Never invent decorative variables that sound topical but don't drive the physics (e.g. "contact surface" for Newton's third law). Three honest variables beat four where one is a lie — the learner WILL move it and learn something false.
- UNITS ARE REAL: every variable unit and every readout is a real physical/financial unit (N, m/s, kg, %, $, years). NEVER pixels, NEVER unitless numbers. If the canvas measures something spatially, define a scale (e.g. 50 px = 1 m) and display the converted value.
- DIMENSIONALITY: default to 2D. Research shows 3D raises cognitive load and only helps high-spatial-ability learners. The visualMetaphor should be 2D unless the concept's ESSENCE is 3D spatial structure (molecular geometry, protein folding, crystal lattices, orbital inclination, vector fields in space). Planar concepts (forces, circuits, graphs, kinematics, economics, statistics, waves) MUST be 2D — never describe a 3D scene for them.
- LABELS: every object the learner sees must be nameable in one word. If a variable or object can't be given a clear one-word on-screen label, it's probably too abstract — reconsider it.
- rules MUST include at least one threshold that triggers the aha moment visually
- the default state must already show interesting behavior on load — never a blank or boring starting point. The sim opens mid-phenomenon.
- reflection question must be answerable only AFTER interacting — not a definition lookup
- lab_archetype MUST be one of the ten listed — choose the one that best reveals the concept through interaction, not the most generic one. For non-STEM topics: history/ethics/philosophy → branching-decision; behavioral economics/psychology → bias-trap; government/personal finance/nutrition → budget-allocation; sociology/epidemiology/economics → agent-social-sim
- entry_misconception MUST be a specific wrong belief, not a vague gap — "they think heavier objects fall faster" not "they don't understand gravity"
- first_move MUST describe a concrete action that surprises the learner within 10 seconds and directly challenges the entry_misconception
- direct_manipulation MUST describe a canvas object the learner grabs with their finger/mouse — not a slider. The primary variable is controlled by dragging something on the canvas.
- interaction_palette MUST include at least one "draggable" and one "toggle-button" entry — the lab needs multiple interaction types, not just sliders
- do NOT include interaction_type or any format label anywhere in the JSON

Now produce the spec JSON.`
      },
      { role: "user", content: `Topic: ${topic}\n\nReasoning:\n${thinking}\n\nNow produce the spec JSON.` }
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
// NOTE: This step originally ran on Claude (claude-opus-4-7), then Gemini, then Vertex, then Ollama. Now uses OpenAI.
// Change LAB_MODEL here to swap models.
const LAB_MODEL = "gemini-2.5-pro";
// Fallback model tried if LAB_MODEL is overloaded (503) after retries.
const LAB_MODEL_FALLBACK = "gemini-2.5-flash";

function isOverloadError(err) {
  const msg = String(err && err.message || err);
  // Quota/billing exhaustion is a 429 too, but retrying won't help — treat
  // it as a hard error so we surface a clear billing message instead.
  if (/insufficient_quota|exceeded your current quota|billing/i.test(msg)) return false;
  return /\b(503|429|overloaded|high demand|Service Unavailable|rate limit)\b/i.test(msg);
}

function isQuotaError(err) {
  const msg = String(err && err.message || err);
  return /insufficient_quota|exceeded your current quota|billing/i.test(msg);
}

// Gemini's free tier 503s under load. Retry with exponential backoff across
// both Gemini models, then — if an openaiFallback is provided — fall back to
// OpenAI (a different provider, unlikely to be down at the same time).
// `openaiFallback` is `async (request) => string`; its return is wrapped to
// match the Gemini response shape so callers stay unchanged.
async function geminiGenerate(request, { label = "gemini", openaiFallback = null } = {}) {
  const models = [LAB_MODEL, LAB_MODEL_FALLBACK];
  let lastErr;
  for (const modelName of models) {
    const model = gemini.getGenerativeModel({ model: modelName });
    // Backoff schedule: ~1s, 2s, 4s, 8s
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await model.generateContent(request);
      } catch (err) {
        lastErr = err;
        // Only retry/fallback on transient overload errors; rethrow real bugs.
        if (!isOverloadError(err)) throw err;
        if (attempt < 3) {
          const wait = 1000 * Math.pow(2, attempt);
          console.warn(`[${label}] ${modelName} overloaded (attempt ${attempt + 1}), retrying in ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          console.warn(`[${label}] ${modelName} still overloaded after retries; trying next model`);
        }
      }
    }
  }
  // All Gemini models exhausted. Try OpenAI as a cross-provider fallback.
  if (openaiFallback) {
    try {
      console.warn(`[${label}] all Gemini models overloaded; falling back to OpenAI`);
      const text = await openaiFallback(request);
      return { response: { text: () => text } };
    } catch (err) {
      console.warn(`[${label}] OpenAI fallback also failed: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

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

  const archetype = design.spec.lab_archetype || "physics-sim";

  // Archetype-specific architecture patterns injected into codegen
  const archetypeArchitecture = {
    "physics-sim": `
━━━ ARCHITECTURE: PHYSICS SIMULATION ━━━
Build on requestAnimationFrame. State object holds all positions/velocities. Physics integrates every frame. Trail array stores past positions.
const state = { x, y, vx, vy, trail: [], t: 0 };
function update(dt) { /* integrate forces */ state.trail.push({x:state.x,y:state.y}); if(state.trail.length>200) state.trail.shift(); }
function draw() { ctx.clearRect(0,0,W,H); drawTrail(); drawObject(); drawVectors(); drawReadouts(); requestAnimationFrame(loop); }`,

    "threshold": `
━━━ ARCHITECTURE: THRESHOLD ━━━
One primary slider drives the simulation. The canvas shows a continuous slow change PLUS a sudden jump at the threshold.
const state = { value: defaultVal, threshold: X, crossed: false };
// In draw(): show the "approach" visually even before threshold. At threshold: trigger a burst + state.crossed=true.
// Hysteresis: if reversible, use two threshold values (up-threshold ≠ down-threshold).`,

    "accumulation": `
━━━ ARCHITECTURE: ACCUMULATION ━━━
Time advances via a play/pause loop. Draw TWO curves: the linear expectation AND the actual curve. Use a graph with labeled axes.
const state = { t: 0, playing: false, data: [] }; // data[t] = actual value
// Draw both curves from t=0 to current t. Show the gap between them as a filled region.
// Controls: Play/Pause button, Speed slider, Reset button. Time axis labeled in meaningful units.`,

    "process-flow": `
━━━ ARCHITECTURE: PROCESS FLOW ━━━
Draw each stage as a labeled region. Animate particles/tokens flowing between stages.
const stages = [{x,y,w,h,label,rate},...]; const particles = [];
// Each frame: move particles toward next stage. At each stage: transform particle color/size to show what happens there.
// Bottleneck visualization: particles pile up before a slow stage, showing the constraint.`,

    "tradeoff": `
━━━ ARCHITECTURE: TRADEOFF ━━━
Draw two curves that oppose each other. Their sum (or product) shows the optimum.
// curve1: decreasing function of x. curve2: increasing function of x. total: curve1+curve2.
// Learner drags a vertical cursor left/right. Show current values of both curves + total.
// Optimum point marked with a subtle indicator — glows only when cursor is within 5% of it.`,

    "structure-puzzle": `
━━━ ARCHITECTURE: STRUCTURE PUZZLE ━━━
NO continuous rAF physics loop. State changes on click, then evaluate() + draw().
const nodes = [{id, x, y, state:'unset', shape:'circle'},...];
canvas.addEventListener('click', e => { const hit = findHit(canvasPt(e)); if(hit){ hit.state=nextState(hit.state); evaluate(); draw(); } });
function evaluate() { /* check if current config matches the correct pattern */ }
function draw() { /* draw edges, then nodes colored by state, then status text */ }
// Light rAF loop ONLY for hover glow animation — not for physics.`,

    "branching-decision": `
━━━ ARCHITECTURE: BRANCHING DECISION ━━━
Show a tree of consequences that unfolds as the learner makes choices at each fork. No physics loop.
const tree = { id:'root', text:'Crisis begins...', choices:[{ label:'Negotiate', next:'negotiate-path', consequence:'...' }, { label:'Confront', next:'confront-path', consequence:'...' }] };
let currentNode = tree; const history = [];
// Render: draw the full tree structure as a visual graph (nodes as rounded rects, edges as bezier curves, visited = solid, unvisited = faded).
// Show the CURRENT node large in the center, its choices as prominent buttons.
// On choice: animate the edge, push to history, set currentNode = chosen branch, redraw.
// Progress bar shows how deep through the consequence chain the learner has gone.
// At leaf nodes: reveal the OUTCOME prominently — "This is why [historical/ethical consequence]."
// Back button lets learner explore alternate paths — encourage this, it IS the learning.`,

    "bias-trap": `
━━━ ARCHITECTURE: BIAS TRAP ━━━
The learner makes a series of real judgments (estimates, predictions, allocations) WITHOUT knowing a cognitive bias is at play.
const trials = [{ question:'...', anchor: X, correctAnswer: Y }, ...]; let trialIdx = 0; const responses = [];
// Phase 1 — LIVE (no explanation): show each trial, capture response, show no feedback.
// Phase 2 — REVEAL (after all trials): animate each response vs the correct answer. Draw a histogram of where MOST people land. Highlight the learner's dot in a different color on the distribution.
// Show the bias name and mechanism ONLY after the learner has experienced it — never before.
// The reveal must feel like a mirror: "Here is YOUR pattern across 5 trials."
// Then show one countermeasure the learner can use going forward.
// Use D3 for the distribution plot — real data showing the bias from studies, overlaid with the learner's result.`,

    "budget-allocation": `
━━━ ARCHITECTURE: BUDGET ALLOCATION ━━━
A fixed total resource (budget $, time hours, calories, votes) is distributed across 3-5 competing priorities via draggable sliders.
const TOTAL = 1000; // e.g. $1000 budget
const categories = [{id:'r&d', label:'R&D', allocated:0, color:'#3B82F6', consequence:'...'}, ...];
// Constraint: sum(allocated) MUST always equal TOTAL — when one slider moves, redistribute the remainder proportionally.
// Draw: a horizontal stacked bar at the top showing current allocation with live $ labels.
// Below: each category shows allocated amount + its CONSEQUENCE (icons/text that changes with allocation level).
// Outcomes: a live OUTCOME score (profit, health, happiness) computed from the allocations via a formula.
// The learner must discover that the naive "equal split" is suboptimal — the optimal has nonlinear payoffs.
// Win: reach within 5% of the optimal allocation. Show the optimal breakdown after win.`,

    "agent-social-sim": `
━━━ ARCHITECTURE: AGENT SOCIAL SIM ━━━
Many autonomous agents (dots, icons, avatars) follow simple local rules. Emergent collective behavior appears.
const agents = Array.from({length:100}, (_,i) => ({ x:Math.random()*W, y:Math.random()*H, type:Math.random()<0.5?'A':'B', state:'neutral' }));
// Each frame: for each agent, look at nearest neighbors and apply the rule (e.g. Schelling threshold, SIR transition probability).
// Draw agents as colored dots (r=6). Use different colors per type/state. Show count labels per state.
// Controls: rule parameters (e.g. "Tolerance threshold", "Infection rate") — learner adjusts rules and watches collective behavior change.
// The emergent pattern (segregation, epidemic curve, price convergence) must appear NATURALLY from individual rules — never hard-code the macro pattern.
// Show a live aggregate chart (D3 line chart of state proportions over time) so the learner sees BOTH the individual agents AND the macro trend.
// Convergence to a stable state fires the win condition — show the emergent property named explicitly.`,
  };

  const briefText = `━━━ REPEND MISSION ━━━
Repend is an exploration engine that teaches any topic through hands-on interaction. Before generating ANYTHING, ask: "What is the most engaging way to make this concept click — through a simulation, a game, a decision tree, a social experiment, or a visual puzzle?" Default to the format that lets the learner FEEL the concept, not just read about it. A good lab produces an "aha" moment the learner couldn't get from a textbook. Passive explanations, static charts, and reading-only interfaces are rejected — every element must respond to the learner's action.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are building a single self-contained interactive learning lab. LAB ARCHETYPE: ${archetype.toUpperCase()}. You MUST output a complete, working HTML file right now — no summaries, no explanations.

${imageDataUrl ? `You are given two inputs:
1. A VISUAL MOCKUP (image) — use ONLY for layout, color, spatial arrangement.
2. A BEHAVIORAL BRIEF (below) — source of truth for what the lab DOES. Brief wins over image always.
` : `You are given a behavioral brief below — the source of truth for what the lab does.`}

GOAL: the learner manipulates something, watches the concept's real mechanism unfold, understands what every element on screen means, and sees how it works in the real world.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESEARCH-GROUNDED RULES (from PhET, cognitive-load theory, Mayer's multimedia principles, direct-manipulation HCI — follow these; they override any conflicting instinct):
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

2D BY DEFAULT — 3D ONLY WHEN SPATIAL STRUCTURE IS THE LESSON (research: 3D raises cognitive load and only helps high-spatial-ability learners with interactive manipulation): Use flat 2D for forces in a plane, circuits, graphs, charts, kinematics, economics, statistics, waves — 3D for these HURTS comprehension and adds perspective bias. Reserve pseudo-3D/3D for concepts whose essence IS 3D spatial structure (molecular geometry, protein folding, crystal lattices, orbital inclination, vector fields in space). Newton's third law is a planar concept — keep it 2D; the fix is labels + collision + units, not 3D.

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

STEP 2 — Wrap it in Predict → Manipulate → Reveal:

- Predict: before the sim is interactive, one specific falsifiable question about what will happen (2–4 options), then a confidence tap. They must commit before touching it.
- Manipulate: reveal the full interactive visual. Every control produces immediate, visible, meaningful change. One conceptual prompt only ("Test it — were you right?"), no step-by-step instructions.
- Reveal: an explanation that references THEIR prediction — whether it held and the real reason why — landing as a visible event in the sim, not a paragraph.

STEP 3 — Make it transfer to real life. Tie the concept to a concrete real-world instance the learner can picture (the money in their savings account; the actual orbit of the ISS; a real population of animals). The "aha" should make them see the concept operating in the world, not just on screen.

HARD RULES:
- The visual must externalize the core mechanism. If you could delete it and lose no understanding, it's decoration — remove it.
- Strip everything that doesn't encode meaning. No ornamental images, no decorative motion. Color and motion must carry the concept.
- Any continuous animation gets play/pause/step + speed controls. Open in a near-still state with one obviously-grabbable element.
- Max ~3 groups of ~3 controls. Labels 1–3 words. Play area visually separate from controls.
- Single self-contained HTML file, vanilla JS, canvas or SVG, no external dependencies, zero console errors on first load, works from 360px wide up.

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
PHYSICAL TRUTH — nothing on screen may be false or meaningless:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Every readout shows a NAMED quantity with a REAL unit: "Acceleration: 3.2 m/s²", "Balance: $4,820". NEVER a bare number ("Resulting Motion: 7.12") and NEVER pixels ("Separation: 154 px") — define a world scale (e.g. 50 px = 1 m) and always display converted physical values.
• Every control must visibly change an output through one of the formulas. If moving a control changes nothing the learner can see, DELETE the control — a dead or fake control teaches something false.
• Only implement variables that appear in the formulas. If the brief or spec includes a variable that drives no formula, drop it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPLAIN EVERYTHING ON SCREEN (non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every entity, dot, shape, color, or symbol MUST be explained with a visible legend or inline label BEFORE or AS the learner first sees it.
• Show a compact legend at the top of the play area before the sim starts — e.g. "● = one organism  |  color = trait  |  size = fitness"
• As the sim runs, show ONE live mechanic line just below the legend that narrates what's happening RIGHT NOW — e.g. "High-fitness organisms reproducing faster…" or "Escape velocity not yet reached — orbit decaying"
• The learner must never see a moving element without knowing what it represents.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PREDICT → MANIPULATE → REVEAL (non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Structure the lab in three phases:

PREDICT (shown before the sim is interactive):
• Ask one specific, falsifiable question about what will happen when they interact (2–4 options).
• Show a confidence selector (Sure / Unsure / Just guessing).
• A "Commit & Start" button reveals the simulation. They cannot touch the sim until they commit.
• Display their prediction choice visibly throughout the Manipulate phase so they remember what they predicted.

MANIPULATE:
• Reveal the full interactive visual. Every control produces immediate, visible, meaningful change.
• Show ONE conceptual prompt only: "Test it — were you right?" No step-by-step instructions.

REVEAL (triggered by hitting the aha moment or success condition):
• Flash a card that references their exact prediction choice — "You predicted X. Here's what actually happened and why."
• State the REAL-WORLD PAYOFF as one concrete sentence: "[What you just saw] is why [real-world consequence]."
• This card appears as a visible event in the sim (slides in, overlays briefly), not as a paragraph below the canvas.
• After 4 seconds the card fades and the learner can keep exploring.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMULA PANEL — teach the rule, not just the animation:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The formulas below are the governing equations. The learner must see them, not just watch the result.
Render a formula panel (pinned inside Zone A or at the top of Zone B):
• Show the governing equation symbolically (e.g. R = v²·sin(2θ) / g).
• Each slider/control maps to a symbol in the equation — label that mapping clearly (e.g. "θ → angle slider").
• When the learner moves a control, HIGHLIGHT the corresponding term in the equation (color flash or bold) AND update the computed result live beside the equation.
• The learner sees: the animation, the equation, and the result number — all changing together as linked representations of the same thing.
• Render equations with the renderFormula helper (KaTeX + plain-text fallback) so they look like a textbook, never like code.
FORMULAS (implement exactly, highlight live):
${formulas || "  (derive from the concept — no approximations)"}

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
• CDN libraries ALLOWED — use only what the concept genuinely needs (load from jsDelivr; include an inline vanilla fallback check so the lab degrades gracefully if the CDN is down):
  - p5.js for animated many-entity sims (agent-based, particles, populations):
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
  - Google Fonts — ALWAYS include this one (typography is the cheapest polish; if it fails to load, system fonts take over automatically — zero risk):
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
    Use: body { font-family: 'Inter', -apple-system, sans-serif; } for all UI text; font-family: 'JetBrains Mono', monospace; for every number, readout, match %, and formula fallback text — tabular numbers make live values feel precise and stable.
  - Plain vanilla JS is fine for simple cases — don't load a library you don't use (Google Fonts is the only always-on item).
• No localStorage / sessionStorage. No fetch().
• Works in sandbox="allow-scripts".
• Zero console errors on first load.
• Responsive: usable from 360px wide to full desktop.
• Dark theme: bg #0B1220, stage #0E1830, panels #131A2A, border rgba(59,130,246,0.2). Accents: blue #3B82F6, copper #D4A574, success #22C55E, muted #8899BB.
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
• Implement the formulas above EXACTLY in JS. Live readouts must name the EFFECT ("Earthquake Magnitude: 7.2"), not echo the input ("Friction: 0.9").
• Include a Reset button.
• SUCCESS REPORTING — when the learner reaches the success condition (use a visible "Check Answer" button to evaluate it):
  window.parent.postMessage({ type:"labCheck", result:{ ok:true,  score:1, total:1 } }, "*") on success
  window.parent.postMessage({ type:"labCheck", result:{ ok:false, score:0, total:1 } }, "*") on failure
  On success also show the real-world payoff card.
• DO NOT render any multiple-choice quiz or "verify your understanding" section — the platform shows its own quiz after the lab. The Predict step (2–4 options before interaction) is the only question allowed; it is a prediction commitment, not a quiz.

Before returning, verify ALL of these — fix any that fail before responding:
1. Does Zone B contain actual drawn SHAPES that represent the concept — NOT just text on a grid?
2. Is there a legend or key visible BEFORE the sim runs, labeling every entity/color/symbol?
3. Is there a live ONE-LINE mechanic narrator updating as the sim runs?
4. Is there a PREDICT step with 2–4 options + confidence + "Commit & Start" before the sim is interactive?
5. Is the formula panel present, with each control mapped to a symbol, terms highlighted on change, and computed result live?
6. Does the REVEAL card reference the learner's exact prediction AND state the real_world_payoff as one concrete sentence?
7. Is Zone B in motion on load, with the central visual LARGE (not a small dot in empty space)?
8. Does canvas.width/height match the element's actual rendered pixel size?
9. Is there a persistent trail/trace + hidden vectors/force arrows drawn?
10. Are there at least 2 interactive controls plus preset + reset buttons?
11. Is the mission's TARGET drawn on the canvas with live progress, and does achieving it auto-trigger the win celebration + labCheck postMessage?
12. If the concept has a movable object: can the learner steer it with held arrow keys + mirrored touch buttons?
13. Did you load a CDN library only if the concept genuinely needs it (p5/GSAP/Matter/D3/KaTeX — don't load what you don't use)?
14. Does the canvas use gradients and glow — polished simulation, not a flat grey box?
15. If the brief gave a real scenario: is the real target drawn from the start (labeled, with units), is there a live match % readout, and does crossing the match threshold reveal the equation with the learner's values plugged in?
16. Are formulas rendered via renderFormula (KaTeX with plain-text fallback) — never raw ASCII math?
17. Does EVERY object on the canvas have a one-word label drawn on/beside it, with labels/readouts placed adjacent to what they describe (not in a far panel)?
18. Does EVERY control map to a real formula term and visibly change a real output? (No inert, topical-sounding fake variables.)
19. Are ALL readouts real units with a declared world scale — zero pixel or bare-number readouts?
20. If two objects are drawn as solid, do they collide instead of overlapping/intertwining — including while being dragged?
21. Do draggable objects show grab/grabbing cursors + a hover affordance, with hit radius ≥24px and touch-action:none?
22. Is the lab 2D unless the concept's essence is genuinely 3D spatial structure?
23. (branching-decision only) Does the tree render visually as a graph? Can the learner backtrack and explore alternate paths? Does each leaf reveal a concrete consequence?
24. (bias-trap only) Does the learner complete trials WITHOUT knowing the bias first? Is the reveal shown as a distribution plot with the learner's own data highlighted?
25. (budget-allocation only) Is the total always constrained (sum=TOTAL)? Does each allocation show live consequences, not just a number change?
26. (agent-social-sim only) Do agents follow LOCAL rules only — no hard-coded macro pattern? Is there a live D3 aggregate chart showing the emergent trend over time?

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

  // Gemini 2.5 Pro via the native @google/generative-ai SDK. Build the parts
  // array: text brief plus, if present, the mockup image as inline base64.
  // (The OpenAI-compatible endpoint returns opaque "400 no body" errors, so we
  // use the native SDK which surfaces the real error message.)
  const model = gemini.getGenerativeModel({ model: LAB_MODEL });
  const parts = [{ text: briefText }];
  if (imageDataUrl) {
    const m = imageDataUrl.match(/^data:(.+?);base64,(.*)$/);
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }

  let res;
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig: { maxOutputTokens: 32000, temperature: 0.7 },
      });
      break;
    } catch (err) {
      const status = err && (err.status || err.statusCode);
      const retryable = status === 503 || status === 429 || status === 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        const wait = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.warn(`GEMINI ${status} on attempt ${attempt}/${MAX_ATTEMPTS} — retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error("GEMINI LAB GENERATION ERROR — model:", LAB_MODEL);
      console.error("  message:", err && err.message);
      console.error("  status:", status);
      throw err;
    }
  }

  let html = res.response.text().trim();
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
        const { data: { user }, error } = await supabase.auth.getUser(user_token);
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
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) { res.writeHead(401); res.end(JSON.stringify({ error: "Invalid token" })); return; }
      const { data: rows } = await supabase
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
        // Turn cryptic provider 503s into a clear, actionable message.
        const friendly = isQuotaError(err)
          ? "An AI provider API quota or billing limit was reached. Check the OpenAI/Gemini account billing — the keys are valid but out of quota."
          : isOverloadError(err)
          ? "Our lab-building models are overloaded right now (high demand). This is temporary — please try again in a minute."
          : (err.message || "Something went wrong");
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
server.timeout = 120_000; // 120 s — lab generation is multi-step and long
server.listen(PORT, "0.0.0.0", () => console.log(`Repend running at http://0.0.0.0:${PORT}`));
