import {
  FOCUS_CARDS,
  GAME_CONFIG,
  MANAGEMENT_CARDS,
  SAVE_KEYS,
  getFocusCardById,
  getManagementCardById,
} from "./core/config.js";
import {
  deleteSaveState,
  listSaveSlots,
  loadGameState,
  saveGameState,
} from "./core/persistence.js";
import { getCardAvailability, canAdvanceWeek, computeEntropyIndex, isReleaseAvailable, previewWeek, resolveWeek, sanitizePlan } from "./core/sim.js";
import { createInitialGameState } from "./core/state.js";
import {
  calculateRunwayWeeks,
  clamp,
  deepClone,
  formatCurrency,
  formatPercent,
  formatSigned,
  sumAllocations,
} from "./core/utils.js";

const appRoot = document.querySelector("#app");

const uiState = {
  lastSnapshot: null,
  showWeekModal: false,
  banner: {
    kind: "info",
    message: "Simulation ready.",
  },
};

let gameState = null;

function getWeeklyBurnFromState(state) {
  const salary = state.team.members.reduce((acc, dev) => acc + dev.salary, 0);
  return GAME_CONFIG.economy.officeRentPerWeek + salary;
}

function hydrateDerivedFields(state) {
  const copy = deepClone(state);
  const sanitized = sanitizePlan(copy, copy.plan);
  const releaseAvailable = isReleaseAvailable(copy);

  copy.plan = sanitized.plan;
  copy.team.cpBase = sanitized.derivedCapacity.cpBase;
  copy.team.cpEffective = sanitized.derivedCapacity.cpEffective;
  copy.entropy.entropyIndex = computeEntropyIndex(
    copy.entropy.techDebt,
    copy.entropy.bugBacklog,
  );
  copy.resources.weeklyBurn = getWeeklyBurnFromState(copy);
  copy.resources.runwayWeeks = calculateRunwayWeeks(
    copy.resources.cash,
    copy.resources.weeklyBurn,
  );
  copy.project.releaseReady =
    copy.project.completion >= 120 && copy.entropy.bugBacklog <= 25;
  copy.plan.releaseRequested = releaseAvailable
    ? Boolean(copy.plan.releaseRequested)
    : false;

  return copy;
}

function setBanner(kind, message) {
  uiState.banner = { kind, message };
}

function stateStatusLabel(status) {
  if (status === "active") {
    return "Active Development";
  }

  if (status === "released") {
    return "Post-Launch Stabilization";
  }

  if (status === "failed") {
    return "Run Failed";
  }

  if (status === "won") {
    return "Run Won";
  }

  return status;
}

function formatRunway(runwayWeeks) {
  if (!Number.isFinite(runwayWeeks)) {
    return "∞";
  }

  return `${Math.max(0, Math.floor(runwayWeeks))}`;
}

function getDeltaClass(value) {
  if (value > 0) {
    return "delta-positive";
  }

  if (value < 0) {
    return "delta-negative";
  }

  return "delta-neutral";
}

function entropyLevel(entropyIndex) {
  if (entropyIndex > 40) {
    return "red";
  }

  if (entropyIndex >= 20) {
    return "amber";
  }

  return "green";
}

function statusBannerKindClass(kind) {
  if (kind === "warn") {
    return "status-warn";
  }

  if (kind === "bad") {
    return "status-bad";
  }

  if (kind === "good") {
    return "status-good";
  }

  return "status-info";
}

