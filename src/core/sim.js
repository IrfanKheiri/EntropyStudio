import {
  FOCUS_CARDS,
  FRICTION_EVENTS,
  GAME_CONFIG,
  GHOST_TASK_RANGE,
  MANAGEMENT_CARDS,
  MILESTONES,
  getFocusCardById,
  getManagementCardById,
} from "./config.js";
import { createRng } from "./rng.js";
import {
  calculateRunwayWeeks,
  clamp,
  deepClone,
  floorInt,
  normalizeIntegerAllocations,
  round2,
  sumAllocations,
} from "./utils.js";

const MANAGEMENT_COOLDOWN_KEY_BY_CARD_ID = {
  crunch: "crunch",
  teamBuilding: "teamBuilding",
};

function getCooldownKeyForManagementCard(cardId) {
  return MANAGEMENT_COOLDOWN_KEY_BY_CARD_ID[cardId] ?? null;
}

function getTotalSalaryPerWeek(state) {
  return state.team.members.reduce((acc, dev) => acc + dev.salary, 0);
}

function getWeeklyBurn(state) {
  return GAME_CONFIG.economy.officeRentPerWeek + getTotalSalaryPerWeek(state);
}

function getTeamCpBase(state, cpBaseMultiplier = 1) {
  const base = state.team.members.reduce((acc, dev) => {
    const availability = Number.isFinite(dev.availabilityMultiplier)
      ? dev.availabilityMultiplier
      : 1;

    return acc + dev.baseCp * availability;
  }, 0);

  return floorInt(base * cpBaseMultiplier);
}

function computeCapacity(state, managementCard) {
  const cpBase = getTeamCpBase(state, managementCard.multipliers.cpBase ?? 1);

  const moraleMultiplier = 0.6 + 0.006 * state.resources.morale;
  const debtMultiplier = Math.max(
    0.25,
    1 - (0.75 * state.entropy.techDebt) / 100,
  );
  const cpEffective = floorInt(
    cpBase *
      moraleMultiplier *
      debtMultiplier *
      (managementCard.multipliers.cpEffective ?? 1),
  );

  return {
    cpBase,
    cpEffective: Math.max(0, cpEffective),
    moraleMultiplier: round2(moraleMultiplier),
    debtMultiplier: round2(debtMultiplier),
  };
}

function getLastWeekPlan(state) {
  if (!state.history.length) {
    return null;
  }

  return state.history[state.history.length - 1]?.plan ?? null;
}

function isFocusCardSelectable(state, focusCardId) {
  const card = getFocusCardById(focusCardId);

  if (!card) {
    return false;
  }

  if (card.constraints?.cannotRepeatConsecutively) {
    const lastPlan = getLastWeekPlan(state);
    if (lastPlan?.focusCardId === card.id) {
      return false;
    }
  }

  const minCompletion = card.constraints?.minCompletion;
  if (
    Number.isFinite(minCompletion) &&
    state.project.completion < minCompletion
  ) {
    return false;
  }

  return true;
}

function isManagementCardSelectable(state, managementCardId) {
  const card = getManagementCardById(managementCardId);

  if (!card) {
    return false;
  }

  const cooldownKey = getCooldownKeyForManagementCard(card.id);
  if (!cooldownKey) {
    return true;
  }

  return (state.plan.cooldowns?.[cooldownKey] ?? 0) <= 0;
}

function findFirstSelectableFocusCard(state) {
  return (
    FOCUS_CARDS.find((card) => isFocusCardSelectable(state, card.id))?.id ??
    FOCUS_CARDS[0]?.id ??
    "featureSprint"
  );
}

function findFirstSelectableManagementCard(state) {
  return (
    MANAGEMENT_CARDS.find((card) => isManagementCardSelectable(state, card.id))
      ?.id ??
    "sustainablePace"
  );
}

export function getCardAvailability(state) {
  const focus = {};
  const management = {};

  for (const card of FOCUS_CARDS) {
    focus[card.id] = isFocusCardSelectable(state, card.id);
  }

  for (const card of MANAGEMENT_CARDS) {
    management[card.id] = isManagementCardSelectable(state, card.id);
  }

  return { focus, management };
}

function mergePlan(state, planOverride = null) {
  if (!planOverride) {
    return deepClone(state.plan);
  }

  return {
    ...deepClone(state.plan),
    ...deepClone(planOverride),
    allocations: {
      ...deepClone(state.plan.allocations),
      ...deepClone(planOverride.allocations ?? {}),
    },
    cooldowns: {
      ...deepClone(state.plan.cooldowns ?? {}),
      ...deepClone(planOverride.cooldowns ?? {}),
    },
  };
}

