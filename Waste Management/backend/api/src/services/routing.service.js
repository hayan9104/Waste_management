import axios from 'axios';
import env from '../config/env.js';
import { roadKm, distanceKm } from '../lib/geo.js';
import { prisma } from '../lib/prisma.js';
import { CALIBRATION } from '../config/calibration/index.js';

/**
 * Route optimisation (plan §7 — "a solver, not a learned model").
 *
 * With ROUTING_SERVICE_URL set, OSRM/OR-Tools does the work. Without it, this
 * built-in solver runs nearest-neighbour → 2-opt → Or-opt, which is fast enough
 * to re-solve live in front of judges and good enough to show a real saving
 * against the baseline "visit them in the order they were reported" route.
 *
 * Output shape is what Leaflet needs directly: an ordered stop list plus a
 * [[lng,lat], ...] polyline.
 */

const DEFAULTS = {
  // Fleet-telemetry-calibrated (see config/calibration/tsp.json), not hand-guessed.
  speedKmph: CALIBRATION.tsp.params.avg_truck_speed_kmh,
  serviceMin: CALIBRATION.tsp.params.stop_service_time_mins,
  startTime: '07:00',
  kmPerLitre: 5.5,
  fuelCostPerLitre: 96,
  co2KgPerLitre: 2.68,
};

