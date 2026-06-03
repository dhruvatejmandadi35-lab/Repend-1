const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
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
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function topicKey(topic) {
  return topic.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Build a human-readable learner profile summary for prompt injection.
// Returns "" when no meaningful answers were given (learner skipped all).
function profileSummary(profile) {
  if (!profile || typeof profile !== "object") return "";
  const parts = [];
  if (profile.level)          parts.push(`Level: ${profile.level}`);
  if (profile.intent)         parts.push(`Reason for learning: ${profile.intent}`);
  if (profile.priorKnowledge) parts.push(`Prior knowledge: ${profile.priorKnowledge}`);
  if (profile.learnStyle)     parts.push(`Learns best by: ${profile.learnStyle}`);
  return parts.join(" | ");
}

// A short, stable signature of the profile so different profiles cache
// to different lab variants (and skipped-profile labs share one cache slot).
function profileSig(profile) {
  const s = profileSummary(profile);
  if (!s) return "default";
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return "p" + (h >>> 0).toString(36);
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
  "why": "One sentence: the specific aha moment this concept produces. E.g. 'The moment you see the ball curve MORE than expected is when you understand that spin changes the effective gravity on the ball.'",
  "kind": "EXACTLY one of: 'simulation' or 'puzzle'. Choose 'simulation' when the concept is about CONTINUOUS CHANGE OVER TIME or physical motion driven by equations — things that move, grow, oscillate, orbit, accelerate (projectile motion, compound interest, orbital mechanics, wave interference, population growth). Choose 'puzzle' when the concept is about STRUCTURE, RELATIONSHIPS, or PATTERN RECOGNITION that the learner reads or builds rather than watches — things that are mostly static until clicked (pedigree inheritance, circuit diagrams, food webs, the periodic table, supply-demand equilibrium, classification trees, logic gates, chemical bonding). When in doubt: does understanding come from WATCHING something move (simulation) or from ARRANGING/READING a structure (puzzle)?",
  "mechanism": "REQUIRED. The concrete cause→effect chain in one sentence, naming the THING the learner manipulates, the HIDDEN PROCESS it drives, and the MEASURABLE OUTPUT that results. Format: 'When the learner [changes X on a real object], it [drives hidden process Y], which makes [output Z] change in a way you can see and measure.' Example: 'When the learner drags the catapult arm to a steeper angle, it splits the launch force into more vertical and less horizontal velocity, which makes the projectile fly higher but land shorter.' If you cannot write a concrete, physical, measurable mechanism like this, the topic is NOT teachable as an interactive lab — you MUST pivot to a specific sub-concept that has one."
}

CRITICAL — THE MECHANISM TEST (apply before anything else):
A valid lab topic MUST have all three: (1) a concrete thing the learner can directly grab/drag/click/place, (2) a hidden process that thing drives, (3) a measurable output that visibly changes as a result. If the raw input is a vague field, tool, or buzzword with no single causal mechanism — 'AI', 'machine learning', 'productivity', 'the economy', 'success', 'leadership' — DO NOT build a lab about the field. Pivot HARD to ONE specific mechanism inside it that passes the test. Examples:
- 'AI' → 'Gradient Descent: how step size decides whether the model finds the valley bottom or bounces out of it' (drag the step size, watch the ball descend or diverge).
- 'Machine learning' → 'Overfitting: why a curve that hits every training dot fails on new dots' (drag points / add wiggle, watch test error spike).
- 'The economy' → 'Supply & Demand: why a price ceiling creates a shortage' (drag the price line, watch the gap open).
NEVER produce a lab that is just floating nodes, a generic 'network', or a slider that changes a number with no visible causal chain. Those teach nothing.

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

async function thinkAboutTopic(topic, mechanism) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 700,
    messages: [
      {
        role: "system",
        content: `You are an expert at explaining how concepts should FEEL to learn. Given a topic, write a short analysis covering exactly these five things:

1. THE CORE INSIGHT — what single thing, once felt in the body or seen visually, makes this concept truly click? Not a definition — the moment of understanding.

2. THE CAUSAL MODEL ON SCREEN — describe a picture that SHOWS THE MECHANISM, not a decoration. The picture must contain three visible, linked things: (a) the object the learner grabs/moves, (b) the hidden process it drives drawn so you can SEE it happening, (c) the output that changes as a result. The learner must be able to trace cause→effect with their eyes. BAD: "a tree growing" (decorative — doesn't show stack frames). GOOD for recursion: "a stack of labeled frame-cards that literally push upward as each call is made and pop off as each returns — the tower height IS the stack space, and it visibly overflows the top edge when depth is too high." Describe the causal picture for THIS topic at that level of specificity.

3. THE THING THE LEARNER DIRECTLY MANIPULATES — name the ONE object on screen they grab, drag, or place (NOT an abstract slider). Then 1-2 secondary things they can adjust. For each, explain WHY changing it reveals the core insight. The primary one must be the literal object in the causal picture — e.g. "drag the recursion-depth marker up the stack and watch frames pile past the overflow line", not "a slider labeled depth".

4. THE AHA MOMENT — describe the precise moment in the interaction when the learner says "oh!". What did they just see happen? What did they move or change right before it?

5. THE REAL-WORLD COST — one concrete situation where NOT understanding this concept costs someone something real (money, health, a bad decision, a failed system).

Write in plain, direct prose. Be specific to ${topic}. Do not use generic educational language. Do not suggest a lab format or interaction type.`,
      },
      { role: "user", content: `Topic: ${topic}${mechanism ? `\n\nThe core mechanism (build your analysis around this exact cause→effect chain): ${mechanism}` : ""}` },
    ],
  });
  return res.choices[0].message.content.trim();
}