export function sanitizePlan(state, planOverride = null) {
  const merged = mergePlan(state, planOverride);

  if (!isFocusCardSelectable(state, merged.focusCardId)) {
    merged.focusCardId = findFirstSelectableFocusCard(state);
  }

  if (!isManagementCardSelectable(state, merged.managementCardId)) {
    merged.managementCardId = findFirstSelectableManagementCard(state);
  }

  if (!merged.scopeCreepPolicy || !["accept", "reject"].includes(merged.scopeCreepPolicy)) {
    merged.scopeCreepPolicy = "reject";
  }

  const managementCard = getManagementCardById(merged.managementCardId);
  const capacity = computeCapacity(state, managementCard);

  merged.allocations = normalizeIntegerAllocations(
    merged.allocations ?? {},
    capacity.cpEffective,
  );

  return {
    plan: merged,
    derivedCapacity: capacity,
    cards: {
      focus: getFocusCardById(merged.focusCardId),
      management: managementCard,
    },
  };
}

function resolveEvent(state, rng) {
  const triggerConfig = GAME_CONFIG.events.trigger;
  const chance = clamp(
    triggerConfig.baseChance +
      state.entropy.techDebt / triggerConfig.debtDivisor +
      (triggerConfig.moraleOffsetBaseline - state.resources.morale) /
        triggerConfig.moraleDivisor,
    triggerConfig.minChance,
    triggerConfig.maxChance,
  );

  const roll = rng.nextFloat();

  if (roll >= chance) {
    return {
      chance,
      roll,
      event: null,
    };
  }

  const event = rng.pickWeighted(FRICTION_EVENTS, (entry) => entry.weight);

  return {
    chance,
    roll,
    event,
  };
}

function buildEventEffectDelta() {
  return {
    cpFeatureDelta: 0,
    cpTotalDelta: 0,
    debtDelta: 0,
    bugDelta: 0,
    qualityDelta: 0,
    moraleDelta: 0,
    hypeDelta: 0,
    scopeDelta: 0,
    decision: null,
    message: null,
  };
}

function materializeEventEffect(plan, event) {
  const delta = buildEventEffectDelta();

  if (!event) {
    return delta;
  }

  const effect = event.effect ?? {};

  delta.cpFeatureDelta = effect.cpFeatureDelta ?? 0;
  delta.cpTotalDelta = effect.cpTotalDelta ?? 0;
  delta.debtDelta = effect.debtDelta ?? 0;
  delta.bugDelta = effect.bugDelta ?? 0;
  delta.qualityDelta = effect.qualityDelta ?? 0;
  delta.moraleDelta = effect.moraleDelta ?? 0;
  delta.hypeDelta = effect.hypeDelta ?? 0;
  delta.scopeDelta = effect.scopeDelta ?? 0;
  delta.message = effect.message ?? null;

  if (effect.requiresDecision) {
    const decision = plan.scopeCreepPolicy === "accept" ? "accept" : "reject";
    const decisionEffect = effect[decision] ?? {};

    delta.decision = decision;
    delta.debtDelta += decisionEffect.debtDelta ?? 0;
    delta.bugDelta += decisionEffect.bugDelta ?? 0;
    delta.qualityDelta += decisionEffect.qualityDelta ?? 0;
    delta.moraleDelta += decisionEffect.moraleDelta ?? 0;
    delta.hypeDelta += decisionEffect.hypeDelta ?? 0;
    delta.scopeDelta += decisionEffect.scopeDelta ?? 0;
    delta.message = decisionEffect.message ?? delta.message;
  }

  return delta;
}

function applyEventToAllocation(planAllocations, cpEffective, eventDelta) {
  const adjustedCp = Math.max(0, cpEffective + eventDelta.cpTotalDelta);
  const adjustedAlloc = {
    ...planAllocations,
    feature: Math.max(0, planAllocations.feature + eventDelta.cpFeatureDelta),
  };

  return {
    cpEffective: adjustedCp,
    allocations: normalizeIntegerAllocations(adjustedAlloc, adjustedCp),
  };
}

function resolveMilestones(state, completion, bugBacklog) {
  const reached = new Set(state.project.milestonesReached);
  const newlyReached = [];
  let moraleBonus = 0;
  let hypeBonus = 0;

  for (const milestone of MILESTONES) {
    if (reached.has(milestone.id)) {
      continue;
    }

    if (completion < milestone.thresholdCompletion) {
      continue;
    }

    const bugLimit = milestone.conditions?.maxBugBacklog;
    if (Number.isFinite(bugLimit) && bugBacklog > bugLimit) {
      continue;
    }

    reached.add(milestone.id);
    newlyReached.push(milestone.id);
    moraleBonus += milestone.reward?.morale ?? 0;
    hypeBonus += milestone.reward?.hype ?? 0;
  }

  return {
    milestonesReached: Array.from(reached),
    newlyReached,
    moraleBonus,
    hypeBonus,
  };
}

