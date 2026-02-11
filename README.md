# Entropy: The Studio Simulation — Web MVP Prototype

Browser-first, single-player dashboard simulation prototype for Tier 1 (Garage tutorial scope), based on [`plans/web_mvp_tier1_spec.md`](plans/web_mvp_tier1_spec.md).

## Implemented Scope

- Weekly turn-based planning and resolution loop
- Deterministic simulation core with seeded RNG
- Focus and Management policy cards with constraints and cooldowns
- Capacity allocation across Feature, Refactor, Marketing, and QA
- Tech Debt, Bug Backlog, Morale, Cash runway, and Hype systems
- Friday stability check and ghost task generation
- Launch guardrails and launch outcome resolution
- Post-launch weekly sales behavior and terminal state checks
- Dashboard UI with:
  - Resource bar
  - Burndown chart and forecast cone
  - Entropy gauge and warning tags
  - Planning controls and projected weekly deltas
  - Event feed and week review modal
  - Save/load slot controls
- Local save system with autosave and 3 manual slots
- Determinism smoke tests

## Project Structure

- [`index.html`](index.html): Browser entrypoint
- [`src/main.js`](src/main.js): UI composition, event handlers, run controls
- [`src/styles.css`](src/styles.css): Dashboard styling
- [`src/core/config.js`](src/core/config.js): Balance tables, cards, events, constants
- [`src/core/state.js`](src/core/state.js): Initial game state factory
- [`src/core/rng.js`](src/core/rng.js): Deterministic RNG
- [`src/core/sim.js`](src/core/sim.js): Simulation preview and week resolution engine
- [`src/core/persistence.js`](src/core/persistence.js): Local storage save/load/migration guard
- [`test/sim/determinism.smoke.test.mjs`](test/sim/determinism.smoke.test.mjs): Smoke tests

## Run Locally

### 1) Start static server

```bash
npm run serve
```

Then open `http://127.0.0.1:8080`.

### 2) Run simulation smoke tests

```bash
npm run test
```

## Notes

- The default local server may log a 404 for `/favicon.ico`; this is non-blocking.
- Save payloads are versioned with schema metadata for future migration support.

