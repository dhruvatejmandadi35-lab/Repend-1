import { useState } from "react";
import { motion } from "framer-motion";
import { Link, Check } from "lucide-react";
import type { Lesson, SimulationBlueprint } from "../lib/types";

interface Props {
  topic: string;
  lesson: Lesson;
  blueprint: SimulationBlueprint;
}

export default function LessonView({ topic, lesson, blueprint }: Props) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // fallback for environments without clipboard API
      const el = document.createElement("textarea");
      el.value = url;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-accent/80 bg-accent/10 border border-accent/20 px-2.5 py-1 rounded-full">
            {blueprint.archetype.replace(/_/g, " ")}
          </span>
          <button
            onClick={handleShare}
            title="Copy shareable link"
            className="inline-flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-full border transition-all duration-200
              border-white/[0.08] text-muted hover:border-primary/40 hover:text-primary"
          >
            {copied ? (
              <>
                <Check size={11} className="text-accent" />
                <span className="text-accent">Copied!</span>
              </>
            ) : (
              <>
                <Link size={11} />
                Share
              </>
            )}
          </button>
        </div>
      </div>

      <LinkifiedText text={lesson.scenario} className="text-text text-lg leading-relaxed mb-4" delay={0} />
      <LinkifiedText
        text={lesson.invitation}
        className="text-accent/90 text-base font-medium"
        delay={lesson.scenario.length}
      />
    </motion.div>
  );
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;

function LinkifiedText({ text, className, delay = 0 }: { text: string; className?: string; delay?: number }) {
  const parts: Array<{ type: "text" | "link"; value: string }> = [];
  let last = 0;
  let match: RegExpExecArray | null;

  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ type: "text", value: text.slice(last, match.index) });
    }
    parts.push({ type: "link", value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) });
  }

  return (
    <motion.p
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6, delay: Math.min(delay / 800, 0.6) }}
    >
      {parts.map((part, i) =>
        part.type === "link" ? (
          <a
            key={i}
            href={part.value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 decoration-primary/40 hover:decoration-primary transition-colors"
          >
            {part.value}
          </a>
        ) : (
          <span key={i}>{part.value}</span>
        )
      )}
    </motion.p>
  );
}