function resolveBuildResult(stabilityScore, rng) {
  if (stabilityScore >= GAME_CONFIG.formulas.stability.cleanThreshold) {
    return {
      buildResult: "clean",
      ghostTasks: 0,
    };
  }

  if (stabilityScore >= GAME_CONFIG.formulas.stability.warningThreshold) {
    return {
      buildResult: "warning",
      ghostTasks: rng.nextInt(
        GHOST_TASK_RANGE.warning.min,
        GHOST_TASK_RANGE.warning.max,
      ),
    };
  }

  return {
    buildResult: "failed",
    ghostTasks: rng.nextInt(GHOST_TASK_RANGE.failed.min, GHOST_TASK_RANGE.failed.max),
  };
}

function runLaunchCheck(stateValues) {
  const launchConfig = GAME_CONFIG.formulas.launch;
  const strengthConfig = launchConfig.productStrength;

  const completionRatio =
    stateValues.scopeTarget > 0
      ? clamp(stateValues.completion / stateValues.scopeTarget, 0, 1.2)
      : 0;
  const bugQualityTerm = Math.max(
    0,
    strengthConfig.bugQualityBase -
      Math.min(strengthConfig.bugQualityBase, stateValues.bugBacklog * strengthConfig.bugPenaltyFactor),
  );

  const productStrength =
    completionRatio * strengthConfig.completionWeight +
    stateValues.quality * strengthConfig.qualityWeight +
    bugQualityTerm +
    stateValues.morale * strengthConfig.moraleWeight;

  const delta = productStrength - stateValues.hype;
  const outcomeCfg = launchConfig.outcomes;

  let outcome = "mixedFair";

  if (delta >= outcomeCfg.miracleDeltaThreshold) {
    outcome = "miracle";
  } else if (delta <= outcomeCfg.scamDeltaThreshold) {
    outcome = "scam";
  } else if (
    productStrength >= outcomeCfg.hiddenGemProductStrengthThreshold &&
    stateValues.hype < outcomeCfg.hiddenGemHypeCeiling
  ) {
    outcome = "hiddenGem";
  }

  const salesBase = launchConfig.baseSales;
  const multiplier = launchConfig.salesMultiplier[outcome] ?? 1;
  const refundPenalty =
    outcome === "scam"
      ? salesBase * launchConfig.refundPenaltyRateScam
      : 0;
  const weekSales = Math.max(0, floorInt(salesBase * multiplier - refundPenalty));

  return {
    productStrength: round2(productStrength),
    outcome,
    weekSales,
    refunds: floorInt(refundPenalty),
    delta: round2(delta),
  };
}

function computePostLaunchWeekSales(outcome, postLaunchWeekIndex) {
  const launchCfg = GAME_CONFIG.formulas.launch;
  const salesCfg = launchCfg.weeklyPostLaunchSales[outcome] ?? launchCfg.weeklyPostLaunchSales.mixedFair;
  const baseSales = launchCfg.baseSales;

  if (outcome === "hiddenGem") {
    if (postLaunchWeekIndex <= salesCfg.growthWeeks) {
      const growth = 1 + salesCfg.growthPerWeek * (postLaunchWeekIndex - 1);
      const raw = baseSales * salesCfg.baseMultiplier * growth;
      const floorValue = baseSales * salesCfg.floorMultiplier;
      return floorInt(Math.max(floorValue, raw));
    }

    const grownValue =
      baseSales *
      salesCfg.baseMultiplier *
      (1 + salesCfg.growthPerWeek * (salesCfg.growthWeeks - 1));
    const decayed = grownValue * salesCfg.decayAfterGrowth ** (postLaunchWeekIndex - salesCfg.growthWeeks);
    const floorValue = baseSales * salesCfg.floorMultiplier;
    return floorInt(Math.max(floorValue, decayed));
  }

  const decayed =
    baseSales *
    (salesCfg.baseMultiplier ?? 0.8) *
    (salesCfg.decay ?? 0.85) ** Math.max(0, postLaunchWeekIndex - 1);
  const floorValue = baseSales * (salesCfg.floorMultiplier ?? 0.1);

  return floorInt(Math.max(floorValue, decayed));
}

function decrementCooldowns(cooldowns = {}) {
  const next = { ...cooldowns };

  for (const key of Object.keys(next)) {
    next[key] = Math.max(0, floorInt(next[key]) - 1);
  }

  return next;
}

