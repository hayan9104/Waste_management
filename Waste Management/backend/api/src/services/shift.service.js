import { prisma } from '../lib/prisma.js';
import { SOCKET_EVENTS } from '../config/constants.js';
import { emitTo } from '../sockets/realtime.js';
import { today, locationHistory, startOfToday } from './tracking.service.js';
import { HttpError } from '../middleware/error.js';

/**
 * Driver shift clock.
 *
 * "On shift since" used to be inferred from the day's first GPS ping, which
 * is a different fact from the one anybody wanted. A handset that lost signal
 * in the depot yard, or a driver who opened the app on the bus in, both
 * produce a start time nobody actually worked from -- and a supervisor could
 * not tell a truck that has been quiet for ten minutes from one whose shift
 * ended an hour ago, because ping data says the same thing about both.
 *
 * An explicit clock-in/clock-out fixes the fact and makes "who is on duty
 * right now" answerable with one indexed query instead of a guess.
 */

/** The shift a driver is currently clocked into, or null. */
/**
 * The shift a driver is currently clocked into, or null.
 *
 * ON_BREAK counts as clocked in. A driver on a rest break has not gone home —
 * treating a break as "off shift" would drop them off the officer's on-duty
 * board the moment they stopped for tea, and make the shift clock restart when
 * they came back.
 */
export async function activeShift(driverId) {
  return prisma.driverShift.findFirst({
    where: { driverId, status: { in: ['ACTIVE', 'ON_BREAK'] } },
    orderBy: { startedAt: 'desc' },
    include: {
      vehicle: { select: { id: true, registrationNumber: true } },
      ward: { select: { id: true, name: true } },
      breaks: { orderBy: { startedAt: 'asc' } },
    },
  });
}

/** Minutes stood down so far, counting an open break up to now. */
function breakMinutesOf(shift, until = new Date()) {
  const rows = Array.isArray(shift?.breaks) ? shift.breaks : [];
  return rows.reduce((n, b) => {
    const end = b.endedAt ? new Date(b.endedAt) : until;
    return n + Math.max(0, Math.round((end - new Date(b.startedAt)) / 60_000));
  }, 0);
}

/**
 * Stand down for a rest. Idempotent like startShift, for the same reason: a
 * second tap on a flaky connection is not the driver's mistake.
 */
export async function startBreak({ driver, vehicle, latitude, longitude, reason }) {
  const shift = await activeShift(driver.id);
  if (!shift) throw new HttpError(409, 'You are not currently clocked in');

  const open = shift.breaks?.find((b) => !b.endedAt);
  if (open) return { shift, alreadyOnBreak: true };

  await prisma.shiftBreak.create({
    data: {
      shiftId: shift.id,
      reason: reason?.slice(0, 120) || null,
      startedAt: new Date(),
      latitude: latitude ?? vehicle?.lastLat ?? null,
      longitude: longitude ?? vehicle?.lastLng ?? null,
    },
  });
  await prisma.driverShift.update({ where: { id: shift.id }, data: { status: 'ON_BREAK' } });

  // A truck whose driver is resting is not working a route. Parking it keeps
  // the officer's fleet map honest, and the simulator stops driving it.
  if (vehicle && !vehicle.maintenanceFlag) {
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status: 'IDLE', lastSpeed: 0 } });
  }

  const fresh = await activeShift(driver.id);
  emitTo([shift.wardId ? `ward:${shift.wardId}` : null, 'city'], SOCKET_EVENTS.TRUCK_UPDATE, {
    vehicleId: vehicle?.id ?? null,
    driverId: driver.id,
    shift: { id: shift.id, status: 'ON_BREAK', startedAt: shift.startedAt },
  });
  return { shift: fresh, alreadyOnBreak: false };
}

/** Back on the road. Closes the open break and returns the truck to service. */
export async function endBreak({ driver, vehicle }) {
  const shift = await activeShift(driver.id);
  if (!shift) throw new HttpError(409, 'You are not currently clocked in');

  const open = shift.breaks?.find((b) => !b.endedAt);
  if (!open) return { shift, alreadyWorking: true };

  await prisma.shiftBreak.update({ where: { id: open.id }, data: { endedAt: new Date() } });
  await prisma.driverShift.update({ where: { id: shift.id }, data: { status: 'ACTIVE' } });

  if (vehicle && !vehicle.maintenanceFlag) {
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status: 'ON_ROUTE' } });
  }

  const fresh = await activeShift(driver.id);
  emitTo([shift.wardId ? `ward:${shift.wardId}` : null, 'city'], SOCKET_EVENTS.TRUCK_UPDATE, {
    vehicleId: vehicle?.id ?? null,
    driverId: driver.id,
    shift: { id: shift.id, status: 'ACTIVE', startedAt: shift.startedAt },
  });
  return { shift: fresh, alreadyWorking: false };
}