const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return h * 60 + (m || 0);
};
const fmt = (mins) => {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const r2 = (n) => Number(n.toFixed(2));

export async function optimizeRoute(payload) {
  const started = Date.now();

  if (env.routingServiceUrl) {
    try {
      const { data } = await axios.post(`${env.routingServiceUrl}/optimize`, payload, { timeout: 20000 });
      return { ...data, solver: data.solver || 'osrm+ortools', solveMs: Date.now() - started };
    } catch (err) {
      console.warn('[routing] external solver unavailable, using built-in:', err.message);
    }
  }

  return { ...solveLocal(payload), solveMs: Date.now() - started };
}

export function solveLocal({ stops = [], depot, options = {} } = {}) {
  const opts = { ...DEFAULTS, ...options };
  const origin = depot?.coordinates || (stops[0] ? [stops[0].longitude, stops[0].latitude] : [0, 0]);

  const points = stops.map((s, i) => ({
    ...s,
    order: i,
    coordinates: s.coordinates || [s.longitude, s.latitude],
    serviceMin: s.serviceMin ?? opts.serviceMin,
  }));

  if (!points.length) {
    return {
      solver: 'safaai-node-2opt',
      stops: [],
      polyline: [],
      distanceKm: 0,
      baselineKm: 0,
      savedKm: 0,
      savedPct: 0,
      durationMin: 0,
      fuelSaved: 0,
      co2SavedKg: 0,
      options: opts,
    };
  }

  // Baseline: serve complaints in the order they were reported.
  const baselineKm = tourKm(origin, points);

  let order = nearestNeighbour(origin, points);
  order = twoOpt(origin, order);
  order = orOpt(origin, order);

  const distance = tourKm(origin, order);

  let clock = toMin(opts.startTime);
  const scheduled = order.map((stop, i) => {
    const from = i === 0 ? origin : order[i - 1].coordinates;
    const travelMin = (roadKm(from, stop.coordinates) / opts.speedKmph) * 60;
    clock += travelMin;
    const arrival = clock;
    clock += stop.serviceMin;

    return {
      seq: i + 1,
      complaintId: stop.complaintId ?? stop.id ?? null,
      code: stop.code ?? null,
      label: stop.label || stop.address || `Stop ${i + 1}`,
      category: stop.category ?? null,
      severity: stop.severity ?? null,
      isEmergency: Boolean(stop.isEmergency),
      reportedAt: stop.reportedAt ?? null,
      latitude: stop.coordinates[1],
      longitude: stop.coordinates[0],
      serviceMin: stop.serviceMin,
      etaMin: Math.round(arrival - toMin(opts.startTime)),
      eta: fmt(arrival),
      status: 'PENDING',
      legKm: r2(roadKm(from, stop.coordinates)),
    };
  });

  const returnMin = (roadKm(order[order.length - 1].coordinates, origin) / opts.speedKmph) * 60;
  const durationMin = Math.round(clock + returnMin - toMin(opts.startTime));

  const litresSaved = (baselineKm - distance) / opts.kmPerLitre;

  return {
    solver: 'safaai-node-2opt',
    stops: scheduled,
    polyline: [origin, ...order.map((s) => s.coordinates), origin],
    distanceKm: r2(distance),
    baselineKm: r2(baselineKm),
    savedKm: r2(baselineKm - distance),
    savedPct: baselineKm ? r2(((baselineKm - distance) / baselineKm) * 100) : 0,
    durationMin,
    endsAt: fmt(toMin(opts.startTime) + durationMin),
    fuelSaved: r2(litresSaved * opts.fuelCostPerLitre),
    litresSaved: r2(litresSaved),
    co2SavedKg: r2(litresSaved * opts.co2KgPerLitre),
    options: opts,
  };
}

function tourKm(origin, order) {
  if (!order.length) return 0;
  let km = roadKm(origin, order[0].coordinates);
  for (let i = 1; i < order.length; i += 1) km += roadKm(order[i - 1].coordinates, order[i].coordinates);
  return km + roadKm(order[order.length - 1].coordinates, origin);
}

/**
 * Emergencies are pulled to the front regardless of geography — a dead animal
 * report does not wait because it is on the far side of the ward.
 */
function nearestNeighbour(origin, stops) {
  const urgent = stops.filter((s) => s.isEmergency);
  const normal = stops.filter((s) => !s.isEmergency);

  const walk = (pool, from) => {
    const remaining = [...pool];
    const out = [];
    let current = from;
    while (remaining.length) {
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const d = roadKm(current, remaining[i].coordinates);
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      const [next] = remaining.splice(best, 1);
      out.push(next);
      current = next.coordinates;
    }
    return out;
  };

  const urgentOrder = walk(urgent, origin);
  const start = urgentOrder.length ? urgentOrder[urgentOrder.length - 1].coordinates : origin;
  return [...urgentOrder, ...walk(normal, start)];
}

/** 2-opt over the non-emergency tail so urgent stops keep their priority. */
function twoOpt(origin, order) {
  const lockedCount = order.filter((s) => s.isEmergency).length;
  if (order.length - lockedCount < 4) return order;

  const head = order.slice(0, lockedCount);
  let tail = order.slice(lockedCount);
  const anchor = head.length ? head[head.length - 1].coordinates : origin;
  const cost = (r) => tourKm(anchor, r);

  let best = cost(tail);
  let improved = true;
  let guard = 0;

  while (improved && guard < 60) {
    improved = false;
    guard += 1;
    for (let i = 0; i < tail.length - 1; i += 1) {
      for (let k = i + 1; k < tail.length; k += 1) {
        const candidate = [...tail.slice(0, i), ...tail.slice(i, k + 1).reverse(), ...tail.slice(k + 1)];
        const c = cost(candidate);
        if (c + 1e-9 < best) {
          tail = candidate;
          best = c;
          improved = true;
        }
      }
    }
  }
  return [...head, ...tail];
}

/** Or-opt relocation — cleans up the detours 2-opt leaves behind. */
function orOpt(origin, order) {
  const lockedCount = order.filter((s) => s.isEmergency).length;
  if (order.length - lockedCount < 4) return order;

  const head = order.slice(0, lockedCount);
  let tail = order.slice(lockedCount);
  const anchor = head.length ? head[head.length - 1].coordinates : origin;
  const cost = (r) => tourKm(anchor, r);

  let best = cost(tail);
  let improved = true;
  let guard = 0;

  while (improved && guard < 40) {
    improved = false;
    guard += 1;
    for (let i = 0; i < tail.length; i += 1) {
      for (let j = 0; j < tail.length; j += 1) {
        if (i === j) continue;
        const candidate = [...tail];
        const [moved] = candidate.splice(i, 1);
        candidate.splice(j, 0, moved);
        const c = cost(candidate);
        if (c + 1e-9 < best) {
          tail = candidate;
          best = c;
          improved = true;
        }
      }
    }
  }
  return [...head, ...tail];
}

/**
 * Straight-line legs are fine for the solver, but the drawn polyline should
 * look like driving. This is the last-resort fallback when OSRM cannot be
 * reached: an L-shaped waypoint per leg, which at least reads as street
 * movement instead of a diagonal across buildings.
 */
export function drivablePolyline(points) {
  const out = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    if (i === 0) out.push([ax, ay]);
    // Alternate the corner so consecutive legs do not all bend the same way.
    out.push(i % 2 === 0 ? [bx, ay] : [ax, by]);
    out.push([bx, by]);
  }
  return out;
}

