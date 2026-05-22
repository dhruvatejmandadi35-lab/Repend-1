import { motion } from "framer-motion";
import type { Lesson, SimulationBlueprint } from "../lib/types";

interface Props {
  topic: string;
  lesson: Lesson;
  blueprint: SimulationBlueprint;
}

export default function LessonView({ topic, lesson, blueprint }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="glass p-6 sm:p-8"
    >
      <div className="flex items-baseline justify-between gap-4 mb-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted/70 mb-1 font-mono">
            Topic
          </p>
          <h2 className="font-display text-2xl sm:text-3xl italic text-text">{topic}</h2>
        </div>
        <span className="text-xs font-mono text-accent/80 bg-accent/10 border border-accent/20 px-2.5 py-1 rounded-full">
          {blueprint.archetype.replace(/_/g, " ")}
        </span>
      </div>

      <StreamedText text={lesson.scenario} className="text-text text-lg leading-relaxed mb-4" />
      <StreamedText
        text={lesson.invitation}
        className="text-accent/90 text-base font-medium"
        delay={lesson.scenario.length}
      />
    </motion.div>
  );
}

function StreamedText({ text, className, delay = 0 }: { text: string; className?: string; delay?: number }) {
  // Animate by revealing characters smoothly with a quick fade
  return (
    <motion.p
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6, delay: Math.min(delay / 800, 0.6) }}
    >
      {text}
    </motion.p>
  );
}