export async function startShift({ driver, vehicle, latitude, longitude, odometerKm }) {
  const open = await activeShift(driver.id);
  if (open) {
    // Idempotent rather than an error: a driver who taps "start" twice, or
    // whose first tap succeeded on a flaky connection and looked like it
    // failed, should not be told they are already on shift as if it were
    // their mistake.
    return { shift: open, alreadyOpen: true };
  }

  const shift = await prisma.driverShift.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle?.id ?? null,
      wardId: vehicle?.wardId ?? driver.wardId ?? null,
      date: today(),
      startedAt: new Date(),
      startLat: latitude ?? vehicle?.lastLat ?? null,
      startLng: longitude ?? vehicle?.lastLng ?? null,
      startOdometerKm: odometerKm ?? vehicle?.odometerKm ?? null,
      status: 'ACTIVE',
    },
    include: {
      vehicle: { select: { id: true, registrationNumber: true } },
      ward: { select: { id: true, name: true } },
      breaks: { orderBy: { startedAt: 'asc' } },
    },
  });

  // A truck whose driver just clocked in is on duty; leaving it OFFLINE would
  // hide it from the officer's fleet map for the first few minutes of the
  // shift, until the first ping happened to arrive.
  if (vehicle && vehicle.status === 'OFFLINE' && !vehicle.maintenanceFlag) {
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status: 'ON_ROUTE' } });
  }

  emitTo([shift.wardId ? `ward:${shift.wardId}` : null, 'city'], SOCKET_EVENTS.TRUCK_UPDATE, {
    vehicleId: vehicle?.id ?? null,
    driverId: driver.id,
    shift: { id: shift.id, status: 'ACTIVE', startedAt: shift.startedAt },
  });

  return { shift, alreadyOpen: false };
}

export async function endShift({ driver, vehicle, latitude, longitude, odometerKm, notes }) {
  const open = await activeShift(driver.id);
  if (!open) throw new HttpError(409, 'You are not currently clocked in');

  // Distance comes from the GPS track, not the odometer fields: those are
  // driver-entered and are left blank most of the time, so trusting them
  // would report 0 km for a shift that genuinely drove 40.
  const history = vehicle ? await locationHistory(vehicle.id, { from: open.startedAt }) : { distanceKm: 0 };

  const stopsDone = vehicle
    ? await prisma.complaint.count({
        where: {
          assignedVehicleId: vehicle.id,
          status: 'RESOLVED',
          resolvedAt: { gte: open.startedAt },
        },
      })
    : 0;

  // Clocking out while still on a break would leave that break open forever
  // and its minutes uncounted, so close it at the same moment.
  const endedAtNow = new Date();
  const stillResting = open.breaks?.find((b) => !b.endedAt);
  if (stillResting) {
    await prisma.shiftBreak.update({ where: { id: stillResting.id }, data: { endedAt: endedAtNow } });
  }
  const restMinutes = breakMinutesOf(open, endedAtNow);

  const shift = await prisma.driverShift.update({
    where: { id: open.id },
    data: {
      breakMinutes: restMinutes,
      endedAt: endedAtNow,
      endLat: latitude ?? vehicle?.lastLat ?? null,
      endLng: longitude ?? vehicle?.lastLng ?? null,
      endOdometerKm: odometerKm ?? null,
      distanceKm: history.distanceKm ?? 0,
      stopsDone,
      notes: notes?.slice(0, 300) || null,
      status: 'ENDED',
    },
    include: {
      vehicle: { select: { id: true, registrationNumber: true } },
      ward: { select: { id: true, name: true } },
      // Without this the clock-out response reported breaks: [] even when the
      // driver had taken several, so the summary they land on after ending a
      // shift contradicted the shift they just worked.
      breaks: { orderBy: { startedAt: 'asc' } },
    },
  });

  // Clocking out parks the truck. Without this the fleet map would keep
  // showing it as working all night at whatever spot it last pinged from.
  if (vehicle && !vehicle.maintenanceFlag) {
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status: 'OFFLINE' } });
  }

  emitTo([shift.wardId ? `ward:${shift.wardId}` : null, 'city'], SOCKET_EVENTS.TRUCK_UPDATE, {
    vehicleId: vehicle?.id ?? null,
    driverId: driver.id,
    shift: { id: shift.id, status: 'ENDED', endedAt: shift.endedAt },
  });

  return shift;
}

