# Repend — Audit & Implementation Plan (working doc)

> Status: **PHASE A IMPLEMENTED — reliability/quality guardrails added (no architecture/model/cache/Kimi-flow change).**
> Branch: `claude/elegant-mayer-EblEG` (NVIDIA + llama + Kimi K2.6 stack).
> Governing constraint (user-refined): improve LAB QUALITY + GENERATION RELIABILITY only. Do NOT change Step 0→5 architecture, model assignments, cache architecture, Three.js approach, or Kimi codegen flow. Add guardrails/validation only where needed. Priority: Reliability > Educational quality > UX > New features.

---

## CHANGES IMPLEMENTED (this commit) — all additive, architecture preserved

1. **`validateLabHtml(html)`** (server.js ~183) — static, dependency-free liveness check encoding the "a lab must be live, manipulable, winnable" contract: closing `</html>`/`</script>` (truncation), `THREE.WebGLRenderer/Scene` (renders), `requestAnimationFrame` (animates / visible consequences), interaction wiring (manipulable), `labCheck` postMessage (winnable). Verified: passes the real `proof-lab.html` with zero false positives; flags truncated/empty/non-lab output.
2. **Always-on static gate** in `codeFromImageBriefWithCritique` (server.js ~2360) — runs `validateLabHtml` and, on failure, regenerates via the **existing** `codeFromImageBrief` call with a corrective note (`labCheckNotes`). Reuses the existing `maxRetries`/`critiqueNotes` plumbing — no new model, no Puppeteer, no OOM. Runs even when `ENABLE_VISUAL_CRITIC` is off (the default). Soft (retry-only) — never hard-rejects, so a regex miss can't turn a valid lab into an error. **Primary fix for empty/truncated labs.**
3. **`normalizeSpec(design)`** (server.js ~897), called right after `specFromThinking` parse — fills empty critical interactivity fields (`learning_goal`, `entry_misconception`, `first_move`, `direct_manipulation`, `aha_trigger`, `success_condition`, `real_world_payoff`, `visualMetaphor`) with neutral, topic-derived fallbacks, and guarantees `variables`/`interaction_palette` are arrays. Empty fields previously collapsed whole codegen-prompt sections to blank or printed `undefined` → mechanically inert "weak" labs. Fallbacks are non-fabricated, so they only help a thin spec. **Primary fix for weak labs + concept/intent dropped into blank prompt sections.**
4. **Course context threaded into `specFromThinking`** (signature + user message via `courseContextBlock`, call site passes `courseContext`) — the spec stage previously never saw course context, so a capstone lab's structured mechanic could collapse to one module. **Fix for context dropped between stages (course labs).**

Verification done: `node --check` on server.js + courses.js; unit test of `validateLabHtml` against `proof-lab.html` (pass) and truncated/empty/plain inputs (correctly flagged). Full pipeline not run (needs live NVIDIA keys).

Deliberately NOT changed (out of refined scope): model assignments, cache, Three.js approach, Kimi flow, Step 0→5 structure, grounding parallelism, the gated Puppeteer critic.

---

## 0. Deployment facts & one thing to verify

- App = one file, `server.js` (2910 lines), raw Node `http` server (no Express). Dispatch at `server.js:2340`.
- Reasoning: NVIDIA Build API. `REASON_MODEL=meta/llama-3.3-70b-instruct`, `REASON_MINI_MODEL=meta/llama-3.1-8b-instruct`. Codegen: `CODEGEN_MODEL_ID=moonshotai/kimi-k2.6`. Vision: `nvidia/nemotron-nano-12b-v2-vl`. OpenAI `gpt-4o`/`gpt-4o-mini` = fallback only. **No Gemini.**
- ⚠️ **VERIFY:** `render.yaml` says `branch: main`, but `main` (`a448aa4`) is the OLD Gemini code. This NVIDIA/Kimi stack lives only on `claude/elegant-mayer-EblEG`. `render.yaml` is a Render blueprint and is likely vestigial (you deploy on Railway, branch set in dashboard). Confirm Railway builds THIS branch — otherwise prod runs Gemini code with no `GEMINI_API_KEY`.

---

## 1. Live lab pipeline (`POST /plan-lab`, SSE) — PRESERVE ZONE

`server.js:2673`. Order: cache check → expandTopic(0) → thinkAboutTopic(1)+grounding → specFromThinking(2) → thinkAboutLab(3a)+thinkAboutVisualPedagogy(3b) → [mockup(4), off] → codeFromImageBrief(5, Kimi) → [critic, off] → saveLab.

