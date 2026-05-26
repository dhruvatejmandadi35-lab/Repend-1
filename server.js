const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// PLAN_SYSTEM — prompt for GPT-4o to generate a recipe JSON for a given topic.
// ---------------------------------------------------------------------------
const PLAN_SYSTEM = `You are an expert educational lab designer. You compile any learning topic into a single JSON recipe that drives a fixed interactive runtime engine.

────────────────────────────────────────────────
RECIPE JSON SCHEMA — return exactly this shape:
────────────────────────────────────────────────

{
  "topic": "Display name for the topic",
    "scenario": "2-3 paragraph immersive second-person scenario. Open with a concrete real-world moment where THIS specific concept matters (a real job, a real decision, a real failure mode, a real product, a real news story). Name actual roles, places, dollar amounts, or consequences. End by stating exactly what the learner is about to manipulate to feel why it matters. NO generic 'imagine you are exploring' openings.",
      "verificationQuestion": "Specific question the learner can ONLY answer by interacting with the lab.",
        "recipe": {
            "title": "Lab title shown at top",
                "instructions": "1-2 sentences describing what to click/drag and what the goal is.",
                    "stage": { "width": 900, "height": 540 },
                        "background": {
                              "type": "svg",
                                    "markup": "<line x1='100' y1='100' x2='800' y2='100' stroke='#93C5FD' stroke-width='1'/>"
                                        },
                                            "objects": [],
                                                "winCondition": {
                                                      "type": "states-match",
                                                            "target": {}
                                                                },
                                                                    "hint": "One actionable hint the learner can use if stuck.",
                                                                        "successMessage": "Affirmation shown when correct.",
                                                                            "insight": "One deeper insight dropped after they get it right."
                                                                              }
                                                                              }

                                                                              ────────────────────────────────────────────────
                                                                              OBJECT TYPES — add these to "objects":
                                                                              ────────────────────────────────────────────────

                                                                              NODE (clickable shape cycling through states):
                                                                              {
                                                                                "id": "node-1",
                                                                                  "kind": "node",
                                                                                    "x": 300, "y": 220,
                                                                                      "shape": "circle",
                                                                                        "size": 32,
                                                                                          "label": "II-1",
                                                                                            "states": ["unaffected", "affected"],
                                                                                              "initial": "unaffected",
                                                                                                "stateStyles": {
                                                                                                    "unaffected": { "fill": "transparent", "stroke": "#ffffff" },
                                                                                                        "affected": { "fill": "#3B82F6", "stroke": "#3B82F6" }
                                                                                                          }
                                                                                                          }
                                                                                                          
                                                                                                          DRAGGABLE (labeled card the learner drags):
                                                                                                          {
                                                                                                            "id": "lbl-1",
                                                                                                              "kind": "draggable",
                                                                                                                "x": 80, "y": 460,
                                                                                                                  "width": 140, "height": 36,
                                                                                                                    "label": "Mitochondria",
                                                                                                                      "color": "#1E3A8A"
                                                                                                                      }
                                                                                                                      
                                                                                                                      TARGET (snap zone for draggables):
                                                                                                                      {
                                                                                                                        "id": "zone-1",
                                                                                                                          "kind": "target",
                                                                                                                            "x": 540, "y": 220,
                                                                                                                              "width": 140, "height": 36,
                                                                                                                                "label": "Powerhouse organelle",
                                                                                                                                  "accepts": ["lbl-1"]
                                                                                                                                  }
                                                                                                                                  
                                                                                                                                  SLIDER (numeric control with optional SVG binding):
                                                                                                                                  {
                                                                                                                                    "id": "force",
                                                                                                                                      "kind": "slider",
                                                                                                                                        "label": "Applied Force", "unit": "N",
                                                                                                                                          "min": 0, "max": 50, "step": 1, "initial": 10,
                                                                                                                                            "bind": { "selector": "#forceArrow", "attr": "x2", "scale": 4, "offset": 200 }
                                                                                                                                            }

                                                                                                                                            SLIDER bind options — pick the one that fits:
                                                                                                                                              • Linear: { "selector": "#bar", "attr": "width", "scale": 2, "offset": 0 }   → attr = value*scale + offset
                                                                                                                                              • Expression: { "selector": "#point", "attr": "cx", "expr": "cos(v) * 150 + 450" }  → 'v' is the slider value. Math.sin, cos, tan, sqrt, pow, exp, log, PI, E all available.
                                                                                                                                              • Multi-target (one slider, many elements): { "binds": [
                                                                                                                                                  { "selector": "#point", "attr": "cx", "expr": "cos(v) * 150 + 450" },
                                                                                                                                                  { "selector": "#point", "attr": "cy", "expr": "-sin(v) * 150 + 270" },
                                                                                                                                                  { "selector": "#xVal", "attr": "x", "expr": "0", "textContent": true, "decimals": 3 }
                                                                                                                                                ] }
                                                                                                                                              • textContent:true + decimals:N → writes the computed value AS text into the element (use for readouts like "x = 0.866").

                                                                                                                                            CRITICAL: every slider in a quantitative lab MUST have a bind that visibly changes something. A slider with no bind, or a bind that does nothing visible, is a broken lab. If the formula needs trig, USE the "expr" form — don't fall back to "scale/offset" which only does linear math.
                                                                                                                                            
                                                                                                                                            LABEL (static text annotation on stage):
                                                                                                                                            {
                                                                                                                                              "id": "gen-label",
                                                                                                                                                "kind": "label",
                                                                                                                                                  "x": 60, "y": 100,
                                                                                                                                                    "text": "Generation I",
                                                                                                                                                      "size": 12,
                                                                                                                                                        "color": "rgba(212,165,116,0.9)"
                                                                                                                                                        }
                                                                                                                                                        
                                                                                                                                                        ────────────────────────────────────────────────
                                                                                                                                                        WIN CONDITION TYPES — pick exactly one:
                                                                                                                                                        ────────────────────────────────────────────────
                                                                                                                                                        
                                                                                                                                                        states-match (for NODE labs):
                                                                                                                                                        { "type": "states-match", "target": { "node-1": "affected", "node-2": "affected" } }
                                                                                                                                                        
                                                                                                                                                        snaps-correct (for DRAGGABLE/TARGET labs):
                                                                                                                                                        { "type": "snaps-correct", "target": { "lbl-1": "zone-1", "lbl-2": "zone-2" } }
                                                                                                                                                        
                                                                                                                                                        values-equal (for SLIDER labs):
                                                                                                                                                        { "type": "values-equal", "target": { "force": 22.5 }, "tolerance": 0.5 }
                                                                                                                                                        
                                                                                                                                                        ────────────────────────────────────────────────
                                                                                                                                                        PATTERN SELECTION — read carefully, pick the BEST fit, not the easiest:
                                                                                                                                                        ────────────────────────────────────────────────

                                                                                                                                                        STEP 1 — Identify the topic's DOMAIN:
                                                                                                                                                          A) Quantitative / formula-driven: math, physics, chemistry, economics, statistics, finance, engineering, signal processing, population genetics → DEFAULT to SLIDER lab
                                                                                                                                                          B) Has named PARTS of a visual thing: anatomy, geography, astronomy diagrams, circuits, cell structures, architectural elements → DEFAULT to DRAGGABLE+TARGET (label the diagram)
                                                                                                                                                          C) Classification / true-false / on-off states: genetics pedigrees, logic circuits, historical claim verification, ethical stance identification, market structure labeling, algorithm correctness voting → DEFAULT to NODE click-cycle
                                                                                                                                                          D) Sequence / ordering / matching pairs: historical timelines, recipe steps, OSI layers, geological eras, algorithm complexity, court hierarchy, supply chain → DEFAULT to DRAGGABLE+TARGET (order/match)
                                                                                                                                                          E) Complex topic that spans 2 domains → MIXED: use both NODEs + SLIDERs, or DRAGGABLEs + SLIDERs together

                                                                                                                                                        STEP 2 — Build accordingly:

                                                                                                                                                        DOMAIN A — SLIDER lab (quantitative):
                                                                                                                                                          • 3-5 sliders, each bound to a visible SVG element that changes shape/position/size as the learner drags
                                                                                                                                                          • Background SVG must show axes, gridlines, a live object (arrow, curve, bar) that the sliders animate
                                                                                                                                                          • Win: learner tunes the sliders to hit a target value (e.g., set mass=10, force=20 to achieve acceleration=2)
                                                                                                                                                          • AI/ML example: tune learning_rate + hidden_layers sliders; an SVG loss curve updates live; goal: reach loss < 0.1
                                                                                                                                                          • Compound interest: tune principal + rate + years; SVG bar chart grows; goal: hit $10,000
                                                                                                                                                          • Game theory: tune Player A strategy % + Player B strategy %; SVG payoff matrix cell highlights the Nash equilibrium

                                                                                                                                                        DOMAIN B/D — DRAGGABLE+TARGET (labeling / ordering):
                                                                                                                                                          • Draw the subject in background SVG (body outline, map, network diagram, machine schematic)
                                                                                                                                                          • Place targets at the actual positions of the parts on the drawing
                                                                                                                                                          • Put draggable labels in a bottom tray (y ≈ 460-490)
                                                                                                                                                          • IDs must use descriptive names: "lbl-heart", "zone-heart", NOT "lbl-1", "zone-1"

                                                                                                                                                        DOMAIN C — NODE click-cycle (classification):
                                                                                                                                                          • Each node represents one item to classify
                                                                                                                                                          • States reflect the categories (e.g., ["supervised","unsupervised","reinforcement"] or ["true","false"] or ["affected","carrier","unaffected"])
                                                                                                                                                          • Background SVG provides context (pedigree lines, category boxes, a legend)
                                                                                                                                                          • 8-12 nodes total

                                                                                                                                                        FORBIDDEN: Do NOT use DRAGGABLE+TARGET for a topic that is fundamentally quantitative (physics formulas, math equations, financial models, statistical relationships). Those get SLIDERs. Sorting algorithms into boxes when the concept is about tuning parameters is WRONG — tune the parameters instead.

                                                                                                                                                        ALWAYS prefer the pattern that makes the learner DISCOVER the concept by manipulating it, not just recognize it.
                                                                                                                                                        NEVER use generic IDs like "algo-1", "target-1", "lbl-1". Use topic-specific IDs like "lbl-heart", "zone-frontal-lobe", "slider-mass".

                                                                                                                                                        ────────────────────────────────────────────────
                                                                                                                                                        LAYOUT RULES:
                                                                                                                                                        ────────────────────────────────────────────────
                                                                                                                                                        - Stage is 900x540. Keep objects within 40px inner margin.
                                                                                                                                                        - Draggables go in a tray at y = 470. Targets go on the diagram above.
                                                                                                                                                        - For pedigrees: marriage lines horizontal, descent lines vertical, use SVG lines in background.markup.
                                                                                                                                                        - Background SVG: stroke #93C5FD, text fill rgba(255,255,255,0.6), font-family system-ui.
                                                                                                                                                        
                                                                                                                                                        ────────────────────────────────────────────────
                                                                                                                                                        CRITICAL OUTPUT RULES:
                                                                                                                                                        ────────────────────────────────────────────────
                                                                                                                                                        1. Return ONLY the JSON object. No markdown, no code fences, no commentary.
                                                                                                                                                        2. Do NOT include JavaScript comments (// or /* */) anywhere in the JSON output.
                                                                                                                                                        3. The "shape" field must be exactly the string "circle" or the string "square" — no pipe characters.
                                                                                                                                                        4. All string values must be valid JSON strings with no unescaped quotes inside them.
                                                                                                                                                        5. Do NOT include the text strings "RECIPE" or "END" inside any SVG markup or other string values.
                                                                                                                                                        6. Be specific: use real names, real organelles, real numbers — not placeholder text.
                                                                                                                                                        7. The activity must be solvable in 30-90 seconds and force the learner to discover the key insight by interacting.

UNIVERSAL DEPTH REQUIREMENTS — apply to EVERY topic without exception:
1. MINIMUM 6 interactive objects. Count them before submitting. If you have fewer, add more. No topic is too simple to reach 6.
   - Labeling/sorting topic (anatomy, chemistry, history, geography): 6-10 draggable labels + matching targets placed on a diagram
   - Sequence/classification topic (cell cycle, historical events, logic gates): 6-8 nodes or draggables to order/classify
   - Pedigree/family/inheritance topic: 8-12 nodes across 3 generations
   - Physics/math/quantitative topic: 3-5 sliders each binding to a visible SVG element
   - Any other topic: find 6+ meaningful pieces the learner must place, toggle, or tune

2. RICH BACKGROUND SVG — always draw a real visual context (15+ SVG elements):
   - Labeling: draw the actual subject (body outline, cell membrane, map outline, circuit schematic) using <path>, <ellipse>, <circle>, <rect>, <line>
   - Pedigree: draw every marriage/descent/sibling connector line
   - Physics: draw axes, gridlines, arrows, force vectors, object shapes
   - Never leave background.markup as an empty string or a single line

3. Place interactive objects at visually meaningful positions that correspond to the background diagram, not scattered randomly.

4. NEVER copy the placeholder values from the schema examples (Mitochondria, II-1, force, Powerhouse organelle). Every id, label, and value must be specific to the user's actual topic.

If your output has fewer than 6 interactive objects or an empty background, you have failed. Think harder and re-plan.
                                                                                                                                                        `;