function applyUsedManagementCooldown(cooldowns, managementCardId) {
  const next = { ...cooldowns };
  const card = getManagementCardById(managementCardId);
  const cooldownKey = getCooldownKeyForManagementCard(managementCardId);

  if (!card || !cooldownKey) {
    return next;
  }

  if ((card.cooldownWeeks ?? 0) > 0) {
    next[cooldownKey] = card.cooldownWeeks;
  }

  return next;
}

function evaluateTerminalStates(values) {
  if (values.cashNegativeStreak >= 2) {
    return {
      isTerminal: true,
      type: "insolvency",
      message: "Cash remained below zero for 2 consecutive weeks.",
    };
  }

  if (values.moraleBelow20Streak >= 4) {
    return {
      isTerminal: true,
      type: "mutiny",
      message: "Morale stayed below 20 for 4 consecutive weeks.",
    };
  }

  if (values.released && values.productStrength < 10) {
    return {
      isTerminal: true,
      type: "delisting",
      message: "Product strength dropped below platform minimum visibility threshold.",
    };
  }

  if (
    values.released &&
    values.postLaunchNonNegativeCashStreak >=
      GAME_CONFIG.successCondition.requiredPostLaunchWeeks
  ) {
    return {
      isTerminal: true,
      type: "success",
      message: "Studio remained solvent through post-launch stabilization window.",
    };
  }

  return {
    isTerminal: false,
    type: null,
    message: null,
  };
}

export function computeEntropyIndex(techDebt, bugBacklog) {
  return round2(0.7 * techDebt + Math.min(30, bugBacklog * 0.8));
}

export function isReleaseAvailable(state) {
  if (state.run.status !== "active") {
    return false;
  }

  if (state.project.released) {
    return false;
  }

  const req = GAME_CONFIG.releaseGuardrails;

  return (
    state.project.completion >= req.minCompletion &&
    state.project.quality >= req.minQuality &&
    state.run.week >= req.minWeek &&
    state.resources.cash >= req.minCash
  );
}

export function canAdvanceWeek(state, planOverride = null) {
  if (state.run.status === "failed" || state.run.status === "won") {
    return false;
  }

  const { plan, derivedCapacity } = sanitizePlan(state, planOverride);
  const total = sumAllocations(plan.allocations);

  return derivedCapacity.cpEffective === 0 || total > 0;
}

export function previewWeek(state, planOverride = null) {
  const { plan, cards, derivedCapacity } = sanitizePlan(state, planOverride);
  const cpEffective = derivedCapacity.cpEffective;
  const allocations = normalizeIntegerAllocations(plan.allocations, cpEffective);

  const featureShare = allocations.feature / Math.max(cpEffective, 1);
  const qaShare = allocations.qa / Math.max(cpEffective, 1);

  const bugPressure = Math.min(
    GAME_CONFIG.formulas.bugs.featureBugPressureCap,
    state.entropy.bugBacklog / GAME_CONFIG.formulas.bugs.featureBugPressureDivisor,
  );

  const featurePoints = floorInt(
    allocations.feature * cards.focus.multipliers.feature * (1 - bugPressure),
  );

  const debtReduction =
    allocations.refactor *
    GAME_CONFIG.formulas.debt.refactorBaseEfficiency *
    cards.focus.multipliers.refactor *
    (1 + allocations.qa / Math.max(cpEffective, 1));

  const complexityRatio =
    (state.project.scopeTarget - state.project.completion) / Math.max(cpEffective, 1);

  let debtGain = 0;
  if (featureShare > GAME_CONFIG.formulas.debt.featureRushThreshold) {
    debtGain +=
      (featureShare - GAME_CONFIG.formulas.debt.featureRushThreshold) *
      GAME_CONFIG.formulas.debt.featureRushMultiplier;
  }

  if (qaShare < GAME_CONFIG.formulas.debt.qaShareFloor) {
    debtGain +=
      (GAME_CONFIG.formulas.debt.qaShareFloor - qaShare) *
      GAME_CONFIG.formulas.debt.qaPenaltyMultiplier;
  }

  if (complexityRatio > GAME_CONFIG.formulas.debt.complexityRatioThreshold) {
    debtGain += GAME_CONFIG.formulas.debt.complexityFlatGain;
  }

  debtGain *= cards.management.multipliers.debtGain ?? 1;
  debtGain += cards.focus.flatDeltas.debt ?? 0;

  const projectedDebt = clamp(
    state.entropy.techDebt + debtGain - debtReduction,
    GAME_CONFIG.ranges.debtMin,
    GAME_CONFIG.ranges.debtMax,
  );

  const projectedBugs = Math.max(
    0,
    state.entropy.bugBacklog +
      Math.ceil(
        allocations.feature *
          (GAME_CONFIG.formulas.bugs.generationBase +
            state.entropy.techDebt / GAME_CONFIG.formulas.bugs.generationDebtDivisor),
      ) -
      floorInt(
        allocations.qa *
          GAME_CONFIG.formulas.bugs.fixPerQaCp *
          cards.focus.multipliers.qa,
      ),
  );

  const qualityGain =
    floorInt(
      allocations.qa *
        GAME_CONFIG.formulas.quality.qaContribution *
        cards.focus.multipliers.qa +
        allocations.feature * GAME_CONFIG.formulas.quality.featureContribution,
    ) * cards.focus.multipliers.quality;

  const qualityDecay =
    projectedDebt > GAME_CONFIG.formulas.quality.highDebtDecayThreshold
      ? GAME_CONFIG.formulas.quality.highDebtDecayValue
      : 0;

  const projectedQuality = clamp(
    state.project.quality + qualityGain - qualityDecay,
    GAME_CONFIG.ranges.qualityMin,
    GAME_CONFIG.ranges.qualityMax,
  );

  const projectedMorale = clamp(
    state.resources.morale -
      GAME_CONFIG.formulas.morale.baseDecayPerWeek +
      (cards.management.flatDeltas.morale ?? 0) +
      (cards.focus.flatDeltas.morale ?? 0),
    GAME_CONFIG.ranges.moraleMin,
    GAME_CONFIG.ranges.moraleMax,
  );

  const projectedHype = clamp(
    state.market.hype +
      floorInt(
        allocations.marketing *
          GAME_CONFIG.formulas.hype.cpToHype *
          cards.focus.multipliers.marketing,
      ) -
      (allocations.marketing === 0 ? GAME_CONFIG.formulas.hype.noMarketingDecay : 0),
    GAME_CONFIG.ranges.hypeMin,
    GAME_CONFIG.ranges.hypeMax,
  );

  const projectedCompletion = Math.min(
    state.project.scopeTarget,
    state.project.completion + featurePoints,
  );

  return {
    plan,
    derivedCapacity,
    allocations,
    projected: {
      completionDelta: projectedCompletion - state.project.completion,
      debtDelta: round2(projectedDebt - state.entropy.techDebt),
      bugDelta: projectedBugs - state.entropy.bugBacklog,
      qualityDelta: projectedQuality - state.project.quality,
      moraleDelta: round2(projectedMorale - state.resources.morale),
      hypeDelta: projectedHype - state.market.hype,
    },
    releaseAvailable: isReleaseAvailable(state),
  };
}

