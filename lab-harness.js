// lab-harness.js — the ONE shared lab template.
//
// GLM never writes (or sees the internals of) the renderer scaffolding: layout,
// predict gate, legend, formula panel, playback controls, labCheck wiring. It
// receives HARNESS_API_DOC in its prompt and outputs only three fragments:
//
//   <style>   lab-specific css                                  </style>
//   <div id="lab-stage">  lab-specific dom                      </div>
//   <script>  lab logic, talking to the window.Lab API          </script>
//
// buildLabHTML() assembles the final self-contained file, so the harness bytes
// are identical in every lab — zero mutation risk, and GLM's whole token
// budget goes to the sim.

"use strict";

// Pinned CDN tags. The node selector picks from these; versions live here and
// nowhere else so GLM can never hallucinate a URL.
const LIB_TAGS = {
  p5:      '<script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.4/p5.min.js"><\/script>',
  three:   '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.1/three.min.js"><\/script>',
  d3:      '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"><\/script>',
  chart:   '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.3/chart.umd.min.js"><\/script>',
  matter:  '<script src="https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js"><\/script>',
  gsap:    '<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"><\/script>',
  tfjs:    '<script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js"><\/script>',
  katex:   '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.10/katex.min.css">\n' +
           '<script src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.10/katex.min.js"><\/script>',
};

// concept_type → libraries. Deterministic; the model only picks the enum.
const NODE_ROUTES = {
  "dynamic-physical": ["p5", "chart"],
  "emergent":         ["p5", "chart"],
  "quantitative":     ["chart"],
  "probabilistic":    ["chart"],
  "spatial-2D":       [],            // vanilla SVG
  "spatial-3D":       ["three"],
  "sequential":       [],            // vanilla JS step-through
  "abstract":         [],            // vanilla JS sort/contrast
  "network":          ["d3"],
  "ml-concept":       ["chart"],     // vanilla JS math; tfjs only for real NN training
};

const VALID_CONCEPT_TYPES = Object.keys(NODE_ROUTES);
const DEFAULT_CONCEPT_TYPE = "quantitative";

// One visual-rule block per type. Only the matching block is put in the prompt.
const VISUAL_RULES = {
  "dynamic-physical": "Live requestAnimationFrame animation with a linked chart updating in real time. Initial conditions are draggable. The motion IS the lesson — never a static diagram.",
  "emergent":         "Many individual entities visible on canvas, each following local rules the learner can perturb. NEVER a slider controlling an aggregate curve — the aggregate must emerge from visible individuals.",
  "quantitative":     "Controls drive a live chart with real axes and units, PLUS a concrete real-world referent that scales alongside it (stacks of money, filling tanks — not just a curve).",
  "probabilistic":    "Animate individual trials one by one, visibly accumulating into a histogram. The learner watches randomness converge — never show the final distribution first.",
  "spatial-2D":       "Draggable SVG objects with live measurements that expose the invariant. Dragging is the primary verb; numbers update mid-drag.",
  "spatial-3D":       "A Three.js scene the learner orbits and manipulates. Camera responds to interaction. Depth must carry meaning — if 2D would teach it equally well, the design is wrong.",
  "sequential":       "Learner-paced step-through with an explicit next control and a visible trail of completed steps. NEVER autoplay-only.",
  "abstract":         "Sort-into-bins with instant right/wrong feedback, or a side-by-side contrast the learner toggles. Concrete instances, not definitions.",
  "network":          "Stocks visibly filling and draining, flows the learner adjusts, feedback loops highlighted when they dominate. D3 node-link or flow diagram.",
  "ml-concept":       "Implement the algorithm in plain JS so every update step is visible (loss dropping point by point on a chart). Use tfjs ONLY if the lab genuinely trains a neural network.",
};

