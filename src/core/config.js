export const SAVE_SCHEMA_VERSION = 1;

export const SAVE_KEYS = {
  autosave: "entropy.m3.autosave",
  slot1: "entropy.m3.slot1",
  slot2: "entropy.m3.slot2",
  slot3: "entropy.m3.slot3",
};

export const GAME_CONFIG = {
  starting: {
    cash: 220_000,
    morale: 70,
    techDebt: 8,
    bugBacklog: 4,
    hype: 10,
    reputation: 20,
    quality: 30,
    completion: 0,
    scopeTarget: 120,
  },
  team: {
    fixedDevelopers: [
      { id: "dev-1", name: "Dev A", baseCp: 8, salary: 6_000 },
      { id: "dev-2", name: "Dev B", baseCp: 8, salary: 6_000 },
      { id: "dev-3", name: "Dev C", baseCp: 8, salary: 6_000 },
    ],
  },
  economy: {
    officeRentPerWeek: 4_000,
    marketingExtraSpendPerCp: 0,
  },
  ranges: {
    moraleMin: 0,
    moraleMax: 100,
    debtMin: 0,
    debtMax: 100,
    qualityMin: 0,
    qualityMax: 100,
    hypeMin: 0,
    hypeMax: 200,
    reputationMin: 0,
    reputationMax: 100,
  },
  formulas: {
    morale: {
      baseDecayPerWeek: 2,
      cleanBuildBonus: 1,
      failedBuildPenalty: 5,
      crunchStreakPenaltyPerWeek: 2,
    },
    debt: {
      featureRushThreshold: 0.8,
      featureRushMultiplier: 25,
      qaShareFloor: 0.1,
      qaPenaltyMultiplier: 20,
      complexityRatioThreshold: 6,
      complexityFlatGain: 1.5,
      refactorBaseEfficiency: 0.35,
    },
    bugs: {
      generationBase: 0.08,
      generationDebtDivisor: 250,
      fixPerQaCp: 0.55,
      featureBugPressureCap: 0.3,
      featureBugPressureDivisor: 200,
    },
    quality: {
      qaContribution: 0.2,
      featureContribution: 0.03,
      highDebtDecayThreshold: 35,
      highDebtDecayValue: 1,
    },
    hype: {
      cpToHype: 1.2,
      noMarketingDecay: 3,
    },
    stability: {
      debtPenalty: 0.9,
      bugPenalty: 0.6,
      bugPenaltyCap: 40,
      qaShareBonusFactor: 20,
      cleanThreshold: 70,
      warningThreshold: 40,
    },
    launch: {
      baseSales: 30_000,
      productStrength: {
        completionWeight: 60,
        qualityWeight: 0.3,
        moraleWeight: 0.1,
        bugQualityBase: 20,
        bugPenaltyFactor: 0.4,
      },
      outcomes: {
        miracleDeltaThreshold: 15,
        scamDeltaThreshold: -15,
        hiddenGemProductStrengthThreshold: 70,
        hiddenGemHypeCeiling: 55,
      },
      salesMultiplier: {
        miracle: 2.2,
        mixedFair: 1.0,
        hiddenGem: 0.8,
        scam: 0.5,
      },
      refundPenaltyRateScam: 0.25,
      weeklyPostLaunchSales: {
        miracle: { baseMultiplier: 1.1, decay: 0.88, floorMultiplier: 0.2 },
        mixedFair: { baseMultiplier: 0.8, decay: 0.85, floorMultiplier: 0.15 },
        hiddenGem: {
          baseMultiplier: 0.65,
          growthPerWeek: 0.1,
          growthWeeks: 4,
          decayAfterGrowth: 0.9,
          floorMultiplier: 0.2,
        },
        scam: { baseMultiplier: 0.45, decay: 0.75, floorMultiplier: 0.1 },
      },
    },
  },
  events: {
    trigger: {
      baseChance: 0.15,
      debtDivisor: 200,
      moraleOffsetBaseline: 50,
      moraleDivisor: 250,
      minChance: 0.05,
      maxChance: 0.65,
    },
  },
  releaseGuardrails: {
    minCompletion: 100,
    minQuality: 35,
    minWeek: 8,
    minCash: 0,
  },
  successCondition: {
    requiredPostLaunchWeeks: 8,
  },
};

