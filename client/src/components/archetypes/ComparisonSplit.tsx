import { useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ComparisonSplitConfig, SimulationBlueprint } from "../../lib/types";
import { evalFormula, formatOutput } from "../../lib/formula";

interface Props {
  blueprint: SimulationBlueprint;
  values: Record<string, number>;
  outputValues: Record<string, number>;
}

export default function ComparisonSplit({ blueprint, values }: Props) {
  const cfg = blueprint.config as ComparisonSplitConfig;
  const variableNames = blueprint.variables.map((v) => v.name);

  const sweepVar = cfg.xAxis
    ? blueprint.variables.find((v) => v.name === cfg.xAxis!.variable)
    : blueprint.variables.find((v) => v.name !== cfg.differingVariable);

  const series = cfg.series ?? blueprint.outputs.slice(0, 1).map((o) => ({ output: o.name, label: o.label }));

  const data = useMemo(() => {
    if (!sweepVar) return [];
    const points = 60;
    const out: Array<Record<string, number>> = [];
    for (let i = 0; i <= points; i++) {
      const t = sweepVar.min + ((sweepVar.max - sweepVar.min) * i) / points;
      const envLeft: Record<string, number> = {
        ...values,
        [sweepVar.name]: t,
        [cfg.differingVariable]: cfg.leftValue,
      };
      const envRight: Record<string, number> = {
        ...values,
        [sweepVar.name]: t,
        [cfg.differingVariable]: cfg.rightValue,
      };
      const row: Record<string, number> = { [sweepVar.name]: t };
      for (const s of series) {
        const out1 = evalFormula(
          blueprint.outputs.find((o) => o.name === s.output)?.formula ?? "0",
          { ...envLeft, ...row },
          variableNames
        );
        const out2 = evalFormula(
          blueprint.outputs.find((o) => o.name === s.output)?.formula ?? "0",
          { ...envRight, ...row },
          variableNames
        );
        row[`left_${s.output}`] = out1;
        row[`right_${s.output}`] = out2;
      }
      out.push(row);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprint, values, cfg.leftValue, cfg.rightValue]);

  // Compute final values for cards
  const leftEnv = { ...values, [cfg.differingVariable]: cfg.leftValue };
  const rightEnv = { ...values, [cfg.differingVariable]: cfg.rightValue };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ScenarioCard
          title={cfg.leftLabel}
          label={cfg.differingVariable}
          value={cfg.leftValue}
          blueprint={blueprint}
          env={leftEnv}
          tone="primary"
        />
        <ScenarioCard
          title={cfg.rightLabel}
          label={cfg.differingVariable}
          value={cfg.rightValue}
          blueprint={blueprint}
          env={rightEnv}
          tone="accent"
        />
      </div>

      {sweepVar && (
        <div className="h-[300px]">
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 6 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey={sweepVar.name}
                stroke="#94A3B8"
                fontSize={11}
                label={{
                  value: cfg.xAxis?.label ?? sweepVar.label,
                  position: "insideBottom",
                  offset: -2,
                  fill: "#94A3B8",
                  fontSize: 11,
                }}
              />
              <YAxis stroke="#94A3B8" fontSize={11} />
              <Tooltip
                contentStyle={{ background: "#131A2A", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 }}
                labelStyle={{ color: "#F5F5F0" }}
              />
              <Legend wrapperStyle={{ color: "#94A3B8", fontSize: 12 }} />
              {series.map((s) => (
                <Line
                  key={`left_${s.output}`}
                  type="monotone"
                  dataKey={`left_${s.output}`}
                  stroke="#3B82F6"
                  strokeWidth={2.5}
                  dot={false}
                  name={`${cfg.leftLabel} · ${s.label}`}
                  isAnimationActive={false}
                />
              ))}
              {series.map((s) => (
                <Line
                  key={`right_${s.output}`}
                  type="monotone"
                  dataKey={`right_${s.output}`}
                  stroke="#D4A574"
                  strokeWidth={2.5}
                  dot={false}
                  name={`${cfg.rightLabel} · ${s.label}`}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function ScenarioCard({
  title,
  label,
  value,
  blueprint,
  env,
  tone,
}: {
  title: string;
  label: string;
  value: number;
  blueprint: SimulationBlueprint;
  env: Record<string, number>;
  tone: "primary" | "accent";
}) {
  const variableNames = blueprint.variables.map((v) => v.name);
  return (
    <div
      className={`rounded-2xl border p-4 ${
        tone === "primary"
          ? "border-primary/30 bg-primary/[0.05]"
          : "border-accent/30 bg-accent/[0.05]"
      }`}
    >
      <p className="text-xs uppercase tracking-widest font-mono text-muted mb-1">{title}</p>
      <p className="font-display text-lg mb-3">
        {label} = <span className={tone === "primary" ? "text-primary" : "text-accent"}>{value}</span>
      </p>
      <div className="space-y-2">
        {blueprint.outputs.map((o) => {
          const v = evalFormula(o.formula, env, variableNames);
          return (
            <div key={o.name} className="flex items-baseline justify-between text-sm">
              <span className="text-muted">{o.label}</span>
              <span className="font-mono tabular-nums">{formatOutput(v, o.format, o.unit)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
