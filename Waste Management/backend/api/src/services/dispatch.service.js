import { prisma } from '../lib/prisma.js';
import { SOCKET_EVENTS } from '../config/constants.js';
import { emitTo } from '../sockets/realtime.js';
import { notify } from './notification.service.js';
import { distanceKm } from '../lib/geo.js';
import { today } from './tracking.service.js';

/**
 * Emergency auto-dispatch.
 *
 * A citizen emergency used to page the ward's officers and stop there. Nobody
 * who could physically go and clear it was told anything: the driver's handset
 * showed the same route it showed a minute earlier, and the report sat waiting
 * for an officer to notice the page and assign a truck by hand. For a category
 * on a 30-minute SLA that human hop is the whole clock.
 *
 * So the emergency is also pushed straight at a truck: nearest live vehicle in
 * the ward, prepended to that driver's route as stop 1, driver notified, truck
 * room told. The officer page still fires -- this supplements the officer, it
 * does not replace them, and an officer can still reassign.
 */

/** A truck silent for longer than this is not somewhere we can send an emergency. */
const PING_FRESH_MS = 5 * 60_000;

/**
 * Candidate trucks, best first.
 *
 * Ward crew first, then anywhere in the city: a ward whose whole crew is off
 * shift is exactly when an emergency must not go undispatched, and a truck two
 * wards away is still better than nobody. Preference order is encoded in the
 * sort, not in an early return, so a same-ward truck always wins over a nearer
 * out-of-ward one.
 */
async function candidates(wardId, latitude, longitude) {
  const trucks = await prisma.vehicle.findMany({
    where: {
      maintenanceFlag: false,
      status: { notIn: ['OFFLINE', 'MAINTENANCE'] },
      driverId: { not: null },
      driver: { is: { isActive: true } },
    },
    select: {
      id: true,
      registrationNumber: true,
      wardId: true,
      status: true,
      lastLat: true,
      lastLng: true,
      lastPingAt: true,
      driverId: true,
      driver: { select: { id: true, name: true, phone: true } },
    },
  });

  const now = Date.now();
  return trucks
    .map((t) => {
      const fresh = t.lastPingAt ? now - new Date(t.lastPingAt).getTime() <= PING_FRESH_MS : false;
      const km =
        t.lastLat != null && t.lastLng != null
          ? distanceKm({ latitude: t.lastLat, longitude: t.lastLng }, { latitude, longitude })
          : null;
      return { ...t, fresh, km };
    })
    .sort((a, b) => {
      // Same ward beats another ward; a reporting handset beats a silent one;
      // then nearest. A truck with no position at all sorts last.
      if ((a.wardId === wardId) !== (b.wardId === wardId)) return a.wardId === wardId ? -1 : 1;
      if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
      if (a.km == null) return 1;
      if (b.km == null) return -1;
      return a.km - b.km;
    });
}

/**
 * Puts the emergency at the front of the driver's published route for today.
 *
 * Renumbers the stops rather than appending: an emergency that lands as stop 9
 * of 9 has not been dispatched in any meaningful sense. Completed stops keep
 * their place -- rewriting history to make room would tell the driver they
 * still owe work they have already done.
 */
async function prependStop(route, complaint) {
  const existing = Array.isArray(route.orderedStops) ? route.orderedStops : [];
  const done = existing.filter((s) => s.status === 'DONE');
  const pending = existing.filter((s) => s.status !== 'DONE');

  const stop = {
    seq: 0, // renumbered below
    complaintId: complaint.id,
    code: complaint.code,
    label: complaint.address || 'Emergency call',
    category: complaint.category,
    severity: complaint.severity,
    isEmergency: true,
    reportedAt: complaint.createdAt,
    latitude: complaint.latitude,
    longitude: complaint.longitude,
    serviceMin: 10,
    etaMin: 0,
    eta: null,
    status: 'PENDING',
    legKm: null,
    dispatchedAt: new Date().toISOString(),
  };

  const ordered = [...done, stop, ...pending].map((s, i) => ({ ...s, seq: i + 1 }));
  await prisma.route.update({ where: { id: route.id }, data: { orderedStops: ordered } });
  return ordered;
}

/**
 * Dispatches an emergency complaint to a truck.
 *
 * Never throws into the caller: intake has already created the complaint and
 * charged the citizen's credits by the time this runs, so a dispatch failure
 * must not roll back a report that genuinely exists. Returns null when no
 * truck could take it, which the caller surfaces rather than swallowing.
 */
