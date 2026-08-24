import { prisma } from '../lib/prisma.js';
import env from '../config/env.js';
import { ingestLocation, today } from './tracking.service.js';
import { distanceKm, lerpPoint, bearing } from '../lib/geo.js';

/**
 * Demo vehicle movement.
 *
 * It drives seeded trucks along their published polyline and pushes every
 * position through `ingestLocation` — the same function a real driver handset
 * hits. Nothing about the architecture is shortcut for the demo; turn it off
 * with SIMULATOR_ENABLED=false and real devices take over unchanged.
 */

const SPEED_KMPH = 24;

/**
 * Signal quality belongs to the handset, not to the fix.
 *
 * Rolling a 12% chance of a rough fix on every single ping reads as realistic
 * and is not: the health grade is the *median* accuracy over ten minutes, so
 * an 88% good stream converges on "Strong" for every truck alike, and the
 * whole fleet grades GOOD however long you watch it. Real degradation sticks
 * to a device — a cracked antenna is bad all day, a truck working between tall
 * sector blocks is mediocre all day — so the tier is assigned per vehicle and
 * held.
 *
 * Keyed off the vehicle id so a truck keeps the same handset across restarts
 * and the officer's board does not reshuffle its warnings every deploy.
 */
const GOOD_HANDSET = { name: 'GOOD', accuracy: () => 4 + Math.random() * 12 };
const FAIR_HANDSET = { name: 'FAIR', accuracy: () => 28 + Math.random() * 24 };
const POOR_HANDSET = { name: 'POOR', accuracy: () => 66 + Math.random() * 30 };
// Good signal when it arrives; the problem is that it often does not.
const PATCHY_HANDSET = { name: 'PATCHY', accuracy: () => 5 + Math.random() * 14, dropsFixes: true };

/**
 * Dealt round-robin over this pattern rather than drawn from a distribution.
 *
 * Weighted-random keyed on the vehicle id looks more principled and behaves
 * worse: cuids share so much structure that a cheap hash correlates, and over
 * the real 44 vehicles it dealt 34 GOOD but only two FAIR and a single POOR —
 * a fleet with nothing to look at. Ten slots give an exact, stable spread, and
 * position in a sorted list is as stable a key as the id itself.
 */
const HANDSET_PATTERN = [
  GOOD_HANDSET, GOOD_HANDSET, FAIR_HANDSET, GOOD_HANDSET, PATCHY_HANDSET,
  GOOD_HANDSET, FAIR_HANDSET, GOOD_HANDSET, POOR_HANDSET, GOOD_HANDSET,
];

const handsetAt = (index) => HANDSET_PATTERN[index % HANDSET_PATTERN.length];

const state = {
  running: false,
  timer: null,
  ticks: 0,
  trucks: new Map(),
};

export function simulatorStatus() {
  return {
    enabled: env.simulator.enabled,
    running: state.running,
    intervalMs: env.simulator.intervalMs,
    trucks: state.trucks.size,
    ticks: state.ticks,
  };
}

export async function startSimulator() {
  if (!env.simulator.enabled || state.running) return simulatorStatus();

  await syncTrucks();

  state.running = true;
  state.timer = setInterval(() => {
    tick().catch((err) => console.error('[sim]', err.message));
  }, env.simulator.intervalMs);
  state.timer.unref?.();
  console.log(`[sim] driving ${state.trucks.size} trucks every ${env.simulator.intervalMs}ms`);
  return simulatorStatus();
}

export function stopSimulator() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
  return simulatorStatus();
}

/**
 * Re-reads today's published routes and merges them into the running truck
 * set, instead of a one-time snapshot at boot. A route created (or
 * re-optimised) after the server started would otherwise never be picked up
 * for demo movement until the next restart.
 */
async function syncTrucks() {
  const routes = await prisma.route.findMany({
    where: { date: today(), status: { in: ['PUBLISHED', 'IN_PROGRESS'] } },
    include: { vehicle: true },
  });

  /**
   * Drivers currently standing down.
   *
   * Their trucks must not keep driving: a vehicle moving along its route while
   * the officer's board says its driver is on a rest break is the two screens
   * contradicting each other, and the break is the fact the driver actually
   * asserted.
   *
   * They must not stop reporting either, which is what dropping them from the
   * truck set did. A parked truck still has a handset on the dashboard, so
   * after two minutes of silence the board was showing a driver as on duty and
   * on a break with their GPS dead — the same contradiction from the other
   * side. They stay in the set and report a stationary fix instead.
   */
  const resting = new Set(
    (
      await prisma.driverShift.findMany({
        where: { status: 'ON_BREAK', date: today() },
        select: { vehicleId: true },
      })
    )
      .map((r) => r.vehicleId)
      .filter(Boolean)
  );

  const active = new Set();
  // Sorted so the same truck keeps the same handset across restarts.
  routes.sort((a, b) => String(a.vehicleId).localeCompare(String(b.vehicleId)));
  let handsetIndex = -1;
  for (const route of routes) {
    const path = route.polylineGeometry;
    if (!Array.isArray(path) || path.length < 2) continue;
    if (route.vehicle?.maintenanceFlag) continue;
    active.add(route.vehicleId);
    handsetIndex += 1;
    const handset = handsetAt(handsetIndex);
    const existing = state.trucks.get(route.vehicleId);
    if (existing) {
      // Route may have been re-optimised — refresh the path, keep progress.
      existing.path = path;
      existing.driverId = route.driverId;
      existing.resting = resting.has(route.vehicleId);
      // A truck already in the set from before this field existed.
      existing.handset = handset;
      existing.skipUntilTick ??= 0;
    } else {
      state.trucks.set(route.vehicleId, {
        vehicleId: route.vehicleId,
        driverId: route.driverId,
        path,
        leg: 0,
        progress: 0,
        pausedUntil: 0,
        resting: resting.has(route.vehicleId),
        lastPosition: path[0],
        lastHeading: 0,
        handset,
        skipUntilTick: 0,
      });
    }
  }

  for (const vehicleId of [...state.trucks.keys()]) {
    if (!active.has(vehicleId)) state.trucks.delete(vehicleId);
  }

  if (!state.trucks.size) {
    console.log('[sim] no published routes for today — simulator idle (run `npm run seed`)');
  }
}

