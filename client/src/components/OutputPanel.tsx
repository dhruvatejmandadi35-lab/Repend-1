import type { Output } from "../lib/types";
import { formatOutput } from "../lib/formula";

interface Props {
  outputs: Output[];
  values: Record<string, number>;
  highlightIndex?: number;
}

export default function OutputPanel({ outputs, values, highlightIndex }: Props) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {outputs.map((o, i) => {
        const highlighted = highlightIndex === i;
        return (
          <div
            key={o.name}
            className={`rounded-xl px-4 py-3 border transition-colors ${
              highlighted
                ? "border-accent/50 bg-accent/[0.06] shadow-copper"
                : "border-white/[0.06] bg-white/[0.02]"
            }`}
          >
            <p className="text-[11px] uppercase tracking-wider text-muted/80 font-mono mb-1">
              {o.label}
            </p>
            <p className="font-display text-2xl tabular-nums">
              {formatOutput(values[o.name] ?? NaN, o.format, o.unit)}
            </p>
          </div>
        );
      })}
    </div>
  );
}
