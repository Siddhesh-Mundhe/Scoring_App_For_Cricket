/* ===================== Constants ===================== */
const INNINGS_TAGS = ["1st Innings", "1st Innings", "2nd Innings", "2nd Innings"];
const STORAGE_KEY = "scorebook.matches.v1";

/* ===================== State ===================== */
let matches = [];
let view = "home"; // 'home' | 'setup' | 'live' | 'summary'
let currentId = null;
let confirmDeleteId = null;
let setupFormat = "overs";
let pausePromptOpen = false;
let openPauseKey = null; // which pause-log badge is expanded, keyed "matchId-inningsIdx"
let extraPickerOpen = null; // 'wide' | 'noball' | 'bye' | 'legbye' | null — which overthrow picker is open
let runOtherOpen = false; // whether the "Other" custom runs-off-the-bat entry is open
let tickTimer = null;

/* ===================== Utilities ===================== */
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function emptyInnings(battingTeam, bowlingTeam, extra) {
  return Object.assign({ battingTeam, bowlingTeam, deliveries: [] }, extra || {});
}

function computeStats(deliveries) {
  let runs = 0, wickets = 0, legalBalls = 0;
  const extras = { wides: 0, noballs: 0, byes: 0, legbyes: 0 };
  for (const d of deliveries) {
    if (d.type === "run") { runs += d.runs; legalBalls += 1; }
    // A wide is always an extra: the 1-run penalty plus any runs run (or an
    // overthrow) while the ball was live all count as wide extras.
    else if (d.type === "wide") { const total = 1 + (d.runs || 0); runs += total; extras.wides += total; }
    // A no-ball's 1-run penalty is an extra; any further runs (run between the
    // wickets, or an overthrow) count as runs off the bat, same as a normal ball.
    else if (d.type === "noball") { runs += 1 + (d.runs || 0); extras.noballs += 1; }
    else if (d.type === "bye") { runs += d.runs; extras.byes += d.runs; legalBalls += 1; }
    else if (d.type === "legbye") { runs += d.runs; extras.legbyes += d.runs; legalBalls += 1; }
    else if (d.type === "wicket") { wickets += 1; legalBalls += 1; }
  }
  const oversFull = Math.floor(legalBalls / 6);
  const oversBalls = legalBalls % 6;
  const totalExtras = extras.wides + extras.noballs + extras.byes + extras.legbyes;
  return { runs, wickets, legalBalls, oversFull, oversBalls, extras, totalExtras };
}

function oversLabel(oversFull, oversBalls) { return `${oversFull}.${oversBalls}`; }

function formatClock(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function getElapsedMs(inn) {
  if (!inn.timerRunning) return inn.elapsedMs || 0;
  return (inn.elapsedMs || 0) + (Date.now() - inn.lastTickAt);
}

function groupOvers(deliveries) {
  const overs = [];
  let current = [];
  let legalCount = 0;
  for (const d of deliveries) {
    current.push(d);
    const isLegal = d.type === "run" || d.type === "bye" || d.type === "legbye" || d.type === "wicket";
    if (isLegal) legalCount += 1;
    if (legalCount === 6) { overs.push(current); current = []; legalCount = 0; }
  }
  if (current.length) overs.push(current);
  return overs;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ballBadgeHTML(d) {
  let label = "", cls = "badge-run0";
  if (d.type === "run") {
    label = String(d.runs);
    cls = d.runs === 0 ? "badge-run0" : d.runs === 4 ? "badge-4" : d.runs === 6 ? "badge-6" : "badge-run";
  } else if (d.type === "wide") { label = d.runs ? `wd+${d.runs}` : "wd"; cls = "badge-extra"; }
  else if (d.type === "noball") { label = d.runs ? `nb+${d.runs}` : "nb"; cls = "badge-extra"; }
  else if (d.type === "bye") { label = "b" + d.runs; cls = "badge-extra"; }
  else if (d.type === "legbye") { label = "lb" + d.runs; cls = "badge-extra"; }
  else if (d.type === "wicket") { label = "W"; cls = "badge-wicket"; }
  return `<span class="ball-badge ${cls}">${label}</span>`;
}

function flipRowHTML(value) {
  return `<span class="flip-row">${String(value).split("").map((ch) => `<span class="flip-digit">${ch}</span>`).join("")}</span>`;
}

function overStripHTML(balls) {
  if (!balls.length) return `<span class="over-strip-empty">No balls bowled yet</span>`;
  return balls.map(ballBadgeHTML).join("");
}

function pauseLogBadgeHTML(matchId, inningsIdx, pauseLog) {
  if (!pauseLog || !pauseLog.length) return "";
  const key = `${matchId}-${inningsIdx}`;
  const open = openPauseKey === key;
  const items = pauseLog.map((p) => `
    <div class="pause-badge-item">
      <span>${esc(p.reason)}</span>
      <span class="pause-badge-duration">${p.durationMs != null ? formatClock(p.durationMs) : "—"}</span>
    </div>`).join("");
  return `
    <div class="pause-badge-wrap">
      <button class="pause-badge-btn" data-action="toggle-pause-badge" data-key="${key}">
        ⏸ ${pauseLog.length} pause${pauseLog.length === 1 ? "" : "s"} ${open ? "▲" : "▼"}
      </button>
      ${open ? `<div class="pause-badge-list">${items}</div>` : ""}
    </div>`;
}

/* ===================== Persistence ===================== */
function loadMatches() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    matches = raw ? JSON.parse(raw) : [];
  } catch (e) { matches = []; }
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(matches)); } catch (e) {}
  render();
}

function updateMatch(id, updater) {
  matches = matches.map((m) => (m.id === id ? updater(m) : m));
  persist();
}