function clampAllocInput(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function projectScopeRemaining(state) {
  return Math.max(0, state.project.scopeTarget - state.project.completion);
}

function getBurndownSeries(state) {
  const series = [];
  let weekCursor = 0;

  const initialRemaining =
    state.history.length > 0
      ? Math.max(0, state.history[0].before.scopeTarget - state.history[0].before.completion)
      : projectScopeRemaining(state);

  series.push({ week: weekCursor, remaining: initialRemaining });

  for (const snapshot of state.history) {
    weekCursor = snapshot.week;
    series.push({
      week: weekCursor,
      remaining: Math.max(0, snapshot.after.scopeTarget - snapshot.after.completion),
    });
  }

  if (series.length === 1) {
    series[0].remaining = projectScopeRemaining(state);
  }

  return series;
}

function estimateForecast(state, points) {
  const remaining = projectScopeRemaining(state);
  const recent = state.history.slice(-3);
  const avgVelocityRaw =
    recent.reduce((acc, item) => acc + Math.max(0, item.deltas.completion), 0) /
    Math.max(1, recent.length);
  const usedFallbackVelocity = avgVelocityRaw <= 0;
  const avgVelocity = Math.max(0.25, avgVelocityRaw || 0.25);

  const estimatedWeeks = clamp(Math.ceil(remaining / avgVelocity), 1, 24);
  const lastPoint = points[points.length - 1] ?? { week: state.run.week, remaining };
  const targetWeek = lastPoint.week + estimatedWeeks;

  const historyCount = state.history.length;
  const lowDataUncertainty = historyCount < 3 ? 18 - historyCount * 4 : 0;
  const debtUncertainty = Math.ceil(state.entropy.techDebt / 4);
  const stagnationUncertainty = usedFallbackVelocity ? 8 : 0;
  const baselineUncertainty = Math.max(4, Math.ceil(remaining * 0.08));

  const uncertaintyEnd = clamp(
    baselineUncertainty + debtUncertainty + lowDataUncertainty + stagnationUncertainty,
    4,
    Math.max(12, Math.ceil(remaining * 0.55)),
  );

  const uncertaintyStart = clamp(Math.ceil(uncertaintyEnd * 0.35), 2, uncertaintyEnd);

  const segments = 8;
  const coneTop = [];
  const coneBottom = [];

  for (let idx = 0; idx <= segments; idx += 1) {
    const t = idx / segments;
    const week = lastPoint.week + (targetWeek - lastPoint.week) * t;
    const centerRemaining = Math.max(0, lastPoint.remaining * (1 - t));
    const width = uncertaintyStart + (uncertaintyEnd - uncertaintyStart) * Math.pow(t, 1.15);

    coneTop.push({ week, remaining: centerRemaining + width });
    coneBottom.push({ week, remaining: Math.max(0, centerRemaining - width) });
  }

  return {
    avgVelocity,
    targetWeek,
    usedFallbackVelocity,
    dataQuality:
      historyCount < 3 ? "low" : historyCount < 8 ? "medium" : "high",
    line: [
      { week: lastPoint.week, remaining: lastPoint.remaining },
      { week: targetWeek, remaining: 0 },
    ],
    conePolygon: [...coneTop, ...coneBottom.reverse()],
  };
}

function getBurndownStateNote(state) {
  const points = getBurndownSeries(state);
  const forecast = estimateForecast(state, points);
  const remaining = projectScopeRemaining(state);

  if (remaining <= 0) {
    if (state.run.status === "released" || state.run.status === "won") {
      return "Scope is complete. Burndown tracking is closed; focus on post-launch stability and revenue trend.";
    }

    return "Scope has been fully burned down. You are ready to focus on release quality and launch timing.";
  }

  const entropyState = entropyLevel(state.entropy.entropyIndex);
  const velocityPhrase = forecast.usedFallbackVelocity
    ? `Velocity estimate is provisional at ${forecast.avgVelocity.toFixed(2)} FP/week due to limited history.`
    : `Recent velocity is ${forecast.avgVelocity.toFixed(2)} FP/week.`;

  const confidencePhrase =
    forecast.dataQuality === "low"
      ? "Forecast confidence is low because there is limited completed-week history."
      : forecast.dataQuality === "medium"
        ? "Forecast confidence is moderate based on recent velocity."
        : "Forecast confidence is higher because velocity history is stable.";

  const entropyPhrase =
    entropyState === "red"
      ? "Entropy pressure is high and may widen forecast uncertainty."
      : entropyState === "amber"
        ? "Entropy pressure is moderate and requires active monitoring."
        : "Entropy pressure is currently stable.";

  return `Remaining scope is ${remaining.toFixed(1)} FP. ${velocityPhrase} Projected completion is around week ${forecast.targetWeek}. ${confidencePhrase} ${entropyPhrase}`;
}

function getWeekTicks(maxWeek, desiredTickCount = 6) {
  const safeMax = Math.max(1, Math.ceil(maxWeek));
  const step = Math.max(1, Math.ceil(safeMax / Math.max(2, desiredTickCount)));
  const ticks = [];

  for (let week = 0; week <= safeMax; week += step) {
    ticks.push(week);
  }

  if (ticks[ticks.length - 1] !== safeMax) {
    ticks.push(safeMax);
  }

  return ticks;
}

function getRemainingTicks(maxRemaining, desiredTickCount = 5) {
  const safeMax = Math.max(1, Math.ceil(maxRemaining));
  const roughStep = safeMax / Math.max(2, desiredTickCount);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const residual = roughStep / magnitude;

  let niceFactor = 1;
  if (residual > 5) {
    niceFactor = 10;
  } else if (residual > 2) {
    niceFactor = 5;
  } else if (residual > 1) {
    niceFactor = 2;
  }

  const step = Math.max(1, niceFactor * magnitude);
  const ticks = [];

  for (let value = 0; value <= safeMax; value += step) {
    ticks.push(value);
  }

  if (ticks[ticks.length - 1] !== safeMax) {
    ticks.push(safeMax);
  }

  return ticks;
}

function getScopeChangeMarkers(state) {
  return state.history
    .map((snapshot) => {
      const delta = Number((snapshot.after.scopeTarget - snapshot.before.scopeTarget).toFixed(1));
      if (delta === 0) {
        return null;
      }

      return {
        week: snapshot.week,
        delta,
      };
    })
    .filter(Boolean);
}

function scalePoint(point, maxWeek, maxRemaining, width, height, padding) {
  const xSpan = Math.max(1, maxWeek);
  const ySpan = Math.max(1, maxRemaining);

  const x = padding + (point.week / xSpan) * (width - padding * 2);
  const y = height - padding - (point.remaining / ySpan) * (height - padding * 2);

  return { x, y };
}

function linePath(points, maxWeek, maxRemaining, width, height, padding) {
  if (!points.length) {
    return "";
  }

  return points
    .map((point, idx) => {
      const scaled = scalePoint(point, maxWeek, maxRemaining, width, height, padding);
      return `${idx === 0 ? "M" : "L"}${scaled.x.toFixed(2)} ${scaled.y.toFixed(2)}`;
    })
    .join(" ");
}

function polygonPath(points, maxWeek, maxRemaining, width, height, padding) {
  return points
    .map((point) => {
      const scaled = scalePoint(point, maxWeek, maxRemaining, width, height, padding);
      return `${scaled.x.toFixed(2)},${scaled.y.toFixed(2)}`;
    })
    .join(" ");
}

function renderBurndownSvg(state) {
  const width = 900;
  const height = 260;
  const padding = 38;

  const actual = getBurndownSeries(state);
  const remaining = projectScopeRemaining(state);
  const showForecast = remaining > 0 && state.run.status !== "won" && state.run.status !== "failed";
  const forecast = estimateForecast(state, actual);
  const scopeMarkers = getScopeChangeMarkers(state);

  const maxWeek = Math.max(
    12,
    ...actual.map((point) => point.week),
    ...(showForecast ? forecast.line.map((point) => point.week) : [0]),
    ...(scopeMarkers.length ? scopeMarkers.map((marker) => marker.week) : [0]),
  );

  const maxRemaining = Math.max(
    10,
    ...actual.map((point) => point.remaining),
    ...(showForecast ? forecast.line.map((point) => point.remaining) : [0]),
    ...(showForecast ? forecast.conePolygon.map((point) => point.remaining) : [0]),
  );

  const actualPath = linePath(actual, maxWeek, maxRemaining, width, height, padding);
  const forecastPath = showForecast
    ? linePath(
      forecast.line,
      maxWeek,
      maxRemaining,
      width,
      height,
      padding,
    )
    : "";

  const conePoints = showForecast
    ? polygonPath(
      forecast.conePolygon,
      maxWeek,
      maxRemaining,
      width,
      height,
      padding,
    )
    : "";

  const weekTicks = getWeekTicks(maxWeek);
  const remainingTicks = getRemainingTicks(maxRemaining);

  const horizontalGrid = remainingTicks
    .filter((tick) => tick > 0)
    .map((tick) => {
      const { y } = scalePoint({ week: 0, remaining: tick }, maxWeek, maxRemaining, width, height, padding);
      return `<line class="grid-line" x1="${padding}" y1="${y.toFixed(2)}" x2="${(width - padding).toFixed(2)}" y2="${y.toFixed(2)}" />`;
    })
    .join("");

  const verticalGrid = weekTicks
    .filter((tick) => tick > 0)
    .map((tick) => {
      const { x } = scalePoint({ week: tick, remaining: 0 }, maxWeek, maxRemaining, width, height, padding);
      return `<line class="grid-line" x1="${x.toFixed(2)}" y1="${padding}" x2="${x.toFixed(2)}" y2="${(height - padding).toFixed(2)}" />`;
    })
    .join("");

  const xTickLabels = weekTicks
    .map((tick) => {
      const { x } = scalePoint({ week: tick, remaining: 0 }, maxWeek, maxRemaining, width, height, padding);
      const y = height - padding;
      return `
        <line class="tick-line" x1="${x.toFixed(2)}" y1="${y.toFixed(2)}" x2="${x.toFixed(2)}" y2="${(y + 5).toFixed(2)}" />
        <text class="axis-text axis-text-x" x="${x.toFixed(2)}" y="${(y + 9).toFixed(2)}">${tick}</text>
      `;
    })
    .join("");

  const yTickLabels = remainingTicks
    .map((tick) => {
      const { y } = scalePoint({ week: 0, remaining: tick }, maxWeek, maxRemaining, width, height, padding);
      return `
        <line class="tick-line" x1="${(padding - 5).toFixed(2)}" y1="${y.toFixed(2)}" x2="${padding}" y2="${y.toFixed(2)}" />
        <text class="axis-text axis-text-y" x="${(padding - 8).toFixed(2)}" y="${(y + 3).toFixed(2)}">${tick}</text>
      `;
    })
    .join("");

  const actualDots = actual
    .map((point, index) => {
      const scaled = scalePoint(point, maxWeek, maxRemaining, width, height, padding);
      const isCurrent = index === actual.length - 1;
      const r = isCurrent ? 4.4 : 3.4;

      return `
        <circle class="${isCurrent ? "data-dot data-dot-current" : "data-dot"}" cx="${scaled.x.toFixed(2)}" cy="${scaled.y.toFixed(2)}" r="${r}">
          <title>Week ${point.week}: ${point.remaining.toFixed(1)} FP remaining</title>
        </circle>
      `;
    })
    .join("");

  const forecastEndDot = showForecast
    ? (() => {
      const forecastEnd = forecast.line[1];
      const scaled = scalePoint(forecastEnd, maxWeek, maxRemaining, width, height, padding);
      return `
        <circle class="forecast-end-dot" cx="${scaled.x.toFixed(2)}" cy="${scaled.y.toFixed(2)}" r="3.4">
          <title>Projected completion by week ${Math.round(forecast.targetWeek)}</title>
        </circle>
      `;
    })()
    : "";

  const scopeMarkerLines = scopeMarkers
    .map((marker, idx) => {
      const { x } = scalePoint({ week: marker.week, remaining: 0 }, maxWeek, maxRemaining, width, height, padding);
      const markerLabel = `${marker.delta > 0 ? "+" : ""}${marker.delta.toFixed(1)} FP`;
      const markerMessage = marker.delta > 0 ? "increased" : "reduced";
      const labelY = padding + 12 + (idx % 2) * 12;

      return `
        <g>
          <title>Week ${marker.week}: Scope ${markerMessage} by ${Math.abs(marker.delta).toFixed(1)} FP.</title>
          <line class="scope-marker" x1="${x.toFixed(2)}" y1="${padding}" x2="${x.toFixed(2)}" y2="${(height - padding).toFixed(2)}" />
          <text class="scope-marker-text" x="${x.toFixed(2)}" y="${labelY.toFixed(2)}">${markerLabel}</text>
        </g>
      `;
    })
    .join("");

  const ariaLabel = showForecast
    ? `Burndown chart with forecast to week ${Math.round(forecast.targetWeek)}`
    : "Burndown chart with completed scope";

  return `
    <svg class="burndown-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}">
      ${horizontalGrid}
      ${verticalGrid}
      <line class="axis-line" x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" />
      <line class="axis-line" x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" />
      ${xTickLabels}
      ${yTickLabels}
      <text class="axis-title axis-title-x" x="${(width / 2).toFixed(2)}" y="${(height - 6).toFixed(2)}">Week</text>
      <text class="axis-title axis-title-y" transform="translate(12 ${(height / 2).toFixed(2)}) rotate(-90)">Remaining FP</text>
      ${showForecast ? `<polygon class="cone" points="${conePoints}" />` : ""}
      ${scopeMarkerLines}
      <path class="line-actual" d="${actualPath}" />
      ${showForecast ? `<path class="line-forecast" d="${forecastPath}" />` : ""}
      ${actualDots}
      ${forecastEndDot}
    </svg>
  `;
}

function getWarnings(state) {
  const warnings = [];

  if (state.entropy.entropyIndex > 40) {
    warnings.push({ kind: "bad", text: "Entropy critical" });
  } else if (state.entropy.entropyIndex >= 20) {
    warnings.push({ kind: "warn", text: "Entropy elevated" });
  } else {
    warnings.push({ kind: "good", text: "Entropy stable" });
  }

  if (state.resources.cashNegativeStreak >= 1) {
    warnings.push({ kind: "bad", text: "Insolvency risk" });
  }

  if (state.resources.moraleBelow20Streak >= 1) {
    warnings.push({ kind: "warn", text: "Mutiny pressure" });
  }

  if (state.run.status === "released") {
    warnings.push({ kind: "good", text: "Post-launch mode" });
  }

  return warnings;
}

function renderEventFeed(state) {
  const logs = [...state.logs].reverse();

  if (!logs.length) {
    return `<div class="small">No activity recorded yet.</div>`;
  }

  return logs
    .slice(0, 30)
    .map(
      (entry) => `
      <article class="event-item">
        <div class="meta">Week ${entry.week} · ${entry.type}</div>
        <div class="msg">${entry.message}</div>
      </article>
    `,
    )
    .join("");
}

function renderWeekModal() {
  if (!uiState.showWeekModal || !uiState.lastSnapshot) {
    return "";
  }

  const snap = uiState.lastSnapshot;

  return `
    <section class="week-modal" aria-live="polite">
      <h3>Week ${snap.week} Review</h3>
      <div class="week-grid">
        <div class="week-cell">
          <div>Build: <strong>${snap.build.result}</strong></div>
          <div>Stability: <strong>${snap.build.stabilityScore}</strong></div>
          <div>Ghost Tasks: <strong>${snap.build.ghostTasks}</strong></div>
        </div>
        <div class="week-cell">
          <div>Completion Δ: <strong>${formatSigned(snap.deltas.completion, 1)}</strong></div>
          <div>Tech Debt Δ: <strong>${formatSigned(snap.deltas.techDebt, 2)}</strong></div>
          <div>Bugs Δ: <strong>${formatSigned(snap.deltas.bugBacklog, 0)}</strong></div>
        </div>
        <div class="week-cell">
          <div>Cash Δ: <strong>${formatCurrency(snap.deltas.cash)}</strong></div>
          <div>Morale Δ: <strong>${formatSigned(snap.deltas.morale, 1)}</strong></div>
          <div>Hype Δ: <strong>${formatSigned(snap.deltas.hype, 0)}</strong></div>
        </div>
        <div class="week-cell">
          <div>Event: <strong>${snap.event?.name ?? "None"}</strong></div>
          <div>Launch: <strong>${snap.release.executed ? snap.release.outcome : "No"}</strong></div>
          <div>Sales: <strong>${formatCurrency(snap.sales.weekSales)}</strong></div>
        </div>
      </div>
      <div class="action-bar">
        <button class="btn" id="dismiss-week-modal">Dismiss</button>
      </div>
    </section>
  `;
}

function renderSaveSlots() {
  const slots = listSaveSlots();

  return slots
    .map(
      (slot) => `
      <article class="save-slot save-slot-compact">
        <div class="save-slot-head">
          <strong>${slot.id.toUpperCase()}</strong>
          <span class="meta">${slot.exists ? `W${slot.week}` : "Empty"}</span>
        </div>
        <div class="action-bar action-bar-tight">
          <button class="btn" data-save-action="save" data-save-key="${slot.storageKey}">Save</button>
          <button class="btn" data-save-action="load" data-save-key="${slot.storageKey}">Load</button>
          <button class="btn" data-save-action="delete" data-save-key="${slot.storageKey}">Delete</button>
        </div>
      </article>
    `,
    )
    .join("");
}

function renderDashboard() {
  const cardAvailability = getCardAvailability(gameState);
  const preview = previewWeek(gameState, gameState.plan);
  const releaseAvailable = isReleaseAvailable(gameState);
  const canAdvance = canAdvanceWeek(gameState, gameState.plan);

  const cpTotal = preview.derivedCapacity.cpEffective;
  const cpUsed = sumAllocations(preview.allocations);
  const cpUnallocated = Math.max(0, cpTotal - cpUsed);

  const entropyIdx = gameState.entropy.entropyIndex;
  const entropyPct = clamp((entropyIdx / 70) * 100, 0, 100);
  const entropyState = entropyLevel(entropyIdx);
  const chartRemaining = projectScopeRemaining(gameState);
  const chartShowForecast =
    chartRemaining > 0 && gameState.run.status !== "won" && gameState.run.status !== "failed";
  const hasScopeChanges = gameState.history.some(
    (snapshot) => Number((snapshot.after.scopeTarget - snapshot.before.scopeTarget).toFixed(1)) !== 0,
  );

  const warnings = getWarnings(gameState);

  const focusCard = getFocusCardById(gameState.plan.focusCardId);
  const managementCard = getManagementCardById(gameState.plan.managementCardId);

  const showRunResult = gameState.run.status === "won" || gameState.run.status === "failed";
  const statusClass = statusBannerKindClass(uiState.banner.kind);
  const runStatus = stateStatusLabel(gameState.run.status);
  const isMobileView = window.matchMedia("(max-width: 767px)").matches;

  const html = `
    <main class="app-shell">
      <header class="dashboard-header">
        <div class="dashboard-header-copy">
          <div class="header-kicker">Entropy: The Studio Simulation</div>
          <h1 class="header-title">Week ${gameState.run.week} Command Deck</h1>
          <div class="header-subtitle">${runStatus}</div>
        </div>
        <div class="header-status-chip">${uiState.banner.message}</div>
      </header>

      <section class="resource-bar" aria-label="Run metrics">
        <div class="metric">
          <div class="label">Cash</div>
          <div class="value">${formatCurrency(gameState.resources.cash)}</div>
          <div class="sub">Runway: ${formatRunway(gameState.resources.runwayWeeks)} weeks</div>
        </div>
        <div class="metric">
          <div class="label">Morale</div>
          <div class="value">${formatPercent(gameState.resources.morale, 0)}</div>
          <div class="sub">Crunch streak: ${gameState.resources.crunchStreak}</div>
        </div>
        <div class="metric">
          <div class="label">Week and Status</div>
          <div class="value">Week ${gameState.run.week}</div>
          <div class="sub">${stateStatusLabel(gameState.run.status)}</div>
        </div>
        <div class="metric">
          <div class="label">Project</div>
          <div class="value">${Math.round(gameState.project.completion)} / ${Math.round(gameState.project.scopeTarget)}</div>
          <div class="sub">Quality ${gameState.project.quality.toFixed(1)} · Hype ${gameState.market.hype.toFixed(0)}</div>
        </div>
      </section>

      <section class="status-banner ${statusClass}">${uiState.banner.message}</section>

      <section class="dashboard-grid">
        <aside class="panel planning-panel">
          <h2 class="panel-title">Weekly Planning</h2>

          <div class="planning-grid">
            <div class="control-row">
              <label for="focus-card">Focus Card</label>
              <select id="focus-card">
                ${FOCUS_CARDS.map(
                  (card) => `
                  <option value="${card.id}" ${card.id === gameState.plan.focusCardId ? "selected" : ""} ${cardAvailability.focus[card.id] ? "" : "disabled"}>
                    ${card.name}${cardAvailability.focus[card.id] ? "" : " (Locked)"}
                  </option>
                `,
                ).join("")}
              </select>
              <div class="small">${focusCard.description}</div>
            </div>

            <div class="control-row">
              <label for="management-card">Management Card</label>
              <select id="management-card">
                ${MANAGEMENT_CARDS.map(
                  (card) => `
                  <option value="${card.id}" ${card.id === gameState.plan.managementCardId ? "selected" : ""} ${cardAvailability.management[card.id] ? "" : "disabled"}>
                    ${card.name}${cardAvailability.management[card.id] ? "" : " (Cooldown)"}
                  </option>
                `,
                ).join("")}
              </select>
              <div class="small">${managementCard.description}</div>
            </div>

            <div class="control-row">
              <label for="scope-creep-policy">Scope Creep Policy</label>
              <select id="scope-creep-policy">
                <option value="reject" ${gameState.plan.scopeCreepPolicy === "reject" ? "selected" : ""}>Reject request (safer schedule)</option>
                <option value="accept" ${gameState.plan.scopeCreepPolicy === "accept" ? "selected" : ""}>Accept request (higher hype)</option>
              </select>
            </div>

            <div class="control-row">
              <label>
                <input type="checkbox" id="release-request" ${gameState.plan.releaseRequested ? "checked" : ""} ${releaseAvailable ? "" : "disabled"} />
                Release on next advance
              </label>
              <div class="small">${releaseAvailable ? "Guardrails met" : "Release locked until guardrails are met"}</div>
            </div>

            <div class="capacity-strip" role="status" aria-live="polite">
              <span>Capacity ${cpTotal} CP</span>
              <span>Allocated ${cpUsed}</span>
              <span>Unallocated ${cpUnallocated}</span>
            </div>

            ${[
              ["feature", "Feature"],
              ["refactor", "Refactor"],
              ["marketing", "Marketing"],
              ["qa", "QA"],
            ]
              .map(
                ([key, label]) => `
                <div class="alloc-row">
                  <div class="alloc-label">${label}</div>
                  <input class="alloc-input" type="number" min="0" value="${preview.allocations[key]}" data-alloc-key="${key}" />
                </div>
              `,
              )
              .join("")}

            <div class="action-bar action-bar-primary">
              <button class="btn primary" id="advance-week-btn" ${canAdvance && !showRunResult ? "" : "disabled"}>Advance Week</button>
              <button class="btn" id="new-run-btn">New Run</button>
            </div>
          </div>
        </aside>

        <section class="main-stack">
          <section class="panel burndown-wrap">
            <h2 class="panel-title">Burndown and Forecast</h2>
            ${renderBurndownSvg(gameState)}
            <div class="chart-state-note">${getBurndownStateNote(gameState)}</div>
            <div class="legend">
              <span><span class="legend-dot legend-dot-actual"></span>Actual Remaining Scope</span>
              ${
                chartShowForecast
                  ? `
                    <span><span class="legend-line legend-line-forecast"></span>Forecast (dashed)</span>
                    <span><span class="legend-swatch legend-cone-swatch"></span>Uncertainty range</span>
                  `
                  : `<span><span class="legend-dot legend-dot-complete"></span>Scope complete</span>`
              }
              ${
                hasScopeChanges
                  ? `<span><span class="legend-line legend-line-scope"></span>Scope target changed</span>`
                  : ""
              }
            </div>
          </section>

          <section class="panel preview-panel">
            <h2 class="panel-title">Weekly Preview</h2>
            <div class="preview-grid">
              <div class="preview-item"><span>Completion Δ</span><span class="${getDeltaClass(preview.projected.completionDelta)}">${formatSigned(preview.projected.completionDelta, 1)}</span></div>
              <div class="preview-item"><span>Tech Debt Δ</span><span class="${getDeltaClass(preview.projected.debtDelta)}">${formatSigned(preview.projected.debtDelta, 2)}</span></div>
              <div class="preview-item"><span>Bugs Δ</span><span class="${getDeltaClass(preview.projected.bugDelta)}">${formatSigned(preview.projected.bugDelta, 0)}</span></div>
              <div class="preview-item"><span>Quality Δ</span><span class="${getDeltaClass(preview.projected.qualityDelta)}">${formatSigned(preview.projected.qualityDelta, 1)}</span></div>
              <div class="preview-item"><span>Morale Δ</span><span class="${getDeltaClass(preview.projected.moraleDelta)}">${formatSigned(preview.projected.moraleDelta, 1)}</span></div>
              <div class="preview-item"><span>Hype Δ</span><span class="${getDeltaClass(preview.projected.hypeDelta)}">${formatSigned(preview.projected.hypeDelta, 0)}</span></div>
            </div>
          </section>

          <section class="panel howto-panel">
            <details class="howto-details" ${isMobileView ? "open" : ""}>
              <summary class="panel-title howto-summary">How the Run Works</summary>
              <div class="howto-scroll" role="region" aria-label="How to play quick guide" tabindex="0">
                <p><strong>Simulation:</strong> You run a product team balancing delivery speed, quality, morale, and market traction while scope and events keep changing.</p>
                <p><strong>Weekly flow:</strong> plan your allocations and cards, click <em>Advance Week</em>, then review deltas and events before planning the next turn.</p>
                <p><strong>Key Terms:</strong> <strong>CP (Capacity Points)</strong> is weekly work energy allocated across Feature, Refactor, Marketing, and QA. <strong>FP (Feature Points)</strong> is the unit of scope and progress used in completion and burndown velocity.</p>
                <p><strong>Weekly Preview:</strong> these deltas are next-week projections from your current plan before random friction and build outcomes resolve.</p>
                <ul class="howto-list">
                  <li><strong>Completion Δ</strong> is expected scope delivered in FP (Feature Points); higher is better.</li>
                  <li><strong>Tech Debt Δ</strong> is expected debt change; lower or negative is better.</li>
                  <li><strong>Bugs Δ</strong> is expected backlog change; lower or negative is better.</li>
                  <li><strong>Quality Δ</strong> is expected quality movement; higher is better.</li>
                  <li><strong>Morale Δ</strong> is expected team sentiment change; higher supports future capacity.</li>
                  <li><strong>Hype Δ</strong> is expected market expectation change; higher helps reach but can outpace product strength.</li>
                </ul>
                <p><strong>How Entropy Works:</strong> Entropy Index = 0.7 * Tech Debt + min(30, 0.8 * Bug Backlog).</p>
                <ul class="howto-list">
                  <li><strong>Green (&lt; 20)</strong> means low operational drag.</li>
                  <li><strong>Amber (20-40)</strong> means rising friction and schedule risk.</li>
                  <li><strong>Red (&gt; 40)</strong> means critical instability pressure.</li>
                </ul>
                <p><strong>Control entropy:</strong> allocate Capacity Points (CP) to <em>Refactor</em> to reduce tech debt and <em>QA</em> to reduce bug backlog. Heavy <em>Feature</em> focus with weak QA pushes entropy upward.</p>
                <ul class="howto-list">
                  <li><strong>Feature</strong> pushes completion fastest, but can raise tech debt and bugs if overused.</li>
                  <li><strong>Refactor</strong> lowers entropy and future risk, but slows short-term progress.</li>
                  <li><strong>Marketing</strong> raises hype and launch upside, but does not stabilize the build.</li>
                  <li><strong>QA</strong> cuts bug backlog and protects quality before release.</li>
                </ul>
                <p><strong>Play effectively:</strong> keep entropy out of red, avoid long crunch streaks, and rebalance each week instead of tunneling on one lane.</p>
                <p><strong>Release timing:</strong> ship when guardrails are met and quality is stable; too early tanks outcomes, too late burns runway.</p>
              </div>
            </details>
          </section>

          ${renderWeekModal()}
        </section>

        <aside class="panel insight-panel">
          <h2 class="panel-title">Entropy and Event Feed</h2>

          <div class="control-row">
            <label>Entropy Index ${entropyIdx.toFixed(1)}</label>
            <div class="entropy-meter">
              <div class="entropy-fill state-${entropyState}" style="width:${entropyPct.toFixed(1)}%"></div>
            </div>
            <div class="small">Tech Debt ${gameState.entropy.techDebt.toFixed(1)} · Bugs ${gameState.entropy.bugBacklog}</div>
          </div>

          <div class="tag-row">
            ${warnings
              .map((warning) => `<span class="tag ${warning.kind}">${warning.text}</span>`)
              .join("")}
          </div>

          <div class="control-row">
            <label>Latest Build</label>
            <div class="small">${gameState.entropy.latestBuildResult} · stability ${gameState.entropy.latestStabilityScore.toFixed(1)} · ghost ${gameState.entropy.latestGhostTasks}</div>
          </div>

          <div class="control-row">
            <label>Event Feed</label>
            <div class="event-feed">${renderEventFeed(gameState)}</div>
          </div>

          <section class="planning-subpanel right-save-panel">
            <h3 class="subpanel-title">Save and Run Controls</h3>
            <div class="action-bar action-bar-tight">
              <button class="btn" id="save-autosave-btn">Save Auto</button>
              <button class="btn" id="load-autosave-btn">Load Auto</button>
            </div>
            <div class="small">Autosave is written each resolved week.</div>
            <details class="save-collapsible">
              <summary>Manual Slots</summary>
              <div class="save-grid save-grid-compact">${renderSaveSlots()}</div>
            </details>
          </section>
        </aside>
      </section>
    </main>
  `;

  appRoot.innerHTML = html;
}

function applyPlanPatch(patch) {
  const candidatePlan = {
    ...gameState.plan,
    ...patch,
    allocations: {
      ...gameState.plan.allocations,
      ...(patch.allocations ?? {}),
    },
  };

  const sanitized = sanitizePlan(gameState, candidatePlan);

  gameState = hydrateDerivedFields({
    ...gameState,
    plan: sanitized.plan,
    team: {
      ...gameState.team,
      cpBase: sanitized.derivedCapacity.cpBase,
      cpEffective: sanitized.derivedCapacity.cpEffective,
    },
  });
}

function bindPlanningEvents() {
  const focusSelect = document.querySelector("#focus-card");
  const managementSelect = document.querySelector("#management-card");
  const scopePolicy = document.querySelector("#scope-creep-policy");
  const releaseRequest = document.querySelector("#release-request");

  focusSelect?.addEventListener("change", (event) => {
    applyPlanPatch({ focusCardId: event.target.value });
    render();
  });

  managementSelect?.addEventListener("change", (event) => {
    applyPlanPatch({ managementCardId: event.target.value });
    render();
  });

  scopePolicy?.addEventListener("change", (event) => {
    applyPlanPatch({ scopeCreepPolicy: event.target.value });
    render();
  });

  releaseRequest?.addEventListener("change", (event) => {
    applyPlanPatch({ releaseRequested: Boolean(event.target.checked) });
    render();
  });

  document.querySelectorAll("[data-alloc-key]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const key = event.target.getAttribute("data-alloc-key");
      const value = clampAllocInput(Number(event.target.value));
      applyPlanPatch({
        allocations: {
          [key]: value,
        },
      });
      render();
    });
  });
}