/** Serialisable view of a shift, with the elapsed clock resolved server-side. */
export function serializeShift(shift) {
  if (!shift) return null;
  const end = shift.endedAt ? new Date(shift.endedAt) : new Date();
  const minutes = Math.max(0, Math.round((end - new Date(shift.startedAt)) / 60_000));
  // Prefer the stored total once the shift is closed; recompute live while it
  // is still running so an open break's minutes tick up rather than sitting at
  // whatever they were when it started.
  const breakMinutes = shift.endedAt ? shift.breakMinutes ?? 0 : breakMinutesOf(shift, end);
  const rows = Array.isArray(shift.breaks) ? shift.breaks : [];
  const onBreak = shift.status === 'ON_BREAK';
  return {
    id: shift.id,
    date: shift.date,
    status: shift.status,
    startedAt: shift.startedAt,
    endedAt: shift.endedAt,
    minutes,
    breakMinutes,
    /** Time actually on the job — what a supervisor is really asking about. */
    workedMinutes: Math.max(0, minutes - breakMinutes),
    onBreak,
    breakStartedAt: rows.find((b) => !b.endedAt)?.startedAt ?? null,
    breaks: rows.map((b) => ({
      id: b.id,
      reason: b.reason,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      minutes: Math.max(0, Math.round(((b.endedAt ? new Date(b.endedAt) : end) - new Date(b.startedAt)) / 60_000)),
    })),
    distanceKm: shift.distanceKm,
    stopsDone: shift.stopsDone,
    startOdometerKm: shift.startOdometerKm,
    endOdometerKm: shift.endOdometerKm,
    notes: shift.notes,
    vehicle: shift.vehicle ?? null,
    ward: shift.ward ?? null,
  };
}

/**
 * Who is clocked on right now, for the officer and admin consoles.
 *
 * Counts today's ended shifts too, so "3 on duty" reads against "of 5 who
 * worked today" rather than against nothing.
 */
export async function shiftBoard(wardIds) {
  const wardWhere = wardIds === null ? {} : { wardId: { in: wardIds } };

  const [active, endedToday] = await Promise.all([
    prisma.driverShift.findMany({
      // ON_BREAK is still on duty — see activeShift.
      where: { status: { in: ['ACTIVE', 'ON_BREAK'] }, ...wardWhere },
      orderBy: { startedAt: 'asc' },
      include: {
        driver: { select: { id: true, name: true, phone: true, avatarColor: true } },
        vehicle: { select: { id: true, registrationNumber: true } },
        ward: { select: { id: true, name: true, code: true } },
        breaks: { orderBy: { startedAt: 'asc' } },
      },
    }),
    prisma.driverShift.findMany({
      where: { status: 'ENDED', date: today(), ...wardWhere },
      orderBy: { endedAt: 'desc' },
      include: {
        driver: { select: { id: true, name: true, phone: true, avatarColor: true } },
        vehicle: { select: { id: true, registrationNumber: true } },
        ward: { select: { id: true, name: true, code: true } },
        breaks: { orderBy: { startedAt: 'asc' } },
      },
    }),
  ]);

  const withDriver = (s) => ({ ...serializeShift(s), driver: s.driver });
  const totalMinutes = endedToday.reduce((n, s) => n + Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60_000), 0);

  return {
    date: today(),
    onDuty: active.map(withDriver),
    endedToday: endedToday.map(withDriver),
    totals: {
      onDuty: active.length,
      /** Clocked in but standing down right now — counted inside onDuty. */
      onBreak: active.filter((s) => s.status === 'ON_BREAK').length,
      completed: endedToday.length,
      workedToday: active.length + endedToday.length,
      hoursLogged: Number((totalMinutes / 60).toFixed(1)),
      breakHours: Number((endedToday.reduce((n, s) => n + (s.breakMinutes ?? 0), 0) / 60).toFixed(1)),
      distanceKm: Number(endedToday.reduce((n, s) => n + (s.distanceKm ?? 0), 0).toFixed(1)),
    },
  };
}

/** A driver's own recent shifts, for their summary page. */
export async function shiftHistory(driverId, days = 14) {
  const since = new Date(startOfToday().getTime() - (days - 1) * 86_400_000);
  const rows = await prisma.driverShift.findMany({
    where: { driverId, startedAt: { gte: since } },
    orderBy: { startedAt: 'desc' },
    include: {
      vehicle: { select: { id: true, registrationNumber: true } },
      ward: { select: { id: true, name: true } },
      breaks: { orderBy: { startedAt: 'asc' } },
    },
  });
  return rows.map(serializeShift);
}

export default { activeShift, startShift, endShift, startBreak, endBreak, serializeShift, shiftBoard, shiftHistory };
