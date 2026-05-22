import { motion, AnimatePresence } from "framer-motion";
import { Check } from "lucide-react";
import type { ReasoningStep } from "../lib/types";

interface Props {
  topic: string;
  active: ReasoningStep | null;
  done: ReasoningStep[];
  labels: Record<ReasoningStep, string>;
}

const ORDER: ReasoningStep[] = ["understanding", "selecting", "building"];

export default function LoadingState({ topic, active, done, labels }: Props) {
  return (
    <div className="pt-16 max-w-xl mx-auto">
      <p className="text-xs uppercase tracking-widest text-muted/70 mb-3 font-mono">
        Topic
      </p>
      <p className="font-display text-3xl mb-10 italic text-text">{topic}</p>

      <ul className="space-y-4">
        {ORDER.map((step, i) => {
          const isDone = done.includes(step);
          const isActive = active === step;
          const visible = isDone || isActive || (i === 0 && !active && done.length === 0);

          return (
            <AnimatePresence key={step}>
              {visible && (
                <motion.li
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease: "easeOut" }}
                  className="flex items-center gap-3 font-mono text-sm"
                >
                  <div className="flex items-center justify-center w-6 h-6 shrink-0">
                    {isDone ? (
                      <motion.div
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="w-5 h-5 rounded-full bg-accent/15 border border-accent/40 flex items-center justify-center"
                      >
                        <Check size={12} className="text-accent" />
                      </motion.div>
                    ) : isActive ? (
                      <span className="reasoning-dot" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-white/15" />
                    )}
                  </div>
                  <span className={isDone ? "text-muted" : "text-text"}>{labels[step]}</span>
                </motion.li>
              )}
            </AnimatePresence>
          );
        })}
      </ul>
    </div>
  );
}
