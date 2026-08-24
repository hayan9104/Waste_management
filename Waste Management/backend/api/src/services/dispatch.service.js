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

export default { dispatchEmergency };
