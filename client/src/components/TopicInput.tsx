import { useState, FormEvent } from "react";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";

const EXAMPLES = [
  "compound interest",
  "photosynthesis",
  "supply and demand",
  "Newton's second law",
  "logical fallacies",
  "DNA replication",
];

interface Props {
  onSubmit: (topic: string) => void;
}

export default function TopicInput({ onSubmit }: Props) {
  const [value, setValue] = useState("");

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div className="pt-12 sm:pt-20 text-center">
      <motion.h1
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="font-display text-5xl sm:text-6xl font-medium tracking-tight mb-4"
      >
        Learn by <span className="italic text-accent">doing</span>.
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1, ease: "easeOut" }}
        className="text-muted text-base sm:text-lg mb-12 max-w-lg mx-auto"
      >
        Type anything you want to understand. Repend builds the lesson and the simulation around it.
      </motion.p>

      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
        className="glass-strong flex items-center gap-2 px-2 py-2 max-w-2xl mx-auto"
      >
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="What do you want to understand?"
          className="flex-1 bg-transparent px-4 py-3 outline-none text-text placeholder:text-muted/70"
          aria-label="Topic"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          className="btn-primary px-4 py-3"
          aria-label="Generate lesson"
        >
          <ArrowRight size={18} />
        </button>
      </motion.form>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.4 }}
        className="mt-10"
      >
        <p className="text-xs uppercase tracking-widest text-muted/70 mb-4 font-mono">
          Try one of these
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 max-w-2xl mx-auto">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => onSubmit(ex)}
              className="chip"
            >
              {ex}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
