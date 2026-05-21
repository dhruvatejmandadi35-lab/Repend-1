import { useState, FormEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, RefreshCcw, Send, Sparkles } from "lucide-react";
import type { VerificationQuestion, VerificationResult } from "../lib/types";

interface Props {
  question: VerificationQuestion;
  verifying: boolean;
  result: VerificationResult | null;
  onSubmit: (userAnswer: string) => void;
  onReset: () => void;
}

export default function VerificationStep({ question, verifying, result, onSubmit, onReset }: Props) {
  const [answer, setAnswer] = useState("");

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = answer.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  const isCorrect = result?.correct === true;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.3, ease: "easeOut" }}
      className="glass p-5 sm:p-6"
    >
      <div className="flex items-start gap-3 mb-4">
        <div className="w-8 h-8 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center shrink-0 mt-0.5">
          <Sparkles size={14} className="text-accent" />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-widest text-muted/70 font-mono mb-1">
            Verify your understanding
          </p>
          <p className="text-text leading-relaxed">{question.question}</p>
          {question.hint && !result && (
            <p className="text-xs text-muted/70 mt-2 italic">Hint: {question.hint}</p>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Type your answer after playing with the simulation..."
          rows={3}
          disabled={verifying || isCorrect}
          className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-4 py-3 text-text placeholder:text-muted/60 outline-none focus:border-primary/40 transition-colors resize-none disabled:opacity-60"
        />

        <div className="flex items-center gap-3 flex-wrap">
          {!isCorrect && (
            <button
              type="submit"
              disabled={!answer.trim() || verifying}
              className="btn-primary"
            >
              {verifying ? (
                <>
                  <span className="reasoning-dot" /> Checking…
                </>
              ) : (
                <>
                  <Send size={14} /> Check answer
                </>
              )}
            </button>
          )}
          {isCorrect && (
            <button type="button" onClick={onReset} className="btn-primary">
              <RefreshCcw size={14} /> Learn another topic
            </button>
          )}
        </div>
      </form>

      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className={`mt-4 p-4 rounded-xl border ${
              isCorrect
                ? "border-accent/40 bg-accent/[0.06]"
                : "border-primary/40 bg-primary/[0.05]"
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              {isCorrect ? (
                <Check size={14} className="text-accent" />
              ) : (
                <Sparkles size={14} className="text-primary" />
              )}
              <p className={`text-xs uppercase tracking-widest font-mono ${
                isCorrect ? "text-accent" : "text-primary"
              }`}>
                {isCorrect ? "You got it" : "Not quite — try again"}
              </p>
            </div>
            <p className="text-text text-sm leading-relaxed">{result.explanation}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