function saveAutosave() {
  const result = saveGameState(SAVE_KEYS.autosave, gameState);

  if (result.ok) {
    setBanner("good", `Autosave updated (${result.bytes} bytes).`);
  } else {
    setBanner("bad", `Autosave failed: ${result.error}`);
  }
}

function handleAdvanceWeek() {
  if (!canAdvanceWeek(gameState, gameState.plan)) {
    setBanner("warn", "Cannot advance: allocate capacity or resolve plan constraints.");
    render();
    return;
  }

  const nextState = resolveWeek(gameState, gameState.plan);
  gameState = hydrateDerivedFields(nextState);

  uiState.lastSnapshot = gameState.history[gameState.history.length - 1] ?? null;
  uiState.showWeekModal = true;

  saveAutosave();

  if (gameState.run.status === "won") {
    setBanner("good", gameState.run.result?.message ?? "Run succeeded.");
  } else if (gameState.run.status === "failed") {
    setBanner("bad", gameState.run.result?.message ?? "Run failed.");
  } else if (uiState.lastSnapshot?.release.executed) {
    setBanner("info", `Launch resolved: ${uiState.lastSnapshot.release.outcome}.`);
  } else {
    setBanner("info", "Week resolved.");
  }

  render();
}

function handleNewRun() {
  const seed = Date.now();
  gameState = hydrateDerivedFields(createInitialGameState(seed));
  uiState.lastSnapshot = null;
  uiState.showWeekModal = false;
  saveAutosave();
  setBanner("info", `New run created with seed ${gameState.meta.seed}.`);
  render();
}