| Step | Fn | Model | Tok | server.js |
|---|---|---|---|---|
| 0 | expandTopic | llama-3.1-8b | 200 | 637 |
| 1 | thinkAboutTopic | llama-3.1-8b | 1000 | 698 |
| 2 | specFromThinking | llama-3.3-70b | 4096 | 758 |
| 3a | thinkAboutLab | llama-3.3-70b | 1200 | 883 |
| 3b | thinkAboutVisualPedagogy | llama-3.1-8b | 800 | 1092 |
| 5 | codeFromImageBrief | kimi-k2.6 | 16384 | 1112 |
| critic | screenshotLab+critiqueLab | nemotron-nano-12b-vl | — | 2165 (OFF: ENABLE_VISUAL_CRITIC) |

Cache: exact `getCachedLab` (271) skips whole pipeline; fuzzy `findSimilarLab` (303) = Jaccard token overlap, no embeddings. Win signal: lab iframe posts `{type:'labCheck', result:{ok,score,total}}`; parent listens.

---

## 2. Course flow — IN-SCOPE ZONE

- `courses.js` (391 lines): `generateOutline` (119), `generateLesson` (194), `generateQuiz` (257), `validateCourse` (319). Model `COURSE_MODEL_ID` default `openai/gpt-oss-20b` on NVIDIA.
- Frontend orchestration `learn.html`: `buildCourseFromWizard` (2155), `openLessons` (1827), `openQuiz` (1900), `quizSubmit` (2013), `startCourseLab` (2483), lab-complete handler (2660).
- Reality: ONE capstone lab per course (`_activeCourseModuleOrder=null`); `expandTopic` skipped via `courseContextBlock` (server.js:682), injected into Steps 1 & 3a only. Lessons = all modules' slides flattened into one deck. Quiz = ONE 4–6 Q quiz for the whole course (combined module, lessonMd truncated to 6000 chars). Course progress in `localStorage` only; lab completion → Supabase `/api/progress`.

### System prompts (locations — full text in source)
| Prompt | Location | Zone |
|---|---|---|
| expandTopic (Step 0) | server.js:654-671 | preserve |
| thinkAboutTopic (Step 1) | server.js:721-754 | preserve |
| specFromThinking (Step 2) | server.js:765-845 | preserve |
| thinkAboutLab (Step 3a) | server.js:890-1015 | preserve |
| thinkAboutVisualPedagogy (3b) | server.js:1093-1108 | preserve |
| codeFromImageBrief (Step 5) | server.js:1256-2008 | preserve |
| course outline | courses.js:138-174 | **in-scope** |
| lesson | courses.js:209-238 | **in-scope** |
| quiz | courses.js:262-289 | **in-scope** |
| courseContextBlock | server.js:688-694 | in-scope (course glue) |

---

## 3. Risk register (deduped, tagged)

Tags: ✅ in-scope to fix · 🔒 security (in-scope) · ⚠️ preserve-zone (needs explicit sign-off)

| # | Risk | Where | Tag |
|---|---|---|---|
| R1 | `validateCourse` never called by UI — quality gate is dead | learn.html buildCourseFromWizard:2155 | ✅ |
| R2 | Coverage check meaningless: any ≥4-char substring counts as "taught" | courses.js:341-342 | ✅ |
| R3 | Quiz doesn't scale: 4–6 Q for whole course; lessonMd cut to 6000 chars | courses.js:283 / learn.html:1913 | ✅ |
| R4 | `correct_index` silently defaults to 0 → mislabels answer A correct | courses.js:295 | ✅ |
| R5 | Lesson per-module failures silently dropped (`continue`/`catch`) | learn.html:1846,1849 | ✅ |
| R6 | Course progress only in localStorage (lost on device switch) | learn.html:1695 | ✅ (opt: needs table) |
| R7 | Model drift: courses default gpt-oss-20b, labs llama-3.3-70b | courses.js:40 vs server.js:88 | ✅ |
| R8 | `/upvote-course` non-atomic read-modify-write | server.js:2533 | 🔒 |
| R9 | `rating_sum` ordering: total stars beat average; great low-volume labs never fetched | server.js:312,383 | 🔒 |
| R10 | Grounding text injected into prompts unsanitized (prompt-injection) | grounding.js → server.js:847 | 🔒 |
| R11 | `/s/:id` serves stored lab HTML top-level, NO sandbox (same-origin) | server.js:2599 | 🔒 |
| R12 | Truncation ships as success: no finish_reason/`</html>` check | server.js:167,2804 | ⚠️ |
| R13 | Empty spec fields collapse prompt sections (`direct_manipulation`, etc.); `success_condition` prints `undefined` | server.js:1637,1757 | ⚠️ |
| R14 | proof-lab.html NOT injected — model authors whole file (doc says paste harness) | server.js:1260 | ⚠️ |
| R15 | specFromThinking never receives courseContext → capstone mechanic can collapse to 1 module | server.js:2783 | ⚠️ |
| R16 | expandTopic prompt improvements (your original ask) | server.js:654 | ⚠️ |

