const http = require("http");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PLAN_SYSTEM = `You are an expert educational experience designer. Given a learning topic, return ONLY valid JSON (no markdown, no explanation):

{
  "topic": "Clean display name for the topic",
  "scenario": "2-3 paragraphs. Immersive real-world scenario framing the concept in a vivid moment. Second person, present tense. Specific and sensory — place the learner inside a moment where this concept is what separates success from failure. No fluff.",
  "activityFormat": "One of: 'pedigree-builder', 'drag-and-drop', 'sort-and-classify', 'click-to-reveal', 'build-a-circuit', 'plot-points', 'sequence-steps', 'simulator-3d', 'fill-the-diagram', 'match-pairs', 'free-canvas'. Pick the format that BEST fits the topic — do not default to 3D.",
  "simulationType": "One precise sentence describing the exact interactive activity you will build. Specify what the learner clicks, drags, toggles, builds, or arranges, and what visual feedback they get.",
  "verificationQuestion": "A specific question the learner can only answer by interacting with the activity. Not a general knowledge question. Requires hands-on discovery."
}

CRITICAL: Choose dimensionality honestly.
- Pedigrees, family trees, flowcharts, graphs, sorting, matching, circuits, plots → 2D
- Molecules, planets, physics in 3-space, anatomy, architecture → 3D
Do not force 3D on a 2D concept.`;

const SIM_SYSTEM = `You are a senior interactive educational developer in the style of PBS Kids Labs, Phet, and Khan Academy. You build polished, FOCUSED, hands-on activities — not 3D worlds. Write a COMPLETE, fully working, self-contained HTML document — no truncation, no placeholders, no TODO comments.

CORE PRINCIPLE: This is an ACTIVITY, not a visualization. The learner must DO something — click, drag, toggle, build, arrange, sequence — and the activity must respond with clear visual feedback. Every element on screen should be either interactive or directly informing an interaction.

CHOOSE THE RIGHT RENDER STACK PER FORMAT:
- 2D activities (pedigree-builder, drag-and-drop, sort-and-classify, plot-points, fill-the-diagram, match-pairs, sequence-steps, build-a-circuit, free-canvas): use SVG or HTML5 Canvas. Do NOT use Three.js for 2D.
- 3D activities only (simulator-3d): use Three.js via ES module: import * as THREE from 'https://cdn.skypack.dev/three@0.128.0' and OrbitControls from 'https://cdn.skypack.dev/three@0.128.0/examples/jsm/controls/OrbitControls.js'

LAYOUT:
- body: background #0B1220; margin: 0; padding: 0; font-family: system-ui, sans-serif; color: white; overflow: hidden
- For 2D: center the activity stage; use viewport sizing with a window resize handler
- For 3D: 100vw × 100vh canvas, antialias true, devicePixelRatio set, resize handler

UI PANEL (position: fixed, not blocking the activity):
- Background: rgba(11,18,32,0.88); border: 1px solid rgba(59,130,246,0.25); border-radius: 12px; backdrop-filter: blur(8px); padding: 16px
- Title: white, 15px, 700, margin-bottom 12px
- Labels: #D4A574 (warm copper), 12px, 600, uppercase, letter-spacing 0.8px
- Values: white, 14px
- Buttons: background #3B82F6, white, no border, border-radius 8px, padding 8px 16px, cursor pointer
- Sliders: accent-color #3B82F6

ACTIVITY DESIGN PATTERNS (use one that fits):

PEDIGREE-BUILDER:
- Show a family tree skeleton with squares (males) and circles (females) connected by horizontal marriage lines and vertical descent lines
- Each shape is CLICKABLE — toggles between unaffected (outline) and affected (filled)
- Show a legend, a generation label (I, II, III), and a live readout of inheritance pattern hypothesis ("Likely autosomal recessive" etc.)
- Include a goal: e.g., "Click affected individuals to match the case description, then identify the pattern"

DRAG-AND-DROP:
- Draggable labeled tokens that snap to target zones with feedback (green flash correct, red shake wrong)

SORT-AND-CLASSIFY:
- Items the user drags into bins/categories with running score

BUILD-A-CIRCUIT / FILL-THE-DIAGRAM:
- Click endpoints to draw connections; valid connections light up; invalid ones flash red

PLOT-POINTS / FREE-CANVAS:
- Click on a grid to place points; live curve fit or visual relationship updates

SEQUENCE-STEPS:
- Drag step cards into the correct order; reveal animation plays when correct

SIMULATOR-3D:
- Sliders/buttons drive a meaningful 3D scene (orbits, forces, molecules) — only when 3D actually clarifies the concept

UNIVERSAL REQUIREMENTS:
- Always include an instruction strip at the top ("Click each individual to mark affected. Goal: match the case.")
- Always include live feedback that responds to user actions
- Always include a "Reset" button
- Make it feel like a polished educational lab, not a tech demo

Output ONLY the raw HTML document. Nothing else — no preamble, no explanation.`;

const VERIFY_SYSTEM = `You are a learning coach checking a student's answer to a simulation-based question. Be direct and encouraging. Return ONLY valid JSON:
{
  "correct": true or false,
  "feedback": "2-3 sentences. If correct: affirm with precision and add one deeper insight. If wrong: explain what they likely misread and exactly what to look for in the simulation."
}`;

async function plan(topic) {
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: `Topic: ${topic}` },
    ],
  });
  const text = res.choices[0].message.content.trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return JSON.parse(text.slice(first, last + 1));
}

async function simulate(topic, simulationType, scenario, activityFormat) {
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 8192,
    messages: [
      { role: "system", content: SIM_SYSTEM },
      { role: "user", content: `Topic: ${topic}\nActivity format: ${activityFormat || "auto"}\nActivity to build: ${simulationType}\nContext: ${scenario.slice(0, 300)}` },
    ],
  });
  let code = res.choices[0].message.content.trim();
  if (code.startsWith("```")) {
    code = code.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  return code;
}

async function verify(topic, question, simulationType, userAnswer) {
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 512,
    messages: [
      { role: "system", content: VERIFY_SYSTEM },
      { role: "user", content: `Topic: ${topic}\nSimulation: ${simulationType}\nQuestion: ${question}\nStudent answer: ${userAnswer}` },
    ],
  });
  const text = res.choices[0].message.content.trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return JSON.parse(text.slice(first, last + 1));
}

async function analyzeImage(base64Image, question) {
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 512,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
        { type: "text", text: question || "Describe what you see in this image in the context of the educational activity." },
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
          const { topic, simulationType, scenario, activityFormat } = data;
          const html = await simulate(topic, simulationType, scenario, activityFormat);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);

        } else if (req.url === "/verify") {
          const { topic, question, simulationType, userAnswer } = data;
          const result = await verify(topic, question, simulationType, userAnswer);
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
