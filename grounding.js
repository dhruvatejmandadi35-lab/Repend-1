// grounding.js — fact-grounding layer for the lab pipeline.
//
// Before the spec/reasoning stages run, we pull verified facts about the topic
// so the LLM grounds its formulas, constants, and claims in reality instead of
// hallucinating them. Three free sources, all fail-open (a dead source never
// blocks lab generation):
//   • Wikipedia REST/action API — intro extract (the substantive facts). No key.
//   • Wikidata — one-line structured description of the matched entity. No key.
//   • Tavily — fresh, cited web answer. Optional: only runs if TAVILY_API_KEY set.
//
// Returns { text, sources } or null when nothing usable came back.

const UA = "Repend/1.0 (educational labs; hmandadi@gmail.com)";

async function jget(url, timeout = 8000) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// Wikipedia: search for the best-matching page, then pull its intro extract.
async function wikipediaFacts(topic) {
  const s = await jget(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&srlimit=1&format=json&origin=*`
  );
  const hit = s?.query?.search?.[0];
  if (!hit) return null;
  const title = hit.title;
  const e = await jget(
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`
  );
  const page = Object.values(e?.query?.pages || {})[0];
  const extract = page?.extract?.trim();
  if (!extract) return null;
  return {
    title,
    extract: extract.slice(0, 1500),
    wikidataId: page?.pageprops?.wikibase_item || null,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  };
}

// Wikidata: a single human-readable description for the matched entity.
async function wikidataFacts(qid) {
  if (!qid) return null;
  const d = await jget(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=descriptions&languages=en&format=json&origin=*`
  );
  const desc = d?.entities?.[qid]?.descriptions?.en?.value;
  return desc ? { qid, description: desc, url: `https://www.wikidata.org/wiki/${qid}` } : null;
}

// Tavily: cited web answer. Skipped silently when no API key is configured.
async function tavilyFacts(topic) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query: `key facts, real formulas, constants, and real numbers for teaching: ${topic}`,
      search_depth: "basic",
      include_answer: true,
      max_results: 4,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`tavily HTTP ${r.status}`);
  const j = await r.json();
  const answer = j?.answer?.trim() || null;
  const sources = (j?.results || []).slice(0, 4).map(x => ({ title: x.title, url: x.url }));
  if (!answer && !sources.length) return null;
  return { answer: answer ? answer.slice(0, 1200) : null, sources };
}

// Orchestrator: gather all sources in parallel, fail-open on each.
async function groundTopic(topic, category = "General") {
  const [wikiR, tavR] = await Promise.allSettled([
    wikipediaFacts(topic).then(async w =>
      w ? { w, wd: await wikidataFacts(w.wikidataId).catch(() => null) } : null
    ),
    tavilyFacts(topic),
  ]);

  const parts = [];
  const sources = [];

  if (wikiR.status === "fulfilled" && wikiR.value) {
    const { w, wd } = wikiR.value;
    parts.push(`ENCYCLOPEDIC GROUNDING (Wikipedia — "${w.title}"):\n${w.extract}`);
    sources.push({ source: "Wikipedia", url: w.url });
    if (wd) {
      parts.push(`STRUCTURED FACT (Wikidata ${wd.qid}): ${wd.description}`);
      sources.push({ source: "Wikidata", url: wd.url });
    }
  }

  if (tavR.status === "fulfilled" && tavR.value) {
    if (tavR.value.answer) parts.push(`LIVE WEB GROUNDING (Tavily):\n${tavR.value.answer}`);
    for (const s of tavR.value.sources || []) sources.push({ source: s.title || "web", url: s.url });
  }

  if (!parts.length) return null;
  return { text: parts.join("\n\n"), sources };
}

module.exports = { groundTopic };
