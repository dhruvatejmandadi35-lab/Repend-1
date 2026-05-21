import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { SimulationBlueprint } from "../lib/types";
import { evalFormula } from "../lib/formula";
import SliderPanel from "./SliderPanel";
import OutputPanel from "./OutputPanel";
import GraphExplorer from "./archetypes/GraphExplorer";
import PhysicsObject from "./archetypes/PhysicsObject";
import SystemDiagram from "./archetypes/SystemDiagram";
import ParticleField from "./archetypes/ParticleField";
import StepwiseProcess from "./archetypes/StepwiseProcess";
import ComparisonSplit from "./archetypes/ComparisonSplit";

interface Props {
  blueprint: SimulationBlueprint;
}

export default function SimulationRunner({ blueprint }: Props) {
  const [values, setValues] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const v of blueprint.variables) initial[v.name] = v.default;
    return initial;
  });

  const variableNames = useMemo(() => blueprint.variables.map((v) => v.name), [blueprint]);

  const outputValues = useMemo(() => {
    const env: Record<string, number> = { ...values };
    const out: Record<string, number> = {};
    for (const o of blueprint.outputs) {
      const v = evalFormula(o.formula, env, [...variableNames, ...blueprint.outputs.map((x) => x.name)]);
      out[o.name] = v;
      env[o.name] = v;
    }
    return out;
  }, [blueprint, values, variableNames]);

  const handleChange = (name: string, value: number) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const renderArchetype = () => {
    switch (blueprint.archetype) {
      case "graph_explorer":
        return <GraphExplorer blueprint={blueprint} values={values} outputValues={outputValues} />;
      case "physics_object":
        return <PhysicsObject blueprint={blueprint} values={values} />;
      case "system_diagram":
        return <SystemDiagram blueprint={blueprint} values={values} />;
      case "particle_field":
        return <ParticleField blueprint={blueprint} values={values} />;
      case "stepwise_process":
        return <StepwiseProcess blueprint={blueprint} values={values} />;
      case "comparison_split":
        return <ComparisonSplit blueprint={blueprint} values={values} outputValues={outputValues} />;
      default:
        return null;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
      className="glass p-5 sm:p-6"
    >
      <div className="flex items-baseline justify-between gap-4 mb-5 flex-wrap">
        <h3 className="font-display text-xl text-text">{blueprint.title}</h3>
        <p className="text-xs font-mono text-muted/70 max-w-md">{blueprint.reasoning}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        <aside className="space-y-6">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted/70 font-mono mb-3">Controls</p>
            <SliderPanel variables={blueprint.variables} values={values} onChange={handleChange} />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted/70 font-mono mb-3">Live Output</p>
            <OutputPanel outputs={blueprint.outputs} values={outputValues} />
          </div>
        </aside>

        <div className="min-w-0">{renderArchetype()}</div>
      </div>
    </motion.div>
  );
}