---

## 4. Implementation plan (phased, PDF-compliant first)

**Phase 1 — Course/lesson/quiz/validation (✅ fully in-scope, zero pipeline risk)**
1. R1: Wire `/validate-course`. Run cheap outline-level validation at build (`buildCourseFromWizard`); run full coverage validation after `openLessons` generates slides (attach `slides` to modules, call validate, surface a non-blocking "course health" panel).
2. R2: Replace the coverage heuristic with phrase + whole-word coverage minus a stoplist (draft in §5).
3. R3: Scale the quiz — pass a target question count `clamp(modules*1.5, 4, 12)` and require coverage across all key_concepts; raise lessonMd budget.
4. R4: Validate `correct_index ∈ [0,3]`; drop malformed questions instead of defaulting to A.
5. R5: Track + surface failed-module lessons with a retry affordance.

**Phase 2 — Security hardening (🔒 in-scope, "don't break")**
6. R11: Wrap `/s/:id` output in a sandboxed iframe (or serve with sandbox), matching learn.html embedding.
7. R10: Delimit + neutralize grounding text before prompt assembly.
8. R9: Order recommended/similar by a computed average (or Wilson lower bound); widen pool, rank in JS.
9. R8: Atomic upvote via RPC (mirror `bump_lab_plays`).

**Phase 3 — Lab-quality hardening (⚠️ preserve-zone — REQUIRES YOUR SIGN-OFF)**
10. R12: Detect `finish_reason==='length'` + missing `</html>`; treat as failure/retry, not success.
11. R13: Guard empty spec fields so interactivity sections don't collapse to blank/`undefined`.
12. R15: Thread courseContext into specFromThinking so the capstone spec spans modules.
13. R16: Improve the expandTopic (Step 0) prompt (your original request).
14. R14: Actually inject proof-lab.html into the codegen prompt (reconcile with nemotron doc).

---

## 5. Concrete drafts (NOT applied)

### R2 — stronger coverage check (courses.js:336-346)
```js
const STOP = new Set(["data","rate","time","cost","value","model","system","energy",
  "force","field","point","state","level","factor","number","amount","change","effect",
  "power","work","idea","thing","kind","type","form","case","part","unit"]);
const lessonText = slides.map(s => `${s.title} ${s.body}`).join(" ").toLowerCase();
for (const c of concepts) {
  const head = String(c).toLowerCase().split(/[(:,]/)[0].trim();
  const sig = head.split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w));
  const need = sig.length ? Math.ceil(sig.length * 0.6) : 0;
  const hits = sig.filter(w => new RegExp(`\\b${w}\\b`).test(lessonText)).length;
  const covered = (head && lessonText.includes(head)) || (need > 0 && hits >= need);
  if (head && !covered) errors.push(`${label}: lesson never teaches key concept "${c}".`);
}
```

### R4 — correct_index validation (courses.js:292-298)
```js
quiz.questions = (quiz.questions || []).map(q => ({
  question: (q.question || "").trim(),
  options: Array.isArray(q.options) ? q.options.slice(0, 4) : [],
  correct_index: q.correct_index,
  concept: (q.concept || "").trim(),
  explanation: (q.explanation || "").trim(),
})).filter(q =>
  q.question && q.options.length === 4 &&
  Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index <= 3
);
```

### R3 — quiz scales (courses.js generateQuiz signature + prompt + learn.html openQuiz)
- `generateQuiz(module, lessonMarkdown, category, targetCount)` → prompt: "Produce EXACTLY ${targetCount} questions, distributed across ALL key concepts (≥1 per concept where possible)."
- `openQuiz`: `targetCount = Math.min(12, Math.max(4, Math.round(course.modules.length * 1.5)))`; raise lessonMd slice to ~10000.

### R1 — wire validation (learn.html)
- After `openLessons` builds `_lessonSlides`, group slides back per module, call `/validate-course` with `{course:{...course, modules: modules.map(m => ({...m, slides: slidesFor(m)}))}}`, render `warnings`/`errors` in a dismissible panel. Non-blocking.

---

## 6. Open questions for the user
1. Scope to proceed: Phase 1 only / +Phase 2 / +Phase 3 (relaxes PDF preserve)?
2. R6 course-progress persistence needs a Supabase table (migration) — do it now or defer?
3. Confirm Railway is building `claude/elegant-mayer-EblEG`, not `main`.

## 7. Next action
On confirmation: implement chosen phases one task at a time (PDF: "one task completely before the next"), verify each, commit, push, open a DRAFT PR. No code is touched until then.