// What GLM is told about the harness. This is the API contract — keep it in
// lock-step with the runtime below.
const HARNESS_API_DOC = `
THE HARNESS (already loaded — do not re-implement any of this):
Layout: your markup goes in <div id="lab-stage"> (the main viewport). The side
panel, header, predict gate, legend, formula panel, reveal panel, and playback
bar already exist. window.Lab is available before your script runs.

Lab.predict.setup({ question, options: ["...", ...], correctIndex, explain })
    Shows the predict gate and LOCKS #lab-stage (blurred, uninteractable)
    until the learner commits a prediction + confidence. Call this FIRST.
Lab.predict.choice()            → committed option index (or null)
Lab.onStart(fn)                 fn runs when the gate unlocks — boot your sim here.
Lab.legend.add(color, label, shape="dot")   Register EVERY entity/color on screen.
Lab.formula.set([{ latex, symbols: {sym: meaning} }])   Renders KaTeX panel (only if KaTeX was injected).
Lab.formula.update(values)      e.g. Lab.formula.update({ F: "12.4 N" }) — live computed values.
Lab.formula.highlight(sym)      Flash the term tied to the control being moved (null to clear).
Lab.playback.attach({ onPlay, onPause, onStep, onSpeed })
    Wires the existing play/pause/step/speed bar to your sim loop. Attach this
    for ANY continuous animation.
Lab.reveal.show({ held, text })  End state: held = did their prediction hold.
    Reference THEIR choice via Lab.predict.choice(). Make the reveal land as a
    visible event in the sim too, not only text.
Lab.check(passed, detail)        Reports labCheck to the platform. Call with true
    when the learner reaches the success condition.
Lab.colors                       Brand palette: { mars:"#F26419", hot:"#FF8A3D", ice:"#4CC9F0", green:"#34D399", copper:"#D4A574", bg:"#0A0B10", panel:"#141726", text:"#E8EAF2", dim:"#8A90A6" }
Lab.lerp(a,b,t), Lab.clamp(v,lo,hi), Lab.fmt(n, digits)  utilities.

YOUR OUTPUT — exactly three fragments, nothing else:
<style>/* lab-specific css only — the harness styles the frame */</style>
<div id="lab-stage"><!-- your sim dom --></div>
<script>/* your logic. Boot inside Lab.onStart(). */</script>
`.trim();

// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Resolve the library list for a blueprint. Deterministic, validated, logged.
function selectNode(blueprint) {
  let type = (blueprint && blueprint.concept_type || "").trim();
  if (!VALID_CONCEPT_TYPES.includes(type)) {
    console.warn(`[node-selector] unknown concept_type "${type}" — defaulting to ${DEFAULT_CONCEPT_TYPE}`);
    type = DEFAULT_CONCEPT_TYPE;
  }
  const libs = new Set(NODE_ROUTES[type]);
  const contract = blueprint && blueprint.interaction_contract || {};
  if (contract.requiresPhysics) libs.add("matter");
  const hasFormulas = Array.isArray(blueprint && blueprint.formulas) && blueprint.formulas.length > 0;
  if (hasFormulas) libs.add("katex");
  return {
    conceptType: type,
    libs: [...libs],
    scriptTags: [...libs].map((l) => LIB_TAGS[l]).join("\n"),
    visualRules: VISUAL_RULES[type],
    hasFormulas,
  };
}