export function resolveWeek(currentState, planOverride = null) {
  if (currentState.run.status === "failed" || currentState.run.status === "won") {
    return deepClone(currentState);
  }

  const state = deepClone(currentState);
  const before = {
    cash: state.resources.cash,
    morale: state.resources.morale,
    techDebt: state.entropy.techDebt,
    bugBacklog: state.entropy.bugBacklog,
    completion: state.project.completion,
    scopeTarget: state.project.scopeTarget,
    quality: state.project.quality,
    hype: state.market.hype,
  };

  const { plan, cards, derivedCapacity } = sanitizePlan(state, planOverride);
  let allocations = normalizeIntegerAllocations(plan.allocations, derivedCapacity.cpEffective);
  let cpEffective = derivedCapacity.cpEffective;

  if (sumAllocations(allocations) <= 0 && cpEffective > 0) {
    allocations = {
      feature: cpEffective,
      refactor: 0,
      marketing: 0,
      qa: 0,
    };
  }

  const rng = createRng(state.meta.rngState);

  const eventRollData = resolveEvent(state, rng);
  const event = eventRollData.event;
  const eventDelta = materializeEventEffect(plan, event);

  if (event) {
    state.counters.totalEventsTriggered += 1;
  }

  const allocationAfterEvent = applyEventToAllocation(
    allocations,
    cpEffective,
    eventDelta,
  );
  cpEffective = allocationAfterEvent.cpEffective;
  allocations = allocationAfterEvent.allocations;

  const cpFeature = allocations.feature;
  const cpRefactor = allocations.refactor;
  const cpMarketing = allocations.marketing;
  const cpQa = allocations.qa;

  const featureShare = cpFeature / Math.max(cpEffective, 1);
  const qaShare = cpQa / Math.max(cpEffective, 1);
  const complexityRatio =
    (state.project.scopeTarget - state.project.completion) / Math.max(cpEffective, 1);

  const bugPressure = Math.min(
    GAME_CONFIG.formulas.bugs.featureBugPressureCap,
    state.entropy.bugBacklog / GAME_CONFIG.formulas.bugs.featureBugPressureDivisor,
  );

  const featurePointsDone = floorInt(
    cpFeature * cards.focus.multipliers.feature * (1 - bugPressure),
  );

  const completion = Math.min(
    state.project.scopeTarget,
    state.project.completion + featurePointsDone,
  );

  const refactorDebtReduction =
    cpRefactor *
    GAME_CONFIG.formulas.debt.refactorBaseEfficiency *
    cards.focus.multipliers.refactor *
    (1 + cpQa / Math.max(cpEffective, 1));

  let debtGain = 0;
  if (featureShare > GAME_CONFIG.formulas.debt.featureRushThreshold) {
    debtGain +=
      (featureShare - GAME_CONFIG.formulas.debt.featureRushThreshold) *
      GAME_CONFIG.formulas.debt.featureRushMultiplier;
  }

  if (qaShare < GAME_CONFIG.formulas.debt.qaShareFloor) {
    debtGain +=
      (GAME_CONFIG.formulas.debt.qaShareFloor - qaShare) *
      GAME_CONFIG.formulas.debt.qaPenaltyMultiplier;
  }

  if (complexityRatio > GAME_CONFIG.formulas.debt.complexityRatioThreshold) {
    debtGain += GAME_CONFIG.formulas.debt.complexityFlatGain;
  }

  debtGain *= cards.management.multipliers.debtGain ?? 1;
  debtGain += cards.focus.flatDeltas.debt ?? 0;

  let techDebt = clamp(
    state.entropy.techDebt + debtGain - refactorDebtReduction + eventDelta.debtDelta,
    GAME_CONFIG.ranges.debtMin,
    GAME_CONFIG.ranges.debtMax,
  );

  const bugGenerated = Math.ceil(
    cpFeature *
      (GAME_CONFIG.formulas.bugs.generationBase +
        state.entropy.techDebt / GAME_CONFIG.formulas.bugs.generationDebtDivisor),
  );

  const bugFixed = floorInt(
    cpQa * GAME_CONFIG.formulas.bugs.fixPerQaCp * cards.focus.multipliers.qa,
  );

  let bugBacklog = Math.max(
    0,
    state.entropy.bugBacklog + bugGenerated - bugFixed + eventDelta.bugDelta,
  );

  const qualityGain =
    floorInt(
      cpQa * GAME_CONFIG.formulas.quality.qaContribution * cards.focus.multipliers.qa +
        cpFeature * GAME_CONFIG.formulas.quality.featureContribution,
    ) * cards.focus.multipliers.quality;

  const qualityDecay =
    techDebt > GAME_CONFIG.formulas.quality.highDebtDecayThreshold
      ? GAME_CONFIG.formulas.quality.highDebtDecayValue
      : 0;

  let quality = clamp(
    state.project.quality + qualityGain - qualityDecay + eventDelta.qualityDelta,
    GAME_CONFIG.ranges.qualityMin,
    GAME_CONFIG.ranges.qualityMax,
  );

  let scopeTarget = state.project.scopeTarget + eventDelta.scopeDelta;

  const milestoneResult = resolveMilestones(state, completion, bugBacklog);

  const milestoneMoraleBonus = milestoneResult.moraleBonus;
  const milestoneHypeBonus = milestoneResult.hypeBonus;

  let hype = clamp(
    state.market.hype +
      floorInt(
        cpMarketing *
          GAME_CONFIG.formulas.hype.cpToHype *
          cards.focus.multipliers.marketing,
      ) +
      milestoneHypeBonus -
      (cpMarketing === 0 ? GAME_CONFIG.formulas.hype.noMarketingDecay : 0) +
      eventDelta.hypeDelta,
    GAME_CONFIG.ranges.hypeMin,
    GAME_CONFIG.ranges.hypeMax,
  );

  const stabilityScore =
    100 -
    GAME_CONFIG.formulas.stability.debtPenalty * techDebt -
    Math.min(
      GAME_CONFIG.formulas.stability.bugPenaltyCap,
      GAME_CONFIG.formulas.stability.bugPenalty * bugBacklog,
    ) +
    GAME_CONFIG.formulas.stability.qaShareBonusFactor * qaShare;

  const buildResolution = resolveBuildResult(stabilityScore, rng);
  scopeTarget += buildResolution.ghostTasks * 1.5;

  const usedCrunch = cards.management.id === "crunch";
  const crunchStreak = usedCrunch ? state.resources.crunchStreak + 1 : 0;
  const crunchPenalty = usedCrunch
    ?
      Math.max(0, crunchStreak - 1) *
      GAME_CONFIG.formulas.morale.crunchStreakPenaltyPerWeek
    : 0;

  let morale = state.resources.morale;
  morale -= GAME_CONFIG.formulas.morale.baseDecayPerWeek;
  morale += milestoneMoraleBonus;
  morale += cards.management.flatDeltas.morale ?? 0;
  morale += cards.focus.flatDeltas.morale ?? 0;
  morale += eventDelta.moraleDelta;
  morale -= crunchPenalty;

  if (buildResolution.buildResult === "clean") {
    morale += GAME_CONFIG.formulas.morale.cleanBuildBonus;
  }

  if (buildResolution.buildResult === "failed") {
    morale -= GAME_CONFIG.formulas.morale.failedBuildPenalty;
  }

  morale = clamp(
    morale,
    GAME_CONFIG.ranges.moraleMin,
    GAME_CONFIG.ranges.moraleMax,
  );

  const weeklyBurn = getWeeklyBurn(state);
  const marketingExtraSpend =
    cpMarketing * GAME_CONFIG.economy.marketingExtraSpendPerCp;

  let weekSales = 0;
  let lifetimeSales = state.market.lifetimeSales;
  let refunds = state.market.refunds;
  let productStrength = state.market.productStrength;
  let launchOutcome = state.market.launchOutcome;

  let statusAfterWeek = state.run.status;
  let launchWeek = state.run.launchWeek;
  let postLaunchWeeks = state.run.postLaunchWeeks;
  let postLaunchNonNegativeCashStreak = state.run.postLaunchNonNegativeCashStreak;

  const releaseRequested = plan.releaseRequested === true;
  const releaseAvailableBeforeWeek = isReleaseAvailable(state);
  const releaseAttempted = releaseRequested && state.run.status === "active";
  const releaseExecuted = releaseAttempted && releaseAvailableBeforeWeek;

  if (state.run.status === "released") {
    const nextPostLaunchWeek = state.run.postLaunchWeeks + 1;
    weekSales = computePostLaunchWeekSales(state.market.launchOutcome, nextPostLaunchWeek);
    postLaunchWeeks = nextPostLaunchWeek;
  }

  if (releaseExecuted) {
    const launchResult = runLaunchCheck({
      completion,
      scopeTarget,
      quality,
      bugBacklog,
      morale,
      hype,
    });

    weekSales = launchResult.weekSales;
    refunds += launchResult.refunds;
    productStrength = launchResult.productStrength;
    launchOutcome = launchResult.outcome;
    statusAfterWeek = "released";
    launchWeek = state.run.week;
    postLaunchWeeks = 1;
  }

  lifetimeSales += weekSales;

  let cash =
    state.resources.cash -
    weeklyBurn -
    marketingExtraSpend +
    (cards.management.flatDeltas.cash ?? 0) +
    weekSales;

  cash = floorInt(cash);

  const cashNegativeStreak = cash < 0 ? state.resources.cashNegativeStreak + 1 : 0;
  const moraleBelow20Streak = morale < 20 ? state.resources.moraleBelow20Streak + 1 : 0;

  if (statusAfterWeek === "released") {
    postLaunchNonNegativeCashStreak =
      cash >= 0 ? postLaunchNonNegativeCashStreak + 1 : 0;
  } else {
    postLaunchNonNegativeCashStreak = 0;
  }

  const terminal = evaluateTerminalStates({
    cashNegativeStreak,
    moraleBelow20Streak,
    released: statusAfterWeek === "released",
    productStrength,
    postLaunchNonNegativeCashStreak,
  });

  const weekResultType = terminal.type;

  if (terminal.isTerminal && terminal.type !== "success") {
    statusAfterWeek = "failed";
  } else if (terminal.isTerminal && terminal.type === "success") {
    statusAfterWeek = "won";
  }

  const releaseReady =
    completion >= 120 &&
    bugBacklog <= 25;

  const entropyIndex = computeEntropyIndex(techDebt, bugBacklog);

  const nextCooldowns = applyUsedManagementCooldown(
    decrementCooldowns(state.plan.cooldowns),
    cards.management.id,
  );

  const logs = [...state.logs];
  if (event) {
    logs.push({
      week: state.run.week,
      type: "event",
      message: eventDelta.message ?? event.name,
      eventId: event.id,
      decision: eventDelta.decision,
    });
  }

  if (milestoneResult.newlyReached.length) {
    logs.push({
      week: state.run.week,
      type: "milestone",
      message: `Reached milestones: ${milestoneResult.newlyReached.join(", ")}.`,
    });
  }

  if (releaseExecuted) {
    logs.push({
      week: state.run.week,
      type: "launch",
      message: `Launch outcome: ${launchOutcome}.`,
    });
  }

  if (releaseAttempted && !releaseExecuted) {
    logs.push({
      week: state.run.week,
      type: "warning",
      message: "Release request ignored because guardrails were not met.",
    });
  }

  if (terminal.isTerminal) {
    logs.push({
      week: state.run.week,
      type: terminal.type === "success" ? "success" : "failure",
      message: terminal.message,
    });
  }

  const after = {
    cash,
    morale,
    techDebt,
    bugBacklog,
    completion,
    scopeTarget,
    quality,
    hype,
  };

  const deltas = {
    cash: after.cash - before.cash,
    morale: round2(after.morale - before.morale),
    techDebt: round2(after.techDebt - before.techDebt),
    bugBacklog: after.bugBacklog - before.bugBacklog,
    completion: round2(after.completion - before.completion),
    quality: round2(after.quality - before.quality),
    hype: round2(after.hype - before.hype),
  };

  const snapshot = {
    week: state.run.week,
    plan: {
      focusCardId: cards.focus.id,
      managementCardId: cards.management.id,
      scopeCreepPolicy: plan.scopeCreepPolicy,
      releaseRequested,
      allocations,
    },
    derivedCapacity: {
      cpBase: derivedCapacity.cpBase,
      cpEffective,
      moraleMultiplier: derivedCapacity.moraleMultiplier,
      debtMultiplier: derivedCapacity.debtMultiplier,
    },
    event: event
      ? {
          id: event.id,
          name: event.name,
          chance: round2(eventRollData.chance),
          roll: round2(eventRollData.roll),
          decision: eventDelta.decision,
          message: eventDelta.message,
        }
      : null,
    build: {
      stabilityScore: round2(stabilityScore),
      result: buildResolution.buildResult,
      ghostTasks: buildResolution.ghostTasks,
    },
    milestones: milestoneResult.newlyReached,
    release: {
      attempted: releaseAttempted,
      executed: releaseExecuted,
      availableBeforeWeek: releaseAvailableBeforeWeek,
      outcome: releaseExecuted ? launchOutcome : null,
      productStrength: releaseExecuted ? productStrength : null,
    },
    sales: {
      weekSales,
      lifetimeSales,
      refunds,
    },
    before,
    after,
    deltas,
    terminal: {
      type: weekResultType,
      message: terminal.message,
    },
  };

  const history = [...state.history, snapshot];

  const nextWeek =
    statusAfterWeek === "failed" || statusAfterWeek === "won"
      ? state.run.week
      : state.run.week + 1;

  return {
    ...state,
    meta: {
      ...state.meta,
      rngState: rng.getState(),
      updatedAtIso: new Date().toISOString(),
    },
    run: {
      ...state.run,
      week: nextWeek,
      phase: "planning",
      status: statusAfterWeek,
      result:
        terminal.isTerminal
          ? {
              type: terminal.type,
              message: terminal.message,
            }
          : state.run.result,
      launchWeek,
      postLaunchWeeks,
      postLaunchNonNegativeCashStreak,
    },
    resources: {
      ...state.resources,
      cash,
      morale,
      weeklyBurn,
      runwayWeeks: calculateRunwayWeeks(cash, weeklyBurn),
      moraleBelow20Streak,
      cashNegativeStreak,
      crunchStreak,
    },
    team: {
      ...state.team,
      cpBase: derivedCapacity.cpBase,
      cpEffective,
      members: state.team.members.map((member) => ({
        ...member,
        availabilityMultiplier: 1,
      })),
    },
    project: {
      ...state.project,
      completion,
      scopeTarget: round2(scopeTarget),
      quality,
      milestonesReached: milestoneResult.milestonesReached,
      releaseReady,
      released: statusAfterWeek === "released" || statusAfterWeek === "won",
    },
    entropy: {
      ...state.entropy,
      techDebt: round2(techDebt),
      bugBacklog,
      entropyIndex,
      latestStabilityScore: round2(stabilityScore),
      latestBuildResult: buildResolution.buildResult,
      latestGhostTasks: buildResolution.ghostTasks,
    },
    market: {
      ...state.market,
      hype,
      productStrength,
      launchOutcome,
      weekSales,
      lifetimeSales,
      refunds,
    },
    plan: {
      ...plan,
      allocations,
      locked: false,
      pendingDecision: null,
      cooldowns: nextCooldowns,
      releaseRequested: false,
    },
    counters: {
      ...state.counters,
      totalWeeksSimulated: state.counters.totalWeeksSimulated + 1,
      totalFeaturePointsDone: state.counters.totalFeaturePointsDone + featurePointsDone,
      totalDebtReduced:
        state.counters.totalDebtReduced + Math.max(0, round2(refactorDebtReduction)),
      totalBugsFixed: state.counters.totalBugsFixed + bugFixed,
      totalGhostTasks: state.counters.totalGhostTasks + buildResolution.ghostTasks,
      totalMilestones:
        state.counters.totalMilestones + milestoneResult.newlyReached.length,
      totalEventsTriggered: state.counters.totalEventsTriggered,
    },
    history,
    logs: logs.slice(-200),
  };
}

