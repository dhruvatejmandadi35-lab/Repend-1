import { useMemo } from "react";
import type { SystemDiagramConfig, SimulationBlueprint } from "../../lib/types";
import { evalFormula } from "../../lib/formula";

interface Props {
  blueprint: SimulationBlueprint;
  values: Record<string, number>;
}

const KIND_COLOR: Record<string, string> = {
  source: "#D4A574",
  process: "#3B82F6",
  sink: "#94A3B8",
  store: "#6366F1",
};

interface NodePos {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
}

export default function SystemDiagram({ blueprint, values }: Props) {
  const cfg = blueprint.config as SystemDiagramConfig;
  const variableNames = blueprint.variables.map((v) => v.name);

  const layout: NodePos[] = useMemo(() => {
    // Simple grid-radial layout. Sources on left, sinks on right.
    const sources = cfg.nodes.filter((n) => n.kind === "source");
    const sinks = cfg.nodes.filter((n) => n.kind === "sink");
    const middle = cfg.nodes.filter((n) => n.kind !== "source" && n.kind !== "sink");

    const width = 700;
    const height = 320;

    const placeColumn = (arr: typeof cfg.nodes, x: number) =>
      arr.map((n, i) => ({
        id: n.id,
        label: n.label,
        kind: n.kind,
        x,
        y: 60 + (i + 1) * (height - 120) / (arr.length + 1) + (arr.length === 1 ? 60 : 0),
      }));

    return [
      ...placeColumn(sources, 70),
      ...placeColumn(middle, width / 2),
      ...placeColumn(sinks, width - 70),
    ];
  }, [cfg.nodes]);

  const edges = cfg.edges.map((e) => {
    const from = layout.find((n) => n.id === e.from);
    const to = layout.find((n) => n.id === e.to);
    if (!from || !to) return null;
    const flow = evalFormula(e.flowFormula, values, variableNames);
    return { from, to, label: e.label, flow };
  });

  const flows = edges.filter(Boolean).map((e) => Math.abs(e!.flow));
  const maxFlow = flows.length ? Math.max(...flows, 0.01) : 1;

  return (
    <div className="glass-strong p-4">
      <svg viewBox="0 0 700 320" className="w-full h-[360px]">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
            fill="#3B82F6"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>

        {edges.map((e, i) => {
          if (!e) return null;
          const w = 1 + (Math.abs(e.flow) / maxFlow) * 5;
          const midX = (e.from.x + e.to.x) / 2;
          const midY = (e.from.y + e.to.y) / 2;
          const dx = e.to.x - e.from.x;
          const dy = e.to.y - e.from.y;
          const len = Math.hypot(dx, dy);
          const ux = dx / len;
          const uy = dy / len;
          const x1 = e.from.x + ux * 32;
          const y1 = e.from.y + uy * 32;
          const x2 = e.to.x - ux * 36;
          const y2 = e.to.y - uy * 36;

          return (
            <g key={i}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#3B82F6"
                strokeOpacity={0.25 + Math.abs(e.flow) / maxFlow * 0.6}
                strokeWidth={w}
                markerEnd="url(#arrow)"
              />
              <text
                x={midX}
                y={midY - 6}
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
                fill="#D4A574"
                textAnchor="middle"
              >
                {Number.isFinite(e.flow) ? e.flow.toFixed(2) : "—"}
                {e.label ? ` · ${e.label}` : ""}
              </text>
            </g>
          );
        })}

        {layout.map((n) => (
          <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
            <circle r={30} fill={KIND_COLOR[n.kind] ?? KIND_COLOR.process} fillOpacity={0.18} stroke={KIND_COLOR[n.kind] ?? KIND_COLOR.process} strokeWidth={1.5} />
            <circle r={6} fill={KIND_COLOR[n.kind] ?? KIND_COLOR.process} />
            <text y={48} fontSize="12" fontFamily="Inter, sans-serif" fill="#F5F5F0" textAnchor="middle" fontWeight={500}>
              {n.label}
            </text>
            <text y={62} fontSize="9" fontFamily="JetBrains Mono, monospace" fill="#94A3B8" textAnchor="middle">
              {n.kind}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
