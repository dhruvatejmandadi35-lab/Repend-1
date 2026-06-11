const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Load .env locally (Railway injects env vars directly).
try { require("fs").readFileSync(path.join(__dirname, ".env"), "utf8")
  .split("\n").forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) {}

// Two providers: OpenAI runs the text/reasoning steps; Gemini builds the HTML lab.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing-openai-key" });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

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
  return openaiJSON(`${PLAN_SYSTEM}\n\nTopic: ${topic}\n\nProduce the complete recipe JSON.`, 4096);
}

function injectRecipe(recipe) {
  const serialized = JSON.stringify(recipe);
  return ENGINE_TEMPLATE.replace(
    /\/\*__RECIPE__\*\/[\s\S]*?\/\*__END__\*\//,
    `/*__RECIPE__*/ ${serialized} /*__END__*/`
  );
}

async function verify(topic, question, recipeSummary, userAnswer, labResult) {
  return openaiJSON(`${VERIFY_SYSTEM}

Topic: ${topic}
Question: ${question}
Lab summary: ${recipeSummary}
Engine verdict: ${labResult ? JSON.stringify(labResult) : "n/a"}
Student answer: ${userAnswer}`, 512, "gpt-4o-mini");
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
// FREEFORM LAB PIPELINE — OpenAI runs steps 0-3, Gemini builds the HTML:
//   0. expandTopic        — gemini-2.5-flash JSON: sharpens vague input
//   1. thinkAboutTopic    — gemini-2.5-flash prose: insight, metaphor, variables
//   2. specFromThinking   — gemini-2.5-flash JSON: typed spec with archetype
//   3. thinkAboutLab      — gemini-2.5-flash prose: archetype-adapted visual brief
//   4. mockupImage        — gpt-image-1: clean UI mockup (OPTIONAL, USE_MOCKUP=1)
//   5. codeFromImageBrief — gpt-4o vision: image + brief → final HTML
// ─────────────────────────────────────────────────────────────────

// Step 0 — turns vague topics into one specific, teachable concept.
// "ML" → "Gradient Descent: how a model finds the bottom of a loss landscape"
// "Physics" → "Newton's Second Law: why heavier objects need more force to accelerate"
async function expandTopic(rawTopic) {
  return openaiJSON(`You sharpen vague learning topics into one specific, teachable concept.

Return JSON:
{
  "topic": "The sharpened topic. 3-10 words. Must be a CONCEPT with a surprising insight, not a skill or activity.",
  "why": "One sentence: the specific aha moment this concept produces."
}

RULES:
- Sport/activity (tennis, basketball): find the underlying physics concept. 'Tennis' → 'Topspin: why spin bends a ball's path'.
- Musical instrument/sound: pick the wave/physics concept. 'Violin' → 'Standing Waves: why pressing a string produces different pitches'.
- Broad field (ML, physics, biology): pick the sub-concept with the clearest aha moment.
- Already a specific concept (compound interest, Ohm's law): return nearly unchanged.
- NEVER pick abstract concepts like 'resonance', 'harmony', 'energy flow' — pick something with a concrete visual output.
- Never return a skill, definition, or procedure. Return the INSIGHT.

Topic: ${rawTopic}`, 300, "gpt-4o-mini");
}

async function thinkAboutTopic(topic) {
  return openaiText(`You are an expert at explaining how concepts should FEEL to learn. Write a short analysis of "${topic}" covering exactly these five things:

1. THE CORE INSIGHT — what single thing, once seen visually, makes this concept truly click? Not a definition — the moment of understanding.
2. THE VISUAL METAPHOR — what does this concept look like IN MOTION? Be vivid and specific to this topic.
3. THE KEY VARIABLES — what 2-4 things can a learner change? For each, explain WHY it matters to the insight.
4. THE AHA MOMENT — the precise moment when the learner says "oh!". What did they just see happen?
5. THE REAL-WORLD COST — one concrete situation where not understanding this costs something real.

Write in plain direct prose. Be specific to ${topic}.`, 800, "gpt-4o-mini");
}

async function specFromThinking(topic, thinking) {
  const parsed = await openaiJSON(`You convert educational reasoning into an interactive lab spec. Read the reasoning and produce JSON.

Return ONLY JSON with this exact shape:
{
  "topic": "Display name for the topic",
  "scenario": "2-3 paragraph immersive 2nd-person scenario. Open with a CONCRETE real-world moment: a real role, place, dollar amount, failure mode. End by telling the learner exactly what they are about to manipulate and why it matters right now.",
  "verificationQuestion": "One specific question the learner can only answer correctly AFTER interacting with the lab.",
  "spec": {
    "title": "Short punchy lab title",
    "lab_archetype": "Exactly one of: physics-sim | threshold | accumulation | process-flow | tradeoff | structure-puzzle. Choose based on what kind of interaction best reveals the core insight: physics-sim = continuous motion/forces (orbital, waves, projectile); threshold = behavior jumps suddenly at a boundary (states of matter, equilibrium, action potential); accumulation = things pile up / compound over time (interest, growth, debt); process-flow = something moves through stages (photosynthesis, digestion, supply chain); tradeoff = two competing forces find an optimum (supply/demand, natural selection); structure-puzzle = click to arrange/mark a static structure (genetics pedigree, circuits, food web). Pick the ONE that best fits.",
    "learning_goal": "One sentence using the exact words of the core insight from the reasoning.",
    "entry_misconception": "The specific wrong belief the learner almost certainly walks in with. Be concrete: not 'they don't understand X' but 'they think X because Y, so they predict Z'. This is what the lab must break.",
    "first_move": "The very first thing the learner should try — what to drag/click/adjust and what surprising thing happens in the first 10 seconds. This must directly challenge the entry_misconception.",
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
    "direct_manipulation": "Describe one thing the learner grabs/drags directly ON the canvas — the PRIMARY variable must be controllable by dragging an object, not just a slider. E.g. 'Drag the planet closer or farther from the star to change orbital radius. The planet snaps to pointer on drag.' Be concrete about the visual object being grabbed.",
    "interaction_palette": [
      { "type": "draggable", "element": "name of draggable canvas object", "effect": "what changes in the simulation when dragged" },
      { "type": "click-spawn", "element": "what clicking the canvas does", "effect": "immediate visual result" },
      { "type": "toggle-button", "element": "button label", "effect": "what boolean flips and what visually changes" }
    ],
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
- rules MUST include at least one threshold that triggers the aha moment visually
- the default state must already show interesting behavior on load — never a blank or boring starting point. The sim opens mid-phenomenon.
- reflection question must be answerable only AFTER interacting — not a definition lookup
- lab_archetype MUST be one of the six listed — choose the one that best reveals the concept through interaction, not the most generic one
- entry_misconception MUST be a specific wrong belief, not a vague gap — "they think heavier objects fall faster" not "they don't understand gravity"
- first_move MUST describe a concrete action that surprises the learner within 10 seconds and directly challenges the entry_misconception
- direct_manipulation MUST describe a canvas object the learner grabs with their finger/mouse — not a slider. The primary variable is controlled by dragging something on the canvas.
- interaction_palette MUST include at least one "draggable" and one "toggle-button" entry — the lab needs multiple interaction types, not just sliders
- do NOT include interaction_type or any format label anywhere in the JSON

Topic: ${topic}

Reasoning:
${thinking}

Now produce the spec JSON.`, 2500);
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

  const archetype = design.spec.lab_archetype || "physics-sim";

  // Archetype-specific questions that shape what the lab is DESIGNED to do
  const archetypeQuestions = {
    "physics-sim": `
━━━ ARCHETYPE: PHYSICS SIMULATION ━━━
This is a continuous-motion lab. The learner changes something and watches a physical system evolve. Design around these questions:
- What does the default state look like — what's already moving before the learner touches anything?
- What trajectory, path, or trail morphs visibly as the primary variable changes? (This morphing trail IS the lab.)
- What are the 2-3 distinct regimes the primary variable spans? (e.g. crash / orbit / escape) What does each look like visually?
- What hidden force or vector should be drawn as an arrow? (velocity, gravity, tension — name it, color it, make it proportional)
- At what exact value does the most surprising visual transition happen? What does the canvas look like 1 second before vs 1 second after?`,

    "threshold": `
━━━ ARCHETYPE: THRESHOLD / PHASE TRANSITION ━━━
This lab is about a sudden jump. The learner moves a slider and MOST of the range feels boring — then suddenly everything changes. Design around:
- What does "before the threshold" look like? What single property is the learner watching?
- What exact value triggers the jump? What changes visually — color, shape, motion, state?
- Is the jump reversible? If yes, show hysteresis (the threshold going back is different from going forward). If no, make the irreversibility dramatic.
- What's the subtle early warning sign just before the threshold? (a tremor, a glow building up, a value approaching a line)
- The boring region MUST still be visually alive — what slow continuous change shows the system approaching the threshold?`,

    "accumulation": `
━━━ ARCHETYPE: ACCUMULATION / COMPOUNDING ━━━
This lab is about how small rates produce enormous outcomes over time. Time runs forward. Design around:
- Two curves must be drawn simultaneously: the linear "what most people intuitively expect" line, and the actual exponential/accumulation curve. The gap between them IS the insight.
- What does the graph look like at t=0? At t=halfway? At t=max? Describe the visual divergence.
- What does the "crossing point" look like — when does the accumulation curve visibly pull ahead of intuition?
- Time controls: a play button that advances time, a speed slider, a reset. The learner must be able to run time forward and back.
- Live readouts: current value, "if it were linear it would be X, but it's actually Y" — show the difference as a number.`,

    "process-flow": `
━━━ ARCHETYPE: PROCESS / FLOW ━━━
This lab shows something moving through stages. The learner controls the inputs and watches how the output changes. Design around:
- Draw each stage as a physical region on the canvas (a chamber, a node, a box). Label them.
- Show the thing that flows (molecules, money, energy, signal) as particles or a stream visually moving between stages.
- What happens at each stage? What transforms there? Make the transformation visible.
- What happens when a stage is bottlenecked or overloaded? Show the backup, the overflow, the failure.
- The learner's control changes the rate or condition at one stage — how does this ripple downstream? Show the ripple.`,

    "tradeoff": `
━━━ ARCHETYPE: TRADEOFF / OPTIMUM ━━━
This lab has two competing forces and an optimum in the middle. Design around:
- Draw BOTH forces simultaneously — one curve going up, one going down, their sum showing a peak or trough.
- The learner drags a cursor along the tradeoff space. The cursor's position shows the current tradeoff. The optimal point is marked but not highlighted until the learner finds it.
- What happens at the extreme left? Extreme right? The extremes must be visibly bad in different ways.
- When the learner hits the optimum, what visual event marks it? (a click, a peak lighting up, a readout turning green)
- Show the real-world cost of being off-optimum as a concrete number ("you're leaving $X on the table").`,

    "structure-puzzle": `
━━━ ARCHETYPE: STRUCTURE / PUZZLE ━━━
This lab is about recognizing a pattern in a structure. No continuous physics loop. Design around:
- Draw the full structure clearly at startup: a pedigree tree, a circuit, a web of nodes. It fills the canvas.
- Clicking a node/element cycles its state visually (affected → carrier → unaffected; on → off; connected → disconnected).
- After every click, evaluate() re-checks whether the current configuration is consistent/correct.
- What's the wrong configuration the learner tries first? What feedback makes it clearly wrong?
- What's the correct configuration? When reached, what visual celebration happens? (a path lights up, a circuit closes, a glow travels through the correct nodes)
- There must be intermediate "close but not quite" states that give the learner useful partial feedback.`,
  };

  const prompt = `You are a senior learning designer and creative coder. Produce a CONCRETE BRIEF that a developer can implement directly in HTML Canvas 2D.

TOPIC: ${design.topic}
LAB ARCHETYPE: ${archetype}
LEARNING GOAL: ${design.spec.learning_goal}
ENTRY MISCONCEPTION (what the learner believes walking in): "${design.spec.entry_misconception || "not specified"}"
FIRST MOVE (what to try first that breaks the misconception): "${design.spec.first_move || "not specified"}"
VISUAL METAPHOR: "${design.spec.visualMetaphor}"

VARIABLES:
${vars}

AHA MOMENT: ${design.spec.aha_trigger}

${archetypeQuestions[archetype] || archetypeQuestions["physics-sim"]}

Now write the FULL VISUAL BRIEF covering these sections. Be specific — a developer must be able to draw this directly from your words. No vague gestures.

━━━ A. LEARNING ARC (not visual — pedagogical) ━━━
1. What wrong thing will the learner try first? (based on entry_misconception)
2. What happens when they try it? (the surprising result)
3. What do they adjust next? (the natural follow-up)
4. What's the moment of "oh!" — what exactly changed on screen?
5. What can they now explain that they couldn't before?

━━━ B. WHAT DRAWS ON LOAD ━━━
Describe exactly what the canvas shows at startup — every element, position, color, whether animated. Must look alive and interesting before any interaction.

━━━ C. HOW EACH VARIABLE CHANGES THE CANVAS ━━━
For each variable: exact visual change, what equation drives it, what it looks like at min vs max.

━━━ D. THE AHA MOMENT VISUAL ━━━
Canvas state right before vs right after. Exact trigger value. What visual event makes it unmissable.

━━━ E. MAKE THE INVISIBLE VISIBLE ━━━
- TRACE/TRAIL: what path or history stays on screen so the learner compares before vs now?
- HIDDEN MECHANISM: what force/field/process is normally invisible that must be drawn as arrows/bars/glows?
- LINKED REPRESENTATIONS: same quantity shown 2+ ways simultaneously?

━━━ F. LIVE READOUTS ━━━
Every text label that updates live. Each shows an OUTPUT (the effect), never just the input value echoed back.

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
- Everything must be drawable with Canvas 2D (fillRect, arc, bezierCurveTo, etc.)
- The central visual must be LARGE — filling the stage, not floating small in empty space
- No decorative elements — every element either reacts to input or displays the concept
- The lab opens mid-phenomenon — already showing interesting behavior at the default values`;

  return openaiText(prompt, 2500, "gpt-4o");
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
    // mockupImage disabled — was using gpt-image-1 (OpenAI), now Gemini-only
    return null;
  } catch (err) {
    console.warn("mockupImage failed, continuing without:", err.message);
    return null;
  }
}