export async function dispatchEmergency(complaint, ward) {
  if (!complaint?.isEmergency) return null;

  const ranked = await candidates(ward?.id ?? complaint.wardId, complaint.latitude, complaint.longitude);
  const truck = ranked[0];
  if (!truck) {
    console.warn(`[dispatch] ${complaint.code}: no available truck to dispatch — officer page is the only route`);
    return null;
  }

  await prisma.complaint.update({
    where: { id: complaint.id },
    data: {
      assignedVehicleId: truck.id,
      assignedAt: new Date(),
      // PENDING/VERIFIED both become ASSIGNED; anything further along was
      // already picked up by a human and is not ours to move backwards.
      ...(['PENDING', 'VERIFIED'].includes(complaint.status) ? { status: 'ASSIGNED' } : {}),
    },
  });

  await prisma.complaintEvent.create({
    data: {
      complaintId: complaint.id,
      status: 'ASSIGNED',
      note: `Emergency auto-dispatched to ${truck.registrationNumber} (${truck.driver?.name ?? 'driver'})`,
    },
  });

  // Put it at the head of today's route if one is published; a driver with no
  // route today still gets the notification and the socket push.
  const route = await prisma.route.findFirst({
    where: { vehicleId: truck.id, date: today(), status: { in: ['PUBLISHED', 'IN_PROGRESS'] } },
  });
  let stops = null;
  if (route) stops = await prependStop(route, complaint);

  await notify({
    userId: truck.driverId,
    type: 'EMERGENCY',
    title: `EMERGENCY — go now: ${complaint.code}`,
    body: `${complaint.address || 'Reported location'} — added as your next stop. ${
      complaint.slaMinutes ?? 30
    } minute SLA.`,
    payload: {
      complaintId: complaint.id,
      code: complaint.code,
      latitude: complaint.latitude,
      longitude: complaint.longitude,
      vehicleId: truck.id,
    },
  });

  const payload = {
    complaintId: complaint.id,
    code: complaint.code,
    // Flagged explicitly so a client does not have to infer "emergency" from
    // severity or SLA minutes to decide how loudly to announce it.
    isEmergency: true,
    autoDispatched: true,
    category: complaint.category,
    severity: complaint.severity,
    address: complaint.address,
    latitude: complaint.latitude,
    longitude: complaint.longitude,
    slaMinutes: complaint.slaMinutes,
    dueAt: complaint.dueAt,
    vehicle: { id: truck.id, registrationNumber: truck.registrationNumber },
    driver: truck.driver,
    stops,
  };

  // The driver's own room, the truck room the live map listens on, and the
  // ward/city rooms the officer and admin consoles are already in.
  emitTo(
    [
      `user:${truck.driverId}`,
      `truck:${truck.id}`,
      ward?.id ? `ward:${ward.id}` : null,
      'city',
    ],
    SOCKET_EVENTS.ASSIGNMENT_NEW,
    payload
  );

  console.log(
    `[dispatch] ${complaint.code} -> ${truck.registrationNumber} (${truck.driver?.name}) ` +
      `${truck.km != null ? truck.km.toFixed(2) + 'km' : 'position unknown'}${truck.wardId === ward?.id ? '' : ' [out of ward]'}`
  );

  return payload;
}


/**
 * Auto-assign: the whole outstanding queue in one press.
 *
 * Assigning by hand means selecting complaints, opening a modal and picking a
 * truck, repeated for every report — so in practice an officer assigns the
 * ones at the top and the tail sits unassigned until it breaches. The
 * information needed to choose is already on the screen, which is the sign it
 * should not need a human: the ward, which trucks are reporting, how loaded
 * each already is, and how far each is from the report.
 *
 * This returns a plan and writes nothing. The caller performs the transitions,
 * so the audit trail, the socket traffic and the driver notification are
 * identical to a manual assignment — auto-assign is the same action taken
 * faster, not a second path into the database.
 */

/** A truck silent this long is not somewhere we can send work with confidence. */
const AUTO_PING_FRESH_MS = 5 * 60_000;

/**
 * Ranks the complaints, not just the trucks.
 *
 * Whatever is dispatched first gets the least-loaded truck, so the order here
 * decides who waits. An emergency runs a 30-minute clock and a critical report
 * is not far behind, so they go out before a routine bin that has all day —
 * and within a band the report closest to its deadline goes first.
 */
function queueOrder(a, b) {
  if (a.isEmergency !== b.isEmergency) return a.isEmergency ? -1 : 1;
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const sa = rank[a.severity] ?? 9;
  const sb = rank[b.severity] ?? 9;
  if (sa !== sb) return sa - sb;
  const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
  const db = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
  if (da !== db) return da - db;
  return new Date(a.createdAt) - new Date(b.createdAt);
}

/**
 * Works out who should take what, without writing anything.
 *
 * @param {string[]|null} wardIds  officer's wards, or null for the whole city
 * @param {string[]|null} onlyIds  restrict to these complaints, or null for all
 *                                 outstanding unassigned work in scope
 */
