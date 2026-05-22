import { z } from "zod";

export const VariableSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/i, "must be a valid identifier"),
  min: z.number(),
  max: z.number(),
  default: z.number(),
  step: z.number().optional(),
  unit: z.string().optional().default(""),
  label: z.string(),
});

export const OutputSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/i),
  formula: z.string().min(1),
  label: z.string(),
  unit: z.string().optional().default(""),
  format: z.enum(["number", "currency", "percent", "scientific"]).optional().default("number"),
});

export const ArchetypeSchema = z.enum([
  "graph_explorer",
  "physics_object",
  "system_diagram",
  "particle_field",
  "stepwise_process",
  "comparison_split",
]);

// Archetype-specific config schemas
export const GraphExplorerConfigSchema = z.object({
  visualization: z.enum(["line_chart", "line_chart_dual", "bar_chart", "area_chart"]).default("line_chart"),
  xAxis: z.object({
    variable: z.string(),
    label: z.string(),
  }),
  series: z.array(
    z.object({
      output: z.string(),
      label: z.string(),
      color: z.enum(["primary", "accent", "muted"]).default("primary"),
    })
  ).min(1),
  threeDecoration: z.enum(["coin_stack", "growing_sphere", "bar_tower", "none"]).default("none"),
});

export const PhysicsObjectConfigSchema = z.object({
  object: z.enum(["pendulum", "projectile", "spring", "orbit", "inclined_plane", "collision", "cart"]),
  worldGravity: z.number().default(9.81),
  description: z.string(),
});

export const SystemDiagramConfigSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(["source", "process", "sink", "store"]).default("process"),
    })
  ).min(2),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      flowFormula: z.string(),
      label: z.string().optional(),
    })
  ).min(1),
});

export const ParticleFieldConfigSchema = z.object({
  particleCount: z.number().int().min(20).max(2000).default(400),
  rule: z.enum(["brownian", "attract", "repel", "flow", "boids", "diffusion"]),
  speedFormula: z.string().default("1"),
  description: z.string(),
});

export const StepwiseProcessConfigSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      visual: z.enum([
        "split_strand",
        "primer_attach",
        "polymerase",
        "ligase",
        "generic_assemble",
        "generic_react",
        "generic_transform",
      ]),
    })
  ).min(2).max(8),
});

export const ComparisonSplitConfigSchema = z.object({
  leftLabel: z.string(),
  rightLabel: z.string(),
  differingVariable: z.string(),
  leftValue: z.number(),
  rightValue: z.number(),
  visualization: z.enum(["line_chart", "bar_chart", "scene_3d"]).default("line_chart"),
  series: z.array(
    z.object({
      output: z.string(),
      label: z.string(),
    })
  ).optional(),
  xAxis: z
    .object({
      variable: z.string(),
      label: z.string(),
    })
    .optional(),
});

export const SimulationBlueprintSchema = z.object({
  archetype: ArchetypeSchema,
  reasoning: z.string().min(20),
  title: z.string(),
  variables: z.array(VariableSchema).min(1).max(6),
  outputs: z.array(OutputSchema).min(1).max(4),
  config: z.union([
    GraphExplorerConfigSchema,
    PhysicsObjectConfigSchema,
    SystemDiagramConfigSchema,
    ParticleFieldConfigSchema,
    StepwiseProcessConfigSchema,
    ComparisonSplitConfigSchema,
  ]),
});

export type SimulationBlueprint = z.infer<typeof SimulationBlueprintSchema>;
export type Archetype = z.infer<typeof ArchetypeSchema>;

export const LessonSchema = z.object({
  scenario: z.string().min(20),
  invitation: z.string().min(5),
});
export type Lesson = z.infer<typeof LessonSchema>;

export const VerificationQuestionSchema = z.object({
  question: z.string().min(10),
  hint: z.string().optional(),
});
export type VerificationQuestion = z.infer<typeof VerificationQuestionSchema>;

export const VerificationResultSchema = z.object({
  correct: z.boolean(),
  explanation: z.string(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
