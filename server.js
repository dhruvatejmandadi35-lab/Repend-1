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
    "scenario": "2-3 paragraph immersive second-person scenario placing the learner in a vivid moment where this concept matters.",
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
                                                                                                                                                        PATTERN SELECTION:
                                                                                                                                                        ────────────────────────────────────────────────
                                                                                                                                                        - Pedigrees, family trees, cell state toggles, classification → NODE + states-match
                                                                                                                                                        - Anatomy labeling, organelle naming, sorting, sequencing → DRAGGABLE + TARGET + snaps-correct
                                                                                                                                                        - Physics equations (F=ma, lens, half-life, circuits) → SLIDER + values-equal + SVG background
                                                                                                                                                        
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Repend running at http://localhost:${PORT}`));
