const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}

export function floorInt(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.floor(value);
}

export function sumAllocations(allocations) {
  return (
    floorInt(allocations.feature) +
    floorInt(allocations.refactor) +
    floorInt(allocations.marketing) +
    floorInt(allocations.qa)
  );
}

export function normalizeIntegerAllocations(allocations, limit) {
  const safeLimit = Math.max(0, floorInt(limit));
  const safe = {
    feature: Math.max(0, floorInt(allocations.feature)),
    refactor: Math.max(0, floorInt(allocations.refactor)),
    marketing: Math.max(0, floorInt(allocations.marketing)),
    qa: Math.max(0, floorInt(allocations.qa)),
  };

  const total = sumAllocations(safe);

  if (safeLimit === 0) {
    return { feature: 0, refactor: 0, marketing: 0, qa: 0 };
  }

  if (total <= safeLimit) {
    return safe;
  }

  const ratio = safeLimit / total;
  const scaled = {
    feature: 0,
    refactor: 0,
    marketing: 0,
    qa: 0,
  };

  const remainder = [];
  let used = 0;

  for (const key of Object.keys(scaled)) {
    const raw = safe[key] * ratio;
    const floored = Math.floor(raw);
    scaled[key] = floored;
    used += floored;
    remainder.push({ key, fraction: raw - floored });
  }

  remainder.sort((a, b) => b.fraction - a.fraction);

  let idx = 0;
  while (used < safeLimit && idx < remainder.length) {
    scaled[remainder[idx].key] += 1;
    used += 1;
    idx += 1;
  }

  return scaled;
}

export function formatCurrency(value) {
  return usdFormatter.format(Math.round(value));
}

export function formatPercent(value, digits = 0) {
  return `${Number(value).toFixed(digits)}%`;
}

export function formatSigned(value, digits = 0) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(digits)}`;
}

export function calculateRunwayWeeks(cash, weeklyBurn) {
  const burn = Math.max(0, floorInt(weeklyBurn));

  if (burn === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, Math.floor(cash / burn));
}

export function deepClone(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

