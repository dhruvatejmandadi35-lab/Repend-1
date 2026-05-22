// Mirror of server types (without zod). Keep these in sync.

export type Archetype =
  | "graph_explorer"
  | "physics_object"
  | "system_diagram"
  | "particle_field"
  | "stepwise_process"
  | "comparison_split";

export interface Variable {
  name: string;
  min: number;
  max: number;
  default: number;
  step?: number;
  unit?: string;
  label: string;
}

export interface Output {
  name: string;
  formula: string;
  label: string;
  unit?: string;
  format?: "number" | "currency" | "percent" | "scientific";
}

export interface GraphExplorerConfig {
  visualization: "line_chart" | "line_chart_dual" | "bar_chart" | "area_chart";
  xAxis: { variable: string; label: string };
  series: Array<{ output: string; label: string; color: "primary" | "accent" | "muted" }>;
  threeDecoration: "coin_stack" | "growing_sphere" | "bar_tower" | "none";
}

export interface PhysicsObjectConfig {
  object: "pendulum" | "projectile" | "spring" | "orbit" | "inclined_plane" | "collision" | "cart";
  worldGravity: number;
  description: string;
}

export interface SystemDiagramConfig {
  nodes: Array<{ id: string; label: string; kind: "source" | "process" | "sink" | "store" }>;
  edges: Array<{ from: string; to: string; flowFormula: string; label?: string }>;
}

export interface ParticleFieldConfig {
  particleCount: number;
  rule: "brownian" | "attract" | "repel" | "flow" | "boids" | "diffusion";
  speedFormula: string;
  description: string;
}

export interface StepwiseProcessConfig {
  steps: Array<{
    id: string;
    title: string;
    description: string;
    visual:
      | "split_strand"
      | "primer_attach"
      | "polymerase"
      | "ligase"
      | "generic_assemble"
      | "generic_react"
      | "generic_transform";
  }>;
}

export interface ComparisonSplitConfig {
  leftLabel: string;
  rightLabel: string;
  differingVariable: string;
  leftValue: number;
  rightValue: number;
  visualization: "line_chart" | "bar_chart" | "scene_3d";
  series?: Array<{ output: string; label: string }>;
  xAxis?: { variable: string; label: string };
}

export type ArchetypeConfig =
  | GraphExplorerConfig
  | PhysicsObjectConfig
  | SystemDiagramConfig
  | ParticleFieldConfig
  | StepwiseProcessConfig
  | ComparisonSplitConfig;

export interface SimulationBlueprint {
  archetype: Archetype;
  reasoning: string;
  title: string;
  variables: Variable[];
  outputs: Output[];
  config: ArchetypeConfig;
}

export interface Lesson {
  scenario: string;
  invitation: string;
}

export interface VerificationQuestion {
  question: string;
  hint?: string;
}

export interface VerificationResult {
  correct: boolean;
  explanation: string;
}

export type ReasoningStep = "understanding" | "selecting" | "building";

export interface ReasoningEvent {
  step: ReasoningStep;
  label: string;
}

export type LoopPhase =
  | "idle"
  | "reasoning"
  | "lesson"
  | "simulation"
  | "verification"
  | "complete"
  | "error";
