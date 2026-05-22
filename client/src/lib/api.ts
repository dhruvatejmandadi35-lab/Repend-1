import type {
  Lesson,
  ReasoningEvent,
  SimulationBlueprint,
  VerificationQuestion,
  VerificationResult,
} from "./types";

export interface GenerateHandlers {
  onReasoning: (e: ReasoningEvent) => void;
  onBlueprint: (b: SimulationBlueprint) => void;
  onLesson: (l: Lesson) => void;
  onQuestion: (q: VerificationQuestion) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

export async function streamGenerate(topic: string, handlers: GenerateHandlers): Promise<void> {
  const resp = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic }),
  });

  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => "");
    handlers.onError(`Server returned ${resp.status}: ${txt || "no body"}`);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        const lines = rawEvent.split("\n");
        let eventName = "message";
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith(":")) continue; // comment / heartbeat
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }

        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join("\n");

        let data: unknown;
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }

        switch (eventName) {
          case "reasoning":
            handlers.onReasoning(data as ReasoningEvent);
            break;
          case "blueprint":
            handlers.onBlueprint(data as SimulationBlueprint);
            break;
          case "lesson":
            handlers.onLesson(data as Lesson);
            break;
          case "question":
            handlers.onQuestion(data as VerificationQuestion);
            break;
          case "error":
            handlers.onError((data as { message: string }).message);
            break;
          case "done":
            handlers.onDone();
            return;
        }
      }
    }
  } catch (err) {
    handlers.onError(err instanceof Error ? err.message : String(err));
  }
}

export async function verifyAnswer(args: {
  topic: string;
  blueprint: SimulationBlueprint;
  question: string;
  userAnswer: string;
}): Promise<VerificationResult> {
  const resp = await fetch("/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Verify failed with status ${resp.status}`);
  }
  return (await resp.json()) as VerificationResult;
}