const SYNC_EVERY_TICKS = Math.max(1, Math.round(30_000 / env.simulator.intervalMs));

async function tick() {
  state.ticks += 1;
  if (state.ticks % SYNC_EVERY_TICKS === 0) await syncTrucks();

  const hours = env.simulator.intervalMs / 3_600_000;
  const stepKm = SPEED_KMPH * hours;

  for (const truck of state.trucks.values()) {
    if (state.ticks < truck.pausedUntil) continue;

    /**
     * Parked, but still on the air.
     *
     * A handset left on a dashboard keeps reporting the same spot, drifting a
     * couple of metres as the fix wanders. That drift stays under the 8 m the
     * tracker needs before it writes a history row, so this keeps the truck
     * alive on the map without filling vehicle_locations with a stationary
     * smear.
     */
    if (truck.resting) {
      const [lng, lat] = truck.lastPosition ?? truck.path[0];
      await ingestLocation({
        vehicleId: truck.vehicleId,
        latitude: lat + (Math.random() - 0.5) * 0.00004,
        longitude: lng + (Math.random() - 0.5) * 0.00004,
        heading: truck.lastHeading,
        speed: 0,
        accuracy: Number(truck.handset.accuracy().toFixed(1)),
      });
      continue;
    }

    const moved = advance(truck, stepKm);
    if (!moved) {
      // Reached the depot — idle briefly, then run the beat again so a long
      // demo never goes static.
      truck.leg = 0;
      truck.progress = 0;
      truck.pausedUntil = state.ticks + 5;
      continue;
    }

    /**
     * A real handset reports its own accuracy with every fix, and the fleet's
     * GPS health is read from exactly that. Emitting fixes without it left
     * the column empty for every simulated truck, so the health grade could
     * only ever say "not reported".
     *
     * Most fixes are good; a minority degrade the way they genuinely do in a
     * built-up sector, which is what makes the weak-signal state visible at
     * all rather than theoretical.
     */
    /**
     * A dropout is a gap the handset never filled, which is what the health
     * grade counts. Capped well under the two minutes that means "offline":
     * this truck is reporting badly, not gone.
     */
    if (truck.handset.dropsFixes) {
      if (state.ticks < truck.skipUntilTick) continue;
      if (Math.random() < 0.04) {
        truck.skipUntilTick = state.ticks + Math.round((50 + Math.random() * 25) * 1000 / env.simulator.intervalMs);
      }
    }
    const accuracy = truck.handset.accuracy();

    // Remembered so a driver who goes on break keeps reporting from where the
    // truck actually stopped, rather than from the top of the route.
    truck.lastPosition = moved.position;
    truck.lastHeading = moved.heading;

    await ingestLocation({
      vehicleId: truck.vehicleId,
      latitude: moved.position[1],
      longitude: moved.position[0],
      heading: moved.heading,
      speed: SPEED_KMPH,
      accuracy: Number(accuracy.toFixed(1)),
    });
  }
}

/** Walk the polyline by `km`, returning the interpolated position and heading. */
function advance(truck, km) {
  let remaining = km;

  while (remaining > 0) {
    const a = truck.path[truck.leg];
    const b = truck.path[truck.leg + 1];
    if (!b) return null;

    const legKm = Math.max(distanceKm(a, b), 1e-6);
    const leftOnLeg = legKm * (1 - truck.progress);

    if (remaining < leftOnLeg) {
      truck.progress += remaining / legKm;
      remaining = 0;
    } else {
      remaining -= leftOnLeg;
      truck.leg += 1;
      truck.progress = 0;
      if (!truck.path[truck.leg + 1]) {
        return { position: truck.path[truck.leg], heading: bearing(a, b) };
      }
    }
  }

  const a = truck.path[truck.leg];
  const b = truck.path[truck.leg + 1] || a;
  return { position: lerpPoint(a, b, truck.progress), heading: bearing(a, b) };
}

export default { startSimulator, stopSimulator, simulatorStatus };
