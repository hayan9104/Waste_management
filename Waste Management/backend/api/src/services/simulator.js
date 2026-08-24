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
   * Drivers currently standing down. Their trucks must not keep driving: a
   * vehicle moving along its route while the officer's board says its driver
   * is on a rest break is the two screens contradicting each other, and the
   * break is the fact the driver actually asserted.
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
  for (const route of routes) {
    const path = route.polylineGeometry;
    if (!Array.isArray(path) || path.length < 2) continue;
    if (route.vehicle?.maintenanceFlag) continue;
    if (resting.has(route.vehicleId)) {
      state.trucks.delete(route.vehicleId);
      continue;
    }

    active.add(route.vehicleId);
    const existing = state.trucks.get(route.vehicleId);
    if (existing) {
      // Route may have been re-optimised — refresh the path, keep progress.
      existing.path = path;
      existing.driverId = route.driverId;
    } else {
      state.trucks.set(route.vehicleId, {
        vehicleId: route.vehicleId,
        driverId: route.driverId,
        path,
        leg: 0,
        progress: 0,
        pausedUntil: 0,
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
    const rough = Math.random() < 0.12;
    const accuracy = rough ? 45 + Math.random() * 45 : 4 + Math.random() * 14;

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
