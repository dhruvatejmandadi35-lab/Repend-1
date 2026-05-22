import { callClaudeStructured } from "./claude.js";
import { LessonSchema, type Lesson, type SimulationBlueprint } from "../types.js";

const LESSON_SYSTEM = `You write 3-4 sentence learning scenarios that frame an abstract concept in a real-world moment.

Rules:
- The reader is about to use an interactive simulation tailored to this concept. End with an invitation to explore.
- Use second person ("you").
- Conversational, not academic. No filler words.
- No emojis, no exclamation marks, no marketing language.
- Be specific: name dollar amounts, distances, times, scenarios — concrete beats abstract.
- The "scenario" is 3-4 sentences setting up a real situation.
- The "invitation" is one sentence pointing at what to manipulate in the simulation.

Output ONLY valid JSON in this shape:
{
  "scenario": "<3-4 sentence scenario in second person>",
  "invitation": "<one sentence inviting them to use the simulation>"
}

No prose outside the JSON. No markdown fences.`;

export async function generateLesson(topic: string, blueprint: SimulationBlueprint): Promise<Lesson> {
  const varList = blueprint.variables.map((v) => `${v.label} (${v.name})`).join(", ");
  const user = `Topic: ${topic}

The user will manipulate these variables in the simulation: ${varList}.

Write the scenario and invitation.`;

  return await callClaudeStructured({
    system: LESSON_SYSTEM,
    user,
    schema: LessonSchema,
    schemaLabel: "Lesson",
    maxTokens: 600,
    temperature: 0.8,
  });
}
