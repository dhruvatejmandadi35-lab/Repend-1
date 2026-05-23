const http = require("http");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an expert curriculum designer. When given a topic, generate a structured course in valid JSON only — no markdown, no explanation, just the JSON object.

The JSON must follow this exact shape:
{
  "title": "Course title",
  "description": "2–3 sentence course overview",
  "level": "Beginner | Intermediate | Advanced",
  "duration": "e.g. 4 weeks",
  "modules": [
    {
      "title": "Module title",
      "summary": "One sentence summary",
      "lessons": [
        {
          "title": "Lesson title",
          "content": "3–5 sentences of lesson content explaining the concept clearly"
        }
      ]
    }
  ]
}

Generate 4–5 modules, each with 3–4 lessons. Make the content genuinely educational.`;

function extractJson(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

async function generateCourse(topic) {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{ role: "user", content: `Generate a complete course on: ${topic}` }],
    system: SYSTEM_PROMPT,
  });

  return extractJson(message.content[0].text);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && req.url === "/generate") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { topic } = JSON.parse(body);
        if (!topic || !topic.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Topic is required" }));
          return;
        }
        const course = await generateCourse(topic.trim());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(course));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to generate course. Please try again." }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Repend running at http://localhost:${PORT}`));
