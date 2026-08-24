import { prisma } from '../lib/prisma.js';

/**
 * GPS health per vehicle.
 *
 * "Online" is a single bit and it hides the case that actually matters: a
 * handset that is technically reporting but doing it badly — drifting to
 * 80-metre accuracy in an urban canyon, or dropping every third fix so the
 * truck teleports between stops. Both look identical to "live" on a map, and
 * both make the live route untrustworthy without saying so.
 *
 * Everything here is measured from pings the handset actually sent. Where a
 * signal was never reported — accuracy is optional on the wire — it is
 * returned as null and labelled "not reported" rather than defaulted to
 * something flattering.
 */

/** No fix in this long and the truck is not on the map in any useful sense. */
const OFFLINE_AFTER_SEC = 120;
/** Window the rate and accuracy figures are measured over. */
const WINDOW_MIN = 10;
/** A gap longer than this between consecutive fixes is a dropout, not jitter. */
const DROPOUT_GAP_SEC = 45;
/** Civilian GPS is ~5m open-sky; past this the pin is guesswork at street scale. */
const ACCURACY_GOOD_M = 25;
const ACCURACY_POOR_M = 60;

const median = (nums) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Grades one vehicle from its recent fixes.
 *
 * Ordered worst-first so a truck is never called healthy on the strength of
 * one good signal while another is failing: no fix at all outranks a stale
 * fix, which outranks poor accuracy, which outranks dropouts.
 */
function grade({ lastPingAgeSec, fixes, dropouts, accuracyM, expectedFixes }) {
  if (lastPingAgeSec == null) {
    return { status: 'NO_SIGNAL', label: 'Never reported', tone: 'neutral' };
  }
  if (lastPingAgeSec > OFFLINE_AFTER_SEC) {
    return { status: 'OFFLINE', label: `No fix for ${Math.round(lastPingAgeSec / 60)} min`, tone: 'neutral' };
  }
  if (accuracyM != null && accuracyM > ACCURACY_POOR_M) {
    return { status: 'POOR', label: `Weak fix (±${Math.round(accuracyM)} m)`, tone: 'danger' };
  }
  // Fewer than two thirds of the fixes we should have seen means the handset
  // is dropping them, even though the last one happened to arrive just now.
  if (expectedFixes >= 4 && fixes < expectedFixes * 0.66) {
    return { status: 'PATCHY', label: `Dropping fixes (${fixes}/${expectedFixes})`, tone: 'warn' };
  }
  if (dropouts > 0) {
    return { status: 'PATCHY', label: `${dropouts} dropout${dropouts > 1 ? 's' : ''} in ${WINDOW_MIN} min`, tone: 'warn' };
  }
  if (accuracyM != null && accuracyM > ACCURACY_GOOD_M) {
    return { status: 'FAIR', label: `Usable (±${Math.round(accuracyM)} m)`, tone: 'warn' };
  }
  return {
    status: 'GOOD',
    label: accuracyM != null ? `Strong (±${Math.round(accuracyM)} m)` : 'Strong signal',
    tone: 'ok',
  };
}

/**
 * Health for many vehicles in two queries.
 *
 * One query per vehicle would be ~44 round trips on the seeded city every
 * time the fleet map refreshes, which is 20 seconds.
 */
export async function gpsHealthFor(vehicleIds) {
  if (!vehicleIds?.length) return new Map();

  const since = new Date(Date.now() - WINDOW_MIN * 60_000);
  const [vehicles, points] = await Promise.all([
    prisma.vehicle.findMany({
      where: { id: { in: vehicleIds } },
      select: { id: true, lastPingAt: true, lastSpeed: true },
    }),
    prisma.vehicleLocation.findMany({
      where: { vehicleId: { in: vehicleIds }, recordedAt: { gte: since } },
      select: { vehicleId: true, recordedAt: true, accuracy: true },
      orderBy: { recordedAt: 'asc' },
    }),
  ]);

  const byVehicle = new Map();
  for (const p of points) {
    if (!byVehicle.has(p.vehicleId)) byVehicle.set(p.vehicleId, []);
    byVehicle.get(p.vehicleId).push(p);
  }

  const now = Date.now();
  const out = new Map();

  for (const v of vehicles) {
    const rows = byVehicle.get(v.id) ?? [];
    const lastPingAgeSec = v.lastPingAt ? Math.round((now - new Date(v.lastPingAt).getTime()) / 1000) : null;

    // Gaps between consecutive fixes tell us both the cadence and the dropouts.
    const gaps = [];
    for (let i = 1; i < rows.length; i += 1) {
      gaps.push((new Date(rows[i].recordedAt) - new Date(rows[i - 1].recordedAt)) / 1000);
    }
    const medianGapSec = median(gaps);
    const dropouts = gaps.filter((g) => g > DROPOUT_GAP_SEC).length;

    const accuracies = rows.map((r) => r.accuracy).filter((a) => a != null);
    const accuracyM = median(accuracies);

    /**
     * Expected fixes across the span the handset was actually reporting for,
     * not across the whole window.
     *
     * Measuring against the full ten minutes punishes a truck for the time
     * before it started: one that came on shift two minutes ago, reporting
     * perfectly every four seconds, showed "30 of ~149" and was graded PATCHY
     * on its first minute of work. The cadence itself is the handset's own
     * (a device reporting every 30s is not unhealthy because another reports
     * every 2s); the span is how long we have actually been listening.
     */
    const spanSec = rows.length > 1
      ? (new Date(rows[rows.length - 1].recordedAt) - new Date(rows[0].recordedAt)) / 1000
      : 0;
    const expectedFixes = medianGapSec && medianGapSec > 0 && spanSec > 0
      ? Math.max(1, Math.round(spanSec / medianGapSec) + 1)
      : rows.length;

    out.set(v.id, {
      ...grade({ lastPingAgeSec, fixes: rows.length, dropouts, accuracyM, expectedFixes }),
      lastPingAgeSec,
      fixes: rows.length,
      expectedFixes,
      dropouts,
      medianGapSec: medianGapSec != null ? Number(medianGapSec.toFixed(1)) : null,
      accuracyM: accuracyM != null ? Number(accuracyM.toFixed(1)) : null,
      accuracyReported: accuracies.length > 0,
      windowMinutes: WINDOW_MIN,
      speedKmph: v.lastSpeed ?? null,
    });
  }

  return out;
}

export default { gpsHealthFor };
