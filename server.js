const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    const res = await client.chat.completions.create({
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
    const res = await client.chat.completions.create({
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
    const res = await client.chat.completions.create({
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
