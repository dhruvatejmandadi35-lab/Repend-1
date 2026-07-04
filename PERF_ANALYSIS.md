# Repend — Generation Latency Analysis & Optimization Order

> Working doc, 2026-07-04. Principle: **a successful first-generation lab is worth more than a faster second-generation lab.** Priority: reliability > educational quality > interaction quality > speed.
> Rule applied throughout: do not assume the code generator is the bottleneck — prove it. Instrumentation is shipped; numbers below marked ⏱ need one live run to confirm.

## 1. Pipeline timing breakdown

**Instrumentation shipped** (server.js `/plan-lab`): every SSE stage boundary is timed; per-generation breakdown is logged as `[timing] {...}` and attached to the `done` event (`data.timings`). Stages: `expand → ground/think → design → labthink → code → total`. Cached hits get timed too.

Static budget (token caps × stage), pending ⏱ live confirmation:

| Stage | Model | Max tokens out | Expected share |
|---|---|---|---|
| expandTopic | llama-3.1-8b | 200 | ~2s |
| thinkAboutTopic ∥ grounding | llama-8b ∥ HTTP | 1000 | ~5-10s |
| specFromThinking | llama-3.3-70b | 4096 | ~15-30s |
| labthink ∥ pedagogy ∥ interaction ∥ lesson ∥ quiz | 70b/8b/deepseek-r1/gpt-oss | 1200/800/4000/—/— | window ≈ slowest of the five |
| **codegen** | **GLM-5.1** | **16384** | **~4+ min of ~5** |
| validation regen (on failure) | GLM-5.1 | 16384 | +full codegen per retry, ×2 max |

**How to capture real numbers:** deploy, run `ONLY_CATEGORY="Everyday Science" npm run warm`, then `grep '\[timing\]' logs`. Retry rate: `grep '\[labcheck\] attempt'`. Codegen wall-clock: `grep '\[codegen/nvidia\] stream done'` (already logs elapsed + finish_reason).

## 2. Bottleneck analysis

- Reasoning stages are parallelized where the dependency graph allows (think∥grounding; labthink∥pedagogy∥interaction∥lesson∥quiz). Serial depth: expand → think → spec → labthink-window → codegen.
- Codegen is single-lane (NVIDIA free tier accepts one GLM/Kimi request at a time — `withKimiLock`). Concurrent users queue: Nth user waits N × codegen time. **Paid tier is the only concurrency fix.**
- Hidden multiplier: `validateLabHtml` failure → full 16K regen (up to 2×). A 30% failure rate turns 5 min into 6.5 min average. ⏱ Measure before optimizing further — the failure *rate* decides whether retry-reduction or raw speed matters more.

## 3. Kimi vs GLM — verdict from existing evidence

**No A/B needed; Kimi is disqualified on reliability.** Evidence: (a) `withKimiLock` exists specifically because Kimi K2.6 on free tier returned **empty streams** under any concurrency (documented in server.js comments: "both sit idle ~47-49s, both return empty streams"); (b) operator experience confirms Kimi "wasn't working". GLM-5.1 is slower per the code comment but *completes*. Reliability > speed ⇒ **GLM-5.1 stays.** Revisit only on a paid tier where Kimi's serving might differ.

## 4. Template-delta codegen — risk analysis

Idea: fixed hand-written harness (HUD/CSS/boilerplate, like `injectRecipe`/`ENGINE_TEMPLATE`), GLM generates only topic-specific sections. ~40-50% fewer output tokens → proportional speedup + fewer truncations (truncation is validation check #1/#2 — boilerplate eats the budget).

Risks: new failure class (section/harness contract mismatches: DOM ids, variable names, load order) that `validateLabHtml` only partially catches; every archetype's freedom (sports-game vs data-sampling layouts differ radically) must fit one harness or need per-archetype harnesses; proof-lab.html gold standard and the 11-section prompt contract both need rework. **Recommendation: defer.** Benefits are real but the risk is architectural; do it only if, after cache warming + retry data, novel-topic latency still hurts. If attempted: one archetype first (threshold — simplest), behind an env flag, A/B against full-file generation.

## 5. Multi-level caching — evaluation

| Level | Verdict | Why |
|---|---|---|
| Final labs (exists) | ✅ keep + **warm it** | Terminal cache short-circuits everything; `tools/warm-cache.js` pre-generates all 49 catalog topics |
| Expanded topics / specs / pedagogy / interaction plans | ❌ skip | Reasoning stages are ~10-15% of wall-clock; the final-lab cache already covers repeat topics end-to-end. Intermediate caches add invalidation complexity for seconds of gain |
| Regen reuse (spec/labthink reused across validation retries) | ✅ already true | Retries only re-run codegen — no change needed |

## 6. Retry reduction (prefer eliminating retries over faster models)

Failure classes, from `validateLabHtml` checks + audit-doc history:
1. **Truncation** (no `</html>`/`</script>`) — token cap hit. Mitigations already in prompt (OUTPUT BUDGET section). Next lever: template-delta (§4) or continuation-on-truncate (resume generation instead of full regen — medium risk, good candidate after measuring).
2. **Weak/blank specs** → inert labs — already guarded by `normalizeSpec`.
3. **Malformed JSON** in reasoning stages — already guarded by `parseLooseJSON` + retry-in-prompt.
4. **Slider-only interactivity** — new contract-aware check; only fires when the interaction director issued a contract, so it adds no regen risk to legacy paths.

⏱ Action: after one warm run, compute regen rate = `[labcheck]` lines ÷ generations. >20% ⇒ prioritize continuation-on-truncate. <10% ⇒ retries are a non-issue; stop optimizing here.

## 7. Recommended implementation order

| # | Change | Impact | Risk | Status |
|---|---|---|---|---|
| 1 | Stage timing instrumentation | Enables all decisions | None (additive) | ✅ shipped |
| 2 | Catalog cache warmer (`npm run warm`) | Catalog users: 5 min → ~2s | None (pure client of existing API) | ✅ shipped, smoke-tested |
| 3 | Run warmer on one category; collect `[timing]` + `[labcheck]` data | Ground truth | None | ⏱ needs deployed server |
| 4 | Full 49-topic warm after prompt quality settles | Demo-proof catalog | Credits (~4h serialized) | pending |
| 5 | Continuation-on-truncate (only if regen rate >20%) | Cuts worst-case 15 min → ~7 | Medium | data-gated |
| 6 | Template-delta codegen (only if novel-topic latency still hurts) | ~2× novel-topic speed | High | deferred |
| 7 | NVIDIA paid tier (when traffic is real) | Unlocks concurrency | Cost | business call |

Low-risk = 1-4. High-risk = 5-6 (both data-gated, one at a time, never combined).
