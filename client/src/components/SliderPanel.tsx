import type { Variable } from "../lib/types";

interface Props {
  variables: Variable[];
  values: Record<string, number>;
  onChange: (name: string, value: number) => void;
}

function formatVal(v: number, unit?: string): string {
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const formatted = Number.isInteger(v) ? v.toString() : v.toFixed(digits);
  return unit ? `${formatted} ${unit}` : formatted;
}

export default function SliderPanel({ variables, values, onChange }: Props) {
  return (
    <div className="space-y-5">
      {variables.map((v) => {
        const step = v.step ?? (v.max - v.min < 10 ? 0.1 : 1);
        return (
          <div key={v.name}>
            <div className="flex items-baseline justify-between mb-1.5">
              <label className="text-sm font-medium text-text" htmlFor={`var-${v.name}`}>
                {v.label}
              </label>
              <span className="font-mono text-sm text-accent">
                {formatVal(values[v.name] ?? v.default, v.unit)}
              </span>
            </div>
            <input
              id={`var-${v.name}`}
              type="range"
              min={v.min}
              max={v.max}
              step={step}
              value={values[v.name] ?? v.default}
              onChange={(e) => onChange(v.name, parseFloat(e.target.value))}
            />
            <div className="flex justify-between text-[10px] text-muted/60 font-mono mt-1">
              <span>{formatVal(v.min, v.unit)}</span>
              <span>{formatVal(v.max, v.unit)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
