const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
      "markup": "<!-- raw SVG: connectors, axes, grids, generation labels, anatomical outlines. Strokes #93C5FD or #ffffff (alpha ~0.6), text fill rgba(255,255,255,0.7), font-size 11-13. NO interactive elements here. -->"
    },
    "objects": [
      // 1) NODE — clickable shape that cycles through states (pedigrees, classification)
      { "id": "II-1", "kind": "node", "x": 300, "y": 220,
        "shape": "square" | "circle", "size": 32, "label": "II-1",
        "states": ["unaffected","affected"], "initial": "unaffected",
        "stateStyles": {
          "unaffected": { "fill": "transparent", "stroke": "#ffffff" },
          "affected":   { "fill": "#3B82F6",     "stroke": "#3B82F6" }
        }
      },
      // 2) DRAGGABLE — labeled card the learner drags (labeling, sorting, sequencing)
      { "id": "lblMito", "kind": "draggable",
        "x": 80, "y": 460, "width": 140, "height": 36,
        "label": "Mitochondria", "color": "#1E3A8A" },
      // 3) TARGET — snap zone for draggables
      { "id": "zoneMito", "kind": "target",
        "x": 540, "y": 220, "width": 140, "height": 36,
        "label": "Powerhouse organelle", "accepts": ["lblMito"] },
      // 4) SLIDER — appears in right-side controls panel
      { "id": "force", "kind": "slider",
        "label": "Applied Force", "unit": "N",
        "min": 0, "max": 50, "step": 1, "initial": 10,
        "bind": { "selector": "#forceArrow", "attr": "x2", "scale": 4, "offset": 200 } },
      // 5) LABEL — static text
      { "id": "genI", "kind": "label", "x": 60, "y": 100,
        "text": "Generation I", "size": 12, "color": "rgba(212,165,116,0.9)" }
    ],
    "winCondition": {
      //   { "type": "states-match", "target": { "<nodeId>": "<stateName>", ... } }
      //   { "type": "snaps-correct", "target": { "<draggableId>": "<targetId>", ... } }
      //   { "type": "values-equal", "target": { "<sliderId>": 22.5 }, "tolerance": 0.5 }
      "type": "states-match",
      "target": { "II-1": "affected", "II-3": "affected" }
    },
    "hint": "One actionable hint if stuck.",
    "successMessage": "Affirmation shown when correct.",
    "insight": "One deeper insight to drop after they get it right."
  }
}

PICK THE RIGHT PATTERN:
- Pedigrees, family trees, on/off states, classification → NODE + states-match
- Anatomy labeling, sorting into bins, sequencing steps → DRAGGABLE + TARGET + snaps-correct
- Physics relationships, tuning to a target value → SLIDER + values-equal

LAYOUT:
- Stage is 900x540. Inner margin ~40px.
- Pedigrees: marriage lines horizontal between partners, descent lines vertical down to children, sibling lines horizontal. Use SVG <line> in background.markup.
- Drag-and-drop: draggables in a tray along bottom (y ~470), targets on diagram.

OUTPUT: Return ONLY the top-level JSON object. No markdown fence. No commentary.
`;

const PLAN_SYSTEM = `You are an expert educational lab designer. You compile any learning topic into a single JSON recipe that drives a fixed interactive runtime engine.

${RECIPE_SCHEMA_DOC}

Be specific to the topic. Pick real example values (real names, real organelles, real numbers). The activity should be solvable in 30-90 seconds and force the learner to discover the key insight by interacting.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  try {
    const data = JSON.parse(event.body || "{}");
    if (!data.topic || !data.topic.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: "Topic is required" }) };
    }
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PLAN_SYSTEM },
        { role: "user", content: `Topic: ${data.topic.trim()}\n\nProduce the complete recipe JSON.` },
      ],
    });
    const text = res.choices[0].message.content.trim();
    const parsed = JSON.parse(text);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Plan failed" }),
    };
  }
};