function getCurrentMatch() { return matches.find((m) => m.id === currentId) || null; }

/* ===================== Match actions ===================== */
function startMatch() {
  const teamAInput = document.getElementById("team-a-input");
  const teamBInput = document.getElementById("team-b-input");
  const tossSelect = document.getElementById("toss-select");
  const decisionSelect = document.getElementById("decision-select");

  const teamA = (teamAInput.value || "").trim() || "Team A";
  const teamB = (teamBInput.value || "").trim() || "Team B";
  const tossWinner = tossSelect.value;
  const decision = decisionSelect.value;

  const battingFirst = tossWinner === "A" ? (decision === "bat" ? teamA : teamB) : (decision === "bat" ? teamB : teamA);
  const bowlingFirst = battingFirst === teamA ? teamB : teamA;

  let match;
  if (setupFormat === "timed-test") {
    const timeLimitInput = document.getElementById("time-limit-input");
    match = {
      id: uid(), format: "timed-test", teamA, teamB, status: "live",
      createdAt: Date.now(), currentInningsIdx: 0,
      innings: [emptyInnings(battingFirst, bowlingFirst, {
        timeLimitMinutes: Math.max(1, Number(timeLimitInput.value) || 60),
        elapsedMs: 0, timerRunning: true, lastTickAt: Date.now(), pauseReason: null, pauseLog: [],
      })],
      result: null,
    };
  } else {
    const oversInput = document.getElementById("overs-input");
    match = {
      id: uid(), format: "overs", teamA, teamB,
      oversLimit: Math.max(1, Number(oversInput.value) || 20),
      status: "live", createdAt: Date.now(), currentInningsIdx: 0,
      innings: [emptyInnings(battingFirst, bowlingFirst)],
      result: null,
    };
  }
  matches = [match, ...matches];
  currentId = match.id;
  view = "live";
  setupFormat = "overs";
  persist();
}

function addDelivery(type, runs) {
  const m = getCurrentMatch();
  if (!m) return;
  updateMatch(m.id, (mm) => {
    const idx = mm.currentInningsIdx;
    const innings = mm.innings.map((inn, i) => i === idx ? { ...inn, deliveries: [...inn.deliveries, { type, runs: runs || 0 }] } : inn);
    let next = { ...mm, innings };

    // Instant chase-win check for the 4th (final) timed-test innings: seal the match
    // the moment this delivery pushes the batting side's aggregate past the target.
    if (mm.format === "timed-test" && idx === 3) {
      const statsA1 = computeStats(innings[0].deliveries);
      const statsA2 = computeStats(innings[2].deliveries);
      const statsB1 = computeStats(innings[1].deliveries);
      const statsB2 = computeStats(innings[3].deliveries);
      const targetTotal = statsA1.runs + statsA2.runs;
      const chaseAggregate = statsB1.runs + statsB2.runs;
      if (chaseAggregate > targetTotal) {
        const now = Date.now();
        const frozenInnings = innings.map((inn, i) => {
          if (i !== idx) return inn;
          if (inn.timerRunning) return { ...inn, elapsedMs: (inn.elapsedMs || 0) + (now - inn.lastTickAt), timerRunning: false };
          return inn;
        });
        const wktsLeft = 10 - statsB2.wickets;
        const result = `${innings[0].bowlingTeam} won by ${wktsLeft} wicket${wktsLeft === 1 ? "" : "s"}`;
        view = "summary";
        next = { ...next, innings: frozenInnings, status: "completed", result };
      }
    }
    return next;
  });
}

function undoLast() {
  const m = getCurrentMatch();
  if (!m) return;
  updateMatch(m.id, (mm) => {
    const idx = mm.currentInningsIdx;
    const innings = mm.innings.map((inn, i) => i === idx ? { ...inn, deliveries: inn.deliveries.slice(0, -1) } : inn);
    return { ...mm, innings };
  });
}

// ---- overs-format transitions ----
function startSecondInnings() {
  const m = getCurrentMatch();
  if (!m) return;
  updateMatch(m.id, (mm) => {
    const firstInn = mm.innings[0];
    const second = emptyInnings(firstInn.bowlingTeam, firstInn.battingTeam);
    return { ...mm, innings: [...mm.innings, second], currentInningsIdx: 1 };
  });
}

