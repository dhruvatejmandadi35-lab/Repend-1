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
// FREEFORM LAB PIPELINE — six steps (image step is optional):
//   0. expandTopic        — gpt-4o-mini: sharpens vague input to one specific concept
//   1. thinkAboutTopic    — gpt-4o-mini prose: insight, metaphor, variables + why
//   2. specFromThinking   — gpt-4o JSON: typed spec
//   3. thinkAboutLab      — gpt-4o prose brief: behavior + visuals, no UI words
//   4. mockupImage        — gpt-image-1: clean UI mockup (OPTIONAL, USE_MOCKUP=1)
//   5. codeFromImageBrief — gpt-4o vision: image + brief → final HTML
// ─────────────────────────────────────────────────────────────────

// Step 0 — turns vague topics into one specific, teachable concept.
// "ML" → "Gradient Descent: how a model finds the bottom of a loss landscape"
// "Physics" → "Newton's Second Law: why heavier objects need more force to accelerate"
// "Compound Interest" → passes through unchanged (already specific enough)
async function expandTopic(rawTopic) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You sharpen vague learning topics into one specific, teachable concept.

Return ONLY JSON:
{
  "topic": "The sharpened topic. 3-10 words. Must be a CONCEPT with a surprising insight, not a skill or activity. Examples: 'Topspin: why a spinning tennis ball curves downward faster than gravity', 'Gradient Descent: why loss curves have valleys a model can slide down', 'Newton\\'s Second Law: why doubling mass halves acceleration for the same force'.",
  "why": "One sentence: the specific aha moment this concept produces. E.g. 'The moment you see the ball curve MORE than expected is when you understand that spin changes the effective gravity on the ball.'"
}

RULES:
- If the input names a SPORT or ACTIVITY (tennis, basketball, cooking, driving): find the underlying physics, biology, or math concept that makes that activity surprising. 'Tennis' → 'Topspin: why spin bends a ball's path', not 'racket mechanics'.
- If the input is a broad FIELD (ML, physics, biology, history): pick the sub-concept with the clearest aha moment — the one that feels like a magic trick until you understand it.
- If the input is already a specific CONCEPT (compound interest, Ohm's law, mitosis): return it nearly unchanged.
- NEVER pick a concept where all the learner does is set inputs — the concept must have a SURPRISING OUTPUT that contradicts naive intuition.
- Never return a skill ('how to serve'), a definition ('what topspin is'), or a procedure ('steps to calculate'). Return the INSIGHT.`,
      },
      { role: "user", content: rawTopic },
    ],
  });
  return JSON.parse(res.choices[0].message.content.trim());
}

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

MANDATORY STRUCTURE — the lab must have exactly two zones:
ZONE A (controls): where the learner changes things. Keep this small and to one side.
ZONE B (result): the large central visual that REACTS and shows the OUTCOME. This is where learning happens.
If you only describe Zone A, the lab fails. Zone B is more important than Zone A.

Answer these five questions:

1. ZONE B — THE RESULT VISUAL: What is the large central thing that reacts? Not a control, not a label — the visual outcome. Describe it in motion: what does it look like when the concept is working vs not working? What shape, color, motion shows the insight? For "${design.topic}" specifically, what would make a first-time learner say "oh — THAT's why"?

2. ZONE A — THE CONTROLS: For each variable, what does the learner do to change it, and what in Zone B changes immediately as a result? The connection between Zone A action and Zone B reaction must be instant and obvious. Describe the exact Zone B change for each variable.

3. AHA ENGINEERING — the aha moment is: "${design.spec.aha_trigger}". Describe the 2 seconds before: what the learner naively expects Zone B to do. Then the 2 seconds after: what Zone B actually does that contradicts that expectation. The surprise IS the learning.

4. LIVE READOUTS — what numbers or text update live in Zone B as the learner interacts? Not in Zone A (not the control values) — in Zone B, as a consequence. E.g. for compound interest: "Final balance: $12,847" growing in Zone B. For topspin: "Curve angle: 34°" changing in Zone B. Name the exact readout for this concept.

5. THE FAILURE MODE — what would make this lab useless? E.g. "If the ball just moves right without curving, nothing is learned." Name the specific failure and state what you're doing to prevent it.

Do NOT use any of these words: slider, button, input, form, checkbox, select, drag, drop, node, widget, component, UI. Describe learning experiences and behaviors only.`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  return res.choices[0].message.content.trim();
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
    const res = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1536x1024",
      n: 1,
    });
    const b64 = res.data[0].b64_json;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.warn("mockupImage failed, continuing without:", err.message);
    return null;
  }
}