async function specFromThinking(topic, thinking, profText, difficulty, kind, mechanism) {
  const kindNote = kind === "puzzle"
    ? `\nLAB TYPE: PUZZLE / STRUCTURE. This concept is understood by ARRANGING or READING a structure, not by watching motion. The interaction_palette should favor draggable, click-spawn, and toggle-button — NOT sliders. The mission must be about reaching a correct configuration or identifying a pattern (e.g. 'Mark every carrier until the inheritance pattern is consistent', 'Wire the circuit so the bulb lights'). The aha_trigger is a moment of recognition when the structure clicks, not a threshold crossing. Do NOT force continuous animation into the spec.\n`
    : `\nLAB TYPE: SIMULATION. This concept is understood by watching continuous change over time. Animated motion driven by the formulas is central.\n`;
  const diffNote = difficulty > 0
    ? `\nDIFFICULTY: The learner already completed the basic version and asked to GO DEEPER (level ${difficulty}). Make this HARDER: add 1-2 more variables, introduce a second interacting effect or a subtler regime, ask a more demanding prediction and reflection question, and use a more advanced real-world scenario. Do NOT just rename the same lab — genuinely raise the conceptual depth.\n`
    : "";
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
    "causal_model": "REQUIRED. Describe the three visible, linked parts of the on-screen picture: (1) CAUSE — the object the learner directly grabs/drags/places; (2) PROCESS — the hidden mechanism drawn so it is literally visible (the thing that connects cause to effect); (3) EFFECT — the measurable output that changes. State how the eye traces cause→process→effect. The visual is INVALID if any part is decorative or missing. E.g. 'CAUSE: drag the angle of the launch ramp. PROCESS: the velocity arrow splits into a tall vertical component and a short horizontal one, redrawn live. EFFECT: the arc height and landing distance change, with a dotted trajectory and a landing marker.'",
    "direct_manipulation": "REQUIRED. The single object the learner GRABS or CLICKS directly on the canvas to change the primary variable — never an abstract slider for the primary variable. Name the object, the gesture (drag/click/place), and what it visibly does. E.g. 'Grab the planet and fling it — drag distance and direction set its launch velocity vector.'",
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
    "prediction": {
      "question": "One short falsifiable question phrased as 'What happens if you [specific action relating to the aha moment]?' This is asked BEFORE the learner touches the sim. E.g. 'If you double orbital speed from 5 to 10 km/s, what happens to the satellite?'",
      "options": ["A: ...", "B: ...", "C: ...", "D: ..."],
      "correct": "B: ..."
    },
    "interaction_palette": [
      {
        "type": "one of: slider | draggable | click-spawn | draw | toggle-button",
        "element": "what specific thing the learner manipulates — name it concretely. E.g. 'planet: drag to set initial position', 'fire button: click to launch projectile', 'gravity toggle: flip gravity on/off'",
        "effect": "what visually changes immediately when they use this interaction. E.g. 'orbit trail morphs from circle to ellipse as planet is dragged farther from center'"
      }
    ],
    "stage_description": "Detailed paragraph: what is drawn on screen, what moves, what colors. Reference the visualMetaphor directly. Specific positions, sizes, what animates.",
    "interaction_description": "What the learner does step by step. What they touch first. What changes visually on each interaction. What the aha moment looks like on screen.",
    "aha_trigger": "The exact visual event that marks the aha moment. Be specific: what threshold, what visual change, what the learner sees right before vs. right after.",
    "mission": "One action sentence starting with a verb — the specific thing the learner must accomplish in the sim. Starts with what to do, ends with the goal state. E.g. 'Drag the satellite to escape velocity and watch it break free of orbit.' or 'Find the interest rate that triples your money before year 30.' or 'Mark every carrier in the family tree until the inheritance pattern becomes clear.' Never use 'explore' or 'observe' — the learner must be trying to achieve something specific.",
    "success_condition": "Exact programmatic rule for completion.",
    "real_world_payoff": "One sentence: the real-world consequence the learner now understands."
  }
}