const VERIFY_SYSTEM = `You are a learning coach. The student attempted an interactive lab and may have written a free-text reflection on top. Return ONLY JSON:
{
  "correct": true,
    "feedback": "2-3 sentences. If correct: affirm with precision and one deeper insight. If wrong: name the specific misread and what to look for next."
    }`;

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
    const text = res.choices[0].message.content.trim();
    return JSON.parse(text);
}

function injectRecipe(recipe) {
    // Replace the placeholder block in engine.html with the real recipe.
  const serialized = JSON.stringify(recipe);
    return ENGINE_TEMPLATE.replace(
          /\/\*__RECIPE__\*\/[\s\S]*?\/\*__END__\*\//,
          `/*__RECIPE__*/ ${serialized} /*__END__*/`
        );
}

async function verify(topic, question, recipeSummary, userAnswer, labResult) {
    const res = await openai.chat.completions.create({
          model: "gpt-4o",
          max_tokens: 512,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: VERIFY_SYSTEM },
            { role: "user", content:
                      `Topic: ${topic}\n` +
                      `Question: ${question}\n` +
                      `Lab summary: ${recipeSummary}\n` +
                      `Engine verdict: ${labResult ? JSON.stringify(labResult) : "n/a"}\n` +
                      `Student's written answer: ${userAnswer}` },
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
// FREEFORM LAB PIPELINE — two-step: Designer spec → Coder writes full HTML
// ─────────────────────────────────────────────────────────────────

const DESIGNER_SYSTEM = `You are an instructional designer who builds discovery-based learning labs. Your job is NOT to design a toy — it is to design a guided experience where the learner DISCOVERS a concept by being walked through specific manipulations, each one with an observation prompt and an insight reveal.

Return ONLY JSON with this shape:
{
  "topic": "Display name",
  "scenario": "2-3 paragraph immersive 2nd-person scenario. Open with a CONCRETE real-world moment (a real role, place, dollar amount, news event, failure mode). Make it clear WHY this concept matters in the real world. End by stating exactly what the learner will discover.",
  "verificationQuestion": "One specific question the learner can only answer AFTER completing the guided sequence.",
  "spec": {
    "title": "Short lab title",
    "learning_goal": "ONE sentence: the precise insight the learner will walk away with. Not 'understand X' — instead 'see that doubling principal doubles final balance but doubling rate more than doubles it'.",
    "interaction_type": "one of: slider-tune | drag-label | click-classify | sequence-order | sketch-construct | multi-stage",
    "visuals": "Detailed description of what the lab looks like — shapes, layout, colors, what moves. Be specific about position, size, color, animation. The visual must make the underlying concept VISIBLE — if money grows, draw bars growing; if a wave shifts, show the wave; if cells divide, animate the division.",
    "controls": "Every interactive control — exactly what changes visually on input. Minimum 2 meaningful controls.",
    "teaching_sequence": [
      {
        "step": 1,
        "instruction": "Specific action the learner should take RIGHT NOW. E.g., 'Drag the rate slider from 5% to 10%.'",
        "observation_prompt": "What they should notice. E.g., 'Look at the green bar — how much did the final balance change?'",
        "insight": "What this proves. E.g., 'Doubling the rate didn't just double your money — it grew it 5x over 30 years. That's compounding.'",
        "completion_check": "Programmatic rule — when this step is done. E.g., 'rate >= 0.10 for at least 1 second'"
      },
      {
        "step": 2,
        "instruction": "...",
        "observation_prompt": "...",
        "insight": "...",
        "completion_check": "..."
      },
      {
        "step": 3,
        "instruction": "Final challenge: ask them to USE what they discovered. E.g., 'Find the combination of rate and years that turns $1,000 into exactly $10,000.'",
        "observation_prompt": "...",
        "insight": "...",
        "completion_check": "..."
      }
    ],
    "success_condition": "Exact rule for the FINAL challenge (step 3). Must be programmatically checkable.",
    "real_world_payoff": "One sentence connecting what they just discovered back to a real-world decision they could make better. E.g., 'This is why starting your IRA at 22 vs 32 matters more than a 1% better rate.'"
  }
}

CRITICAL: every lab is a 3-step guided sequence. Step 1 = make them notice. Step 2 = make them question. Step 3 = make them apply. NOT just "play with this widget".

Use real values, real names, real numbers.`;

async function designLab(topic) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: DESIGNER_SYSTEM },
      { role: "user", content: `Topic: ${topic}\n\nDesign the lab spec.` },
    ],
  });
  return JSON.parse(res.choices[0].message.content.trim());
}