function completeMatch() {
  const m = getCurrentMatch();
  if (!m) return;
  updateMatch(m.id, (mm) => {
    let innings = mm.innings;
    if (mm.format === "timed-test" && innings[mm.currentInningsIdx].timerRunning) {
      innings = innings.map((inn, i) => {
        if (i !== mm.currentInningsIdx) return inn;
        const now = Date.now();
        return { ...inn, elapsedMs: (inn.elapsedMs || 0) + (now - inn.lastTickAt), timerRunning: false };
      });
    }
    const stats = innings.map((inn) => computeStats(inn.deliveries));
    let resultText = "";
    if (mm.format === "timed-test") {
      const teamA = innings[0].battingTeam;
      const teamB = innings[0].bowlingTeam;
      const totalA = (stats[0] ? stats[0].runs : 0) + (stats[2] ? stats[2].runs : 0);
      const totalB = (stats[1] ? stats[1].runs : 0) + (stats[3] ? stats[3].runs : 0);
      if (innings.length === 3) {
        const margin = totalB - totalA;
        if (margin > 0) resultText = `${teamB} won by an innings and ${margin} run${margin === 1 ? "" : "s"}`;
        else if (margin === 0) resultText = `Match tied — both sides finished on ${totalA}`;
        else resultText = `${teamA} won by ${-margin} run${-margin === 1 ? "" : "s"} (aggregate)`;
      } else if (innings.length >= 4) {
        if (totalB > totalA) {
          const wktsLeft = 10 - (stats[3] ? stats[3].wickets : 0);
          resultText = `${teamB} won by ${wktsLeft} wicket${wktsLeft === 1 ? "" : "s"}`;
        } else if (totalA > totalB) {
          resultText = `${teamA} won by ${totalA - totalB} run${totalA - totalB === 1 ? "" : "s"}`;
        } else {
          resultText = `Match tied — both sides finished on ${totalA}`;
        }
      } else if (totalA === totalB) {
        resultText = `Match tied — both sides finished on ${totalA}`;
      } else if (totalA > totalB) {
        resultText = `${teamA} lead by ${totalA - totalB} run${totalA - totalB === 1 ? "" : "s"} when the match ended`;
      } else {
        resultText = `${teamB} lead by ${totalB - totalA} run${totalB - totalA === 1 ? "" : "s"} when the match ended`;
      }
    } else if (innings.length === 1) {
      resultText = `${innings[0].battingTeam} finished on ${stats[0].runs}/${stats[0].wickets}`;
    } else {
      const s1 = stats[0], s2 = stats[1];
      const target = s1.runs + 1;
      if (s2.runs >= target) resultText = `${innings[1].battingTeam} won by ${10 - s2.wickets} wicket${10 - s2.wickets === 1 ? "" : "s"}`;
      else if (s2.runs === s1.runs) resultText = "Match tied";
      else resultText = `${innings[0].battingTeam} won by ${s1.runs - s2.runs} run${s1.runs - s2.runs === 1 ? "" : "s"}`;
    }
    return { ...mm, innings, status: "completed", result: resultText };
  });
  view = "summary";
  render();
}

// ---- timed-test transitions ----
function toggleTimer(reason) {
  const m = getCurrentMatch();
  if (!m) return;
  updateMatch(m.id, (mm) => {
    const idx = mm.currentInningsIdx;
    const inn = mm.innings[idx];
    const now = Date.now();
    if (inn.timerRunning) {
      if (!reason || !reason.trim()) return mm; // pausing requires a reason
      const logEntry = { reason: reason.trim(), pausedAt: now, resumedAt: null, durationMs: null };
      const innings = mm.innings.map((x, i) => i !== idx ? x : {
        ...x,
        elapsedMs: (x.elapsedMs || 0) + (now - x.lastTickAt),
        timerRunning: false, lastTickAt: now, pauseReason: reason.trim(),
        pauseLog: [...(x.pauseLog || []), logEntry],
      });
      return { ...mm, innings };
    }
    const innings = mm.innings.map((x, i) => {
      if (i !== idx) return x;
      const log = x.pauseLog || [];
      const closedLog = log.map((entry, li) =>
        li === log.length - 1 && entry.resumedAt == null
          ? { ...entry, resumedAt: now, durationMs: now - entry.pausedAt }
          : entry
      );
      return { ...x, timerRunning: true, lastTickAt: now, pauseReason: null, pauseLog: closedLog };
    });
    return { ...mm, innings };
  });
}

function startNextTimedInnings(timeLimitMinutes) {
  const m = getCurrentMatch();
  if (!m) return;
  updateMatch(m.id, (mm) => {
    const idx = mm.currentInningsIdx;
    const innings = mm.innings.map((inn, i) => {
      if (i !== idx) return inn;
      if (inn.timerRunning) {
        const now = Date.now();
        return { ...inn, elapsedMs: (inn.elapsedMs || 0) + (now - inn.lastTickAt), timerRunning: false };
      }
      return inn;
    });
    const battingFirst = mm.innings[0].battingTeam;
    const bowlingFirst = mm.innings[0].bowlingTeam;
    const nextIdx = idx + 1;
    const battingTeam = nextIdx % 2 === 0 ? battingFirst : bowlingFirst;
    const bowlingTeam = battingTeam === battingFirst ? bowlingFirst : battingFirst;
    const newInnings = emptyInnings(battingTeam, bowlingTeam, {
      timeLimitMinutes: Math.max(1, Number(timeLimitMinutes) || 60),
      elapsedMs: 0, timerRunning: true, lastTickAt: Date.now(), pauseReason: null, pauseLog: [],
    });
    return { ...mm, innings: [...innings, newInnings], currentInningsIdx: nextIdx };
  });
}

function deleteMatch(id) {
  matches = matches.filter((m) => m.id !== id);
  confirmDeleteId = null;
  persist();
}

function openMatch(id) {
  const m = matches.find((x) => x.id === id);
  if (!m) return;
  currentId = id;
  view = m.status === "completed" ? "summary" : "live";
  render();
}

/* ===================== Render: shell ===================== */
function render() {
  const root = document.getElementById("app-root");
  let html = headerHTML();

  if (view === "home") html += homeHTML();
  else if (view === "setup") html += setupHTML();
  else if (view === "live") {
    const m = getCurrentMatch();
    if (!m) html += `<div class="loading">Match not found.</div>`;
    else if (m.format === "timed-test") html += liveTimedTestHTML(m);
    else html += liveOversHTML(m);
  } else if (view === "summary") {
    const m = getCurrentMatch();
    html += m ? summaryHTML(m) : `<div class="loading">Match not found.</div>`;
  }

  if (confirmDeleteId) html += confirmOverlayHTML();

  root.innerHTML = html;
  attachInlineListeners();
  ensureTimerLoop();
}

function headerHTML() {
  return `
    <header class="header">
      <div class="header-inner">
        <button class="brand" data-action="nav-home">
          <span class="brand-mark">⌂</span><span class="brand-text">SCOREBOOK</span>
        </button>
        ${view !== "home" ? `<button class="ghost-btn on-dark" data-action="nav-home">Matches</button>` : ""}
      </div>
    </header>`;
}