/**
 * Snaps the ordered waypoints to actual streets via OSRM's routing API (the
 * same open road network Google/Uber-style routing draws from) so the drawn
 * line follows real roads instead of cutting through blocks. Falls back to the
 * L-shaped approximation if OSRM is unreachable — the default is a free,
 * unauthenticated demo server, so it must degrade gracefully.
 */
export async function roadSnappedPolyline(points) {
  if (!points || points.length < 2) return drivablePolyline(points || []);
  const { polyline } = await navigationRoute(points);
  return polyline;
}

/**
 * Road geometry PLUS the per-leg numbers a navigation view needs: how far and
 * how long to each waypoint, and where in the flattened polyline that waypoint
 * falls.
 *
 * One OSRM request covers the whole chain. `steps=true` is what makes the
 * breakpoints exact — concatenating each leg's step geometry gives the leg
 * boundaries directly, where matching waypoints back against a single merged
 * `overview` geometry can only approximate them. It also replaces the previous
 * leg-by-leg approach, which fired N sequential requests at a shared public
 * server to build the same line.
 */
export async function navigationRoute(points) {
  const waypoints = (points || []).filter(
    (p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))
  );
  if (waypoints.length < 2) {
    return { polyline: drivablePolyline(waypoints), breakpoints: [], legs: [], distanceMeters: 0, durationSeconds: 0, source: 'fallback' };
  }

  try {
    const coordStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(';');
    const { data } = await axios.get(`${env.osrmUrl}/route/v1/driving/${coordStr}`, {
      params: { overview: 'full', geometries: 'geojson', steps: true },
      timeout: 10_000,
    });

    const route = data?.routes?.[0];
    if (!route?.legs?.length) throw new Error(`OSRM returned ${data?.code || 'no route'}`);

    const polyline = [];
    const breakpoints = [];
    const legs = [];

    for (const leg of route.legs) {
      for (const step of leg.steps || []) {
        for (const coord of step.geometry?.coordinates || []) {
          const last = polyline[polyline.length - 1];
          // Consecutive steps repeat the shared vertex; keep the line clean.
          if (!last || last[0] !== coord[0] || last[1] !== coord[1]) polyline.push(coord);
        }
      }
      breakpoints.push(Math.max(0, polyline.length - 1));
      legs.push({ distanceMeters: Math.round(leg.distance), durationSeconds: Math.round(leg.duration) });
    }

    if (polyline.length < 2) throw new Error('degenerate geometry');

    return {
      polyline,
      breakpoints,
      legs,
      distanceMeters: Math.round(route.distance),
      durationSeconds: Math.round(route.duration),
      source: 'osrm',
    };
  } catch (err) {
    console.warn('[routing] OSRM navigation unavailable, using L-shaped fallback:', err.message);
    // Straight-line estimates so the UI still has numbers to show; the caller
    // is told the source so it can say the guidance is approximate.
    const polyline = drivablePolyline(waypoints);
    const legs = [];
    for (let i = 0; i < waypoints.length - 1; i += 1) {
      const km = roadKm(waypoints[i], waypoints[i + 1]);
      legs.push({
        distanceMeters: Math.round(km * 1000),
        durationSeconds: Math.round((km / DEFAULTS.speedKmph) * 3600),
      });
    }
    return {
      polyline,
      // drivablePolyline emits a corner + an endpoint per leg, so waypoint i
      // lands at index 2i in the flattened line.
      breakpoints: waypoints.slice(1).map((_, i) => (i + 1) * 2),
      legs,
      distanceMeters: legs.reduce((s, l) => s + l.distanceMeters, 0),
      durationSeconds: legs.reduce((s, l) => s + l.durationSeconds, 0),
      source: 'fallback',
    };
  }
}