RULES:
- causal_model is the MOST IMPORTANT field. The visual must SHOW the mechanism (cause→process→effect all visible and linked), never just decorate the topic. A picture where the manipulated thing does not visibly cause the output through a drawn process is REJECTED. No floating nodes, no generic "network", no pretty scene that doesn't explain.
- direct_manipulation is REQUIRED: the primary variable is changed by grabbing/dragging/placing a real object on the canvas, NOT by a slider. Sliders are allowed ONLY for secondary continuous parameters.
- visualMetaphor must be a vivid scene description, never a chart type or UI pattern name
- every variable MUST have why_it_matters — if you can't explain why it matters, remove the variable
- the PRIMARY variable (the one that produces the aha) MUST have regimes_note describing the distinct outcomes across its range, with min/max/default chosen so EVERY regime is reachable and the default sits just below the most surprising boundary
- formulas MUST be real math — look up the actual equation for this concept. Every output shown in Zone B must have a formula entry.
- rules MUST include at least one threshold that triggers the aha moment visually
- the default state must already show interesting behavior on load — never a blank or boring starting point. The sim opens mid-phenomenon.
- reflection question must be answerable only AFTER interacting — not a definition lookup
- do NOT include interaction_type, lab_type, or any format label anywhere in the JSON
- prediction: phrased as a guess BEFORE interaction — about the aha moment. 2-4 options with plausible wrong answers a smart person would make before seeing the sim. correct must be verbatim one of the options.
- mission: one action sentence, starts with a verb, names a specific REACHABLE goal STATE that success_condition can check programmatically. It is a goal, NOT a fact. BAD (a fact restated): "AI can process vast amounts of data in seconds." GOOD (a checkable goal): "Tune the step size until the ball settles exactly at the valley bottom in under 10 steps." The learner must be able to know the instant they've achieved it.
- interaction_palette: 2-3 entries. MUST include at least one non-slider type. Match type to the concept:
  • draggable — when POSITION matters (a body, a charge, an endpoint, a source). The thing the learner moves IS the variable.
  • click-spawn — when the learner should CREATE or TRIGGER an instance (fire a projectile, spawn a particle, inject energy, apply a force at a point).
  • draw — when the learner should trace or sketch (a path prediction, a force field, a wave shape).
  • toggle-button — when a BINARY contrast reveals the concept (gravity on/off, damped vs undamped, before/after a threshold).
  • slider — for smooth continuous quantities that don't map to a natural physical action. Limit to 1-2 sliders per lab.