export async function planAutoAssign(wardIds, onlyIds = null) {
  const wardWhere = wardIds === null ? {} : { wardId: { in: wardIds } };

  const pending = await prisma.complaint.findMany({
    where: {
      ...wardWhere,
      ...(onlyIds ? { id: { in: onlyIds } } : {}),
      assignedVehicleId: null,
      status: { notIn: ['RESOLVED', 'REJECTED'] },
    },
    select: {
      id: true, code: true, wardId: true, latitude: true, longitude: true,
      severity: true, isEmergency: true, dueAt: true, createdAt: true, category: true,
    },
  });

  if (!pending.length) return { assignments: [], skipped: [], trucksUsed: 0 };

  /**
   * Only trucks that could actually take the work: on the road, crewed, and
   * not in the workshop. A truck whose driver has clocked out would take the
   * assignment silently and nobody would look at it until tomorrow.
   */
  const trucks = await prisma.vehicle.findMany({
    where: {
      maintenanceFlag: false,
      status: { notIn: ['OFFLINE', 'MAINTENANCE'] },
      driverId: { not: null },
      driver: { is: { isActive: true } },
      ...(wardIds === null ? {} : { wardId: { in: wardIds } }),
    },
    select: {
      id: true, registrationNumber: true, wardId: true,
      lastLat: true, lastLng: true, lastPingAt: true,
      driverId: true, driver: { select: { id: true, name: true, phone: true } },
    },
  });

  if (!trucks.length) {
    return {
      assignments: [],
      skipped: pending.map((c) => ({ complaint: c, reason: 'No crewed vehicle on the road in this ward' })),
      trucksUsed: 0,
    };
  }

  // Drivers standing down keep their route but should not be handed new work
  // mid-break; they pick it up when they clock back on.
  const resting = new Set(
    (await prisma.driverShift.findMany({
      where: { status: 'ON_BREAK', date: today() },
      select: { vehicleId: true },
    })).map((r) => r.vehicleId).filter(Boolean)
  );

  // What each truck is already carrying, so the load balances across the crew
  // instead of everything landing on whichever truck happens to be nearest.
  const openCounts = await prisma.complaint.groupBy({
    by: ['assignedVehicleId'],
    where: { assignedVehicleId: { in: trucks.map((t) => t.id) }, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
    _count: { _all: true },
  });
  const load = new Map(trucks.map((t) => [t.id, 0]));
  for (const row of openCounts) load.set(row.assignedVehicleId, row._count._all);

  const now = Date.now();
  const enriched = trucks.map((t) => ({
    ...t,
    fresh: t.lastPingAt ? now - new Date(t.lastPingAt).getTime() <= AUTO_PING_FRESH_MS : false,
    resting: resting.has(t.id),
  }));

  const assignments = [];
  const skipped = [];

  for (const c of [...pending].sort(queueOrder)) {
    const ranked = enriched
      .map((t) => ({
        truck: t,
        km:
          t.lastLat != null && t.lastLng != null && c.latitude != null && c.longitude != null
            ? distanceKm({ latitude: t.lastLat, longitude: t.lastLng }, { latitude: c.latitude, longitude: c.longitude })
            : null,
        carrying: load.get(t.id) ?? 0,
      }))
      .sort((a, b) => {
        // Same ward first — a report is the ward's own work.
        const aw = a.truck.wardId === c.wardId;
        const bw = b.truck.wardId === c.wardId;
        if (aw !== bw) return aw ? -1 : 1;
        // A crew on a rest break is a last resort, not a first choice.
        if (a.truck.resting !== b.truck.resting) return a.truck.resting ? 1 : -1;
        // A reporting handset beats a silent one: we can see where it is.
        if (a.truck.fresh !== b.truck.fresh) return a.truck.fresh ? -1 : 1;
        // Then spread the work before optimising the metres.
        if (a.carrying !== b.carrying) return a.carrying - b.carrying;
        if (a.km == null) return 1;
        if (b.km == null) return -1;
        return a.km - b.km;
      });

    const best = ranked[0];
    if (!best) {
      skipped.push({ complaint: c, reason: 'No vehicle available' });
      continue;
    }
    load.set(best.truck.id, (load.get(best.truck.id) ?? 0) + 1);
    assignments.push({
      complaint: c,
      vehicle: best.truck,
      km: best.km == null ? null : Number(best.km.toFixed(2)),
    });
  }

  return {
    assignments,
    skipped,
    trucksUsed: new Set(assignments.map((a) => a.vehicle.id)).size,
  };
}

export default { dispatchEmergency, planAutoAssign };