function loadIntoState(storageKey) {
  const loaded = loadGameState(storageKey);

  if (!loaded.ok) {
    const fallback = loadGameState(SAVE_KEYS.autosave);

    if (fallback.ok && fallback.state) {
      gameState = hydrateDerivedFields(fallback.state);
      uiState.lastSnapshot = gameState.history[gameState.history.length - 1] ?? null;
      uiState.showWeekModal = false;
      setBanner(
        "warn",
        `Failed to load ${storageKey}. Recovered from autosave instead.`,
      );
      render();
      return;
    }

    setBanner("bad", `Failed to load save: ${loaded.error}`);
    render();
    return;
  }

  if (!loaded.state) {
    setBanner("warn", `No save data found in ${storageKey}.`);
    render();
    return;
  }

  gameState = hydrateDerivedFields(loaded.state);
  uiState.lastSnapshot = gameState.history[gameState.history.length - 1] ?? null;
  uiState.showWeekModal = false;
  setBanner("good", `Loaded save from ${storageKey}.`);
  render();
}

function bindActionEvents() {
  document.querySelector("#advance-week-btn")?.addEventListener("click", handleAdvanceWeek);
  document.querySelector("#new-run-btn")?.addEventListener("click", handleNewRun);

  document.querySelector("#dismiss-week-modal")?.addEventListener("click", () => {
    uiState.showWeekModal = false;
    render();
  });

  document.querySelector("#save-autosave-btn")?.addEventListener("click", () => {
    saveAutosave();
    render();
  });

  document.querySelector("#load-autosave-btn")?.addEventListener("click", () => {
    loadIntoState(SAVE_KEYS.autosave);
  });

  document.querySelectorAll("[data-save-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-save-action");
      const key = button.getAttribute("data-save-key");

      if (!key) {
        return;
      }

      if (action === "save") {
        const result = saveGameState(key, gameState);
        if (result.ok) {
          setBanner("good", `Saved to ${key}.`);
        } else {
          setBanner("bad", `Save failed: ${result.error}`);
        }
        render();
        return;
      }

      if (action === "load") {
        loadIntoState(key);
        return;
      }

      if (action === "delete") {
        const result = deleteSaveState(key);
        if (result.ok) {
          setBanner("warn", `Deleted save ${key}.`);
        } else {
          setBanner("bad", `Delete failed: ${result.error}`);
        }
        render();
      }
    });
  });
}

function render() {
  renderDashboard();
  bindPlanningEvents();
  bindActionEvents();
}

function initializeGame() {
  const autosave = loadGameState(SAVE_KEYS.autosave);

  if (autosave.ok && autosave.state) {
    gameState = hydrateDerivedFields(autosave.state);
    setBanner("info", "Loaded autosave state.");
  } else {
    gameState = hydrateDerivedFields(createInitialGameState(Date.now()));
    setBanner("info", `Created new run with seed ${gameState.meta.seed}.`);
    saveAutosave();
  }

  render();
}

initializeGame();