ADAPT TO THE LEARNER (if a learner profile is provided below):
- Level (middle school / high school / college / curious): set vocabulary and math depth. Middle school = everyday words, no jargon, the prediction question is intuitive ("what happens to the ball?"). College = precise terms and real equations in the explanation.
- Reason for learning: shape the scenario. "Studying for a test" = frame it like an exam scenario with the kind of question they'll be asked. "Curious / for fun" = open with a surprising real-world hook. "For work" = a concrete on-the-job situation. "Helping someone else" = keep it explainable.
- Prior knowledge: set how many variables. "Never heard of it" / "vague idea" = 1-2 controls, the single clearest aha. "Studied but confused" = include the variable that resolves the common confusion, and make the explanation directly address why it's confusing. "Refresher" = can be denser.
- Learns best by: "Seeing visually" = richer visualMetaphor. "Hands-on" = frame the mission as an active challenge. "Reading first" = a slightly fuller scenario before the action.
NEVER mention the profile to the learner. Just shape the content. If no profile is given, target a general high-school+ audience.`,
      },
      {
        role: "user",
        content: `Topic: ${topic}\n\nReasoning:\n${thinking}\n${mechanism ? `\nCORE MECHANISM (the causal_model, direct_manipulation, and mission MUST be built around this exact cause→effect chain):\n${mechanism}\n` : ""}${kindNote}${profText ? `\nLEARNER PROFILE (adapt the lab to this person):\n${profText}\n` : ""}${diffNote}\nNow produce the spec JSON.`,
      },
    ],
  });
  const parsed = JSON.parse(res.choices[0].message.content.trim());
  normalizeReflection(parsed);
  normalizePrediction(parsed);
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

function normalizePrediction(design) {
  const p = design && design.spec && design.spec.prediction;
  if (!p) return;
  const opts = Array.isArray(p.options) ? p.options.map(o => String(o).trim()) : [];
  p.options = opts;
  if (opts.length < 2 || !p.question) { design.spec.prediction = null; return; }
  const correct = String(p.correct == null ? "" : p.correct).trim();
  if (opts.includes(correct)) { p.correct = correct; return; }
  const strip = s => s.toLowerCase().replace(/^[a-d]\s*[:.)-]\s*/i, "").replace(/[^a-z0-9 ]/g, "").trim();
  const target = strip(correct);
  const hit = opts.find(o => strip(o) === target) || (target && opts.find(o => strip(o).includes(target)));
  if (hit) { p.correct = hit; return; }
  design.spec.prediction = null;
}

// Step 3 — reasons concretely about what to draw and how.
// Output is a structured visual brief the coder can follow exactly.
async function thinkAboutLab(design, kind) {
  const vars = (design.spec.variables || [])
    .map(v => `  • ${v.name} (${v.unit || ""}), range ${v.min}–${v.max}, default ${v.default}: ${v.why_it_matters}${v.regimes_note ? `\n    REGIMES: ${v.regimes_note}` : ""}`)
    .join("\n");

  const palette = (design.spec.interaction_palette || [])
    .map(p => `  • [${p.type}] ${p.element} → ${p.effect}`)
    .join("\n");

  const kindBrief = kind === "puzzle"
    ? `\nLAB TYPE: PUZZLE / STRUCTURE. The learner understands this by ARRANGING or READING a structure (a family tree, a circuit, a web of relationships), not by watching motion. Do NOT demand a constantly-moving element. Instead the canvas shows a clear structure the learner builds or marks by clicking/dragging. "Alive on load" means a clean, inviting, well-laid-out structure with subtle ambient motion (a gentle pulse on clickable nodes, a hover glow) — NOT a physics animation. The aha is when the arrangement becomes correct and the pattern is revealed (highlight it, connect it, light it up).\n`
    : `\nLAB TYPE: SIMULATION. Continuous animated motion is central — the canvas must be alive and moving on load.\n`;

  const prompt = `You are a senior creative coder designing an interactive learning lab. You will produce a CONCRETE VISUAL BRIEF that another developer can implement directly in HTML Canvas 2D.
${kindBrief}
TOPIC: ${design.topic}
LEARNING GOAL: ${design.spec.learning_goal}
VISUAL METAPHOR: "${design.spec.visualMetaphor}"
${design.spec.causal_model ? `\nCAUSAL MODEL (this is the spine of the lab — the picture MUST show all three parts linked):\n${design.spec.causal_model}\n` : ""}${design.spec.direct_manipulation ? `\nDIRECT MANIPULATION (the learner grabs this real object — NOT a slider — to drive the lab):\n${design.spec.direct_manipulation}\n` : ""}
VARIABLES:
${vars}

