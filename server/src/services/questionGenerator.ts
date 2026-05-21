import { callClaudeStructured } from "./claude.js";
import { VerificationQuestionSchema, type VerificationQuestion, type SimulationBlueprint } from "../types.js";

const QUESTION_SYSTEM = `You write ONE verification question for a learner who just used an interactive simulation.

Strict rules:
- The question MUST require the learner to manipulate the simulation to answer. Not a recall question.
- Reference specific values to set on specific variables.
- Ask what they observe AND why it happens (so they connect mechanism to outcome).
- One question only. 2-3 sentences max.
- No multiple choice. Open-ended but with a clear correct answer.
- No emojis.

Output ONLY valid JSON:
{
  "question": "<the question>",
  "hint": "<optional one-sentence hint, may be omitted>"
}

No prose. No fences.`;

export async function generateQuestion(
  topic: string,
  blueprint: SimulationBlueprint
): Promise<VerificationQuestion> {
  const varSummary = blueprint.variables
    .map((v) => `- ${v.label} (${v.name}): range ${v.min}-${v.max} ${v.unit ?? ""}`.trim())
    .join("\n");
  const outSummary = blueprint.outputs.map((o) => `- ${o.label} (${o.name})`).join("\n");

  const user = `Topic: ${topic}
Archetype: ${blueprint.archetype}

Variables they can set:
${varSummary}

Outputs they can observe:
${outSummary}

Write the verification question.`;

  return await callClaudeStructured({
    system: QUESTION_SYSTEM,
    user,
    schema: VerificationQuestionSchema,
    schemaLabel: "VerificationQuestion",
    maxTokens: 400,
    temperature: 0.7,
  });
}
