import { CALIBRATION } from '../config/calibration/index.js';

/**
 * Ward what-if forecaster (plan §2.3 FEATURE 7) — a real Poisson-Markov Monte
 * Carlo simulation using calibrated parameters (config/calibration/whatif.json,
 * extracted from ward_whatif_forecaster.checkpoint.pt): each run walks the
 * fill-level Markov chain one day at a time and draws a Poisson-distributed
 * report count per day, starting from a state derived from the ward's actual
 * recent report rate. This replaces the previous fixed-formula estimate
 * (`35 + delayHours * 9.5`) with an actual stochastic simulation.
 */

const {
  markov_transition_matrix: MATRIX,
  markov_states: STATES,
  poisson_lambda_inflow: LAMBDA_BASELINE,
  monte_carlo_default_runs: RUNS,
  threshold_optimal: THRESHOLD_OPTIMAL,
  threshold_filling: THRESHOLD_FILLING,
  threshold_near_full: THRESHOLD_NEAR_FULL,
} = CALIBRATION.whatif.params;

/**
 * The calibrated matrix describes a ward under *normal operation*, so it
 * contains recovery transitions — overflow back to near_full at 0.25, and so
 * on. Those only happen because a truck came and emptied the bins.
 *
 * The what-if asks the opposite question: what if dispatch is delayed and
 * nobody collects? Running the unmodified chain answered it backwards — a
 * longer delay came out *safer*, because the bins were quietly emptying
 * themselves in the simulation while the premise said nothing was collected.
 *
 * So for this scenario each row keeps only "stay put or get worse" and is
 * renormalised over what remains. Overflow becomes absorbing, which is the
 * honest statement: without collection, a ward that has overflowed does not
 * un-overflow on its own.
 */
const NO_COLLECTION_MATRIX = MATRIX.map((row, from) => {
  const kept = row.map((prob, to) => (to >= from ? prob : 0));
  const total = kept.reduce((a, b) => a + b, 0);
  return total > 0 ? kept.map((prob) => prob / total) : kept.map((_, to) => (to === from ? 1 : 0));
});

const OVERFLOW_INDEX = STATES.indexOf('overflow');
const NEAR_FULL_INDEX = STATES.indexOf('near_full');
const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** Knuth's algorithm — fine for the small lambdas (single-digit daily rates) this model deals with. */
function samplePoisson(lambda) {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}

function nextState(stateIndex, matrix) {
  const row = matrix[stateIndex];
  const roll = Math.random();
  let acc = 0;
  for (let i = 0; i < row.length; i += 1) {
    acc += row[i];
    if (roll <= acc) return i;
  }
  return row.length - 1;
}

/**
 * Where the ward starts on the fill-level chain, using the calibrated
 * fill-fraction thresholds. Real per-ward fill-sensor data isn't available
 * yet (IoT bin sensors are a documented future phase, see PROJECT_STATUS.md
 * §8), so a ward's report rate relative to 2x the calibrated citywide
 * average inflow is the best available proxy for how full it's running.
 */
/** Stops one truck can realistically clear in a shift, from the seeded beats. */
const STOPS_PER_TRUCK_DAY = 8;

function startingStateIndex(averageReportsPerHour, openBacklog, trucks) {
  /**
   * Prefer backlog against fleet capacity when we have it.
   *
   * The old proxy compared the ward's report rate to twice a citywide constant
   * (2 x 4.18/day). Any ward taking more than about eight reports a day
   * therefore started at "overflow" — which is every ward in a working city —
   * so the simulator answered 100% overflow before the delay was even applied
   * and looked broken whatever the slider said. How far behind the crew
   * actually is says far more about how full a ward is running than its raw
   * inflow does.
   */
  if (openBacklog != null && trucks > 0) {
    const capacity = Math.max(1, trucks * STOPS_PER_TRUCK_DAY);
    const backlogFraction = clamp01(openBacklog / capacity);
    if (backlogFraction < THRESHOLD_OPTIMAL) return 0;
    if (backlogFraction < THRESHOLD_FILLING) return 1;
    if (backlogFraction < THRESHOLD_NEAR_FULL) return 2;
    return 3;
  }

  const fraction = clamp01((averageReportsPerHour * 24) / (LAMBDA_BASELINE * 2));
  if (fraction < THRESHOLD_OPTIMAL) return 0; // optimal
  if (fraction < THRESHOLD_FILLING) return 1; // filling
  if (fraction < THRESHOLD_NEAR_FULL) return 2; // near_full
  return 3; // overflow
}

/**
 * Runs the chain over a fractional number of days.
 *
 * The delay control is in hours and the model stepped in whole days via
 * `Math.max(1, Math.round(delayHours / 24))`, which collapses every delay from
 * 0 to 35 hours onto exactly one day. Dragging the slider across most of its
 * range therefore changed nothing at all — 0h and 24h returned the same
 * numbers — and the simulation looked broken because, as far as the input was
 * concerned, it was.
 *
 * Reports are drawn as a single Poisson over the whole window: the
 * distribution is additive, so Poisson(lambda x days) over a fractional span
 * is exact rather than an approximation, and a zero delay correctly yields
 * zero extra reports instead of a day's worth.
 *
 * The transition matrix is calibrated per day, so a partial day applies one
 * more transition with probability equal to the leftover fraction. Averaged
 * over the Monte Carlo runs that reproduces the right amount of drift without
 * pretending the matrix is valid at hourly resolution.
 */
export function simulateWardOverflow({ delayHours, averageReportsPerHour, openBacklog = null, trucks = 0 }) {
  const exactDays = Math.max(0, delayHours) / 24;
  const wholeDays = Math.floor(exactDays);
  const partialDay = exactDays - wholeDays;
  const startIndex = startingStateIndex(averageReportsPerHour, openBacklog, trucks);
  const dailyLambda = averageReportsPerHour * 24;

  let overflowRuns = 0;
  let atRiskRuns = 0; // near_full or worse
  let reportTotal = 0;

  for (let run = 0; run < RUNS; run += 1) {
    let state = startIndex;
    for (let day = 0; day < wholeDays; day += 1) {
      state = nextState(state, NO_COLLECTION_MATRIX);
    }
    if (partialDay > 0 && Math.random() < partialDay) {
      state = nextState(state, NO_COLLECTION_MATRIX);
    }
    const reports = samplePoisson(dailyLambda * exactDays);
    if (state === OVERFLOW_INDEX) overflowRuns += 1;
    if (state >= NEAR_FULL_INDEX) atRiskRuns += 1;
    reportTotal += reports;
  }

  return {
    runs: RUNS,
    delayHours,
    overflowProbabilityPercent: Math.round((overflowRuns / RUNS) * 100),
    atRiskProbabilityPercent: Math.round((atRiskRuns / RUNS) * 100),
    projectedAdditionalReports: Math.round(reportTotal / RUNS),
    startingState: STATES[startIndex],
  };
}

export default { simulateWardOverflow };
