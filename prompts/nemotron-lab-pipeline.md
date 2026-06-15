# Repend Lab Generation — Nemotron Codegen Pipeline

How to keep GPT/Gemini as the **design brain** and move the **token-heavy code
generation** onto free Nemotron 3 Ultra (via OpenRouter) without losing the
quality of `proof-lab.html`.

The core idea: **a weaker/free model needs less freedom, not more.** Nemotron is
good at filling a proven template. It is bad at inventing architecture and
pedagogy. So GPT/Gemini does all the thinking and hands Nemotron a skeleton it
can only fill in — never design from scratch.

---

## Part 1 — Why `proof-lab.html` works (the teardown)

The file is the reference output. Eight properties make it good, and every one
is something we must force Nemotron to reproduce:

1. **One self-contained HTML file, CDN imports, zero build step.** Opens and
   runs. Three.js + CSS2DRenderer loaded from `cdn.jsdelivr.net`. A weak model
   can one-shot this; it cannot one-shot a webpack project.

2. **A hand-written harness, nothing "hoped for."** The top comment says it:
   *"Objects move because THIS code moves them every single frame."* The three
   classic LLM failures are pre-solved in fixed code:
   - **Black screen** → ambient + directional + two point lights, always present.
   - **Off-camera** → camera at `(0, 0.2, 13)` with explicit `lookAt`.
   - **Dead scene** → ONE `requestAnimationFrame` loop, `getDelta()` called
     exactly once, render happens in exactly one place.

3. **Numbered fill-in sections (1–11).** Renderer → Lighting → Palette → Grid →
   Headers → Tiles → Dragging → Win logic → Tween system → Particles → Loop →
   Reset. This is a *template*, not freeform code. The model swaps the domain
   contents of each section and leaves the plumbing alone.

4. **Pedagogy IS the mechanic (intrinsic integration).** You don't read about
   the 3:1 ratio — you build the Punnett square and the offspring flowers bloom
   in the right phenotype colors. The learning objective is literally the win
   condition. No quiz wrapper.

5. **Concrete-first.** The first action is hands-on in <3 s — grab a glowing
   tile and drop it. No explanation gate before interaction.

6. **Layered feedback.** Wrong drop → red flash + corrective hint. Right drop →
   flower bloom + particle burst + green edge + progress meter. Completion →
   grade screen that finally *states* the concept ("Mendel's law of segregation").

7. **Continuous life.** Idle ≠ static: tiles bob, headers spin, offspring pulse,
   dust drifts, camera gently drifts. Cheap reusable helpers (`tweenTo`,
   `tweenScale`, `burst`) do it.

8. **Platform contract.** On win it fires
   `window.parent.postMessage({ type:'labCheck', result:{ ok, score, total } }, '*')`
   so the Repend shell can score it.

**Takeaway for the pipeline:** properties 1, 2, 3, 7, 8 are *boilerplate* — bake
them into a fixed harness Nemotron copies verbatim. Properties 4, 5, 6 are
*design decisions* — GPT/Gemini must spell them out concretely in the spec so
Nemotron only has to translate, never invent.

---

## Part 2 — The two-model architecture

```
topic ──▶ [ GPT-4o / Gemini ]  ──spec JSON──▶ [ Nemotron 3 Ultra ] ──▶ lab.html
            DESIGN BRAIN                          CODE TYPIST
   pedagogy, mechanic, win-formula,         fills the fixed harness from
   objects, colors, labels — the part       the spec — the token-heavy part
   that needs real reasoning                that's cheap and constrainable
                                                       │
                                                       ▼
                                            [ smoke-test gate ] ──▶ retry once
```

Why split here:
- Codegen is where ~80% of the output tokens are. That's the bill Nemotron erases.
- Codegen is the *most constrainable* stage — a fixed skeleton + a filled spec
  leaves little room for a weaker model to go wrong.
- Pedagogy/spec is short, high-leverage reasoning. Keep it on the strong model;
  it's cheap because the output is small JSON.

This mirrors the existing `server.js` flow (`PLAN_SYSTEM` → visual brief →
codegen). We are only **replacing the codegen model**, not the design stages.

---

## Part 3 — The orchestrator instruction (GPT/Gemini → produce the spec)

Give this to GPT-4o or Gemini. Its only job is to turn a topic into a tight,
**fully-decided** spec. No prose, no ambiguity — every field is a concrete
choice Nemotron can type directly.

