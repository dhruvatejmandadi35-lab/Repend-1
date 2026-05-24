const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// RECIPE SCHEMA — single source of truth for the lab compiler.
// The engine (engine.html) renders whatever the planner produces here.
// ---------------------------------------------------------------------------
const RECIPE_SCHEMA_DOC = `
RECIPE JSON SCHEMA (every lab is one of these — no exceptions):

{
  "topic": "Display name",
  "scenario": "2-3 paragraph immersive second-person scenario placing the learner in a vivid moment where this concept matters.",
  "verificationQuestion": "Specific question the learner can ONLY answer by doing the activity.",
  "recipe": {
    "title": "Lab title shown at top",
    "instructions": "1-2 sentences: what to click/drag and what the goal is.",
    "stage": { "width": 900, "height": 540 },
    "background": {
      "type": "svg",
      "markup": "<!-- raw SVG markup placed behind interactive objects. Use it for connectors, axes, grids, generation labels, anatomical outlines, schematic frames. Style: stroke #93C5FD, fill rgba(147,197,253,0.05), text fill rgba(255,255,255,0.6), font-family: system-ui, sans-serif. NO interactive elements here — those go in objects[]. -->"
    },
    "objects": [
      // pick from these four kinds:

      // 1) NODE — clickable shape that cycles through states. Use for pedigrees,
      //    cell-state toggles, on/off, presence/absence, classification flags.
      { "id": "II-1", "kind": "node", "x": 300, "y": 220,
        "shape": "square" | "circle", "size": 32, "label": "II-1",
        "states": ["unaffected","affected"], "initial": "unaffected",
        "stateStyles": {
          "unaffected": { "fill": "transparent", "stroke": "#ffffff" },
          "affected":   { "fill": "#3B82F6",     "stroke": "#3B82F6" }
        }
      },

      // 2) DRAGGABLE — labeled card the learner drags. Use with TARGETs for
      //    labeling diagrams, sorting into bins, sequencing steps.
      { "id": "lblMitochondria", "kind": "draggable",
        "x": 80, "y": 460, "width": 140, "height": 36,
        "label": "Mitochondria", "color": "#1E3A8A" },

      // 3) TARGET — snap zone for draggables. accepts[] restricts which IDs fit.
      { "id": "zoneMito", "kind": "target",
        "x": 540, "y": 220, "width": 140, "height": 36,
        "label": "Powerhouse organelle",
        "accepts": ["lblMitochondria"] },

      // 4) SLIDER — appears in the right-side controls panel. Optionally
      //    binds to an SVG attribute so dragging it visually changes the stage.
      { "id": "force", "kind": "slider",
        "label": "Applied Force", "unit": "N",
        "min": 0, "max": 50, "step": 1, "initial": 10,
        "bind": { "selector": "#forceArrow", "attr": "x2", "scale": 4, "offset": 200 } },

      // 5) LABEL — static text annotation
      { "id": "genI", "kind": "label", "x": 60, "y": 100,
        "text": "Generation I", "size": 12, "color": "rgba(212,165,116,0.9)" }
    ],
    "winCondition": {
      // pick exactly one:
      //   { "type": "states-match", "target": { "<nodeId>": "<stateName>", ... } }
      //   { "type": "snaps-correct", "target": { "<draggableId>": "<targetId>", ... } }
      //   { "type": "values-equal", "target": { "<sliderId>": 22.5 }, "tolerance": 0.5 }
      "type": "states-match",
      "target": { "II-1": "affected", "II-3": "affected" }
    },
    "hint": "One actionable hint the learner can read if stuck.",
    "successMessage": "Affirmation shown when correct.",
    "insight": "One deeper insight to drop after they get it right."
  }
}

PICKING THE RIGHT PATTERN:
- Pedigrees, family trees, on/off cell states, classification → NODE with click-cycle + states-match
- Anatomy labeling, organelle naming, parts-of-X, sorting items into categories, sequencing steps → DRAGGABLE + TARGET + snaps-correct
- Physics relationships (F=ma, lens equation, half-life decay), tuning to a target value → SLIDER + values-equal (often combined with a background SVG that responds to the bind)

LAYOUT RULES:
- Stage is 900×540. Keep interactive objects in the inner area (margin ~40px).
- Place LEGEND text on the side. Place GENERATION/AXIS labels along the edges.
- For pedigrees: marriage lines horizontal between partners, descent lines vertical down to children, sibling lines horizontal between siblings. Use SVG <line> in background.markup.
- For drag-and-drop: place draggables in a "tray" along the bottom (y ≈ 470), targets on the diagram.

STYLE:
- SVG markup: strokes #93C5FD or #ffffff (alpha ~0.6), no fills on connectors, text fill rgba(255,255,255,0.7), font-size 11-13.
- Node stateStyles: use the design palette (#3B82F6 blue, #F472B6 pink, #22C55E green, transparent + white stroke for empty).

OUTPUT: Return ONLY the top-level JSON object. No markdown fence. No commentary.
`;

const PLAN_SYSTEM = `You are an expert educational lab designer. You compile any learning topic into a single JSON recipe that drives a fixed interactive runtime engine.

${RECIPE_SCHEMA_DOC}

Be specific to the topic. Pick real example values (real names, real organelles, real numbers). The activity should be solvable in 30-90 seconds and force the learner to discover the key insight by interacting.`;

const VERIFY_SYSTEM = `You are a learning coach. The student attempted an interactive lab and may have written a free-text reflection on top. Return ONLY JSON:
{
  "correct": true | false,
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
          // Now: take an already-planned recipe and return engine HTML
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
