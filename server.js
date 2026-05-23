const http = require("http");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PLAN_SYSTEM = `You are an expert educational experience designer. Given a learning topic, return ONLY valid JSON (no markdown, no explanation):

{
  "topic": "Clean display name for the topic",
  "scenario": "2-3 paragraphs. Immersive real-world scenario framing the concept in a vivid moment. Second person, present tense. Specific and sensory — place the learner inside a moment where this concept is what separates success from failure. No fluff.",
  "simulationType": "One precise sentence: exactly what 3D interactive simulation you will build and why this format makes this specific concept click.",
  "verificationQuestion": "A specific question the learner can only answer by interacting with the simulation. Not a general knowledge question. Requires hands-on discovery."
}`;

const SIM_SYSTEM = `You are a senior Three.js developer building immersive educational 3D simulations. Write a COMPLETE, fully working, self-contained HTML document — no truncation, no placeholders, no TODO comments.

TECHNICAL REQUIREMENTS:
- Import Three.js via ES module: import * as THREE from 'https://cdn.skypack.dev/three@0.128.0'
- Import OrbitControls: import { OrbitControls } from 'https://cdn.skypack.dev/three@0.128.0/examples/jsm/controls/OrbitControls.js'
- <script type="module"> for all JS
- body: background #0B1220; margin: 0; padding: 0; overflow: hidden; font-family: system-ui, sans-serif
- Renderer canvas: 100vw × 100vh, antialias: true, renderer.setPixelRatio(window.devicePixelRatio)
- Window resize handler: renderer.setSize + camera.aspect update + camera.updateProjectionMatrix
- requestAnimationFrame animation loop
- No external images or fonts — all geometry generated in code

UI OVERLAY PANEL (position: fixed, not blocking the 3D view):
- Background: rgba(11,18,32,0.88); border: 1px solid rgba(59,130,246,0.25); border-radius: 12px; backdrop-filter: blur(8px); padding: 16px
- Label text: color #D4A574 (warm copper), font-size: 12px, font-weight: 600, letter-spacing: 0.8px, text-transform: uppercase
- Value readouts: color: #ffffff, font-size: 14px
- Sliders: accent-color #3B82F6
- Buttons: background #3B82F6, color white, border: none, border-radius: 8px, padding: 8px 16px, cursor: pointer
- Panel title: color white, font-size: 15px, font-weight: 700, margin-bottom: 12px

3D SCENE REQUIREMENTS:
- Add ambient light + directional light(s) for good depth
- Use physically meaningful geometry that makes the concept tangible
- Add grid/axes helpers or annotations to give spatial context
- Colors should be vivid but harmonize with the dark #0B1220 background
- Make objects respond to UI controls in real time

Output ONLY the raw HTML document. Nothing else — no preamble, no explanation.`;

const VERIFY_SYSTEM = `You are a learning coach checking a student's answer to a simulation-based question. Be direct and encouraging. Return ONLY valid JSON:
{
  "correct": true or false,
  "feedback": "2-3 sentences. If correct: affirm with precision and add one deeper insight. If wrong: explain what they likely misread and exactly what to look for in the simulation."
}`;

async function plan(topic) {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: PLAN_SYSTEM,
    messages: [{ role: "user", content: `Topic: ${topic}` }],
  });
  const text = msg.content[0].text.trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return JSON.parse(text.slice(first, last + 1));
}

async function simulate(topic, simulationType, scenario) {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: SIM_SYSTEM,
    messages: [{
      role: "user",
      content: `Topic: ${topic}\nSimulation to build: ${simulationType}\nContext: ${scenario.slice(0, 300)}`,
    }],
  });
  let code = msg.content[0].text.trim();
  if (code.startsWith("```")) {
    code = code.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  return code;
}

async function verify(topic, question, simulationType, userAnswer) {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: VERIFY_SYSTEM,
    messages: [{
      role: "user",
      content: `Topic: ${topic}\nSimulation: ${simulationType}\nQuestion: ${question}\nStudent answer: ${userAnswer}`,
    }],
  });
  const text = msg.content[0].text.trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return JSON.parse(text.slice(first, last + 1));
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
          const { topic, simulationType, scenario } = data;
          const html = await simulate(topic, simulationType, scenario);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);

        } else if (req.url === "/verify") {
          const { topic, question, simulationType, userAnswer } = data;
          const result = await verify(topic, question, simulationType, userAnswer);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));

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
