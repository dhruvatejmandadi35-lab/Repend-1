import { Router, type Request, type Response } from "express";
import { generateBlueprint } from "../services/decisionEngine.js";
import { generateLesson } from "../services/lessonGenerator.js";
import { generateQuestion } from "../services/questionGenerator.js";

const router = Router();

function send(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

router.post("/", async (req: Request, res: Response) => {
  const topic = String(req.body?.topic ?? "").trim();
  if (!topic) {
    res.status(400).json({ error: "Missing 'topic' in body" });
    return;
  }
  if (topic.length > 200) {
    res.status(400).json({ error: "Topic too long" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);

  const close = () => {
    clearInterval(heartbeat);
    res.end();
  };

  try {
    send(res, "reasoning", { step: "understanding", label: "Understanding the concept" });

    // Step 1: blueprint (the most expensive call)
    send(res, "reasoning", { step: "selecting", label: "Choosing the best simulation type" });
    const blueprint = await generateBlueprint(topic);
    send(res, "blueprint", blueprint);

    // Step 2: lesson + question in parallel
    send(res, "reasoning", { step: "building", label: "Building your interactive experience" });
    const [lesson, question] = await Promise.all([
      generateLesson(topic, blueprint),
      generateQuestion(topic, blueprint),
    ]);
    send(res, "lesson", lesson);
    send(res, "question", question);

    send(res, "done", { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate] failed:", { topic, message });
    send(res, "error", {
      message: "I'm having trouble building this one. Try a different topic.",
    });
  } finally {
    close();
  }
});

export default router;
