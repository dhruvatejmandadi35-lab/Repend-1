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
// FREEFORM LAB PIPELINE
// Three separate steps so each one can think without format pressure:
//   1. thinkAboutTopic   — free prose reasoning, NO format constraints, NO archetype menu
//   2. specFromThinking  — convert reasoning to structured JSON spec
//   3. codeLab           — Claude writes the full interactive HTML
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
        content: `You convert educational reasoning into an interactive lab spec. Read the reasoning and produce JSON for a self-contained interactive HTML lab. The lab should make the visual metaphor from the reasoning come alive.

Return ONLY JSON with this exact shape:
{
  "topic": "Display name for the topic",
  "scenario": "2-3 paragraph immersive 2nd-person scenario. Open with a CONCRETE real-world moment: a real role, place, dollar amount, failure mode. Name it specifically. End by telling the learner exactly what they are about to manipulate and why it matters right now.",
  "verificationQuestion": "One specific question the learner can only answer correctly AFTER interacting with the lab.",
  "spec": {
    "title": "Short punchy lab title",
    "learning_goal": "One sentence using the exact words of the core insight from the reasoning.",
    "visual_metaphor": "Copy the visual metaphor from the reasoning verbatim. This is what the lab must look like.",
    "variables": [
      { "name": "variable name", "unit": "unit", "min": 0, "max": 100, "default": 10, "why": "why this variable matters to the insight" }
    ],
    "stage_description": "Detailed paragraph: what the stage looks like, what is drawn on it, what moves, what colors. Describe from top to bottom. Reference the visual metaphor. Be specific about positions, sizes, what animates.",
    "interaction_description": "What the learner does step by step. What they touch first. What happens visually when they move each control. What the aha moment looks like on screen.",
    "aha_trigger": "The exact screen event that creates the aha moment. E.g. 'When the learner pushes rate past 8%, the bar's growth visibly accelerates — the new amount added each year is larger than the previous year's total, which the bar makes visible by growing faster than linear.'",
    "success_condition": "Exact programmatic rule. E.g. 'balance >= 10000 with principal=1000 and rate and years set by learner'",
    "real_world_payoff": "The real-world cost sentence from the reasoning, rewritten as a direct consequence the learner now understands."
  }
}

Use the metaphors, variables, and aha moment from the reasoning directly. Do NOT add new interaction categories or format labels.`,
      },
      {
        role: "user",
        content: `Topic: ${topic}\n\nReasoning:\n${thinking}\n\nNow produce the spec JSON.`,
      },
    ],
  });
  return JSON.parse(res.choices[0].message.content.trim());
}

async function codeLab(design) {
  const vars = (design.spec.variables || [])
    .map(v => `  • ${v.name} (${v.unit || ""}): range ${v.min}–${v.max}, default ${v.default}. WHY IT MATTERS: ${v.why}`)
    .join("\n");

  const prompt = `Build a world-class interactive educational lab as a single self-contained HTML file.

TOPIC: ${design.topic}
LEARNING GOAL: ${design.spec.learning_goal}

THE VISUAL METAPHOR — this is what the lab must look like in motion:
"${design.spec.visual_metaphor}"

WHAT THE STAGE LOOKS LIKE:
${design.spec.stage_description}

VARIABLES THE LEARNER CONTROLS:
${vars}

WHAT THE LEARNER DOES:
${design.spec.interaction_description}

THE AHA MOMENT — design the lab so this exact thing happens:
${design.spec.aha_trigger}

SUCCESS CONDITION: ${design.spec.success_condition}
REAL-WORLD PAYOFF (show at success): "${design.spec.real_world_payoff || ""}"

═══════════════════════════════════════════════════
BUILD REQUIREMENTS:
═══════════════════════════════════════════════════

VISUAL QUALITY — this must look like Brilliant.org or 3Blue1Brown:
• Dark theme: body bg #0B1220, stage bg #0E1830, panels #131A2A, borders rgba(59,130,246,0.2)
• Glowing accents: primary #3B82F6 (with box-shadow glow), copper #D4A574, success #22C55E, muted #8899BB
• Stage: Canvas 2D or SVG. Draw the visual metaphor. Make it look ALIVE — it should move and respond
• Axes and gridlines wherever spatial context matters (faint, rgba white/blue)
• Sliders: styled custom (no browser default), with live numeric readouts next to them
• Draggables: polished cards with subtle shadow, snap with a scale(1.05) pop animation
• Hover glow on every interactive element

LAYOUT:
• Header bar (56px): topic title bold left, learning goal muted right
• Main stage: fills remaining viewport height, Canvas or SVG
• Controls: floating glass card (backdrop-filter: blur), positioned so it doesn't cover the main visual
• Footer (48px): "Check Answer" blue pill + "Reset" ghost button + feedback text

INTERACTIVITY:
• Every variable change must update the visual IMMEDIATELY (no lag)
• Animate with requestAnimationFrame — smooth, continuous
• When the aha moment condition is met: briefly pulse the relevant visual element with a golden glow
• On success: green glow across stage, confetti burst, show real_world_payoff in a card
• On wrong answer: gentle red pulse, show a specific hint

TECHNICAL:
• Single HTML file — inline <style> and <script>, no external files except CDN libs
• pointerdown/pointermove/pointerup for all drag interactions
• Works in sandbox="allow-scripts" — no fetch(), no localStorage
• KaTeX CDN if equations needed, p5.js CDN if particle simulation, three.js CDN if 3D
• On final success: window.parent.postMessage({ type: "labCheck", result: { ok: true, score: 1, total: 1 } }, "*")
• On wrong check: window.parent.postMessage({ type: "labCheck", result: { ok: false, score: 0, total: 1 } }, "*")

Return ONLY the complete HTML starting with <!doctype html>. No markdown. No explanation. No code fences.`;

  const msg = await claude.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });

  // Find the text block (thinking blocks come first)
  const textBlock = msg.content.find(b => b.type === "text");
  let html = (textBlock ? textBlock.text : msg.content[0].text).trim();
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

          send("code", "Claude is coding your lab from scratch…");
          const html = await codeLab(design);

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
