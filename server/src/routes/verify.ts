import { Router, type Request, type Response } from "express";
import { SimulationBlueprintSchema } from "../types.js";
import { verifyAnswer } from "../services/verifier.js";
import { z } from "zod";

const router = Router();

const VerifyBodySchema = z.object({
  topic: z.string().min(1).max(200),
  blueprint: SimulationBlueprintSchema,
  question: z.string().min(1),
  userAnswer: z.string().min(1).max(2000),
});

router.post("/", async (req: Request, res: Response) => {
  const parsed = VerifyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    const result = await verifyAnswer(parsed.data);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[verify] failed:", { topic: parsed.data.topic, message });
    res.status(500).json({
      error: "I'm having trouble evaluating that. Try rephrasing your answer.",
    });
  }
});

export default router;