// Step 5 — writes the final HTML lab.
// Takes the prose brief (source of truth for behavior) + optional mockup image (look/layout).
//
// NOTE: This step originally ran on Claude (claude-opus-4-7), then OpenAI gpt-4o.
// Now uses Google Gemini (gemini-2.5-flash).
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
  };

  const briefText = `You are building a single self-contained interactive learning lab. LAB ARCHETYPE: ${archetype.toUpperCase()}. You MUST output a complete, working HTML file right now — no summaries, no explanations.

${imageDataUrl ? `You are given two inputs:
1. A VISUAL MOCKUP (image) — use ONLY for layout, color, spatial arrangement.
2. A BEHAVIORAL BRIEF (below) — source of truth for what the lab DOES. Brief wins over image always.
` : `You are given a behavioral brief below — the source of truth for what the lab does.`}

GOAL: the learner manipulates something, watches the concept's real mechanism unfold, understands what every element on screen means, and sees how it works in the real world.

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

[draggable] Grab and drag a canvas object:
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    const {mx, my} = canvasPt(e);
    if (Math.hypot(mx - state.obj.x, my - state.obj.y) < 30) {
      drag = { ox: state.obj.x - mx, oy: state.obj.y - my };
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (drag) { const {mx,my}=canvasPt(e); state.obj.x=mx+drag.ox; state.obj.y=my+drag.oy; }
    else { /* update hover: is pointer near obj? change cursor */ const {mx,my}=canvasPt(e); canvas.style.cursor = Math.hypot(mx-state.obj.x,my-state.obj.y)<30?'grab':'default'; }
  });
  canvas.addEventListener('pointerup', () => { drag=null; canvas.style.cursor='default'; });
  function canvasPt(e) { const r=canvas.getBoundingClientRect(); return { mx:(e.clientX-r.left)*(canvas.width/r.width), my:(e.clientY-r.top)*(canvas.height/r.height) }; }

[click-spawn] Click canvas to fire/spawn an object:
  canvas.addEventListener('click', e => {
    const {mx,my}=canvasPt(e);
    state.particles.push({ x:mx, y:my, vx:(Math.random()-.5)*4, vy:-6, life:1.0 });
  });

[toggle-button] Button that flips a boolean:
  const btn = document.getElementById('toggleBtn');
  btn.addEventListener('click', () => {
    controls.active = !controls.active;
    btn.textContent = controls.active ? '⏸ Pause' : '▶ Play';
    btn.style.background = controls.active ? '#1e3a5f' : '#3a1e1e';
  });

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

HOVER GLOW — every draggable object MUST glow when hovered:
  // In the draw function, check if pointer is near the object:
  if (state.hovered) {
    ctx.save(); ctx.shadowBlur=20; ctx.shadowColor='rgba(99,102,241,0.8)';
    // redraw the object shape here
    ctx.restore();
  }

${archetypeArchitecture[archetype] || archetypeArchitecture["physics-sim"]}

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
LAYOUT — TWO ZONES (non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• MISSION BANNER: at the very top of Zone A, show the SUCCESS CONDITION text in a styled box — copper/amber border, small label "YOUR MISSION", text in white. Stays visible the entire time.
  Example: <div style="background:rgba(212,165,116,0.08);border:1px solid rgba(212,165,116,0.4);border-radius:8px;padding:10px 12px;margin-bottom:12px"><div style="font-size:0.62rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#D4A574;margin-bottom:4px">YOUR MISSION</div><div style="font-size:0.82rem;color:#F0F2F8;line-height:1.5">[mission]</div></div>
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
• CANVAS SIZING — CRITICAL. srcdoc iframes often return offsetWidth=0 at script time, causing permanent blank canvas. Use this EXACT pattern — no shortcuts:
  const canvas = document.getElementById('mainCanvas');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, started = false;
  function resizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const w = Math.round(r.width) || canvas.offsetWidth || canvas.parentElement.offsetWidth || 800;
    const h = Math.round(r.height) || canvas.offsetHeight || canvas.parentElement.offsetHeight || 500;
    if (w > 10 && h > 10) { W = canvas.width = w; H = canvas.height = h; }
    if (!started && W > 0) { started = true; draw(); }
  }
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('load', resizeCanvas);
  // Also handle the custom event fired by the platform's sizing runtime:
  window.addEventListener('repend-resize', resizeCanvas);
  // Try immediately, then defer — whichever fires first when layout is ready
  resizeCanvas();
  setTimeout(resizeCanvas, 50);
  setTimeout(resizeCanvas, 200);
  // draw() is called by resizeCanvas once W > 0 — DO NOT call draw() before then:
  function draw() { if(!W||!H) return; ctx.clearRect(0,0,W,H); /* draw everything */ requestAnimationFrame(draw); }
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

Output only the HTML file. Start with <!doctype html>. No markdown. No explanation. No code fences.`;

  const parts = [{ text: briefText }];
  if (imageDataUrl) {
    const m = imageDataUrl.match(/^data:(.+?);base64,(.*)$/);
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  const res = await geminiGenerate({
    contents: [{ role: "user", parts }],
    generationConfig: { maxOutputTokens: 16000, temperature: 0.7 },
  }, {
    label: "codegen",
    // Cross-provider fallback: gpt-4o produces the same provider-agnostic HTML.
    openaiFallback: () => openaiText(briefText, 16000, "gpt-4o"),
  });
  let html = res.response.text().trim();
  html = html.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return html;
}

