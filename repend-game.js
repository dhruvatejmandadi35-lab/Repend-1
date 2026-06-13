/**
 * Repend gamification — XP, levels, badges, quests, mastery, spaced review (localStorage).
 */
(function (global) {
  const STORAGE_KEY = "repend_game_v1";
  const WEEKLY_GOAL = 3;
  const REVIEW_DAYS = 3;

  const TOPIC_CATALOG = {
    "Physics": ["Newton's Second Law", "Orbital Mechanics", "Wave Interference", "Conservation of Momentum", "Doppler Effect", "Pendulum Resonance", "Black Holes", "Ohm's Law", "Heat Transfer", "Terminal Velocity"],
    "Biology": ["Natural Selection", "DNA Replication", "Photosynthesis", "Enzyme Kinetics", "Predator-Prey Dynamics", "Osmosis", "Herd Immunity", "Genetic Drift", "Action Potentials"],
    "Money & Econ": ["Compound Interest", "Supply and Demand", "Inflation", "Opportunity Cost", "Loan Amortization", "Market Equilibrium", "Diversification and Risk", "Price Elasticity"],
    "Math & Data": ["Central Limit Theorem", "Exponential Growth", "Bayes' Theorem", "Correlation vs Causation", "Sampling Bias", "Logarithmic Scales", "The Birthday Paradox", "Linear Regression"],
    "Sports & Skills": ["Basketball Free-Throw Arc", "Golf Swing Plane", "Soccer Curve Shot", "Tennis Topspin", "Swimming Drag Reduction", "Baseball Pitch Break"],
    "Everyday Science": ["Why Planes Fly", "How Microwaves Heat Food", "Why the Sky Is Blue", "How Vaccines Work", "Why Ice Floats", "How GPS Works", "Caffeine Half-Life", "How Noise-Canceling Works"],
  };

  const CATEGORY_ICONS = {
    "Physics": "⚛️",
    "Biology": "🧬",
    "Money & Econ": "💰",
    "Math & Data": "📊",
    "Sports & Skills": "🏀",
    "Everyday Science": "🔬",
    "General": "🌐",
  };

  const MASTERY_LABELS = ["Not started", "Started", "Familiar", "Proficient", "Mastered"];

  const LEVELS = [
    { level: 1,  title: "Rookie",      xp: 0 },
    { level: 2,  title: "Explorer",    xp: 100 },
    { level: 3,  title: "Apprentice",  xp: 250 },
    { level: 4,  title: "Scholar",     xp: 500 },
    { level: 5,  title: "Specialist",  xp: 900 },
    { level: 6,  title: "Expert",      xp: 1400 },
    { level: 7,  title: "Master",      xp: 2100 },
    { level: 8,  title: "Virtuoso",    xp: 3000 },
    { level: 9,  title: "Legend",      xp: 4200 },
    { level: 10, title: "Grandmaster", xp: 6000 },
  ];

  const BADGES = [
    { id: "first_lab",      name: "First Steps",       icon: "🚀", desc: "Complete your first lab",           check: s => s.labsCompleted >= 1 },
    { id: "five_labs",      name: "On a Roll",         icon: "🔥", desc: "Complete 5 labs",                   check: s => s.labsCompleted >= 5 },
    { id: "ten_labs",       name: "Dedicated",         icon: "💎", desc: "Complete 10 labs",                  check: s => s.labsCompleted >= 10 },
    { id: "perfect",        name: "Flawless",          icon: "⭐", desc: "Get a perfect score on any lab",    check: s => s.perfectScores >= 1 },
    { id: "three_perfect",  name: "Perfectionist",     icon: "✨", desc: "3 perfect scores",                  check: s => s.perfectScores >= 3 },
    { id: "sports",         name: "Athlete",           icon: "🏀", desc: "Complete a Sports & Skills lab",    check: s => s.categories.has("Sports & Skills") },
    { id: "physics",        name: "Physicist",         icon: "⚛️", desc: "Complete a Physics lab",              check: s => s.categories.has("Physics") },
    { id: "biology",        name: "Biologist",         icon: "🧬", desc: "Complete a Biology lab",              check: s => s.categories.has("Biology") },
    { id: "explorer_cat",   name: "Polymath",          icon: "🌐", desc: "Labs in 3+ categories",             check: s => s.categories.size >= 3 },
    { id: "streak_3",       name: "Streak Starter",    icon: "📅", desc: "3-day learning streak",             check: s => s.streak >= 3 },
    { id: "streak_7",       name: "Week Warrior",      icon: "🏆", desc: "7-day learning streak",             check: s => s.streak >= 7 },
    { id: "level_5",        name: "Rising Star",       icon: "🌟", desc: "Reach level 5",                     check: s => s.level >= 5 },
    { id: "level_10",       name: "Elite",             icon: "👑", desc: "Reach level 10",                    check: s => s.level >= 10 },
    { id: "xp_1000",        name: "XP Hunter",         icon: "⚡", desc: "Earn 1,000 total XP",               check: s => s.xp >= 1000 },
    { id: "quest_master",   name: "Quest Master",      icon: "🎯", desc: "Complete all starter quests",       check: s => s.questsCompleted >= 6 },
    { id: "weekly_hero",    name: "Weekly Hero",       icon: "📆", desc: "Hit your weekly lab goal",          check: s => s.weeklyGoalHits >= 1 },
    { id: "reviewer",       name: "Sharp Mind",        icon: "🧠", desc: "Complete a spaced review lab",      check: s => s.reviewsCompleted >= 1 },
    { id: "master_physics", name: "Physics Master",    icon: "🪐", desc: "Master Physics category",           check: s => s.mastery?.Physics?.label === "Mastered" },
  ];

  const QUESTS = [
    { id: "q_first",    title: "Launch Pad",       desc: "Complete any lab",                    goal: 1, track: s => s.labsCompleted, xp: 50 },
    { id: "q_physics",  title: "Force Field",      desc: "Complete a Physics lab",              goal: 1, track: s => s.categories.has("Physics") ? 1 : 0, xp: 75 },
    { id: "q_perfect",  title: "Bullseye",         desc: "Score perfect on a quiz",             goal: 1, track: s => s.perfectScores, xp: 100 },
    { id: "q_weekly",   title: "Weekly Target",    desc: "Complete 3 labs this week",           goal: 3, track: s => s.weeklyLabs || 0, xp: 120 },
    { id: "q_explore",  title: "Broad Horizons",   desc: "Try labs in 2 different categories",  goal: 2, track: s => s.categories.size, xp: 80 },
    { id: "q_review",   title: "Memory Boost",     desc: "Complete a review lab",               goal: 1, track: s => s.reviewsCompleted || 0, xp: 90 },
  ];

  function defaultState() {
    return {
      xp: 0,
      labsCompleted: 0,
      perfectScores: 0,
      reviewsCompleted: 0,
      weeklyGoalHits: 0,
      categories: [],
      badges: [],
      questsDone: [],
      history: [],
      bookmarks: [],
      reviewQueue: [],
      lastSession: null,
      streak: 0,
      lastActiveDate: null,
      weekKey: null,
      weeklyLabs: 0,
    };
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function getWeekKey() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().slice(0, 10);
  }

  function addDays(dateStr, days) {
    const d = new Date(dateStr + "T12:00:00");
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function normalizeState(s) {
    s.categories = s.categories instanceof Set ? s.categories : new Set(s.categories || []);
    s.bookmarks = s.bookmarks || [];
    s.reviewQueue = s.reviewQueue || [];
    s.reviewsCompleted = s.reviewsCompleted || 0;
    s.weeklyGoalHits = s.weeklyGoalHits || 0;
    return s;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      return normalizeState(JSON.parse(raw));
    } catch {
      return defaultState();
    }
  }

  function save(state) {
    const out = { ...state, categories: [...state.categories] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  }

  function getLevelInfo(xp) {
    let cur = LEVELS[0];
    let next = LEVELS[1] || null;
    for (let i = LEVELS.length - 1; i >= 0; i--) {
      if (xp >= LEVELS[i].xp) {
        cur = LEVELS[i];
        next = LEVELS[i + 1] || null;
        break;
      }
    }
    const xpInto = xp - cur.xp;
    const xpNeed = next ? next.xp - cur.xp : 1;
    const pct = next ? Math.min(100, (xpInto / xpNeed) * 100) : 100;
    return { level: cur.level, title: cur.title, xp, xpInto, xpNeed, pct, nextLevel: next?.level || null };
  }

  function updateStreak(state) {
    const today = todayStr();
    if (state.lastActiveDate === today) return state;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);
    if (state.lastActiveDate === yStr) state.streak = (state.streak || 0) + 1;
    else if (state.lastActiveDate !== today) state.streak = 1;
    state.lastActiveDate = today;
    return state;
  }

  function trackWeekly(state) {
    const week = getWeekKey();
    if (state.weekKey !== week) {
      state.weekKey = week;
      state.weeklyLabs = 0;
    }
    state.weeklyLabs += 1;
    if (state.weeklyLabs === WEEKLY_GOAL) state.weeklyGoalHits = (state.weeklyGoalHits || 0) + 1;
    return state;
  }

  function inferCategory(topic) {
    const t = (topic || "").toLowerCase();
    const map = {
      "Sports & Skills": ["basketball", "tennis", "golf", "soccer", "swim", "baseball", "free-throw", "pitch"],
      "Physics": ["newton", "orbit", "wave", "momentum", "ohm", "heat", "velocity", "doppler", "pendulum", "black hole"],
      "Biology": ["natural selection", "dna", "photosynthesis", "enzyme", "osmosis", "immunity", "genetic", "action potential"],
      "Money & Econ": ["interest", "supply", "inflation", "opportunity", "loan", "market", "elasticity", "diversif"],
      "Math & Data": ["theorem", "exponential", "bayes", "correlation", "regression", "sampling", "logarithm", "birthday"],
      "Everyday Science": ["plane", "microwave", "sky", "vaccine", "ice float", "gps", "caffeine", "noise"],
    };
    for (const [cat, keys] of Object.entries(map)) {
      if (keys.some(k => t.includes(k))) return cat;
    }
    return "General";
  }

  function getCategoryMastery(state, category) {
    const count = (state.history || []).filter(h => h.category === category).length;
    const idx = Math.min(count, MASTERY_LABELS.length - 1);
    const pct = Math.min(100, count * 25);
    return { category, count, pct, label: MASTERY_LABELS[idx], icon: CATEGORY_ICONS[category] || "📚" };
  }

  function getAllMastery(state) {
    return Object.keys(TOPIC_CATALOG).map(cat => getCategoryMastery(state, cat));
  }

  function getDailyChallenge(catalog) {
    catalog = catalog || TOPIC_CATALOG;
    const date = todayStr();
    const cats = Object.keys(catalog);
    const h = hashStr(date);
    const cat = cats[h % cats.length];
    const topics = catalog[cat];
    const topic = topics[(h >> 4) % topics.length];
    return { topic, category: cat, date, bonusXp: 25 };
  }

  function isTopicDone(state, topic) {
    const key = (topic || "").toLowerCase();
    return (state.history || []).some(h => h.topic.toLowerCase() === key);
  }

  function getRecommendations(state, catalog, count) {
    catalog = catalog || TOPIC_CATALOG;
    count = count || 4;
    const done = new Set((state.history || []).map(h => h.topic.toLowerCase()));
    const pool = [];
    for (const [category, topics] of Object.entries(catalog)) {
      for (const topic of topics) {
        if (!done.has(topic.toLowerCase())) pool.push({ topic, category });
      }
    }
    const touched = [...state.categories];
    pool.sort((a, b) => {
      const aT = touched.includes(a.category) ? 0 : 1;
      const bT = touched.includes(b.category) ? 0 : 1;
      if (aT !== bT) return aT - bT;
      return hashStr(a.topic) % 100 - hashStr(b.topic) % 100;
    });
    return pool.slice(0, count);
  }

  function scheduleReview(state, topic, category) {
    const key = topic.toLowerCase();
    state.reviewQueue = (state.reviewQueue || []).filter(r => r.topic.toLowerCase() !== key);
    state.reviewQueue.push({
      topic,
      category,
      dueDate: addDays(todayStr(), REVIEW_DAYS),
      scheduledAt: new Date().toISOString(),
    });
    state.reviewQueue = state.reviewQueue.slice(0, 20);
    return state;
  }

  function getDueReviews(state) {
    const today = todayStr();
    return (state.reviewQueue || []).filter(r => r.dueDate <= today);
  }

  function completeReview(state, topic) {
    const key = (topic || "").toLowerCase();
    state.reviewQueue = (state.reviewQueue || []).filter(r => r.topic.toLowerCase() !== key);
    state.reviewsCompleted = (state.reviewsCompleted || 0) + 1;
    return state;
  }

  function setLastSession(topic, category) {
    const state = load();
    state.lastSession = { topic, category, at: new Date().toISOString() };
    save(state);
  }

  function toggleBookmark(topic, category) {
    const state = load();
    const key = topic.toLowerCase();
    const idx = (state.bookmarks || []).findIndex(b => b.topic.toLowerCase() === key);
    if (idx >= 0) state.bookmarks.splice(idx, 1);
    else {
      state.bookmarks.unshift({ topic, category, at: new Date().toISOString() });
      state.bookmarks = state.bookmarks.slice(0, 30);
    }
    save(state);
    return isBookmarked(topic);
  }

  function isBookmarked(topic) {
    const key = (topic || "").toLowerCase();
    return (load().bookmarks || []).some(b => b.topic.toLowerCase() === key);
  }

  function checkNewBadges(state) {
    const unlocked = [];
    const mastery = {};
    for (const cat of Object.keys(TOPIC_CATALOG)) {
      mastery[cat] = getCategoryMastery(state, cat);
    }
    const snapshot = {
      ...state,
      categories: state.categories,
      level: getLevelInfo(state.xp).level,
      questsCompleted: state.questsDone.length,
      mastery,
    };
    for (const b of BADGES) {
      if (state.badges.includes(b.id)) continue;
      if (b.check(snapshot)) {
        state.badges.push(b.id);
        unlocked.push(b);
      }
    }
    return unlocked;
  }

  function checkQuests(state) {
    const completed = [];
    const snap = { ...state, categories: state.categories };
    for (const q of QUESTS) {
      if (state.questsDone.includes(q.id)) continue;
      if (q.track(snap) >= q.goal) {
        state.questsDone.push(q.id);
        state.xp += q.xp;
        completed.push(q);
      }
    }
    return completed;
  }

  function completeLab({ topic, topicKey, category, score = 1, perfect = false, isReview = false, isDaily = false }) {
    let state = load();
    state = updateStreak(state);
    state = trackWeekly(state);
    const cat = category || inferCategory(topic);
    state.categories.add(cat);
    state.labsCompleted += 1;
    if (perfect) state.perfectScores += 1;
    if (isReview) state = completeReview(state, topic);

    let xpGain = 100;
    if (perfect) xpGain += 50;
    if (isReview) xpGain += 40;
    if (isDaily) xpGain += 25;
    if (state.streak >= 3) xpGain += Math.floor(xpGain * 0.1 * Math.min(state.streak, 7));

    const prevLevel = getLevelInfo(state.xp).level;
    state.xp += xpGain;
    const newLevel = getLevelInfo(state.xp).level;

    state.history.unshift({
      topic,
      topicKey: topicKey || topic,
      category: cat,
      xp: xpGain,
      perfect,
      isReview,
      isDaily,
      at: new Date().toISOString(),
    });
    state.history = state.history.slice(0, 50);
    state = scheduleReview(state, topic, cat);

    const questsDone = checkQuests(state);
    const badges = checkNewBadges(state);
    save(state);

    return {
      xpGain,
      levelUp: newLevel > prevLevel,
      newLevel: getLevelInfo(state.xp),
      badges,
      questsDone,
      recommendations: getRecommendations(state, TOPIC_CATALOG, 3),
      isDaily,
      isReview,
      state: exportState(state),
    };
  }

  function exportState(state) {
    state = normalizeState(state || load());
    const info = getLevelInfo(state.xp);
    const week = getWeekKey();
    if (state.weekKey !== week) {
      state.weekKey = week;
      state.weeklyLabs = 0;
    }
    return {
      xp: state.xp,
      labsCompleted: state.labsCompleted,
      perfectScores: state.perfectScores,
      reviewsCompleted: state.reviewsCompleted,
      weeklyGoalHits: state.weeklyGoalHits,
      streak: state.streak,
      weeklyLabs: state.weeklyLabs || 0,
      weeklyGoal: WEEKLY_GOAL,
      weeklyPct: Math.min(100, ((state.weeklyLabs || 0) / WEEKLY_GOAL) * 100),
      level: info.level,
      title: info.title,
      xpPct: info.pct,
      xpInto: info.xpInto,
      xpNeed: info.xpNeed,
      categories: [...state.categories],
      bookmarks: state.bookmarks || [],
      lastSession: state.lastSession,
      dailyChallenge: getDailyChallenge(),
      dueReviews: getDueReviews(state),
      recommendations: getRecommendations(state, TOPIC_CATALOG, 4),
      mastery: getAllMastery(state),
      badges: state.badges.map(id => BADGES.find(b => b.id === id)).filter(Boolean),
      allBadges: BADGES.map(b => ({ ...b, unlocked: state.badges.includes(b.id) })),
      quests: QUESTS.map(q => ({
        ...q,
        done: state.questsDone.includes(q.id),
        progress: Math.min(q.goal, q.track({ ...state, categories: state.categories })),
      })),
      history: state.history || [],
    };
  }

  function showToast(msg, type = "xp") {
    let el = document.getElementById("repend-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "repend-toast";
      el.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:9999;padding:14px 22px;border-radius:12px;font-family:Inter,sans-serif;font-weight:700;font-size:0.9rem;opacity:0;transform:translateY(12px);transition:all 0.35s;pointer-events:none;";
      document.body.appendChild(el);
    }
    el.style.background = type === "level" ? "linear-gradient(135deg,#E85D04,#8B4513)" : "rgba(10,15,30,0.95)";
    el.style.border = "1px solid rgba(232,93,4,0.35)";
    el.style.color = "#F4F0EB";
    el.style.boxShadow = "0 8px 32px rgba(232,93,4,0.25)";
    el.textContent = msg;
    requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateY(0)"; });
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(12px)"; }, 3200);
  }

  function showLevelUpModal(info) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(5,5,8,0.85);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);animation:fadeIn 0.3s";
    overlay.innerHTML = `
      <div style="text-align:center;padding:48px;border-radius:20px;background:rgba(12,14,24,0.95);border:1px solid rgba(232,93,4,0.4);max-width:360px;animation:scaleIn 0.4s">
        <div style="font-size:3rem;margin-bottom:12px">⬆️</div>
        <div style="font-size:0.75rem;letter-spacing:2px;text-transform:uppercase;color:#4CC9F0;margin-bottom:8px">Level Up</div>
        <div style="font-size:2.5rem;font-weight:900;color:#E85D04;margin-bottom:4px">Level ${info.level}</div>
        <div style="font-size:1.1rem;color:#4CC9F0;font-weight:700">${info.title}</div>
        <button style="margin-top:28px;background:linear-gradient(135deg,#E85D04,#8B4513);border:none;color:#fff;padding:12px 32px;border-radius:10px;font-weight:700;cursor:pointer;font-size:0.95rem">Continue</button>
      </div>`;
    if (!document.getElementById("repend-anim-styles")) {
      const st = document.createElement("style");
      st.id = "repend-anim-styles";
      st.textContent = "@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes scaleIn{from{transform:scale(0.85);opacity:0}to{transform:scale(1);opacity:1}}";
      document.head.appendChild(st);
    }
    overlay.querySelector("button").onclick = () => overlay.remove();
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }

  function handleCompletion(result) {
    const extras = [];
    if (result.isDaily) extras.push("Daily bonus");
    if (result.isReview) extras.push("Review bonus");
    showToast(`+${result.xpGain} XP${extras.length ? " · " + extras.join(" · ") : ""}${result.badges.length ? " · Badge!" : ""}`);
    if (result.levelUp) setTimeout(() => showLevelUpModal(result.newLevel), 600);
    if (result.badges.length) {
      result.badges.forEach((b, i) => {
        setTimeout(() => showToast(`${b.icon} ${b.name} unlocked!`, "level"), 800 + i * 1200);
      });
    }
    renderNavXP();
  }

  function renderNavXP() {
    const el = document.getElementById("nav-xp-bar");
    if (!el) return;
    const s = exportState();
    const streakHtml = s.streak > 0 ? `<span class="nav-streak" title="${s.streak}-day streak">🔥${s.streak}</span>` : "";
    el.innerHTML = `
      <div class="nav-xp-inner">
        ${streakHtml}
        <span class="nav-lvl">Lv ${s.level}</span>
        <div class="nav-xp-track"><div class="nav-xp-fill" style="width:${s.xpPct}%"></div></div>
        <span class="nav-xp-num">${s.xp} XP</span>
      </div>`;
  }

  global.RependGame = {
    load,
    save,
    completeLab,
    exportState,
    inferCategory,
    getLevelInfo,
    getDailyChallenge,
    getRecommendations,
    getDueReviews,
    getAllMastery,
    getCategoryMastery,
    setLastSession,
    toggleBookmark,
    isBookmarked,
    isTopicDone,
    TOPIC_CATALOG,
    CATEGORY_ICONS,
    BADGES,
    QUESTS,
    LEVELS,
    WEEKLY_GOAL,
    handleCompletion,
    renderNavXP,
    showToast,
  };
})(typeof window !== "undefined" ? window : global);
