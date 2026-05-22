import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { evalFormula, formatOutput } from "../../lib/formula";
import type { GraphExplorerConfig, SimulationBlueprint } from "../../lib/types";
import ThreeDecoration from "./ThreeDecoration";

interface Props {
  blueprint: SimulationBlueprint;
  values: Record<string, number>;
  outputValues: Record<string, number>;
}

const COLOR: Record<string, string> = {
  primary: "#3B82F6",
  accent: "#D4A574",
  muted: "#94A3B8",
};

export default function GraphExplorer({ blueprint, values, outputValues }: Props) {
  const cfg = blueprint.config as GraphExplorerConfig;
  const variableNames = blueprint.variables.map((v) => v.name);

  const sweepVar = blueprint.variables.find((v) => v.name === cfg.xAxis.variable);

  const data = useMemo(() => {
    if (!sweepVar) return [];
    const points = 60;
    const out: Array<Record<string, number>> = [];
    for (let i = 0; i <= points; i++) {
      const t = sweepVar.min + ((sweepVar.max - sweepVar.min) * i) / points;
      const env: Record<string, number> = { ...values, [sweepVar.name]: t };
      const row: Record<string, number> = { [sweepVar.name]: t };
      // evaluate outputs at this sweep point, in declared order so later outputs can reference earlier
      for (const output of blueprint.outputs) {
        row[output.name] = evalFormula(output.formula, { ...env, ...row }, [
          ...variableNames,
          ...blueprint.outputs.map((o) => o.name),
        ]);
      }
      out.push(row);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprint, values]);

  const yAxisFormatter = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    if (abs >= 1) return v.toFixed(0);
    return v.toFixed(2);
  };

  const ChartComp = (() => {
    const series = cfg.series;
    const tooltipFmt = (val: unknown, name: unknown) => {
      const out = blueprint.outputs.find((o) => o.label === name || o.name === name);
      return [formatOutput(Number(val), out?.format, out?.unit), out?.label ?? String(name)];
    };
    const sweepFmt = (val: unknown) =>
      `${Number(val).toFixed(sweepVar && sweepVar.max - sweepVar.min > 10 ? 0 : 2)}${sweepVar?.unit ? " " + sweepVar.unit : ""}`;

    switch (cfg.visualization) {
      case "bar_chart":
        return (
          <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 6 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey={cfg.xAxis.variable}
              stroke="#94A3B8"
              fontSize={11}
              tickFormatter={(v) => Number(v).toFixed(0)}
              label={{ value: cfg.xAxis.label, position: "insideBottom", offset: -2, fill: "#94A3B8", fontSize: 11 }}
            />
            <YAxis stroke="#94A3B8" fontSize={11} tickFormatter={yAxisFormatter} />
            <Tooltip
              contentStyle={{ background: "#131A2A", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 }}
              labelStyle={{ color: "#F5F5F0" }}
              formatter={tooltipFmt}
              labelFormatter={sweepFmt}
            />
            <Legend wrapperStyle={{ color: "#94A3B8", fontSize: 12 }} />
            {series.map((s) => (
              <Bar key={s.output} dataKey={s.output} fill={COLOR[s.color] ?? COLOR.primary} name={s.label} />
            ))}
          </BarChart>
        );
      case "area_chart":
        return (
          <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 6 }}>
            <defs>
              {series.map((s) => (
                <linearGradient id={`grad-${s.output}`} key={s.output} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLOR[s.color] ?? COLOR.primary} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={COLOR[s.color] ?? COLOR.primary} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey={cfg.xAxis.variable}
              stroke="#94A3B8"
              fontSize={11}
              tickFormatter={(v) => Number(v).toFixed(0)}
              label={{ value: cfg.xAxis.label, position: "insideBottom", offset: -2, fill: "#94A3B8", fontSize: 11 }}
            />
            <YAxis stroke="#94A3B8" fontSize={11} tickFormatter={yAxisFormatter} />
            <Tooltip
              contentStyle={{ background: "#131A2A", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 }}
              labelStyle={{ color: "#F5F5F0" }}
              formatter={tooltipFmt}
              labelFormatter={sweepFmt}
            />
            <Legend wrapperStyle={{ color: "#94A3B8", fontSize: 12 }} />
            {series.map((s) => (
              <Area
                key={s.output}
                type="monotone"
                dataKey={s.output}
                stroke={COLOR[s.color] ?? COLOR.primary}
                fill={`url(#grad-${s.output})`}
                strokeWidth={2}
                name={s.label}
              />
            ))}
          </AreaChart>
        );
      case "line_chart_dual":
      case "line_chart":
      default:
        return (
          <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 6 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey={cfg.xAxis.variable}
              stroke="#94A3B8"
              fontSize={11}
              tickFormatter={(v) => Number(v).toFixed(0)}
              label={{ value: cfg.xAxis.label, position: "insideBottom", offset: -2, fill: "#94A3B8", fontSize: 11 }}
            />
            <YAxis stroke="#94A3B8" fontSize={11} tickFormatter={yAxisFormatter} />
            <Tooltip
              contentStyle={{ background: "#131A2A", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 }}
              labelStyle={{ color: "#F5F5F0" }}
              formatter={tooltipFmt}
              labelFormatter={sweepFmt}
            />
            <Legend wrapperStyle={{ color: "#94A3B8", fontSize: 12 }} />
            {series.map((s) => (
              <Line
                key={s.output}
                type="monotone"
                dataKey={s.output}
                stroke={COLOR[s.color] ?? COLOR.primary}
                strokeWidth={2.5}
                dot={false}
                name={s.label}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        );
    }
  })();

  const primaryOutput = blueprint.outputs[0];
  const decorationValue = primaryOutput ? outputValues[primaryOutput.name] ?? 0 : 0;
  const decorationRange: [number, number] = primaryOutput
    ? [0, Math.max(decorationValue * 1.5, 1)]
    : [0, 1];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 h-[340px]">
        <ResponsiveContainer>{ChartComp}</ResponsiveContainer>
      </div>
      <div className="h-[340px] glass-strong overflow-hidden">
        <ThreeDecoration
          kind={cfg.threeDecoration}
          value={decorationValue}
          range={decorationRange}
          label={primaryOutput?.label ?? ""}
        />
      </div>
    </div>
  );
}
