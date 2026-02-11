export function normalizeSeed(seed) {
  if (!Number.isFinite(seed)) {
    return 0x9e3779b9;
  }

  const normalized = Math.abs(Math.floor(seed)) >>> 0;
  return normalized === 0 ? 0x9e3779b9 : normalized;
}

function xorshift32(state) {
  let x = state >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;

  return x === 0 ? 0x9e3779b9 : x;
}

export function createRng(initialState) {
  let state = normalizeSeed(initialState);

  return {
    nextUint() {
      state = xorshift32(state);
      return state;
    },
    nextFloat() {
      return this.nextUint() / 0x1_0000_0000;
    },
    nextInt(min, max) {
      const lower = Math.min(min, max);
      const upper = Math.max(min, max);
      const span = upper - lower + 1;
      return lower + Math.floor(this.nextFloat() * span);
    },
    pickWeighted(items, getWeight) {
      const totalWeight = items.reduce((acc, item) => acc + Math.max(0, getWeight(item)), 0);

      if (totalWeight <= 0) {
        return items[0] ?? null;
      }

      let roll = this.nextFloat() * totalWeight;

      for (const item of items) {
        roll -= Math.max(0, getWeight(item));
        if (roll <= 0) {
          return item;
        }
      }

      return items[items.length - 1] ?? null;
    },
    getState() {
      return state >>> 0;
    },
  };
}