// Pull the three fragments out of GLM's output (tolerates surrounding noise,
// markdown fences, or a full accidental <html> wrapper).
function extractFragments(raw) {
  let s = String(raw || "");
  s = s.replace(/^```(?:html)?\s*/im, "").replace(/```\s*$/m, "");
  const style = (s.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [, ""])[1];
  const stage = (s.match(/<div id=["']lab-stage["'][^>]*>([\s\S]*)<\/div>\s*(?=<script)/i) || [, ""])[1];
  // last <script> block = the lab logic (earlier ones could be stray CDN tags)
  const scripts = [...s.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)];
  const script = scripts.length ? scripts[scripts.length - 1][1] : "";
  return { style, stage, script };
}

// Static validation — only what can be proven without executing the lab.
// Returns { ok, failures: [...] }.
function validateLab(fragments, node, rawOutput) {
  const failures = [];
  const raw = String(rawOutput || "");
  if (!raw.trim()) failures.push("output is blank");
  if (!fragments.script || fragments.script.trim().length < 200) failures.push("no <script> lab logic found (or under 200 chars)");
  if (!fragments.stage || !fragments.stage.trim()) failures.push('no <div id="lab-stage"> content found');
  // Truncation: an unterminated script/template or dangling brace balance.
  if (/<script(?![^>]*src=)[^>]*>(?![\s\S]*<\/script>)/i.test(raw)) failures.push("truncated: <script> never closes");
  if (fragments.script) {
    try {
      // Compile-only syntax check. Never executed.
      new Function(fragments.script); // eslint-disable-line no-new-func
    } catch (e) {
      failures.push(`script does not parse: ${e.message}`);
    }
    const listeners = (fragments.script.match(/addEventListener\s*\(/g) || []).length
                    + (fragments.script.match(/Lab\.playback\.attach|Lab\.predict\.setup/g) || []).length
                    + (fragments.stage.match(/\bon(click|input|change|pointerdown)=/gi) || []).length;
    if (listeners < 3) failures.push(`not interactive enough: ${listeners} listener wirings found, need >= 3`);
    if (!/Lab\.check\s*\(/.test(fragments.script)) failures.push("labCheck missing: no Lab.check() call");
    if (!/Lab\.predict\.setup\s*\(/.test(fragments.script)) failures.push("predict gate missing: no Lab.predict.setup() call");
    const needsRAF = ["dynamic-physical", "emergent", "probabilistic"].includes(node.conceptType);
    if (needsRAF && !/requestAnimationFrame|new\s+p5|Matter\.Runner|Lab\.playback\.attach/.test(fragments.script)) {
      failures.push(`concept_type ${node.conceptType} requires a live animation loop (requestAnimationFrame) — none found`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// The harness runtime + frame, assembled around GLM's fragments.

function buildLabHTML({ title, blueprint, node, fragments }) {
  const contract = blueprint.interaction_contract || {};
  const payoff = blueprint.payoff || "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Repend Lab</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
${node.scriptTags}
<style>
:root{--mars:#F26419;--hot:#FF8A3D;--ice:#4CC9F0;--green:#34D399;--copper:#D4A574;--bg:#0A0B10;--panel:#141726;--text:#E8EAF2;--dim:#8A90A6;--line:rgba(255,255,255,.08)}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font:400 15px/1.5 Inter,system-ui,sans-serif}
#hx-app{display:grid;grid-template-rows:auto 1fr auto;height:100%;max-width:1200px;margin:0 auto;padding:12px;gap:12px}
#hx-head{display:flex;align-items:baseline;gap:10px;padding:2px 4px}
#hx-head h1{font-size:17px;font-weight:800;letter-spacing:.01em}
#hx-head .hx-tag{font:600 11px/1 "JetBrains Mono",monospace;color:var(--mars);border:1px solid var(--mars);border-radius:99px;padding:4px 9px;text-transform:uppercase;letter-spacing:.08em}
#hx-main{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px;min-height:0}
#hx-stagewrap{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;min-height:320px}
#lab-stage{position:absolute;inset:0;transition:filter .3s}
#hx-stagewrap.hx-locked #lab-stage{filter:blur(7px) saturate(.6);pointer-events:none}
#hx-side{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto}
.hx-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
.hx-card h3{font:600 11px/1 "JetBrains Mono",monospace;color:var(--dim);text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px}
#hx-predict .hx-q{font-weight:600;margin-bottom:10px}
#hx-predict button.hx-opt{display:block;width:100%;text-align:left;background:transparent;border:1px solid var(--line);color:var(--text);border-radius:9px;padding:9px 11px;margin-bottom:7px;font:inherit;cursor:pointer}
#hx-predict button.hx-opt:hover{border-color:var(--mars)}
#hx-predict button.hx-opt.hx-sel{border-color:var(--mars);background:rgba(242,100,25,.12)}
#hx-conf{display:flex;gap:6px;margin:8px 0 10px}
#hx-conf button{flex:1;background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:6px 0;font:600 12px Inter;cursor:pointer}
#hx-conf button.hx-sel{color:var(--mars);border-color:var(--mars)}
#hx-commit{width:100%;background:var(--mars);border:0;color:#fff;font:600 14px Inter;border-radius:9px;padding:10px;cursor:pointer}
#hx-commit:disabled{opacity:.35;cursor:default}
#hx-legend ul{list-style:none;display:flex;flex-direction:column;gap:7px}
#hx-legend li{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--dim)}
.hx-sw{width:13px;height:13px;border-radius:50%;flex:none}
.hx-sw.square{border-radius:3px}.hx-sw.line{height:3px;border-radius:2px}
#hx-formula .katex{font-size:1.05em}
#hx-formula .hx-fx{padding:7px;border-radius:8px;transition:background .25s}
#hx-formula .hx-fx.hx-hot{background:rgba(242,100,25,.16)}
#hx-formula .hx-vals{font:600 12px "JetBrains Mono",monospace;color:var(--ice);margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 14px}
#hx-formula .hx-syms{font-size:12px;color:var(--dim);margin-top:8px}
#hx-reveal{display:none;border-color:var(--green)}
#hx-reveal.hx-show{display:block}
#hx-reveal.hx-miss{border-color:var(--hot)}
#hx-reveal .hx-verdict{font-weight:800;margin-bottom:6px}
#hx-reveal .hx-payoff{margin-top:9px;font-size:13px;color:var(--copper)}
#hx-bar{display:none;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px 12px}
#hx-bar.hx-show{display:flex}
#hx-bar button{background:transparent;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 12px;font:600 13px Inter;cursor:pointer}
#hx-bar button:hover{border-color:var(--mars)}
#hx-bar input[type=range]{flex:1;accent-color:var(--mars)}
#hx-bar .hx-speed{font:600 12px "JetBrains Mono",monospace;color:var(--dim);min-width:38px;text-align:right}
@media (max-width:760px){#hx-main{grid-template-columns:1fr}#hx-stagewrap{min-height:52vh}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}
</style>
<style>${fragments.style}</style>
</head>
<body>
<div id="hx-app">
  <div id="hx-head"><h1>${escapeHtml(title)}</h1><span class="hx-tag">${escapeHtml(node.conceptType)}</span></div>
  <div id="hx-main">
    <div id="hx-stagewrap" class="hx-locked"><div id="lab-stage">${fragments.stage}</div></div>
    <div id="hx-side">
      <div class="hx-card" id="hx-predict"><h3>Predict first</h3><div class="hx-q"></div><div class="hx-opts"></div>
        <div id="hx-conf"><button data-c="1">Guessing</button><button data-c="2">Fairly sure</button><button data-c="3">Certain</button></div>
        <button id="hx-commit" disabled>Lock it in</button></div>
      <div class="hx-card" id="hx-legend" style="display:none"><h3>Legend</h3><ul></ul></div>
      <div class="hx-card" id="hx-formula" style="display:none"><h3>The math, live</h3><div class="hx-fxs"></div><div class="hx-vals"></div><div class="hx-syms"></div></div>
      <div class="hx-card" id="hx-reveal"><h3>Reveal</h3><div class="hx-verdict"></div><div class="hx-text"></div><div class="hx-payoff">${escapeHtml(payoff)}</div></div>
    </div>
  </div>
  <div id="hx-bar"><button data-a="play">▶ Play</button><button data-a="pause">⏸ Pause</button><button data-a="step">⏭ Step</button><input type="range" min="0.25" max="4" step="0.25" value="1"><span class="hx-speed">1.0×</span></div>
</div>
<script>
(function(){
"use strict";
var $=function(s){return document.querySelector(s)};
var startFns=[],committed=null,confidence=null,predictCfg=null;
var Lab={
  colors:{mars:"#F26419",hot:"#FF8A3D",ice:"#4CC9F0",green:"#34D399",copper:"#D4A574",bg:"#0A0B10",panel:"#141726",text:"#E8EAF2",dim:"#8A90A6"},
  lerp:function(a,b,t){return a+(b-a)*t},
  clamp:function(v,lo,hi){return Math.min(hi,Math.max(lo,v))},
  fmt:function(n,d){return Number(n).toFixed(d==null?2:d)},
  onStart:function(fn){startFns.push(fn)},
  predict:{
    setup:function(cfg){
      predictCfg=cfg||{};
      $("#hx-predict .hx-q").textContent=predictCfg.question||"";
      var box=$("#hx-predict .hx-opts");box.innerHTML="";
      (predictCfg.options||[]).forEach(function(opt,i){
        var b=document.createElement("button");b.className="hx-opt";b.textContent=opt;
        b.onclick=function(){box.querySelectorAll(".hx-opt").forEach(function(x){x.classList.remove("hx-sel")});b.classList.add("hx-sel");committed=i;arm()};
        box.appendChild(b);
      });
    },
    choice:function(){return committed}
  },
  legend:{add:function(color,label,shape){
    var card=$("#hx-legend");card.style.display="block";
    var li=document.createElement("li"),sw=document.createElement("span");
    sw.className="hx-sw "+(shape||"dot");sw.style.background=color;
    li.appendChild(sw);li.appendChild(document.createTextNode(label));
    card.querySelector("ul").appendChild(li);
  }},
  formula:{
    _syms:{},
    set:function(list){
      if(!window.katex)return;
      var card=$("#hx-formula");card.style.display="block";
      var fxs=card.querySelector(".hx-fxs");fxs.innerHTML="";var symBox=card.querySelector(".hx-syms");var allSyms={};
      (list||[]).forEach(function(f){
        var d=document.createElement("div");d.className="hx-fx";
        try{katex.render(f.latex,d,{throwOnError:false})}catch(e){d.textContent=f.latex}
        fxs.appendChild(d);
        Object.keys(f.symbols||{}).forEach(function(k){allSyms[k]=f.symbols[k]});
      });
      Lab.formula._syms=allSyms;
      symBox.textContent=Object.keys(allSyms).map(function(k){return k+" = "+allSyms[k]}).join(" · ");
    },
    update:function(values){
      var box=$("#hx-formula .hx-vals");box.innerHTML="";
      Object.keys(values||{}).forEach(function(k){
        var s=document.createElement("span");s.textContent=k+" = "+values[k];box.appendChild(s);
      });
    },
    highlight:function(sym){
      document.querySelectorAll("#hx-formula .hx-fx").forEach(function(d){d.classList.toggle("hx-hot",!!sym)});
    }
  },
  playback:{attach:function(h){
    h=h||{};var bar=$("#hx-bar");bar.classList.add("hx-show");
    bar.querySelectorAll("button").forEach(function(b){
      b.onclick=function(){var a=b.getAttribute("data-a");
        if(a==="play"&&h.onPlay)h.onPlay();if(a==="pause"&&h.onPause)h.onPause();if(a==="step"&&h.onStep)h.onStep()};
    });
    var r=bar.querySelector("input");
    r.oninput=function(){bar.querySelector(".hx-speed").textContent=Number(r.value).toFixed(2).replace(/0$/,"")+"×";if(h.onSpeed)h.onSpeed(parseFloat(r.value))};
  }},
  reveal:{show:function(o){
    o=o||{};var card=$("#hx-reveal");card.classList.add("hx-show");card.classList.toggle("hx-miss",o.held===false);
    card.querySelector(".hx-verdict").textContent=o.held===false?"Your prediction broke — here's why":"Your prediction held";
    card.querySelector(".hx-text").textContent=o.text||"";
  }},
  check:function(passed,detail){
    try{window.parent.postMessage({type:"labCheck",passed:!!passed,detail:detail||null,confidence:confidence,prediction:committed},"*")}catch(e){}
  }
};
function arm(){$("#hx-commit").disabled=!(committed!=null&&confidence!=null)}
document.querySelectorAll("#hx-conf button").forEach(function(b){
  b.onclick=function(){document.querySelectorAll("#hx-conf button").forEach(function(x){x.classList.remove("hx-sel")});b.classList.add("hx-sel");confidence=parseInt(b.getAttribute("data-c"),10);arm()};
});
$("#hx-commit").onclick=function(){
  $("#hx-stagewrap").classList.remove("hx-locked");
  $("#hx-predict").style.display="none";
  startFns.forEach(function(f){try{f()}catch(e){console.error("[lab] onStart error:",e)}});
};
window.Lab=Lab;
})();
</script>
<script>${fragments.script}</script>
</body>
</html>`;
}

module.exports = {
  LIB_TAGS,
  NODE_ROUTES,
  VALID_CONCEPT_TYPES,
  VISUAL_RULES,
  HARNESS_API_DOC,
  selectNode,
  extractFragments,
  validateLab,
  buildLabHTML,
};