// Step 5 — gpt-4o (vision-capable) writes the HTML.
// Takes the prose brief (source of truth for behavior) + optional mockup image (look/layout).
async function codeFromImageBrief(design, labThinking, imageDataUrl) {
  const vars = (design.spec.variables || [])
    .map(v => `  • ${v.name} (${v.unit || ""}): ${v.min}–${v.max}, default ${v.default}. ${v.why_it_matters}`)
    .join("\n");

  const briefText = `You are building a self-contained interactive learning lab for Repend.

${imageDataUrl ? `You are given two inputs:
1. A VISUAL MOCKUP (image) — use ONLY for layout, color, spatial arrangement, overall feel.
2. A BEHAVIORAL BRIEF (below) — source of truth for what the lab actually DOES.

RULES OF PRECEDENCE:
- Image and brief conflict → the brief wins, every time.
- The image contains garbled text, fake labels, or nonsensical UI fragments → IGNORE them. Implement real, working controls with real labels derived from the brief. Never reproduce meaningless elements just because they appear in the image.
` : `You are given a behavioral brief below — the source of truth for what the lab does.`}

TOPIC: ${design.topic}
LEARNING GOAL: ${design.spec.learning_goal}
VISUAL METAPHOR: "${design.spec.visualMetaphor}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEHAVIORAL BRIEF (build exactly this behavior):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${labThinking}

VARIABLES THE LEARNER CONTROLS:
${vars}

SUCCESS CONDITION: ${design.spec.success_condition}
REAL-WORLD PAYOFF (show on success): "${design.spec.real_world_payoff || ""}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYOUT — TWO ZONES (non-negotiable):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• ZONE A — controls: compact panel, max 30% of screen, one side or bottom.
• ZONE B — result: large central canvas/SVG, min 60% of screen. THIS is where the concept lives.
• Zone B must react to every Zone A change within 16ms. No submit button. No lag.
• Zone B must have at least one live text readout of the OUTPUT value (not the control value). E.g. "Curve: 34°" not "Angle: 45°". The readout names the concept, not the input.
• Nothing in Zone B is decorative. Every element either reacts to input or displays a result.
• The aha moment from the brief must be visually unmissable in Zone B — a sudden change, a curve bending, a value jumping past a threshold.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TECHNICAL CONSTRAINTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• ONE complete self-contained HTML file. Inline CSS and JS.
• Vanilla JS only. CDN allowlist: KaTeX (equations), p5.js (particles), three.js (3D). No other libs.
• No localStorage / sessionStorage. No fetch().
• Works in sandbox="allow-scripts".
• Zero console errors on first load.
• Responsive: usable from 360px wide to full desktop.
• Dark theme: bg #0B1220, stage #0E1830, panels #131A2A, border rgba(59,130,246,0.2). Accents: blue #3B82F6, copper #D4A574, success #22C55E, muted #8899BB.
• Canvas 2D or SVG for the main visual — make the visual metaphor literal.
• requestAnimationFrame for all motion. pointerdown/move/up for drag.
• On aha moment: golden pulse on the relevant element.
• On success: green stage glow + real_world_payoff card slides in.
• window.parent.postMessage({ type:"labCheck", result:{ ok:true,  score:1, total:1 } }, "*") on success.
• window.parent.postMessage({ type:"labCheck", result:{ ok:false, score:0, total:1 } }, "*") on wrong.

Before returning, verify ALL of these — fix any that fail before responding:
1. Does every visual element teach something when it changes, or is it just decoration? Remove anything decorative.
2. Is there a live text readout showing the actual value of the concept (not just a shape moving)?
3. Can the learner reach the aha moment described in the brief through normal interaction within 30 seconds?
4. Does each variable change produce a visual result that would surprise someone who hasn't studied this topic?
5. ${imageDataUrl ? "Did you ignore garbled text/fake labels from the image and use real labels from the brief?" : "Does the lab teach the specific insight in the learning goal, not just 'explore this topic'?"}

Output only the HTML file. Start with <!doctype html>. No markdown. No explanation. No code fences.`;

  const userContent = imageDataUrl
    ? [
        { type: "image_url", image_url: { url: imageDataUrl } },
        { type: "text", text: briefText },
      ]
    : briefText;

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 8000,
    messages: [{ role: "user", content: userContent }],
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

          const rawTopic = data.topic.trim();

          send("expand", `Sharpening topic…`);
          const expanded = await expandTopic(rawTopic);
          const topic = expanded.topic;
          send("expanded", `Building lab for: ${topic}`, { topic, why: expanded.why });

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
          const html = await codeFromImageBrief(design, labThinking, imageDataUrl);

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
