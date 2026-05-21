import { callClaudeStructured } from "./claude.js";
import {
  VerificationResultSchema,
  type VerificationResult,
  type SimulationBlueprint,
} from "../types.js";

const VERIFIER_SYSTEM = `You are evaluating whether a learner's free-text answer demonstrates conceptual understanding of a topic after they used an interactive simulation.

Strict rules:
- Judge conceptual correctness, NOT exact wording. If they grasp the mechanism, mark correct.
- If the answer is wrong or superficial, DO NOT give them the answer. Provide a Socratic nudge instead — a specific suggestion of what to try next in the simulation.
- If correct: explanation should affirm clearly and add one sentence of insight that deepens what they noticed.
- Be warm but precise. No emojis. No "great job!" filler.

Output ONLY valid JSON:
{
  "correct": <true | false>,
  "explanation": "<2-4 sentences. If correct, affirm + add insight. If wrong, do NOT reveal answer — give a Socratic nudge pointing to a specific manipulation>"
}

No prose outside the JSON.`;

export async function verifyAnswer(args: {
  topic: string;
  blueprint: SimulationBlueprint;
  question: string;
  userAnswer: string;
}): Promise<VerificationResult> {
  const { topic, blueprint, question, userAnswer } = args;
  const varSummary = blueprint.variables
    .map((v) => `${v.label} (${v.name}): ${v.min}..${v.max} ${v.unit ?? ""}`.trim())
    .join("; ");

  const user = `Topic: ${topic}
Archetype: ${blueprint.archetype}
Variables: ${varSummary}

Verification question they were asked:
"${question}"

Their answer:
"${userAnswer}"

Evaluate.`;

  return await callClaudeStructured({
    system: VERIFIER_SYSTEM,
    user,
    schema: VerificationResultSchema,
    schemaLabel: "VerificationResult",
    maxTokens: 500,
    temperature: 0.4,
  });
}
