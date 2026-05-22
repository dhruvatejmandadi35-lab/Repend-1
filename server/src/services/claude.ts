import Anthropic from "@anthropic-ai/sdk";
import { z, ZodSchema } from "zod";

const MODEL = "claude-opus-4-7";
const MAX_RETRIES = 3;
const TIMEOUT_MS = 60_000;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    client = new Anthropic({ apiKey, timeout: TIMEOUT_MS });
  }
  return client;
}

export interface ClaudeCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

async function callOnce(opts: ClaudeCallOptions): Promise<string> {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return text;
}

export async function callClaude(opts: ClaudeCallOptions): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await callOnce(opts);
    } catch (err) {
      lastErr = err;
      const delay = 500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const trimmed = (raw ?? "").trim();
  // Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Find first { and last }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("No JSON object found in response");
  }
}

export interface StructuredCallOptions<T> extends ClaudeCallOptions {
  schema: ZodSchema<T>;
  schemaLabel: string;
}

export async function callClaudeStructured<T>(opts: StructuredCallOptions<T>): Promise<T> {
  const baseUser = opts.user;
  let userPrompt = baseUser;
  let validationAttempts = 0;
  let lastError = "";

  while (validationAttempts < 2) {
    const text = await callClaude({
      ...opts,
      user: userPrompt,
    });

    try {
      const json = extractJson(text);
      return opts.schema.parse(json);
    } catch (err) {
      validationAttempts++;
      if (err instanceof z.ZodError) {
        lastError = err.errors
          .map((e) => `- at ${e.path.join(".") || "(root)"}: ${e.message}`)
          .join("\n");
      } else {
        lastError = err instanceof Error ? err.message : String(err);
      }
      userPrompt = `${baseUser}\n\nYour previous response could not be parsed as valid ${opts.schemaLabel}. Errors:\n${lastError}\n\nReturn ONLY valid JSON matching the schema. No prose, no markdown fences.`;
    }
  }

  throw new Error(`Claude failed to produce valid ${opts.schemaLabel}: ${lastError}`);
}
