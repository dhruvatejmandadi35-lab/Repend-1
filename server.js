const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
// FREEFORM LAB PIPELINE — four steps, each focused on one job:
//   1. thinkAboutTopic  — GPT-4o-mini prose: core insight, visual metaphor, variables + why
//   2. specFromThinking — GPT-4o JSON: formalises the prose into a typed spec
//   3. thinkAboutLab    — claude-opus-4-7 prose: reasons freely about HOW to build it
//                         (no lab-type labels — describes experience, not UI components)
//   4. codeFromSpec     — claude-sonnet-4-6 HTML: implements exactly what step 3 described
// ─────────────────────────────────────────────────────────────────

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
    max_tokens: 1200,
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
        "why_it_matters": "REQUIRED — one sentence explaining why THIS variable matters to the core insight. Not what it is — why changing it reveals something. E.g. 'Rate matters because doubling it doesn\\'t double the outcome — it compounds, so small rate differences explode over time.'"
      }
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
- do NOT include interaction_type, lab_type, or any format label anywhere in the JSON`,
      },
      {
        role: "user",
        content: `Topic: ${topic}\n\nReasoning:\n${thinking}\n\nNow produce the spec JSON.`,
      },
    ],
  });
  return JSON.parse(res.choices[0].message.content.trim());
}

// Step 3 — claude-opus-4-7 reasons freely about HOW to build the lab.
// No lab-type labels, no UI component names. Pure experience + implementation thinking.
async function thinkAboutLab(design) {
  const vars = (design.spec.variables || [])
    .map(v => `  • ${v.name} (${v.unit || ""}), range ${v.min}–${v.max}: ${v.why_it_matters}`)
    .join("\n");

  const prompt = `You are thinking through how to build a specific interactive learning experience as a self-contained HTML page. All the educational reasoning has been done — your job is to reason about the IMPLEMENTATION: what to draw, what to animate, how to make the aha moment unmissable.

TOPIC: ${design.topic}
LEARNING GOAL: ${design.spec.learning_goal}

VISUAL METAPHOR — this is what it should feel like:
"${design.spec.visualMetaphor}"

VARIABLES AND WHY EACH ONE MATTERS TO THE CONCEPT:
${vars}

AHA MOMENT TO ENGINEER:
${design.spec.aha_trigger}

Reason through these five questions. Write in plain prose — no JSON, no lists, no headers:

1. FIRST FRAME — what does the canvas show the instant it loads, before the learner touches anything? Describe every visual element: shapes, colors, positions, what's already moving.

2. VISUAL MECHANICS — for each variable, describe the exact visual change when it moves. Go beyond "a bar grows" — describe the specific geometry and motion that makes the metaphor real. What does the metaphor look like at the minimum value vs the maximum?

3. AHA ENGINEERING — the aha moment is: "${design.spec.aha_trigger}". How do you make this unmissable? What visual event marks the threshold? Describe what the learner sees in the 2 seconds before and the 2 seconds after.

4. MOTION — what is always in motion, even when the learner isn't interacting? What transitions happen on interaction?

5. UNIQUENESS — what single visual or interaction choice makes this feel like THIS concept and not a generic chart or form?

Do NOT use any of these words: slider, button, input, form, checkbox, select, drag, drop, node, widget, component, UI. Describe experiences and behaviors only.`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  return res.choices[0].message.content.trim();
}

// Step 4 — GPT-4.5 implements the HTML.
// The hard reasoning is done — this step just executes it.
async function codeFromSpec(design, labThinking) {
  const vars = (design.spec.variables || [])
    .map(v => `  • ${v.name} (${v.unit || ""}): ${v.min}–${v.max}, default ${v.default}. ${v.why_it_matters}`)
    .join("\n");

  const prompt = `Build a self-contained interactive educational HTML page. The design thinking is already done — implement it exactly.

TOPIC: ${design.topic}
LEARNING GOAL: ${design.spec.learning_goal}
VISUAL METAPHOR: "${design.spec.visualMetaphor}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPLEMENTATION BRIEF (build exactly this):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${labThinking}

VARIABLES:
${vars}

SUCCESS CONDITION: ${design.spec.success_condition}
REAL-WORLD PAYOFF (show at end): "${design.spec.real_world_payoff || ""}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TECHNICAL REQUIREMENTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Single HTML file — inline <style> and <script> only
• Dark theme: bg #0B1220, stage #0E1830, panels #131A2A, border rgba(59,130,246,0.2)
• Glowing accents: blue #3B82F6, copper #D4A574, success #22C55E, muted #8899BB
• Canvas 2D or SVG for the main visual — make the visual metaphor literal
• requestAnimationFrame for all animation
• pointerdown/pointermove/pointerup for any drag interactions
• Works in sandbox="allow-scripts" — no fetch(), no localStorage
• Controls: styled, not browser-default — live numeric readouts update as values change
• When aha moment fires: golden pulse on the relevant element
• On success: green stage glow + confetti + real_world_payoff card slides in
• KaTeX via CDN if equations, p5.js via CDN if particles, three.js via CDN if 3D
• window.parent.postMessage({ type:"labCheck", result:{ ok:true,  score:1, total:1 } }, "*") on success
• window.parent.postMessage({ type:"labCheck", result:{ ok:false, score:0, total:1 } }, "*") on wrong

Return ONLY the complete HTML starting with <!doctype html>. No markdown. No explanation. No code fences.`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
  });

  let html = res.choices[0].message.content.trim();
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

          const topic = data.topic.trim();

          send("think", `Reasoning about "${topic}"…`);
          const thinking = await thinkAboutTopic(topic);

          send("design", "Translating insight into lab spec…");
          const design = await specFromThinking(topic, thinking);

          send("labthink", "Claude is thinking about how to build it…");
          const labThinking = await thinkAboutLab(design);

          send("code", "Writing your lab…");
          const html = await codeFromSpec(design, labThinking);

          send("done", "Lab ready.", {
            topic: design.topic,
            scenario: design.scenario,
            verificationQuestion: design.verificationQuestion,
            learningGoal: design.spec.learning_goal,
            realWorldPayoff: design.spec.real_world_payoff,
            labHtml: html,
          });

          res.end();

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
