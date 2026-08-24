import { prisma } from '../lib/prisma.js';
import { today } from './tracking.service.js';
import { ROLES } from '../config/constants.js';
import { gpsHealthFor } from './gps.service.js';

/**
 * Ward-wise driver roster.
 *
 * "Which drivers work this ward, and what is each of them doing right now"
 * was answerable only by cross-referencing the fleet list against the user
 * list by hand -- /admin/fleet is keyed by vehicle and /admin/users is a flat
 * directory, so neither one answers it. Both the admin console and the ward
 * officer need the same shape, so it lives here rather than being written
 * twice against two slightly different query sets.
 *
 * Everything is loaded in four queries regardless of how many wards are in
 * scope; the per-driver joining is done in memory. Fanning out one query per
 * driver would be ~40 round trips on the seeded city alone.
 */

/** A truck that has not pinged in this long is treated as offline, matching /admin/fleet. */
const PING_STALE_MS = 120_000;

export async function wardRoster(wardIds) {
  const wards = await prisma.ward.findMany({
    where: wardIds === null ? {} : { id: { in: wardIds } },
    orderBy: { code: 'asc' },
    select: { id: true, name: true, code: true, zone: true },
  });
  if (!wards.length) return [];

  const ids = wards.map((w) => w.id);

  const drivers = await prisma.user.findMany({
    where: { role: ROLES.DRIVER, wardId: { in: ids } },
    orderBy: [{ name: 'asc' }],
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      isActive: true,
      avatarColor: true,
      avatarUrl: true,
      wardId: true,
      lastLoginAt: true,
    },
  });
  const driverIds = drivers.map((d) => d.id);

  const [vehicles, routes, openSos, shifts] = await Promise.all([
    prisma.vehicle.findMany({
      where: { driverId: { in: driverIds } },
      select: {
        id: true,
        registrationNumber: true,
        model: true,
        status: true,
        capacityKg: true,
        maintenanceFlag: true,
        odometerKm: true,
        lastLat: true,
        lastLng: true,
        lastPingAt: true,
        driverId: true,
      },
    }),
    prisma.route.findMany({
      where: { driverId: { in: driverIds }, date: today() },
      // polylineGeometry rides along so the roster can draw the beat on a map
      // without a second round trip per driver.
      select: {
        id: true, driverId: true, status: true, label: true, orderedStops: true,
        distanceKm: true, polylineGeometry: true,
      },
    }),
    prisma.sosAlert.findMany({
      where: { driverId: { in: driverIds }, status: 'OPEN' },
      select: { id: true, driverId: true, createdAt: true, message: true },
    }),
    // Today's shift row per driver — an ACTIVE one means clocked in now, an
    // ENDED one means they worked and went home, and no row at all means they
    // never turned up. Those are three different answers and the roster needs
    // to tell them apart.
    prisma.driverShift.findMany({
      where: { driverId: { in: driverIds }, date: today() },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true, driverId: true, status: true, startedAt: true, endedAt: true,
        distanceKm: true, stopsDone: true, breakMinutes: true,
      },
    }),
  ]);

  // Signal quality per truck, so the roster can say whether a driver's live
  // position is worth trusting rather than only whether one exists.
  const health = await gpsHealthFor(vehicles.map((v) => v.id));
  const vehicleByDriver = new Map(vehicles.map((v) => [v.driverId, v]));
  const routeByDriver = new Map(routes.map((r) => [r.driverId, r]));
  const sosByDriver = new Map(openSos.map((s) => [s.driverId, s]));
  // Ordered newest-first, so the first row seen per driver is the current one.
  const shiftByDriver = new Map();
  for (const sh of shifts) if (!shiftByDriver.has(sh.driverId)) shiftByDriver.set(sh.driverId, sh);
  const now = Date.now();

  return wards.map((ward) => {
    const roster = drivers
      .filter((d) => d.wardId === ward.id)
      .map((d) => {
        const vehicle = vehicleByDriver.get(d.id) ?? null;
        const route = routeByDriver.get(d.id) ?? null;
        const stops = Array.isArray(route?.orderedStops) ? route.orderedStops : [];
        const done = stops.filter((s) => s.status === 'DONE').length;

        // A truck whose last ping has gone stale is offline whatever its
        // stored status says -- the stored value is the last thing the driver
        // chose, not evidence the handset is still reporting.
        const pingAgeSec = vehicle?.lastPingAt
          ? Math.round((now - new Date(vehicle.lastPingAt).getTime()) / 1000)
          : null;
        const isOffline = !vehicle || vehicle.status === 'OFFLINE' || pingAgeSec === null || pingAgeSec * 1000 > PING_STALE_MS;

        return {
          id: d.id,
          name: d.name,
          phone: d.phone,
          email: d.email,
          isActive: d.isActive,
          avatarColor: d.avatarColor,
          avatarUrl: d.avatarUrl,
          lastLoginAt: d.lastLoginAt,
          vehicle: vehicle && {
            id: vehicle.id,
            registrationNumber: vehicle.registrationNumber,
            model: vehicle.model,
            status: vehicle.status,
            capacityKg: vehicle.capacityKg,
            maintenanceFlag: vehicle.maintenanceFlag,
            odometerKm: vehicle.odometerKm,
            latitude: vehicle.lastLat,
            longitude: vehicle.lastLng,
          },
          isOffline,
          lastPingAgeSec: pingAgeSec,
          route: route && {
            id: route.id,
            label: route.label,
            status: route.status,
            distanceKm: route.distanceKm,
            stopsTotal: stops.length,
            stopsDone: done,
            progressPct: stops.length ? Math.round((done / stops.length) * 100) : 0,
            polyline: Array.isArray(route.polylineGeometry) ? route.polylineGeometry : [],
            stops: stops.map((st) => ({
              seq: st.seq,
              code: st.code ?? null,
              label: st.label ?? null,
              latitude: st.latitude,
              longitude: st.longitude,
              status: st.status ?? 'PENDING',
              isEmergency: Boolean(st.isEmergency),
            })),
          },
          gps: vehicle ? health.get(vehicle.id) ?? null : null,
          sos: sosByDriver.get(d.id) ?? null,
          shift: shiftByDriver.get(d.id) ?? null,
          // A driver on a rest break is still on duty — they have not gone
          // home — but they are not working, and a supervisor needs both facts
          // rather than one standing in for the other.
          onDuty: ['ACTIVE', 'ON_BREAK'].includes(shiftByDriver.get(d.id)?.status),
          onBreak: shiftByDriver.get(d.id)?.status === 'ON_BREAK',
        };
      });

    return {
      ward,
      driverCount: roster.length,
      activeCount: roster.filter((d) => d.isActive && !d.isOffline).length,
      onDutyCount: roster.filter((d) => d.onDuty).length,
      onBreakCount: roster.filter((d) => d.onBreak).length,
      onRouteCount: roster.filter((d) => d.route && d.route.status !== 'COMPLETED').length,
      drivers: roster,
    };
  });
}

export default { wardRoster };
