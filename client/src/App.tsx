import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import TopicInput from "./components/TopicInput";
import LoadingState from "./components/LoadingState";
import LessonView from "./components/LessonView";
import SimulationRunner from "./components/SimulationRunner";
import VerificationStep from "./components/VerificationStep";
import { streamGenerate, verifyAnswer } from "./lib/api";
import type {
  Lesson,
  LoopPhase,
  ReasoningEvent,
  ReasoningStep,
  SimulationBlueprint,
  VerificationQuestion,
  VerificationResult,
} from "./lib/types";

const REASONING_LABELS: Record<ReasoningStep, string> = {
  understanding: "Understanding the concept",
  selecting: "Choosing the best simulation type",
  building: "Building your interactive experience",
};

export default function App() {
  const [phase, setPhase] = useState<LoopPhase>("idle");
  const [topic, setTopic] = useState("");
  const [reasoning, setReasoning] = useState<{ done: ReasoningStep[]; active: ReasoningStep | null }>(
    { done: [], active: null }
  );
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [blueprint, setBlueprint] = useState<SimulationBlueprint | null>(null);
  const [question, setQuestion] = useState<VerificationQuestion | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  const reset = useCallback(() => {
    setPhase("idle");
    setTopic("");
    setReasoning({ done: [], active: null });
    setLesson(null);
    setBlueprint(null);
    setQuestion(null);
    setErrorMsg(null);
    setVerificationResult(null);
    setVerifying(false);
  }, []);

  const handleSubmit = useCallback(async (topicText: string) => {
    setTopic(topicText);
    setPhase("reasoning");
    setReasoning({ done: [], active: null });
    setLesson(null);
    setBlueprint(null);
    setQuestion(null);
    setErrorMsg(null);
    setVerificationResult(null);

    await streamGenerate(topicText, {
      onReasoning: (e: ReasoningEvent) => {
        setReasoning((prev) => {
          const newDone = prev.active && prev.active !== e.step ? [...prev.done, prev.active] : prev.done;
          return { done: newDone, active: e.step };
        });
      },
      onBlueprint: (b) => {
        setBlueprint(b);
      },
      onLesson: (l) => {
        setLesson(l);
        setReasoning((prev) =>
          prev.active ? { done: [...prev.done, prev.active], active: null } : prev
        );
        setPhase("lesson");
      },
      onQuestion: (q) => {
        setQuestion(q);
      },
      onError: (m) => {
        setErrorMsg(m);
        setPhase("error");
      },
      onDone: () => {
        // ensure phase advances even if events arrived out of order
        setPhase((prev) => (prev === "reasoning" ? "lesson" : prev));
      },
    });
  }, []);

  const handleVerify = useCallback(
    async (userAnswer: string) => {
      if (!blueprint || !question) return;
      setVerifying(true);
      try {
        const result = await verifyAnswer({
          topic,
          blueprint,
          question: question.question,
          userAnswer,
        });
        setVerificationResult(result);
        if (result.correct) {
          setPhase("complete");
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setVerifying(false);
      }
    },
    [blueprint, question, topic]
  );

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 sm:px-10 pt-6">
        <button
          onClick={reset}
          className="flex items-center gap-2 group"
          aria-label="Reset Repend"
        >
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-glow">
            <Sparkles size={16} className="text-white" />
          </div>
          <div className="font-display text-xl font-semibold tracking-tight">
            Repend
          </div>
        </button>
      </header>

      <main className="flex-1 px-6 sm:px-10 pb-16 pt-6 sm:pt-10">
        <div className="max-w-4xl mx-auto">
          <AnimatePresence mode="wait">
            {phase === "idle" && (
              <motion.div
                key="idle"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8, scale: 0.99 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              >
                <TopicInput onSubmit={handleSubmit} />
              </motion.div>
            )}

            {phase === "reasoning" && (
              <motion.div
                key="reasoning"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              >
                <LoadingState
                  topic={topic}
                  active={reasoning.active}
                  done={reasoning.done}
                  labels={REASONING_LABELS}
                />
              </motion.div>
            )}

            {(phase === "lesson" || phase === "verification" || phase === "complete") && lesson && blueprint && (
              <motion.div
                key="experience"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                className="space-y-8"
              >
                <LessonView topic={topic} lesson={lesson} blueprint={blueprint} />
                <SimulationRunner blueprint={blueprint} />
                {question && (
                  <VerificationStep
                    question={question}
                    verifying={verifying}
                    result={verificationResult}
                    onSubmit={handleVerify}
                    onReset={reset}
                  />
                )}
              </motion.div>
            )}

            {phase === "error" && (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="glass p-8 text-center max-w-md mx-auto mt-20"
              >
                <p className="text-text mb-2 font-display text-xl">Something went sideways.</p>
                <p className="text-muted text-sm mb-6">
                  {errorMsg ?? "I'm having trouble building this one. Try a different topic."}
                </p>
                <button className="btn-ghost" onClick={reset}>
                  Try again
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <footer className="px-6 sm:px-10 py-6 text-center text-xs text-muted font-mono">
        Rep up. End with clarity.
      </footer>
    </div>
  );
}
