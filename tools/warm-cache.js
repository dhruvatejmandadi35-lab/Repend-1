#!/usr/bin/env node
/**
 * Lab cache warmer — pre-generates every TOPIC_CATALOG lab into the Supabase
 * `labs` cache so catalog users (and investor demos) get ~2s cached labs
 * instead of the ~5-minute live pipeline.
 *
 * Pure client of the existing POST /plan-lab SSE endpoint — no server changes.
 * Runs SERIALLY on purpose: NVIDIA Build free tier accepts one codegen request
 * at a time (see withKimiLock in server.js); parallel submits would just queue
 * and risk idle-stall aborts.
 *
 * Usage:
 *   npm run warm                                  # all 49 topics vs localhost
 *   BASE_URL=https://your.app npm run warm        # against deployed server
 *   ONLY_CATEGORY="Everyday Science" npm run warm # partial run
 *
 * Idempotent: topics already cached are skipped by the pipeline itself
 * (source: "cached" comes back in ~2s). Rerun any time prompts change.
 * Exit code 1 if any topic failed, so a cron wrapper can alert.
 */

require("../repend-game.js"); // UMD — attaches RependGame to global in Node
const TOPIC_CATALOG = global.RependGame.TOPIC_CATALOG;

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ONLY_CATEGORY = process.env.ONLY_CATEGORY || null;

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// POST /plan-lab and consume the SSE stream until a done/error event.
// Resolves { status: "generated" | "cached" | "failed", detail }.
async function warmTopic(topic, category) {
  // skipSimilar: catalog topics are canonical — each must get its OWN cached
  // lab. Without it, a fuzzy match sends a non-terminal "similar_found" event
  // and ends the stream, and the topic never enters the cache.
  const res = await fetch(`${BASE_URL}/plan-lab`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, category, skipSimilar: true }),
  });
  if (!res.ok || !res.body) {
    return { status: "failed", detail: `HTTP ${res.status}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by blank lines; each data line is JSON.
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split("\n").find(l => l.startsWith("data: "));
      if (!line) continue; // heartbeat comment
      let evt;
      try { evt = JSON.parse(line.slice(6)); } catch { continue; }
      if (evt.stage === "error") {
        return { status: "failed", detail: evt.msg || "pipeline error" };
      }
      if (evt.stage === "similar_found") {
        // Shouldn't happen with skipSimilar:true — but if it does, surface it
        // clearly instead of misreporting a hang/failure.
        return { status: "failed", detail: "server offered similar lab despite skipSimilar (check request body parsing)" };
      }
      if (evt.stage === "done") {
        const cached = evt.data?.source === "cached";
        return { status: cached ? "cached" : "generated", detail: evt.data?.timings || null };
      }
    }
  }
  return { status: "failed", detail: "stream ended without done event" };
}

async function main() {
  const entries = Object.entries(TOPIC_CATALOG)
    .filter(([cat]) => !ONLY_CATEGORY || cat === ONLY_CATEGORY)
    .flatMap(([cat, topics]) => topics.map(t => [cat, t]));

  if (entries.length === 0) {
    console.error(`No topics matched ONLY_CATEGORY="${ONLY_CATEGORY}". Categories: ${Object.keys(TOPIC_CATALOG).join(", ")}`);
    process.exit(1);
  }

  console.log(`[warm] ${entries.length} topics → ${BASE_URL} (serial; codegen is single-lane on free tier)`);
  const counts = { generated: 0, cached: 0, failed: 0 };
  const failures = [];
  const runStart = Date.now();

  for (let i = 0; i < entries.length; i++) {
    const [category, topic] = entries[i];
    const n = `${String(i + 1).padStart(2)}/${entries.length}`;
    const t0 = Date.now();
    let result;
    try {
      result = await warmTopic(topic, category);
    } catch (err) {
      result = { status: "failed", detail: err.message };
    }
    counts[result.status]++;
    const took = fmtDur(Date.now() - t0);
    if (result.status === "generated") {
      console.log(`[warm] ${n} "${topic}" (${category}) — generated in ${took}`);
    } else if (result.status === "cached") {
      console.log(`[warm] ${n} "${topic}" (${category}) — cached, skipped (${took})`);
    } else {
      failures.push(`"${topic}" (${category}): ${result.detail}`);
      console.error(`[warm] ${n} "${topic}" (${category}) — FAILED after ${took}: ${result.detail}`);
    }
  }

  console.log(`\n[warm] done in ${fmtDur(Date.now() - runStart)} — generated: ${counts.generated}, cached: ${counts.cached}, failed: ${counts.failed}`);
  if (failures.length) {
    console.error(`[warm] failures:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
}

main().catch(err => { console.error("[warm] fatal:", err); process.exit(1); });