/**
 * How far the nearest driveable road is from a point, in metres — so a
 * citizen's pin can be checked against "can a collection vehicle actually
 * reach this?" before the report is accepted. Returns null (never blocks)
 * if the free OSRM demo server is unreachable; that is an availability
 * problem, not evidence the location is unreachable.
 */
export async function nearestRoadDistance(latitude, longitude) {
  try {
    const { data } = await axios.get(
      `${env.osrmUrl}/nearest/v1/driving/${longitude},${latitude}`,
      { timeout: 5000 }
    );
    const metres = data?.waypoints?.[0]?.distance;
    return typeof metres === 'number' ? metres : null;
  } catch (err) {
    console.warn('[routing] nearest-road check unavailable:', err.message);
    return null;
  }
}

/**
 * Snaps a point to the nearest driveable road and returns the road-side
 * coordinate itself (not just the distance) — used at seed time so demo
 * complaints land on real streets instead of open ground. Returns null on
 * any failure so the caller can fall back to the unsnapped point.
 */
export async function snapToRoad(latitude, longitude) {
  try {
    const { data } = await axios.get(
      `${env.osrmUrl}/nearest/v1/driving/${longitude},${latitude}`,
      { timeout: 4000 }
    );
    const wp = data?.waypoints?.[0];
    if (!wp?.location) return null;
    const [lng, lat] = wp.location;
    return { latitude: lat, longitude: lng, distanceMeters: wp.distance };
  } catch {
    return null;
  }
}

/**
 * Road-snapped route geometry PLUS, for each waypoint after the first, the
 * index into the flattened polyline where the vehicle arrives there. A
 * driver's live map uses this to slice off legs already covered instead of
 * drawing the whole day's route (or falling back to a straight line that
 * cuts through fields) once a stop is marked collected.
 */
export async function roadSnappedRoute(points) {
  if (!points || points.length < 2) return { polyline: drivablePolyline(points || []), breakpoints: [] };
  const { polyline, breakpoints, legs, source } = await navigationRoute(points);
  return { polyline, breakpoints, legs, source };
}

/**
 * Every read path that shows a Route's polyline (driver live map, admin
 * fleet view) hit the same bug independently: some stored routes (seeded,
 * or optimized while the OSRM demo server was briefly unreachable) only
 * ever got a straight/degenerate line saved, and serving that verbatim
 * looks broken forever even after the road-snapping code itself works.
 * Detects that case, regenerates real geometry from the route's own
 * ordered stops, and persists the fix so it only has to happen once.
 *
 * Point-count alone isn't enough to detect this: drivablePolyline()'s
 * L-shaped fallback still emits several points (a corner + an endpoint per
 * leg -- exactly `2n - 1` points for n waypoints), so a short-but-nonzero
 * array can still be the zigzag fallback, not real road geometry. Real OSRM
 * geometry is always far denser than that for any leg longer than a few
 * metres, so comparing against the fallback's exact shape is the reliable
 * signal, not just "is the array non-empty."
 */
export async function ensureRoadSnappedPolyline(route, stops) {
  const stored = route?.polylineGeometry;
  if (!route || !Array.isArray(stops) || stops.length < 2) return stored;

  const waypoints = stops
    .filter((s) => s.latitude != null && s.longitude != null)
    .map((s) => [s.longitude, s.latitude]);
  if (waypoints.length < 2) return stored;

  const fallbackShapeSize = 2 * waypoints.length; // drivablePolyline() emits exactly 2n-1 points
  if (Array.isArray(stored) && stored.length > fallbackShapeSize) return stored;

  try {
    const fresh = await roadSnappedRoute(waypoints);
    if (fresh.polyline.length <= fallbackShapeSize) return stored; // OSRM itself fell back too -- nothing to improve on right now

    await prisma.route.update({ where: { id: route.id }, data: { polylineGeometry: fresh.polyline } }).catch(() => {});
    return fresh.polyline;
  } catch {
    return stored; // keep whatever was stored -- callers already handle a short/missing polyline gracefully
  }
}

export { DEFAULTS, distanceKm };
export default {
  optimizeRoute,
  solveLocal,
  drivablePolyline,
  roadSnappedPolyline,
  roadSnappedRoute,
  navigationRoute,
  ensureRoadSnappedPolyline,
  nearestRoadDistance,
  snapToRoad,
};
