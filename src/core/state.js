import {
  FOCUS_CARDS,
  GAME_CONFIG,
  MANAGEMENT_CARDS,
  SAVE_SCHEMA_VERSION,
} from "./config.js";
import { normalizeSeed } from "./rng.js";

function getDefaultFocusCardId() {
  return FOCUS_CARDS[0]?.id ?? "featureSprint";
}

function getDefaultManagementCardId() {
  return MANAGEMENT_CARDS[0]?.id ?? "sustainablePace";
}

let saveIdCounter = 1;

function generateSaveId(seed) {
  const id = `save-${seed}-${String(saveIdCounter).padStart(4, "0")}`;
  saveIdCounter += 1;
  return id;
}

export function createInitialGameState(seed = Date.now()) {
  const resolvedSeed = normalizeSeed(seed);
  const now = new Date().toISOString();

  const salariesTotal = GAME_CONFIG.team.fixedDevelopers.reduce(
    (acc, dev) => acc + dev.salary,
    0,
  );

  return {
    meta: {
      schemaVersion: SAVE_SCHEMA_VERSION,
      saveId: generateSaveId(resolvedSeed),
      createdAtIso: now,
      updatedAtIso: now,
      seed: resolvedSeed,
      rngState: resolvedSeed,
    },
    run: {
      week: 1,
      phase: "planning",
      status: "active", // active | released | failed | won
      result: null,
      postLaunchWeeks: 0,
      postLaunchNonNegativeCashStreak: 0,
      launchWeek: null,
    },
    resources: {
      cash: GAME_CONFIG.starting.cash,
      morale: GAME_CONFIG.starting.morale,
      weeklyBurn:
        GAME_CONFIG.economy.officeRentPerWeek +
        salariesTotal,
      runwayWeeks: Math.floor(
        GAME_CONFIG.starting.cash /
          (GAME_CONFIG.economy.officeRentPerWeek + salariesTotal),
      ),
      moraleBelow20Streak: 0,
      cashNegativeStreak: 0,
      crunchStreak: 0,
    },
    team: {
      members: GAME_CONFIG.team.fixedDevelopers.map((dev) => ({
        ...dev,
        availabilityMultiplier: 1,
      })),
      cpBase: 0,
      cpEffective: 0,
    },
    project: {
      scopeTarget: GAME_CONFIG.starting.scopeTarget,
      completion: GAME_CONFIG.starting.completion,
      quality: GAME_CONFIG.starting.quality,
      milestonesReached: [],
      releaseReady: false,
      released: false,
    },
    entropy: {
      techDebt: GAME_CONFIG.starting.techDebt,
      bugBacklog: GAME_CONFIG.starting.bugBacklog,
      entropyIndex: 0,
      latestStabilityScore: 0,
      latestBuildResult: "none",
      latestGhostTasks: 0,
    },
    market: {
      hype: GAME_CONFIG.starting.hype,
      reputation: GAME_CONFIG.starting.reputation,
      productStrength: 0,
      launchOutcome: null,
      weekSales: 0,
      lifetimeSales: 0,
      refunds: 0,
    },
    plan: {
      focusCardId: getDefaultFocusCardId(),
      managementCardId: getDefaultManagementCardId(),
      scopeCreepPolicy: "reject",
      allocations: {
        feature: 8,
        refactor: 6,
        marketing: 4,
        qa: 6,
      },
      locked: false,
      pendingDecision: null,
      cooldowns: {
        crunch: 0,
        teamBuilding: 0,
      },
      releaseRequested: false,
    },
    counters: {
      totalWeeksSimulated: 0,
      totalFeaturePointsDone: 0,
      totalDebtReduced: 0,
      totalBugsFixed: 0,
      totalGhostTasks: 0,
      totalMilestones: 0,
      totalEventsTriggered: 0,
    },
    history: [],
    logs: [
      {
        week: 1,
        type: "system",
        message: "New run initialized.",
        createdAtIso: now,
      },
    ],
  };
}