function ensureTimerLoop() {
  clearInterval(tickTimer);
  const m = getCurrentMatch();
  if (view === "live" && m && m.format === "timed-test" && m.status === "live") {
    tickTimer = setInterval(render, 1000);
  }
}

/* ===================== Render: Home ===================== */
function homeHTML() {
  if (matches.length === 0) {
    return `
      <div class="home-head-row">
        <div><h1 class="h1">Your matches</h1><p class="subtle">Every over, tracked ball by ball.</p></div>
        <button class="primary-btn" data-action="nav-setup">+ New match</button>
      </div>
      <div class="empty-state">
        <div class="empty-mark">🏏</div>
        <h2 class="h2">Start your first match</h2>
        <p class="subtle">Pick a format, set the teams, and start recording deliveries live.</p>
        <button class="primary-btn" style="margin-top:16px" data-action="nav-setup">+ New match</button>
      </div>`;
  }
  const cards = matches.map((m) => {
    const isTimed = m.format === "timed-test";
    const idx = m.currentInningsIdx;
    const inn = m.innings[idx];
    const stats = computeStats(inn.deliveries);
    return `
      <div class="match-card" data-action="open-match" data-id="${m.id}">
        <div class="match-card-top">
          <div>
            <div class="match-teams">${esc(m.teamA)} <span class="vs">vs</span> ${esc(m.teamB)}</div>
            <div class="match-meta">${isTimed ? `Timed Test · ${INNINGS_TAGS[idx]} · ${esc(inn.battingTeam)} batting` : `${m.oversLimit} overs · ${esc(inn.battingTeam)} batting`}</div>
          </div>
          <span class="status-pill ${m.status === "completed" ? "status-done" : "status-live"}">${m.status === "completed" ? "Completed" : "Live"}</span>
        </div>
        <div class="match-score-row">
          <span class="match-score">${stats.runs}/${stats.wickets}</span>
          <span class="match-overs">(${oversLabel(stats.oversFull, stats.oversBalls)} ov)</span>
        </div>
        ${m.status === "completed" && m.result ? `<div class="result-line">${esc(m.result)}</div>` : ""}
        <button class="delete-link" data-action="delete-match-prompt" data-id="${m.id}">Delete</button>
      </div>`;
  }).join("");
  return `
    <div class="home-head-row">
      <div><h1 class="h1">Your matches</h1><p class="subtle">Every over, tracked ball by ball.</p></div>
      <button class="primary-btn" data-action="nav-setup">+ New match</button>
    </div>
    <div class="match-list">${cards}</div>`;
}