export const FOCUS_CARDS = [
  {
    id: "featureSprint",
    name: "Feature Sprint",
    description: "Push output now and borrow against future velocity.",
    multipliers: {
      feature: 1.25,
      refactor: 1,
      quality: 1,
      marketing: 1,
      qa: 0.9,
    },
    flatDeltas: {
      debt: 1,
      morale: 0,
    },
    constraints: {},
  },
  {
    id: "cleanupWeek",
    name: "Cleanup Week",
    description: "Trade output for debt relief and team breathing room.",
    multipliers: {
      feature: 0,
      refactor: 1.8,
      quality: 1,
      marketing: 1,
      qa: 1,
    },
    flatDeltas: {
      debt: 0,
      morale: 2,
    },
    constraints: {
      cannotRepeatConsecutively: true,
    },
  },
  {
    id: "polishing",
    name: "Polishing",
    description: "Raise quality and perceived fit-and-finish at lower throughput.",
    multipliers: {
      feature: 0.65,
      refactor: 1,
      quality: 2,
      marketing: 1.1,
      qa: 1,
    },
    flatDeltas: {
      debt: 0,
      morale: 0,
    },
    constraints: {
      minCompletion: 40,
    },
  },
];

export const MANAGEMENT_CARDS = [
  {
    id: "sustainablePace",
    name: "Sustainable Pace",
    description: "Default cadence with no extraordinary modifier.",
    multipliers: {
      cpBase: 1,
      cpEffective: 1,
      debtGain: 1,
    },
    flatDeltas: {
      morale: 0,
      cash: 0,
    },
    cooldownWeeks: 0,
  },
  {
    id: "crunch",
    name: "Crunch",
    description: "Temporary output boost with strong morale and debt penalties.",
    multipliers: {
      cpBase: 1.5,
      cpEffective: 1,
      debtGain: 1.2,
    },
    flatDeltas: {
      morale: -8,
      cash: 0,
    },
    cooldownWeeks: 2,
  },
  {
    id: "teamBuilding",
    name: "Team Building",
    description: "Spend cash for morale recovery while sacrificing short-term throughput.",
    multipliers: {
      cpBase: 1,
      cpEffective: 0.9,
      debtGain: 1,
    },
    flatDeltas: {
      morale: 10,
      cash: -8_000,
    },
    cooldownWeeks: 3,
  },
];

export const MILESTONES = [
  {
    id: "prototype",
    name: "Prototype",
    thresholdCompletion: 25,
    reward: {
      morale: 5,
      hype: 4,
    },
  },
  {
    id: "verticalSlice",
    name: "Vertical Slice",
    thresholdCompletion: 60,
    reward: {
      morale: 6,
      hype: 6,
    },
  },
  {
    id: "contentComplete",
    name: "Content Complete",
    thresholdCompletion: 95,
    reward: {
      morale: 7,
      hype: 8,
    },
  },
  {
    id: "shipReady",
    name: "Ship Ready",
    thresholdCompletion: 120,
    reward: {
      morale: 0,
      hype: 0,
    },
    conditions: {
      maxBugBacklog: 25,
    },
  },
];

export const FRICTION_EVENTS = [
  {
    id: "mergeConflict",
    name: "Merge Conflict",
    weight: 30,
    effect: {
      cpFeatureDelta: -2,
      debtDelta: 1,
      message: "Integration collision consumed feature momentum.",
    },
  },
  {
    id: "sickDay",
    name: "Sick Day",
    weight: 25,
    effect: {
      cpTotalDelta: -2,
      debtDelta: 0,
      message: "One developer had reduced availability this week.",
    },
  },
  {
    id: "toolchainOutage",
    name: "Toolchain Outage",
    weight: 10,
    effect: {
      cpTotalDelta: -3,
      debtDelta: 0,
      message: "Build and CI tooling outage reduced total throughput.",
    },
  },
  {
    id: "criticalBugEscalation",
    name: "Critical Bug Escalation",
    weight: 20,
    effect: {
      bugDelta: 8,
      qualityDelta: -2,
      message: "Production-critical issue consumed QA focus.",
    },
  },
  {
    id: "scopeCreepRequest",
    name: "Scope Creep Request",
    weight: 15,
    effect: {
      requiresDecision: true,
      accept: {
        scopeDelta: 6,
        hypeDelta: 5,
        message: "You accepted additional scope and raised expectations.",
      },
      reject: {
        moraleDelta: -2,
        hypeDelta: -1,
        message: "You rejected request and protected schedule confidence.",
      },
    },
  },
];

export const GHOST_TASK_RANGE = {
  warning: { min: 1, max: 3 },
  failed: { min: 4, max: 8 },
};

export function getFocusCardById(id) {
  return FOCUS_CARDS.find((card) => card.id === id) ?? FOCUS_CARDS[0];
}

export function getManagementCardById(id) {
  return MANAGEMENT_CARDS.find((card) => card.id === id) ?? MANAGEMENT_CARDS[0];
}

export function getFrictionEventById(id) {
  return FRICTION_EVENTS.find((event) => event.id === id) ?? null;
}