REQUIRED INTERACTIONS (implement ALL of these — not just sliders):
${palette || "  • at least one draggable or click-spawn interaction"}

NON-NEGOTIABLE: Your brief must make the cause→process→effect chain VISIBLE on the canvas and let the learner drive it by directly grabbing the object named above. Do NOT describe a decorative scene with sliders bolted on the side. The hidden process (the "why") must be drawn, not implied.

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
// NOTE: This step originally ran on Claude (claude-opus-4-7), then Gemini, then Vertex, then Ollama. Now uses OpenAI.
// Change LAB_MODEL here to swap models.
const LAB_MODEL = "gemini-2.0-flash";
async function codeFromImageBrief(design, labThinking, imageDataUrl, kind) {
  const isPuzzle = kind === "puzzle";
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
MISSION (show this prominently in Zone A — always visible while the learner plays): "${design.spec.mission || design.spec.success_condition}"
LEARNING GOAL: ${design.spec.learning_goal}
VISUAL METAPHOR: "${design.spec.visualMetaphor}"
${design.spec.causal_model ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE CAUSAL MODEL — THIS IS THE WHOLE POINT OF THE LAB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${design.spec.causal_model}
The canvas must draw ALL THREE parts — the cause object, the hidden process, and the output — and they must be visibly linked so the learner SEES why the output changes. A visual where the manipulated thing does not visibly drive the output through a drawn process is a FAILED lab. Do not draw a decorative scene.
` : ""}${design.spec.direct_manipulation ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DIRECT MANIPULATION — PRIMARY INTERACTION (NOT A SLIDER):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${design.spec.direct_manipulation}
The learner changes the PRIMARY variable by grabbing/dragging/clicking this object directly on the canvas with pointer events. The object must look grabbable (clear handle, hover cursor, glow on hover). Sliders are allowed ONLY for secondary parameters. If you make the primary interaction a slider, the lab has failed.
` : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEHAVIORAL BRIEF (build exactly this behavior):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${labThinking}

VARIABLES THE LEARNER CONTROLS:
${vars}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED INTERACTIONS — implement EVERY one of these:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${(design.spec.interaction_palette || []).map(p => `  [${p.type}] ${p.element} → ${p.effect}`).join("\n") || "  [draggable] at least one draggable object on canvas\n  [toggle-button] at least one toggle button"}

INTERACTION CODE PATTERNS — use these exact patterns for each type:

[slider] Standard HTML range input wired to controls object — already know how to do this.

[draggable] Drag an object on the canvas:
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    const {mx, my} = canvasPt(e);
    if (Math.hypot(mx - state.obj.x, my - state.obj.y) < 24)
      drag = { ox: state.obj.x - mx, oy: state.obj.y - my };
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const {mx, my} = canvasPt(e);
    state.obj.x = mx + drag.ox; state.obj.y = my + drag.oy;
  });
  canvas.addEventListener('pointerup', () => drag = null);
  function canvasPt(e) {
    const r = canvas.getBoundingClientRect();
    return { mx: (e.clientX-r.left)*(canvas.width/r.width), my: (e.clientY-r.top)*(canvas.height/r.height) };
  }

[click-spawn] Click canvas to fire or spawn an object:
  canvas.addEventListener('click', e => {
    const {mx, my} = canvasPt(e);
    state.particles.push({ x: mx, y: my, vx: (Math.random()-0.5)*4, vy: -6, life: 1.0 });
  });

[draw] Freehand draw/trace on canvas:
  let drawing = false;
  canvas.addEventListener('pointerdown', e => { drawing = true; state.userPath = []; });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const {mx, my} = canvasPt(e);
    state.userPath.push({x: mx, y: my});
  });
  canvas.addEventListener('pointerup', () => { drawing = false; /* compare path to answer */ });

[toggle-button] A styled HTML button that flips a boolean in controls:
  const btn = document.getElementById('toggleBtn');
  btn.addEventListener('click', () => {
    controls.gravityOn = !controls.gravityOn;
    btn.textContent = controls.gravityOn ? '🌍 Gravity ON' : '🚀 Gravity OFF';
    btn.style.background = controls.gravityOn ? '#1e3a5f' : '#3a1e1e';
  });