> You are the design brain for an interactive 3D learning lab. Given a TOPIC,
> output ONLY a JSON spec that a junior coder can implement against a fixed
> Three.js harness without making a single creative decision. If a field would
> make the coder guess, you have failed — decide it for them.
>
> Rules:
> - The **mechanic must BE the concept** (intrinsic integration). The learner
>   performs the idea; they don't answer a quiz about it. State the one repeated
>   action and how doing it correctly demonstrates the concept.
> - The **win condition must be a real formula** over named state, and it must be
>   mathematically reachable. Give the exact target (e.g. `placed === 4 && ratio === "3:1"`).
> - Every object is a **named, labeled 3D mesh** of the literal topic — never a
>   generic sphere, never a space scene unless the topic is astronomy.
> - Every control maps to a **real variable with real units** — no inert
>   topical-sounding sliders.
>
> Output this JSON exactly:
> ```json
> {
>   "topic": "...",
>   "learning_goal": "one sentence: what they'll understand after winning",
>   "entry_misconception": "the wrong intuition this corrects",
>   "core_mechanic": "the ONE action repeated, and why doing it = learning the concept",
>   "first_move": "what the learner grabs/does in the first 3 seconds",
>   "objects": [
>     { "name": "Tile PP", "mesh": "two purple beads on a plate", "label": "PP", "color": "#9B59B6" }
>   ],
>   "interactions": [
>     { "type": "draggable", "element": "genotype tile", "effect": "snaps to matching grid cell, blooms offspring flower" }
>   ],
>   "win": { "formula": "placed === 4", "reveal": "phenotype ratio 3 purple : 1 white", "concept_line": "the 3:1 ratio is Mendel's law of segregation" },
>   "feedback": { "correct": "flower bloom + particle burst + green edge", "wrong": "red flash + hint text" },
>   "palette": { "bg": "#050508", "accent": "#E85D04", "copper": "#D4A574", "ice": "#4CC9F0", "success": "#22C55E" }
> }
> ```

GPT/Gemini returns that JSON. We hand it to Nemotron with Part 4.

---

## Part 4 — The Nemotron system prompt (codegen)

This is the critical piece. Nemotron gets the **harness verbatim** and is told
to only swap domain contents. Embed the literal skeleton from `proof-lab.html`
so it copies, not invents.

> You are a precise front-end coder. You will receive a SPEC (JSON) and a fixed
> HTML HARNESS. Output ONE complete, runnable HTML file and nothing else —
> no markdown fences, no commentary, no `// ...` placeholders, no TODO.
>
> **You must not redesign the harness.** Keep its structure, its 11 numbered
> sections, its lighting, its single animation loop, its tween/particle helpers,
> and its `postMessage` exactly as given. You ONLY replace the domain-specific
> contents:
> - Section 3 (palette): use the spec's colors.
> - Section 4–6 (objects/tiles): build the meshes named in `spec.objects`, with
>   their labels, exactly as listed.
> - Section 7 (win logic): implement `spec.win.formula`; on win, reveal
>   `spec.win.reveal` and show `spec.win.concept_line`.
> - Feedback: correct/wrong handlers must match `spec.feedback`.
>
> **Hard requirements (a violation = broken lab):**
> 1. Load Three.js r128 and CSS2DRenderer from the exact CDN URLs in the harness.
>    Do NOT invent version numbers.
> 2. Lighting: keep all four lights. The scene must never be black.
> 3. Camera: keep an explicit position + `lookAt`. Never at the origin looking
>    at the origin.
> 4. ONE `requestAnimationFrame` loop; `clock.getDelta()` called exactly once;
>    `renderer.render` in exactly one place. All motion scaled by `dt`.
> 5. Every interactive mesh carries a CSS2D label with its real name/value.
> 6. The first action is hands-on within 3 seconds. No explanation gate.
> 7. On win: particle burst + grade + `window.parent.postMessage({ type:'labCheck',
>    result:{ ok:true, score, total } }, '*')`.
> 8. Include a Reset button that restores initial state.
>
> Here is the HARNESS to fill in (copy its structure exactly):
> ```html
> <!-- paste the full proof-lab.html here as the skeleton -->
> ```

> **SPEC:**
> ```json
> <!-- paste the GPT/Gemini spec JSON here -->
> ```

The single most important sentence for a weak model is *"do not redesign the
harness."* Every degree of freedom you remove is a class of bug Nemotron can't
introduce.

---

## Part 5 — Validation gate (before showing the learner)

Nemotron output is cheaper but less reliable, so gate it. Cheap automated checks,
then one retry with the failure pasted back:

- **Static smoke test** — string-check the HTML for the non-negotiables:
  contains `AmbientLight`, `DirectionalLight`, `requestAnimationFrame`,
  `getDelta`, `camera.lookAt`, `postMessage`, the CDN `three@0.128.0` URL, and
  no `// ...` / `TODO` placeholders.
- **Headless render check** (Puppeteer): load the file, wait 1 s, assert the
  WebGL canvas is not a single flat color (catches the black-screen failure),
  and assert no uncaught console errors.
- **Win-reachability** (optional): script the documented winning moves and
  confirm a `labCheck` message fires.
- **Retry policy:** on any failure, send Nemotron the same prompt + the failing
  check ("the scene rendered black — verify all four lights are added"). One
  retry; if it still fails, fall back to GPT-4o codegen for that lab.

---

## Wiring it into `server.js` (later — June 18/19)

Implemented: codegen routes through NVIDIA Build's free endpoint
(`https://integrate.api.nvidia.com/v1`, model `nvidia/nemotron-3-ultra-550b-a55b`)
via the OpenAI SDK. Controlled by `CODEGEN_MODEL` (`nemotron` default, `gemini` to
revert) and gated on `NVIDIA_API_KEY`. Plan/brief/spec stages stay on GPT-4o.
Falls back to Gemini automatically when Nemotron fails, when a mockup image is
present (Nemotron is text-only), or when the key is missing.

> Note 1: NVIDIA Build's free endpoint is rate-limited and caps output at
> ~16384 tokens. For batch course generation expect to throttle requests; a
> single very large lab could brush the output cap.
>
> Note 2: this is the direct-from-NVIDIA path. The OpenRouter route
> (`nvidia/nemotron-3-ultra-550b-a55b:free`) is an alternative — same model,
> different base URL and key.
