// Safe-ish formula evaluator for AI-generated math expressions.
// Allows: numbers, variable names, basic operators, parens, Math.* functions, comma.
// Variables come from a known map. Anything else is rejected.

const SAFE_PATTERN = /^[\sA-Za-z_0-9+\-*/().,%^]+$/;

const MATH_FUNCS = new Set([
  "abs",
  "acos",
  "asin",
  "atan",
  "atan2",
  "ceil",
  "cos",
  "exp",
  "floor",
  "log",
  "log2",
  "log10",
  "max",
  "min",
  "pow",
  "round",
  "sign",
  "sin",
  "sqrt",
  "tan",
]);

const MATH_CONSTS = new Set(["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2"]);

interface CompiledFormula {
  fn: (env: Record<string, number>) => number;
}

const cache = new Map<string, CompiledFormula>();

export function compileFormula(expr: string, knownVars: string[]): CompiledFormula {
  const key = `${knownVars.join(",")}::${expr}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let normalized = expr.trim();
  // Normalize ^ to **
  normalized = normalized.replace(/\^/g, "**");

  if (!SAFE_PATTERN.test(normalized)) {
    const compiled: CompiledFormula = { fn: () => NaN };
    cache.set(key, compiled);
    return compiled;
  }

  // Walk identifiers, ensure each one is allowed
  const identifierRegex = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/g;
  const known = new Set(knownVars);
  let m: RegExpExecArray | null;
  let safe = true;
  while ((m = identifierRegex.exec(normalized)) !== null) {
    const ident = m[0];
    if (ident.startsWith("Math.")) {
      const sub = ident.slice(5);
      if (!MATH_FUNCS.has(sub) && !MATH_CONSTS.has(sub)) {
        safe = false;
        break;
      }
    } else if (!known.has(ident)) {
      // also allow bare math constants like PI
      if (!MATH_CONSTS.has(ident) && !MATH_FUNCS.has(ident)) {
        safe = false;
        break;
      }
    }
  }

  if (!safe) {
    const compiled: CompiledFormula = { fn: () => NaN };
    cache.set(key, compiled);
    return compiled;
  }

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "env",
      `with (env) { try { return (${normalized}); } catch (e) { return NaN; } }`
    ) as (env: Record<string, number>) => number;
    const compiled: CompiledFormula = { fn };
    cache.set(key, compiled);
    return compiled;
  } catch {
    const compiled: CompiledFormula = { fn: () => NaN };
    cache.set(key, compiled);
    return compiled;
  }
}

export function evalFormula(
  expr: string,
  vars: Record<string, number>,
  knownVars?: string[]
): number {
  const compiled = compileFormula(expr, knownVars ?? Object.keys(vars));
  const env = { ...vars, Math } as unknown as Record<string, number>;
  try {
    const v = compiled.fn(env);
    return typeof v === "number" && Number.isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}

export function formatOutput(value: number, format: string | undefined, unit?: string): string {
  if (!Number.isFinite(value)) return "—";
  switch (format) {
    case "currency": {
      const abs = Math.abs(value);
      const formatted =
        abs >= 1_000_000_000
          ? `$${(value / 1_000_000_000).toFixed(2)}B`
          : abs >= 1_000_000
          ? `$${(value / 1_000_000).toFixed(2)}M`
          : abs >= 1_000
          ? `$${(value / 1_000).toFixed(2)}K`
          : `$${value.toFixed(2)}`;
      return formatted;
    }
    case "percent":
      return `${value.toFixed(2)}%`;
    case "scientific":
      return value.toExponential(2);
    case "number":
    default: {
      const abs = Math.abs(value);
      const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
      const num = value.toFixed(digits);
      return unit ? `${num} ${unit}` : num;
    }
  }
}