CRITICAL: Do NOT make the canvas the only interaction surface. Zone A MUST have a mix of the above types — not just range inputs. If the spec calls for a draggable, the draggable is in Zone B (the canvas); toggle buttons go in Zone A.

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
• MISSION BANNER: at the very top of Zone A, show the MISSION text in a styled box — copper/amber border, small label "YOUR MISSION", mission text in white. This stays visible the entire time. It is the first thing the learner reads when the sim loads. Example HTML:
  <div style="background:rgba(212,165,116,0.08);border:1px solid rgba(212,165,116,0.4);border-radius:8px;padding:10px 12px;margin-bottom:12px">
    <div style="font-size:0.62rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#D4A574;margin-bottom:4px">YOUR MISSION</div>
    <div style="font-size:0.82rem;color:#F0F2F8;line-height:1.5">[mission text here]</div>
  </div>
• ZONE A — controls: compact panel below the mission banner. On mobile (width ≤ 500px) Zone A sits at the TOP as a horizontal strip, max 200px tall. On desktop Zone A sits on the LEFT, max 220px wide. Zone B fills all remaining space. Use CSS flex column on mobile, row on desktop. Zone A must NEVER overlap Zone B — set explicit widths/heights so they are cleanly separated.
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

${isPuzzle ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTERACTION REQUIREMENTS — THIS IS A PUZZLE/STRUCTURE LAB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This concept is learned by ARRANGING or READING a structure, not by watching motion. Do NOT force a physics animation loop.
• THE STRUCTURE IS THE STAR — draw the actual structure clearly: a pedigree tree of circles/squares, a circuit of components and wires, a food web of nodes and arrows. It fills the canvas and is readable at a glance.
• CLICK / DRAG TO BUILD OR MARK — the core interaction is clicking nodes to change their state (affected/unaffected, on/off), dragging items into place, or connecting things. Each click gives immediate visual feedback.
• LIVE STATUS READOUT — show the current interpretation as the learner edits: "Pattern: consistent with recessive" / "Circuit: open — bulb off". It updates on every click.
• THE AHA IS RECOGNITION — when the structure reaches a correct/revealing configuration, make it unmistakable: highlight the path, light up the connection, draw a glowing outline around the pattern, flash the insight message.
• SUBTLE AMBIENT MOTION ONLY — clickable nodes can gently pulse or glow on hover so the lab feels alive, but do NOT animate the whole scene with physics. Static-but-responsive is correct here.

BAD: forcing planets to orbit in a lab about circuit diagrams just to satisfy an animation rule
GOOD: a family tree where clicking each person toggles affected/carrier/unaffected, and the moment the carrier pattern is consistent, the inheritance path lights up copper` : `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANIMATION & MOTION REQUIREMENTS (non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• ANIMATE THE CORE MECHANISM — the visual must show the concept's actual process in motion, not a static chart or decorative image. If the concept is about change over time or one-becoming-many, the user must literally watch that transformation happening on screen.
• SLIDERS PRODUCE CONTINUOUS ANIMATED CHANGE — moving any slider must immediately produce visible, ongoing animated change in the visual. No static states. No requiring a button press to see motion. The animation responds to the current slider value on every frame.
• ONE CLEAR "AHA" MOMENT — there must be a point where adjusting an input produces a surprising, visible result the user wouldn't have predicted. This is the concept's insight made visceral. Design the default slider positions so the first nudge the user makes hits or approaches this moment.
• MOTION + MEANINGFUL COLOR + SMOOTH TRANSITIONS — use animation, color that encodes information (hotter = redder, faster = brighter, more dangerous = more saturated), and smooth easing. The visual must feel alive, not like a labeled diagram.

BAD: slider moves, a number updates, a bar changes height, nothing else happens
GOOD: slider moves → particles accelerate, colors shift from cool to hot, a threshold is crossed and the entire visual snaps into a new regime with a visible burst`}

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

${isPuzzle ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PUZZLE ARCHITECTURE — CLICK-DRIVEN STATE, NOT A PHYSICS LOOP:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Build on this model. State changes happen on click/drag, then you re-evaluate and redraw. A light rAF loop is fine for hover glows, but the concept does NOT run on physics every frame.

// 1. Model — the structure's data
const nodes = [ { id:1, x:200, y:80, shape:'circle', state:'unaffected' }, /* ... */ ];
const edges = [ { from:1, to:3 }, /* parent→child links */ ];

// 2. On click: find the node hit, cycle its state, re-evaluate, redraw
canvas.addEventListener('click', e => {
  const {mx,my} = canvasPt(e);
  const hit = nodes.find(n => Math.hypot(mx-n.x, my-n.y) < 22);
  if (hit) { hit.state = nextState(hit.state); evaluate(); draw(); }
});

// 3. evaluate() — derive the live interpretation from the current structure
function evaluate() {
  // e.g. check whether the marked pattern is consistent with recessive inheritance
  status = isConsistentRecessive(nodes, edges) ? 'recessive' : 'unclear';
  if (status === 'recessive' && !solved) { solved = true; celebrate(); }
}

// 4. draw() — render edges, then nodes (colored by state), then the status readout + any highlight
// 5. A light rAF loop ONLY for hover pulse / glow easing — the structure itself is event-driven.

CRITICAL: the success condition is a CONFIGURATION being correct (the right nodes marked, the circuit closed, the web balanced), detected inside evaluate() after each click — not a physics threshold.` : `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHYSICS SIMULATION ARCHITECTURE — MANDATORY PATTERN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Your simulation MUST be built on this exact architecture. Do not draw static frames. Do not recalculate only on slider input. Physics runs every frame via requestAnimationFrame.

REQUIRED STRUCTURE:
// 1. State object — all simulation variables live here, updated every frame
const state = {
  // position, velocity, angle, energy — whatever the concept needs
  x: 0, y: 0, vx: 0, vy: 0,
  trail: [],        // array of past positions for persistent trace
  t: 0,             // simulation time in seconds
};

// 2. Controls object — slider values, read each frame (never cached)
const controls = { speed: 1.0, mass: 1.0 }; // replace with your variables
sliderEl.addEventListener('input', e => { controls.speed = +e.target.value; });

// 3. Physics update — runs every frame with delta-time
let lastTime = null;
function update(timestamp) {
  const dt = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.05) : 0.016;
  lastTime = timestamp;

  // READ controls here, every frame — sliders always take effect immediately
  const speed = controls.speed;

  // APPLY physics equations here — real formulas, not approximations
  // e.g. for orbit: angle += speed * dt; x = cx + r * Math.cos(angle);
  state.t += dt;

  // TRAIL — push current position, cap length
  state.trail.push({ x: state.x, y: state.y });
  if (state.trail.length > 120) state.trail.shift();
}

// 4. Draw — pure rendering, reads from state
function draw(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw trail first (oldest = most transparent)
  state.trail.forEach((pt, i) => {
    ctx.globalAlpha = i / state.trail.length;
    // draw pt
  });
  ctx.globalAlpha = 1;
  // Draw physics objects, force arrows, readouts on top
}

// 5. Loop — update then draw every frame, forever
function loop(timestamp) {
  update(timestamp);
  draw(ctx, canvas);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop); // starts immediately on page load

CRITICAL RULES FROM THIS ARCHITECTURE:
• dt (delta-time) MUST be used in all position/velocity updates — never hardcode pixel offsets like x += 2
• Slider values are read from the controls object INSIDE update(), every frame — a slider change takes effect on the very next frame with zero lag
• The trail array accumulates real positions from the physics, not a decorative effect
• Force arrows and field lines are computed from the same physics state, not drawn separately
• Every regime the learner can reach (fast/slow, stable/unstable, crash/orbit/escape) is produced by the same physics equations — not by if/else branches that swap out different animations`}

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
  - ${isPuzzle ? "A subtle ambient touch (hover glow on clickable nodes, a gentle pulse on the next logical click target) — NOT a full physics animation" : "At least one element that is always animating (wave oscillating, particle moving, value counting) even before interaction"}
  - Layered drawing: background grid/gradient first, then ${isPuzzle ? "structure (edges then nodes)" : "physics objects"}, then labels on top
• MINIMUM 2 interactive controls — never just one slider.
• A visible "Check Answer" button in Zone A.
• requestAnimationFrame for all motion. pointerdown/move/up for drag.
• On aha moment: golden glow burst (shadowBlur spike) on the key Zone B element.
• MISSION COMPLETE — when the learner satisfies the SUCCESS CONDITION, fire a real celebration, automatically (do not wait for the Check button — detect it live every frame):
  - A confetti burst from the center of the canvas: spawn ~40 small colored rects/circles with random velocities and gravity, fading over ~1.2s. Colors: #3B82F6, #D4A574, #22C55E, #E8C49A.
  - A green wave sweeping across the canvas.
  - A "🎯 MISSION COMPLETE" banner sliding in at the top of Zone B for 2.5s.
  - Fire this celebration ONCE per success (guard with a boolean flag); reset the flag if the learner leaves the success state so it can fire again.
  - On the frame the success first triggers: window.parent.postMessage({ type:"labCheck", result:{ ok:true, score:1, total:1 } }, "*")
• If the learner is far from the goal and presses Check: a gentle nudge (red shake on the readout, no harsh failure) and window.parent.postMessage({ type:"labCheck", result:{ ok:false, score:0, total:1 } }, "*").
• Keep a visible "Check Answer" button in Zone A too, but the celebration must also trigger automatically the moment the success condition is met.

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
11. CAUSAL CHAIN: can the learner SEE all three — the object they grab, the hidden process it drives (drawn, not implied), and the output that changes? If the process is invisible, draw it.
12. DIRECT MANIPULATION: is the PRIMARY variable changed by grabbing/dragging an object on the canvas (not a slider)? If the main interaction is a slider, convert it to a draggable on-canvas object.
13. Would a learner who finished this be able to explain WHY the output changed — not just THAT it changed? If not, the causal link is too weak; make the mechanism more visible.

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
  try {
    res = await model.generateContent({
      contents: [{ role: "user", parts }],
      // Pro is a thinking model: reasoning tokens count against this budget
      // before the HTML is written. Keep it high so a long animated lab file
      // isn't truncated mid-output.
      generationConfig: { maxOutputTokens: 32000, temperature: 0.7 },
    });
  } catch (err) {
    console.error("GEMINI LAB GENERATION ERROR — model:", LAB_MODEL);
    console.error("  message:", err && err.message);
    console.error("  status:", err && (err.status || err.statusCode));
    console.error("  details:", JSON.stringify(err && (err.errorDetails || err.response || err), null, 2));
    throw err;
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
          const profile = data.profile || null;
          const profText = profileSummary(profile);
          const difficulty = Math.max(0, Math.min(3, parseInt(data.difficulty, 10) || 0));

          send("expand", `Sharpening topic…`);
          const expanded = await expandTopic(rawTopic);
          const topic = expanded.topic;
          const kind = expanded.kind === "puzzle" ? "puzzle" : "simulation";
          const mechanism = expanded.mechanism || "";
          // Cache key includes the profile signature so a high-schooler and a
          // college student studying the same topic get their own lab variants.
          // Difficulty level is part of the key too — "Go deeper" gets a fresh lab.
          const key = topicKey(topic) + "::" + profileSig(profile) + (difficulty ? "::d" + difficulty : "");
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
          const thinking = await thinkAboutTopic(topic, mechanism);

          send("design", "Translating insight into lab spec…");
          const design = await specFromThinking(topic, thinking, profText, difficulty, kind, mechanism);

          send("labthink", "Thinking about how to build it…");
          const labThinking = await thinkAboutLab(design, kind);

          let imageDataUrl = null;
          if (process.env.USE_MOCKUP === "1") {
            send("image", "Sketching a visual mockup…");
            imageDataUrl = await mockupImage(design.topic, design.spec.visualMetaphor);
          }

          send("code", "Writing your lab…");
          const html = await codeFromImageBrief(design, labThinking, imageDataUrl, kind);

          const labData = {
            topic: design.topic,
            scenario: design.scenario,
            verificationQuestion: design.verificationQuestion,
            learningGoal: design.spec.learning_goal,
            realWorldPayoff: design.spec.real_world_payoff,
            mission: design.spec.mission || null,
            reflection: design.spec.reflection || null,
            prediction: design.spec.prediction || null,
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
server.timeout = 120_000; // 120 s — lab generation is multi-step and long
server.listen(PORT, "0.0.0.0", () => console.log(`Repend running at http://0.0.0.0:${PORT}`));
