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
function startingStateIndex(averageReportsPerHour) {
  const fraction = clamp01((averageReportsPerHour * 24) / (LAMBDA_BASELINE * 2));
  if (fraction < THRESHOLD_OPTIMAL) return 0; // optimal
  if (fraction < THRESHOLD_FILLING) return 1; // filling
  if (fraction < THRESHOLD_NEAR_FULL) return 2; // near_full
  return 3; // overflow
}

export function simulateWardOverflow({ delayHours, averageReportsPerHour }) {
  const days = Math.max(1, Math.round(delayHours / 24));
  const startIndex = startingStateIndex(averageReportsPerHour);
  const dailyLambda = averageReportsPerHour * 24;

  let overflowRuns = 0;
  let atRiskRuns = 0; // near_full or worse
  let reportTotal = 0;

  for (let run = 0; run < RUNS; run += 1) {
    let state = startIndex;
    let reports = 0;
    for (let day = 0; day < days; day += 1) {
      state = nextState(state, MATRIX);
      reports += samplePoisson(dailyLambda);
    }
    if (state === OVERFLOW_INDEX) overflowRuns += 1;
    if (state >= NEAR_FULL_INDEX) atRiskRuns += 1;
    reportTotal += reports;
  }

  return {
    runs: RUNS,
    overflowProbabilityPercent: Math.round((overflowRuns / RUNS) * 100),
    atRiskProbabilityPercent: Math.round((atRiskRuns / RUNS) * 100),
    projectedAdditionalReports: Math.round(reportTotal / RUNS),
    startingState: STATES[startIndex],
  };
}

export default { simulateWardOverflow };
