const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VERIFY_SYSTEM = `You are a learning coach. The student attempted an interactive lab and wrote a short reflection. Return ONLY JSON:
{
  "correct": true | false,
  "feedback": "2-3 sentences. If correct: affirm with precision and one deeper insight. If wrong: name the specific misread and what to look for next."
}`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  try {
    const { topic, question, recipeSummary, userAnswer, labResult } = JSON.parse(event.body || "{}");
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
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
    const parsed = JSON.parse(res.choices[0].message.content.trim());
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
      body: JSON.stringify({ error: err.message || "Verify failed" }),
    };
  }
};