async function codeLab(design) {
  const userPrompt = `You are building a world-class GUIDED interactive educational lab as a single self-contained HTML file. This is not a sandbox toy — it is a 3-step discovery experience that TEACHES the concept.

TOPIC: ${design.topic}
LEARNING GOAL: ${design.spec.learning_goal}
INTERACTION TYPE: ${design.spec.interaction_type}

WHAT IT SHOULD LOOK LIKE:
${design.spec.visuals}

CONTROLS & INTERACTIONS:
${design.spec.controls}

═══════════════════════════════════════════════════
GUIDED TEACHING SEQUENCE — render this as a progressive UX:
═══════════════════════════════════════════════════
${(design.spec.teaching_sequence || []).map(s => `
STEP ${s.step}:
  Instruction (show prominently when this step is active): "${s.instruction}"
  Observation prompt (show after they start interacting): "${s.observation_prompt}"
  Insight (reveal when completion_check passes): "${s.insight}"
  Completion rule: ${s.completion_check}
`).join("\n")}

REAL-WORLD PAYOFF (show at the very end): "${design.spec.real_world_payoff || ""}"

FINAL SUCCESS CONDITION: ${design.spec.success_condition}

═══════════════════════════════════════════════════
HOW TO RENDER THE GUIDED EXPERIENCE:
═══════════════════════════════════════════════════
• At the top of the stage, show a "STEP X of 3" indicator with the current instruction in large clear type
• Below it, show the observation prompt in muted text once the learner has interacted at least once on this step
• When the step's completion_check passes:
  - Briefly flash the stage with a soft green glow
  - Reveal the insight as a card that slides in from the right
  - After 2 seconds (or on user click "Continue"), advance to the next step
• Step 3 is the challenge — show the success_condition target prominently. On final correctness:
  - Full stage celebration: confetti burst, success message, real_world_payoff card
  - postMessage({type:"labCheck", result:{ok:true, score:3, total:3}}, "*")
• Never let the learner skip ahead — they must complete each step's completion_check before the next instruction appears
• Always show a "Why?" button next to the current instruction — clicking it reveals a hint or deeper explanation

═══════════════════════════════════════════════════
VISUAL QUALITY:
═══════════════════════════════════════════════════
• Dark theme: bg #0B1220, stage #0E1830, surfaces #131A2A, borders rgba(59,130,246,0.2)
• Glowing accents: primary #3B82F6, copper #D4A574, green #22C55E success, muted #8899BB
• Stage fills viewport. Smooth animations (requestAnimationFrame).
• Main visual = Canvas 2D or SVG, drawing something that looks ALIVE (axes, gridlines, particles, glowing markers)
• Use KaTeX via CDN if equations are involved
• Use p5.js if simulation-heavy, three.js if 3D
• Animated transitions between steps (fade old instruction out, slide new one in)
• Numeric readouts update live as sliders move
• Hover glow on interactive elements

TECHNICAL:
• Single HTML file, inline <style> and <script>
• pointerdown/move/up for drag (works mouse + touch)
• Works in sandbox="allow-scripts" — no fetch, no localStorage
• On final success: postMessage to parent with result

Return ONLY the complete HTML starting with <!doctype html>. No markdown. No explanation.`;

═══════════════════════════════════════════════════
VISUAL QUALITY REQUIREMENTS — this is the most important section:
═══════════════════════════════════════════════════
The lab must look impressive and modern — like something from 3Blue1Brown, Brilliant.org, or a polished science museum app.

REQUIRED VISUAL STANDARDS:
• Dark space theme: bg #0B1220, stage bg #0E1830, surfaces #131A2A, borders rgba(59,130,246,0.2)
• Glowing accents: primary #3B82F6 (blue glow), copper #D4A574, green #22C55E, muted #8899BB
• Stage must fill the viewport (use 100vw × calc(100vh - header - footer))
• All animations must be smooth (requestAnimationFrame or CSS transitions)
• Use Canvas 2D or SVG for the main visual — draw something that looks ALIVE
• NO plain HTML form elements as the main interaction — sliders must be styled, draggables must look polished
• If math is involved: render equations with KaTeX (via CDN) or draw them on canvas
• If physics: show particles, waves, or objects that actually move
• Glowing highlights on interactive elements on hover
• Grid lines / axes wherever spatial context matters (draw on canvas/SVG)

LAYOUT (strict):
• Header: 60px, dark surface, title (bold white) + 1-line instruction (muted)
• Main stage: flex-1, fills remaining height, position:relative — canvas/SVG goes here
• Controls panel (if sliders): floating glass card top-right, max 220px wide, dark with blur backdrop
• Footer: 56px, dark surface, "Check Answer" (blue pill), "Hint" (ghost), "Reset" (ghost), feedback text right-aligned

INTERACTIVITY RULES:
• Every slider/drag/click must change something VISIBLE on the stage IMMEDIATELY
• Animate transitions (at least 200ms ease)
• Show numeric readouts that update live as sliders move
• Draggable elements snap with a satisfying visual pop (scale briefly to 1.05 then back)
• Correct answer: stage flashes green glow + success message
• Wrong: gentle red pulse, specific hint about what's off

TECHNICAL:
• Single HTML file, inline <style> and <script>
• Use requestAnimationFrame for anything animated
• pointerdown/pointermove/pointerup for drag (works mouse + touch)
• On Check: window.parent.postMessage({type:"labCheck", result:{ok:Boolean, score:Number, total:Number}}, "*")
• Works in sandbox="allow-scripts" — no fetch, no localStorage
• p5.js OK via CDN if simulation-heavy; three.js OK for 3D; KaTeX OK for math

Return ONLY the complete HTML starting with <!doctype html>. No markdown. No explanation.`;

  const msg = await claude.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8000,
    messages: [{ role: "user", content: userPrompt }],
  });

  let html = msg.content[0].text.trim();
  html = html.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return html;
}

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

                                                   if (req.url === "/plan") {
                                                               if (!data.topic?.trim()) {
                                                                             res.writeHead(400, { "Content-Type": "application/json" });
                                                                             res.end(JSON.stringify({ error: "Topic is required" }));
                                                                             return;
                                                               }
                                                               const result = await plan(data.topic.trim());
                                                               res.writeHead(200, { "Content-Type": "application/json" });
                                                               res.end(JSON.stringify(result));

                                                   } else if (req.url === "/plan-lab") {
                                                               // Freeform pipeline: Designer → Coder → full HTML
                                                               if (!data.topic?.trim()) {
                                                                             res.writeHead(400, { "Content-Type": "application/json" });
                                                                             res.end(JSON.stringify({ error: "Topic is required" }));
                                                                             return;
                                                               }
                                                               const design = await designLab(data.topic.trim());
                                                               const html = await codeLab(design);
                                                               res.writeHead(200, { "Content-Type": "application/json" });
                                                               res.end(JSON.stringify({
                                                                   topic: design.topic,
                                                                   scenario: design.scenario,
                                                                   verificationQuestion: design.verificationQuestion,
                                                                   labHtml: html,
                                                                   spec: design.spec,
                                                               }));

                                                   } else if (req.url === "/simulate") {
                                                               // Take an already-planned recipe and return engine HTML
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
                                                           res.writeHead(500, { "Content-Type": "application/json" });
                                                           res.end(JSON.stringify({ error: err.message || "Something went wrong" }));
                                                 }
                                         });
                                         return;
                                   }

                                   res.writeHead(404); res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Repend running at http://localhost:${PORT}`));