/* ===================== Render: Setup ===================== */
function setupHTML() {
  return `
    <div class="setup-card">
      <h1 class="h1">New match</h1>
      <p class="subtle">Set the format and teams before the first ball.</p>

      <div class="format-toggle">
        <button class="format-btn ${setupFormat === "overs" ? "format-active" : ""}" data-action="setup-format" data-format="overs">
          Limited overs
          <span class="format-sub">1 innings each, overs-limited</span>
        </button>
        <button class="format-btn ${setupFormat === "timed-test" ? "format-active" : ""}" data-action="setup-format" data-format="timed-test">
          Timed Test
          <span class="format-sub">2 innings each, time-limited</span>
        </button>
      </div>

      <div class="form-grid">
        <label class="field-label">Team batting or bowling first (name)
          <input class="text-input" id="team-a-input" placeholder="Team A">
        </label>
        <label class="field-label">Opponent
          <input class="text-input" id="team-b-input" placeholder="Team B">
        </label>
        ${setupFormat === "overs"
          ? `<label class="field-label">Overs per innings<input class="text-input" id="overs-input" type="number" min="1" max="50" value="20"></label>`
          : `<label class="field-label">Time limit for 1st innings (minutes)<input class="text-input" id="time-limit-input" type="number" min="1" value="60"></label>`
        }
        <label class="field-label">Toss won by
          <select class="text-input" id="toss-select">
            <option value="A">Team A</option>
            <option value="B">Team B</option>
          </select>
        </label>
        <label class="field-label">Elected to
          <select class="text-input" id="decision-select">
            <option value="bat">Bat first</option>
            <option value="bowl">Bowl first</option>
          </select>
        </label>
      </div>

      ${setupFormat === "timed-test" ? `<p class="subtle" style="margin-top:14px">After each innings ends (time up or all out), you'll set the time limit for the next one before it starts.</p>` : ""}

      <div style="display:flex; gap:10px; margin-top:24px">
        <button class="ghost-btn" data-action="nav-home">Cancel</button>
        <button class="primary-btn" data-action="setup-start">Start match</button>
      </div>
    </div>`;
}

/* ===================== Render: Live (limited overs) ===================== */
function extraPickerHTML(extraType) {
  const config = {
    wide: { title: "Wide — extra runs run (overthrow etc.)", note: "The standard 1-run penalty is always added on top of this.", chips: [0, 1, 2, 3, 4] },
    noball: { title: "No ball — runs the batter scored", note: "E.g. hit for a boundary. These count as runs off the bat; the 1-run no-ball penalty is always added on top, separately.", chips: [0, 1, 2, 3, 4, 5, 6] },
    bye: { title: "Bye — total runs", note: "How many runs were run (or an overthrow added) on this bye.", chips: [1, 2, 3, 4] },
    legbye: { title: "Leg bye — total runs", note: "How many runs were run (or an overthrow added) on this leg bye.", chips: [1, 2, 3, 4] },
  }[extraType];
  const chips = config.chips.map((n) => `<button class="chip-btn" data-action="extra-chip" data-extra="${extraType}" data-runs="${n}">${n}</button>`).join("");
  return `
    <div class="extra-picker">
      <div class="extra-picker-title">${config.title}</div>
      <div class="extra-picker-note">${config.note}</div>
      <div class="chip-row">${chips}</div>
      <div class="chip-other-row">
        <input class="text-input" id="extra-other-input" type="number" min="0" placeholder="Other amount">
        <button class="ghost-btn" data-action="extra-other-confirm" data-extra="${extraType}">Use</button>
      </div>
      <button class="ghost-btn" style="margin-top:8px" data-action="extra-cancel">Cancel</button>
    </div>`;
}

function scoringPanelHTML(canUndo) {
  return `
    <div class="panel">
      <div class="panel-label">Runs off the bat</div>
      <div class="run-grid">
        ${[0, 1, 2, 3, 4, 5, 6].map((r) => `<button class="run-btn ${r === 4 ? "run-4" : r === 6 ? "run-6" : ""}" data-action="ball" data-type="run" data-runs="${r}">${r}</button>`).join("")}
        ${!runOtherOpen ? `<button class="run-btn run-other" data-action="run-other-open">Other</button>` : ""}
      </div>
      ${runOtherOpen ? `
        <div class="chip-other-row" style="margin-bottom:16px">
          <input class="text-input" id="run-other-input" type="number" min="0" placeholder="Runs off the bat (e.g. 7+ with overthrow)">
          <button class="ghost-btn" data-action="run-other-confirm">Use</button>
          <button class="ghost-btn" data-action="run-other-cancel">Cancel</button>
        </div>` : ""}

      <div class="panel-label">Extras</div>
      <div class="extra-grid">
        <div class="extra-cell">
          <button class="extra-btn" data-action="ball" data-type="wide" data-runs="0">Wide</button>
          <button class="extra-adjust" data-action="extra-open" data-extra="wide">+ overthrow</button>
        </div>
        <div class="extra-cell">
          <button class="extra-btn" data-action="ball" data-type="noball" data-runs="0">No ball</button>
          <button class="extra-adjust" data-action="extra-open" data-extra="noball">+ runs scored</button>
        </div>
        <div class="extra-cell">
          <button class="extra-btn" data-action="ball" data-type="bye" data-runs="1">Bye</button>
          <button class="extra-adjust" data-action="extra-open" data-extra="bye">+ more runs</button>
        </div>
        <div class="extra-cell">
          <button class="extra-btn" data-action="ball" data-type="legbye" data-runs="1">Leg bye</button>
          <button class="extra-adjust" data-action="extra-open" data-extra="legbye">+ more runs</button>
        </div>
      </div>
      ${extraPickerOpen ? extraPickerHTML(extraPickerOpen) : ""}

      <div class="action-row">
        <button class="wicket-btn" data-action="ball" data-type="wicket" data-runs="0">Wicket</button>
        <button class="undo-btn" data-action="undo" ${canUndo ? "" : "disabled"}>Undo last ball</button>
      </div>
    </div>`;
}

function oversHistoryHTML(overGroups) {
  if (!overGroups.length) return "";
  const rows = overGroups.map((over, i) => `
    <div class="over-history-row">
      <span class="over-history-label">Ov ${overGroups.length - i}</span>
      <div class="over-strip">${overStripHTML(over)}</div>
    </div>`).join("");
  return `<div class="overs-history"><div class="over-strip-label">Over by over</div>${rows}</div>`;
}

function liveOversHTML(m) {
  const inn = m.innings[m.currentInningsIdx];
  const stats = computeStats(inn.deliveries);
  const isSecond = m.currentInningsIdx === 1;
  const firstStats = isSecond ? computeStats(m.innings[0].deliveries) : null;
  const target = isSecond ? firstStats.runs + 1 : null;
  const ballsRemaining = m.oversLimit * 6 - stats.legalBalls;
  const runsNeeded = isSecond ? Math.max(0, target - stats.runs) : null;
  const inningsOver = stats.legalBalls >= m.oversLimit * 6 || stats.wickets >= 10 || (isSecond && stats.runs >= target);

  const groups = groupOvers(inn.deliveries);
  const currentOverBalls = groups.length ? groups[groups.length - 1] : [];
  let legalInCurrent = 0;
  for (const d of currentOverBalls) if (d.type === "run" || d.type === "bye" || d.type === "legbye" || d.type === "wicket") legalInCurrent++;
  const isCurrentOverComplete = legalInCurrent === 6;
  const overGroups = groups.slice().reverse();
  const runRate = stats.legalBalls > 0 ? (stats.runs / (stats.legalBalls / 6)).toFixed(2) : "0.00";
  const reqRunRate = isSecond && ballsRemaining > 0 ? (runsNeeded / (ballsRemaining / 6)).toFixed(2) : null;

  return `
    <div class="scoreboard">
      <div class="scoreboard-team-row"><span class="scoreboard-team">${esc(inn.battingTeam)}</span><span class="scoreboard-vs">batting</span></div>
      <div class="scoreboard-main">${flipRowHTML(`${stats.runs}-${stats.wickets}`)}</div>
      <div class="scoreboard-sub">
        <span>OVERS ${flipRowHTML(oversLabel(stats.oversFull, stats.oversBalls))} / ${m.oversLimit}</span>
        <span>RUN RATE ${runRate}</span>
      </div>
      ${isSecond ? `<div class="target-row">Target ${target} · need ${runsNeeded} off ${ballsRemaining} ball${ballsRemaining === 1 ? "" : "s"}${reqRunRate && ballsRemaining > 0 ? ` · req RR ${reqRunRate}` : ""}</div>` : ""}
      <div class="extras-row">Extras ${stats.totalExtras} (wd ${stats.extras.wides}, nb ${stats.extras.noballs}, b ${stats.extras.byes}, lb ${stats.extras.legbyes})</div>
    </div>

    <div class="over-strip-wrap">
      <div class="over-strip-label">This over</div>
      <div class="over-strip">${overStripHTML(currentOverBalls)}</div>
    </div>

    ${!inningsOver ? scoringPanelHTML(inn.deliveries.length > 0) : `
      <div class="innings-over-card">
        <h2 class="h2">Innings complete</h2>
        <p class="subtle">${esc(inn.battingTeam)} finished on ${stats.runs}/${stats.wickets} from ${oversLabel(stats.oversFull, stats.oversBalls)} overs.</p>
        ${!isSecond ? `<button class="primary-btn" data-action="start-second-innings">Start second innings</button>` : `<button class="primary-btn" data-action="complete-match">Finish match</button>`}
      </div>`}

    ${!inningsOver && isCurrentOverComplete ? `<div style="margin-top:12px"><span class="over-complete-note">Over complete — next ball starts a new over.</span></div>` : ""}

    <div style="margin-top:28px">
      ${!inningsOver && !isSecond ? `<button class="ghost-btn" data-action="start-second-innings">End innings early</button>` : ""}
      ${!inningsOver && isSecond ? `<button class="ghost-btn" data-action="complete-match">End match now</button>` : ""}
    </div>

    ${oversHistoryHTML(overGroups)}`;
}

/* ===================== Render: Live (timed test) ===================== */
function liveTimedTestHTML(m) {
  const idx = m.currentInningsIdx;
  const inn = m.innings[idx];
  const stats = computeStats(inn.deliveries);
  const tag = INNINGS_TAGS[idx];
  const teamA = m.innings[0].battingTeam;
  const teamB = m.innings[0].bowlingTeam;

  const elapsedMs = getElapsedMs(inn);
  const limitMs = (inn.timeLimitMinutes || 60) * 60000;
  const remainingMs = Math.max(0, limitMs - elapsedMs);
  const timeUp = elapsedMs >= limitMs;

  const statsA1 = computeStats(m.innings[0].deliveries);
  const statsB1 = idx >= 1 ? computeStats(m.innings[1].deliveries) : null;
  const statsA2 = idx === 2 ? stats : idx > 2 ? computeStats(m.innings[2].deliveries) : null;

  const inningsDefeat = idx === 2 && stats.wickets >= 10 && (statsA1.runs + stats.runs) < statsB1.runs;
  const targetTotal = idx === 3 ? statsA1.runs + statsA2.runs : null;
  const chaseAggregate = idx === 3 ? statsB1.runs + stats.runs : null;
  // Note: the exact-ball chase win is sealed inside addDelivery(); by the time this
  // renders that case already redirected to the summary view. This flag only covers
  // the innings ending by time/all-out while still short of the target.
  const isLast = idx === 3;
  const inningsOver = stats.wickets >= 10 || timeUp;

  const groups = groupOvers(inn.deliveries);
  const currentOverBalls = groups.length ? groups[groups.length - 1] : [];
  const overGroups = groups.slice().reverse();
  const runRate = stats.legalBalls > 0 ? (stats.runs / (stats.legalBalls / 6)).toFixed(2) : "0.00";

  const priorInnings = m.innings.slice(0, idx);
  const nextBattingTeam = !isLast ? ((idx + 1) % 2 === 0 ? teamA : teamB) : null;

  let contextLine = null;
  if (idx === 1) {
    const diff = stats.runs - statsA1.runs;
    contextLine = diff > 0 ? `${esc(teamB)} lead by ${diff} run${diff === 1 ? "" : "s"}` : diff < 0 ? `${esc(teamB)} trail by ${-diff} run${-diff === 1 ? "" : "s"}` : "Scores level";
  } else if (idx === 2) {
    const aggregateA = statsA1.runs + stats.runs;
    const diff = aggregateA - statsB1.runs;
    contextLine = diff > 0 ? `${esc(teamA)} lead by ${diff} run${diff === 1 ? "" : "s"}` : diff < 0 ? `${esc(teamA)} trail by ${-diff} run${-diff === 1 ? "" : "s"}` : "Scores level";
  } else if (idx === 3) {
    const need = targetTotal - chaseAggregate;
    contextLine = need > 0 ? `${esc(teamB)} need ${need} more run${need === 1 ? "" : "s"} to win` : `${esc(teamB)} have overtaken the target`;
  }

  const priorStripHTML = priorInnings.length ? `
    <div class="prior-strip">
      ${priorInnings.map((pi, i) => {
        const s = computeStats(pi.deliveries);
        return `
        <div class="prior-card">
          <div>
            <div class="prior-tag">${INNINGS_TAGS[i]} · ${esc(pi.battingTeam)}</div>
            ${pauseLogBadgeHTML(m.id, i, pi.pauseLog)}
          </div>
          <div class="prior-score">${s.runs}/${s.wickets} <span class="prior-overs">(${oversLabel(s.oversFull, s.oversBalls)} ov)</span></div>
        </div>`;
      }).join("")}
    </div>` : "";

  const timerBlockHTML = `
    <div class="timer-card">
      <div class="timer-label">${timeUp ? "Time's up" : inn.timerRunning ? "Time left" : "Paused"}</div>
      <div class="timer-clock">${flipRowHTML(formatClock(remainingMs))}</div>
      <div class="timer-sub">of ${inn.timeLimitMinutes} min innings · elapsed ${formatClock(elapsedMs)}</div>
      ${!inn.timerRunning && !timeUp ? `<div class="pause-reason-banner">Paused — ${esc(inn.pauseReason || "no reason given")}</div>` : ""}
      ${!inningsOver && inn.timerRunning && !pausePromptOpen ? `<button class="ghost-btn" style="margin-top:10px" data-action="pause-open">Pause timer</button>` : ""}
      ${!inningsOver && inn.timerRunning && pausePromptOpen ? `
        <div class="pause-form">
          <label class="field-label">Reason for pausing (required)
            <input class="text-input" id="pause-reason-input" placeholder="e.g. rain delay, drinks break, injury" autofocus>
          </label>
          <div class="pause-error" id="pause-reason-error">Please enter a reason before pausing.</div>
          <div style="display:flex; gap:8px; margin-top:10px; justify-content:center">
            <button class="ghost-btn" data-action="pause-cancel">Cancel</button>
            <button class="primary-btn" data-action="pause-confirm">Confirm pause</button>
          </div>
        </div>` : ""}
      ${!inningsOver && !inn.timerRunning ? `<button class="primary-btn" style="margin-top:10px" data-action="resume-timer">Resume timer</button>` : ""}
    </div>`;

  let completeCardHTML;
  if (!inningsOver) {
    completeCardHTML = `
      ${scoringPanelHTML(inn.deliveries.length > 0)}
      <div style="margin-top:18px">
        ${idx < 3
          ? `<button class="ghost-btn" data-action="declare-innings">Declare innings now</button>`
          : `<button class="ghost-btn" data-action="complete-match">End match now</button>`}
      </div>`;
  } else if (inningsDefeat) {
    completeCardHTML = `
      <div class="innings-over-card">
        <h2 class="h2">${esc(teamA)} all out — still trailing</h2>
        <p class="subtle">${esc(teamA)} were bowled out for ${statsA1.runs + stats.runs} without overturning ${esc(teamB)}'s ${statsB1.runs}. No need for ${esc(teamB)} to bat again — match decided by an innings.</p>
        <div style="display:flex; justify-content:center">${pauseLogBadgeHTML(m.id, idx, inn.pauseLog)}</div>
        <button class="primary-btn" data-action="complete-match">Finish match</button>
      </div>`;
  } else {
    completeCardHTML = `
      <div class="innings-over-card">
        <h2 class="h2">${tag} complete</h2>
        <p class="subtle">${esc(inn.battingTeam)} finished on ${stats.runs}/${stats.wickets} from ${oversLabel(stats.oversFull, stats.oversBalls)} overs${stats.wickets >= 10 ? " — all out." : " — time expired."}</p>
        <div style="display:flex; justify-content:center">${pauseLogBadgeHTML(m.id, idx, inn.pauseLog)}</div>
        ${isLast
          ? `<button class="primary-btn" data-action="complete-match">Finish match</button>`
          : `<div class="next-innings-form">
               <label class="field-label">Time limit for ${esc(nextBattingTeam)}'s ${INNINGS_TAGS[idx + 1]} (minutes)
                 <input class="text-input" id="next-limit-input" type="number" min="1" value="${inn.timeLimitMinutes || 60}">
               </label>
               <button class="primary-btn" style="margin-top:12px" data-action="start-next-innings">Start ${esc(nextBattingTeam)}'s innings</button>
             </div>`}
      </div>`;
  }

  return `
    ${priorStripHTML}
    <div class="scoreboard">
      <div class="scoreboard-team-row"><span class="scoreboard-team">${esc(inn.battingTeam)}</span><span class="scoreboard-vs">${tag} · batting</span></div>
      <div class="scoreboard-main">${flipRowHTML(`${stats.runs}-${stats.wickets}`)}</div>
      <div class="scoreboard-sub">
        <span>OVERS ${flipRowHTML(oversLabel(stats.oversFull, stats.oversBalls))}</span>
        <span>RUN RATE ${runRate}</span>
      </div>
      ${contextLine ? `<div class="target-row">${contextLine}</div>` : ""}
      <div class="extras-row">Extras ${stats.totalExtras} (wd ${stats.extras.wides}, nb ${stats.extras.noballs}, b ${stats.extras.byes}, lb ${stats.extras.legbyes})</div>
    </div>

    ${timerBlockHTML}

    <div class="over-strip-wrap">
      <div class="over-strip-label">This over</div>
      <div class="over-strip">${overStripHTML(currentOverBalls)}</div>
    </div>

    ${completeCardHTML}
    ${oversHistoryHTML(overGroups)}`;
}

/* ===================== Render: Summary ===================== */
function summaryHTML(m) {
  const stats = m.innings.map((inn) => computeStats(inn.deliveries));
  const isTimed = m.format === "timed-test";
  let aggregateHTML = "";
  if (isTimed) {
    const teamA = m.innings[0].battingTeam;
    const teamB = m.innings[0].bowlingTeam;
    const totalA = (stats[0] ? stats[0].runs : 0) + (stats[2] ? stats[2].runs : 0);
    const totalB = (stats[1] ? stats[1].runs : 0) + (stats[3] ? stats[3].runs : 0);
    aggregateHTML = `
      <div class="aggregate-row">
        <div class="aggregate-card"><div class="match-teams">${esc(teamA)}</div><div class="aggregate-total">${totalA}</div><div class="match-meta">combined runs</div></div>
        <div class="aggregate-card"><div class="match-teams">${esc(teamB)}</div><div class="aggregate-total">${totalB}</div><div class="match-meta">combined runs</div></div>
      </div>`;
  }
  const inningsHTML = m.innings.map((inn, idx) => `
    <div class="innings-card">
      <div class="match-meta">${isTimed ? INNINGS_TAGS[idx] : `Innings ${idx + 1}`}</div>
      <div class="match-teams">${esc(inn.battingTeam)}</div>
      <div class="scoreboard-main">${flipRowHTML(`${stats[idx].runs}-${stats[idx].wickets}`)}</div>
      <div class="match-meta">${oversLabel(stats[idx].oversFull, stats[idx].oversBalls)} overs · extras ${stats[idx].totalExtras}</div>
      ${pauseLogBadgeHTML(m.id, idx, inn.pauseLog)}
    </div>`).join("");

  return `
    <div class="result-card">
      <div class="result-badge">Match complete</div>
      <h1 class="h1" style="margin-top:8px">${esc(m.result)}</h1>
    </div>
    ${aggregateHTML}
    ${inningsHTML}
    <button class="primary-btn" style="margin-top:20px" data-action="nav-home">Back to matches</button>`;
}

/* ===================== Overlay ===================== */
function confirmOverlayHTML() {
  return `
    <div class="overlay" data-action="overlay-backdrop">
      <div class="confirm-card" data-stop-propagation="true">
        <p style="margin:0; font-size:15px">Delete this match? This can't be undone.</p>
        <div class="confirm-actions">
          <button class="ghost-btn" data-action="delete-cancel">Cancel</button>
          <button class="danger-btn" data-action="delete-confirm" data-id="${confirmDeleteId}">Delete match</button>
        </div>
      </div>
    </div>`;
}

/* ===================== Event delegation ===================== */
function attachInlineListeners() {
  const reasonInput = document.getElementById("pause-reason-input");
  if (reasonInput) reasonInput.focus();

  const runOtherInput = document.getElementById("run-other-input");
  if (runOtherInput) runOtherInput.focus();

  const extraOtherInput = document.getElementById("extra-other-input");
  if (extraOtherInput) extraOtherInput.focus();

  const teamAInput = document.getElementById("team-a-input");
  const teamBInput = document.getElementById("team-b-input");
  const tossSelect = document.getElementById("toss-select");
  if (teamAInput && tossSelect) {
    teamAInput.addEventListener("input", () => {
      tossSelect.options[0].textContent = teamAInput.value.trim() || "Team A";
    });
  }
  if (teamBInput && tossSelect) {
    teamBInput.addEventListener("input", () => {
      tossSelect.options[1].textContent = teamBInput.value.trim() || "Team B";
    });
  }
}

function handleClick(e) {
  const overlayBackdrop = e.target.closest('[data-action="overlay-backdrop"]');
  const stopCard = e.target.closest('[data-stop-propagation="true"]');
  if (overlayBackdrop && !stopCard) { confirmDeleteId = null; render(); return; }

  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;

  switch (action) {
    case "nav-home": view = "home"; confirmDeleteId = null; pausePromptOpen = false; extraPickerOpen = null; runOtherOpen = false; render(); break;
    case "nav-setup": view = "setup"; setupFormat = "overs"; render(); break;
    case "setup-format": setupFormat = btn.dataset.format; render(); break;
    case "setup-start": startMatch(); break;
    case "open-match": openMatch(btn.dataset.id); break;
    case "delete-match-prompt": confirmDeleteId = btn.dataset.id; render(); break;
    case "delete-cancel": confirmDeleteId = null; render(); break;
    case "delete-confirm": deleteMatch(btn.dataset.id); break;
    case "ball":
      extraPickerOpen = null;
      runOtherOpen = false;
      addDelivery(btn.dataset.type, Number(btn.dataset.runs));
      break;
    case "undo": undoLast(); break;
    case "start-second-innings": extraPickerOpen = null; runOtherOpen = false; startSecondInnings(); break;
    case "complete-match": extraPickerOpen = null; runOtherOpen = false; completeMatch(); break;
    case "pause-open": pausePromptOpen = true; render(); break;
    case "pause-cancel": pausePromptOpen = false; render(); break;
    case "pause-confirm": {
      const input = document.getElementById("pause-reason-input");
      const val = (input.value || "").trim();
      if (!val) { document.getElementById("pause-reason-error").style.display = "block"; return; }
      toggleTimer(val);
      pausePromptOpen = false;
      render();
      break;
    }
    case "resume-timer": toggleTimer(); render(); break;
    case "declare-innings": {
      extraPickerOpen = null;
      runOtherOpen = false;
      const m = getCurrentMatch();
      const inn = m.innings[m.currentInningsIdx];
      startNextTimedInnings(inn.timeLimitMinutes || 60);
      break;
    }
    case "start-next-innings": {
      extraPickerOpen = null;
      runOtherOpen = false;
      const input = document.getElementById("next-limit-input");
      startNextTimedInnings(input ? input.value : 60);
      break;
    }
    case "toggle-pause-badge": {
      const key = btn.dataset.key;
      openPauseKey = openPauseKey === key ? null : key;
      render();
      break;
    }
    case "run-other-open": runOtherOpen = true; render(); break;
    case "run-other-cancel": runOtherOpen = false; render(); break;
    case "run-other-confirm": {
      const input = document.getElementById("run-other-input");
      const val = Math.max(0, Math.floor(Number(input.value)));
      if (!input.value || Number.isNaN(val)) return;
      runOtherOpen = false;
      addDelivery("run", val);
      break;
    }
    case "extra-open": extraPickerOpen = btn.dataset.extra; render(); break;
    case "extra-cancel": extraPickerOpen = null; render(); break;
    case "extra-chip":
      extraPickerOpen = null;
      addDelivery(btn.dataset.extra, Number(btn.dataset.runs));
      break;
    case "extra-other-confirm": {
      const input = document.getElementById("extra-other-input");
      const val = Math.max(0, Math.floor(Number(input.value)));
      if (!input.value || Number.isNaN(val)) return;
      extraPickerOpen = null;
      addDelivery(btn.dataset.extra, val);
      break;
    }
  }
}

/* ===================== Init ===================== */
function init() {
  loadMatches();
  document.getElementById("app-root").addEventListener("click", handleClick);
  render();
}

document.addEventListener("DOMContentLoaded", init);