// Injected into every lab: canvas auto-sizing + error reporter.
// Sentinel attr prevents double-injection on repair.
function injectLabRuntime(html) {
  const runtime = `
<script data-repend-runtime="1">
(function(){
  // Canvas sizing: srcdoc iframes often return offsetWidth=0 at script time.
  // Use ResizeObserver as the reliable trigger, with a polling fallback.
  function sizeCanvas(c){
    // Prefer getBoundingClientRect (accounts for CSS transforms)
    var r = c.getBoundingClientRect();
    var w = Math.round(r.width)  || c.offsetWidth  || c.parentElement && c.parentElement.offsetWidth  || 0;
    var h = Math.round(r.height) || c.offsetHeight || c.parentElement && c.parentElement.offsetHeight || 0;
    if(w > 10 && h > 10 && (c.width !== w || c.height !== h)){
      c.width  = w;
      c.height = h;
      // Tell the lab code to redraw — try both resize event and a custom event
      window.dispatchEvent(new Event('resize'));
      c.dispatchEvent(new Event('repend-resize'));
    }
  }

  function fixAll(){ document.querySelectorAll('canvas').forEach(sizeCanvas); }

  // 1. Try immediately (works if layout is ready)
  fixAll();

  // 2. After DOM is loaded
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ requestAnimationFrame(fixAll); });
  }

  // 3. After full page load (images, fonts — most reliable timing)
  window.addEventListener('load', function(){ requestAnimationFrame(fixAll); });

  // 4. ResizeObserver watches every canvas that appears
  if(typeof ResizeObserver !== 'undefined'){
    var ro = new ResizeObserver(function(entries){
      entries.forEach(function(e){ sizeCanvas(e.target); });
    });
    function observeAll(){
      document.querySelectorAll('canvas').forEach(function(c){
        ro.observe(c);
        sizeCanvas(c);
      });
    }
    observeAll();
    // Catch canvases added later by the lab
    if(typeof MutationObserver !== 'undefined'){
      new MutationObserver(observeAll).observe(document.documentElement,{childList:true,subtree:true});
    }
  }

  // 5. Hard retry if canvas is still 0×0 after 200ms / 600ms (srcdoc timing edge case)
  [200, 600, 1200].forEach(function(ms){
    setTimeout(function(){
      document.querySelectorAll('canvas').forEach(function(c){
        if(c.width < 10 || c.height < 10){ sizeCanvas(c); }
      });
    }, ms);
  });

  // Error reporter
  var reported = false;
  function report(msg, line, col){
    if(reported) return; reported = true;
    try { window.parent.postMessage({ type:'labError', error:{ message:String(msg||'Unknown error'), line:line||0, col:col||0 } }, '*'); } catch(_){}
  }
  window.addEventListener('error', function(e){ report(e.message, e.lineno, e.colno); });
  window.addEventListener('unhandledrejection', function(e){ report((e.reason&&e.reason.message)||String(e.reason)||'Unhandled rejection', 0, 0); });
})();
<\/script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, runtime + "</head>");
  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, "$1" + runtime);
  return runtime + html;
}

async function repairLab(html, errorMessage) {
  const stripped = html.replace(/<script data-repend-runtime="1">[\s\S]*?<\/script>/i, "");
  const prompt = `This interactive HTML lab throws a runtime JavaScript error that leaves the screen blank.

THE ERROR: ${errorMessage}

THE HTML:
${stripped}

Fix the bug. Common causes: variable used before declaration, typo in a variable name, calling a function before defining it, reading a property of null/undefined.
Return the COMPLETE corrected HTML document — entire file, no diff, no snippet, no markdown fences, no commentary.`;

  const res = await geminiGenerate({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 16000, temperature: 0.2 },
  }, {
    label: "repair",
    openaiFallback: () => openaiText(prompt, 16000, "gpt-4o"),
  });
  let fixed = res.response.text().trim();
  fixed = fixed.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return injectLabRuntime(fixed);
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
            "X-Accel-Buffering": "no",
            // NOTE: "Connection: keep-alive" is intentionally omitted —
            // it is illegal over HTTP/2 and causes ERR_HTTP2_PROTOCOL_ERROR on Railway.
          });

          // Heartbeat keeps the SSE connection alive through proxies/Railway
          const heartbeat = setInterval(() => { try { res.write(`: ping\n\n`); } catch(_){} }, 15000);
          res.on("close", () => clearInterval(heartbeat));

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
            // Always re-inject the latest runtime so old cached labs get
            // the current canvas-sizing fix without needing regeneration.
            if (cached.labHtml) {
              const stripped = cached.labHtml.replace(/<script data-repend-runtime="1">[\s\S]*?<\/script>/i, "");
              cached.labHtml = injectLabRuntime(stripped);
            }
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
          const rawHtml = await codeFromImageBrief(design, labThinking, imageDataUrl);
          const html = injectLabRuntime(rawHtml);

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

        } else if (req.url === "/repair-lab") {
          const { html, error } = data;
          if (!html) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing html" })); return; }
          const fixed = await repairLab(html, error || "Unknown error");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ labHtml: fixed }));

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`Repend running at http://0.0.0.0:${PORT}`));
