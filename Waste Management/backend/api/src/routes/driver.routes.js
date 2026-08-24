import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../middleware/error.js';
import { requirePortal, loadUser } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { upload, persist, fileFromRequest } from '../middleware/upload.js';
import { prisma } from '../lib/prisma.js';
import { PORTALS, SOCKET_EVENTS } from '../config/constants.js';
import { ingestLocation, serializeVehicle, locationHistory, today, startOfToday } from '../services/tracking.service.js';
import { transition, serializeComplaint } from '../services/complaint.service.js';
import { emitTo } from '../sockets/realtime.js';
import { notify, notifyWardOfficers, awardCredits } from '../services/notification.service.js';
import { distanceKm } from '../lib/geo.js';
import { ensureRoadSnappedPolyline, navigationRoute, solveLocal } from '../services/routing.service.js';
import { startShift, endShift, activeShift, serializeShift, shiftHistory } from '../services/shift.service.js';

const router = Router();
router.use(requirePortal(PORTALS.DRIVER), loadUser);

/**
 * Navigation geometry is cached per vehicle because the driver map polls while
 * GPS pings every few seconds, and the default OSRM is a shared public demo
 * server. The key rounds the origin to ~110 m and includes the ordered stop
 * ids, so a recompute happens when the driver actually travels or the work
 * changes — not on every jitter of the GPS fix.
 */
const navCache = new Map();
const NAV_TTL_MS = 60_000;

function navCacheKey(origin, stops) {
  const round = (n) => Number(n).toFixed(3);
  return `${round(origin[0])},${round(origin[1])}|${stops.map((s) => s.key).join(',')}`;
}

function readNavCache(vehicleId, key) {
  const hit = navCache.get(vehicleId);
  if (!hit || hit.key !== key || Date.now() - hit.at > NAV_TTL_MS) return null;
  return hit.payload;
}

function writeNavCache(vehicleId, key, payload) {
  navCache.set(vehicleId, { key, at: Date.now(), payload });
  // The map is keyed by vehicle, so it is bounded by fleet size; this only
  // guards against a long-lived process accumulating retired vehicles.
  if (navCache.size > 500) {
    for (const [id, entry] of navCache) {
      if (Date.now() - entry.at > NAV_TTL_MS) navCache.delete(id);
    }
  }
}

async function myVehicle(userId) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { driverId: userId },
    include: { ward: true, driver: { select: { id: true, name: true, phone: true } } },
  });
  if (!vehicle) throw new HttpError(404, 'No vehicle is assigned to your account. Contact your ward officer.');
  return vehicle;
}

/** 
 * FEATURE 1: Live Route Map / Navigation
 * GET /api/driver/route & GET /api/driver/shift
 */
router.get(
  ['/route', '/shift'],
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);

    const [route, assigned, resolvedToday, history, shift] = await Promise.all([
      prisma.route.findFirst({ where: { vehicleId: vehicle.id, date: today() } }),
      prisma.complaint.findMany({
        where: { assignedVehicleId: vehicle.id, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
        include: { ward: true },
        orderBy: [{ isEmergency: 'desc' }, { severity: 'desc' }, { createdAt: 'asc' }],
      }),
      prisma.complaint.count({
        where: { assignedVehicleId: vehicle.id, status: 'RESOLVED', resolvedAt: { gte: startOfToday() } },
      }),
      locationHistory(vehicle.id, {}),
      activeShift(req.user.id),
    ]);

    const stops = route?.orderedStops ?? [];
    const polyline = await ensureRoadSnappedPolyline(route, stops);

    res.json({
      vehicle: serializeVehicle(vehicle, vehicle.ward),
      route: route
        ? {
            id: route.id,
            label: route.label,
            status: route.status,
            stops,
            polyline,
            distanceKm: route.distanceKm,
            baselineKm: route.baselineKm,
            savedKm: route.savedKm,
            durationMin: route.durationMin,
            done: stops.filter((s) => s.status === 'DONE').length,
            total: stops.length,
            solver: route.solver,
          }
        : null,
      nextStop: stops.find((s) => s.status !== 'DONE') ?? null,
      assignedComplaints: assigned.map((c) => serializeComplaint(c)),
      stops: stops.map((s, idx) => ({
        seq: s.seq || idx + 1,
        complaintId: s.complaintId || s.id,
        category: s.category || 'GARBAGE_PILE',
        address: s.label || s.address || 'Reported Location',
        latitude: s.latitude,
        longitude: s.longitude,
        status: s.status || 'PENDING',
        isEmergency: s.isEmergency || false,
        reportedAt: s.reportedAt || null,
      })),
      shift: serializeShift(shift),
      onShift: Boolean(shift),
      summary: {
        stopsDone: stops.filter((s) => s.status === 'DONE').length,
        stopsTotal: stops.length,
        resolvedToday,
        distanceKm: history.distanceKm,
        /**
         * The clocked-in time when there is one, falling back to the first GPS
         * ping only when the driver never clocked in. The ping is a proxy that
         * can be minutes early (app opened on the way in) or late (no signal in
         * the depot), so it is the fallback, not the source of truth.
         */
        onShiftSince: shift?.startedAt ?? history.firstAt,
        onShiftSource: shift ? 'clock' : history.firstAt ? 'first-gps-ping' : null,
      },
    });
  })
);

/**
 * Turn-by-turn navigation geometry.
 * GET /api/driver/navigation?lat=&lng=
 *
 * The /route endpoint returns the day's *planned* route, which starts at the
 * depot and only exists once an officer has published one. What a driver on the
 * road needs is the line from where the truck is right now to the stops that
 * are still open, following real streets. Without this the map fell back to
 * drawing straight segments between stops — a line through buildings that is
 * useless to follow.
 */
router.get(
  '/navigation',
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    // The live fix the phone just reported beats the last one persisted.
    const originLat = Number.isFinite(lat) ? lat : vehicle.lastLat;
    const originLng = Number.isFinite(lng) ? lng : vehicle.lastLng;

    const route = await prisma.route.findFirst({ where: { vehicleId: vehicle.id, date: today() } });

    // Prefer the officer's optimised order; fall back to the same priority
    // ordering the rest of the driver portal uses when no route is published.
    let pending = (route?.orderedStops ?? [])
      .filter((s) => s.status !== 'DONE' && s.latitude != null && s.longitude != null)
      .map((s, i) => ({
        key: String(s.complaintId || s.id || `${s.latitude},${s.longitude}`),
        seq: s.seq || i + 1,
        complaintId: s.complaintId || s.id || null,
        label: s.label || s.address || 'Collection stop',
        category: s.category || null,
        isEmergency: Boolean(s.isEmergency),
        latitude: s.latitude,
        longitude: s.longitude,
      }));

    let ordering = route ? 'officer-route' : 'unordered';

    if (!pending.length) {
      const assigned = await prisma.complaint.findMany({
        where: { assignedVehicleId: vehicle.id, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
        orderBy: [{ isEmergency: 'desc' }, { severity: 'desc' }, { createdAt: 'asc' }],
      });
      pending = assigned
        .filter((c) => c.latitude != null && c.longitude != null)
        .map((c, i) => ({
          key: c.id,
          seq: i + 1,
          complaintId: c.id,
          label: c.address || c.code || 'Collection stop',
          category: c.category,
          isEmergency: c.isEmergency,
          latitude: c.latitude,
          longitude: c.longitude,
        }));

      /*
        With no published route these arrive in report order, which sends the
        driver back and forth across the ward. The same solver the officer's
        planner uses puts them in a sensible driving order from where the truck
        is now — and it already keeps emergencies at the front, so urgency is
        not traded away for mileage.
      */
      if (pending.length > 1 && originLat != null && originLng != null) {
        const solved = solveLocal({
          stops: pending.map((s) => ({ ...s, coordinates: [s.longitude, s.latitude] })),
          depot: { coordinates: [originLng, originLat] },
        });
        const byKey = new Map(pending.map((s) => [s.key, s]));
        const reordered = solved.stops
          .map((s) => byKey.get(String(s.complaintId)))
          .filter(Boolean);
        if (reordered.length === pending.length) {
          pending = reordered.map((s, i) => ({ ...s, seq: i + 1 }));
          ordering = 'auto-optimised';
        }
      }
    }

    if (originLat == null || originLng == null) {
      return res.json({ navigating: false, reason: 'No GPS position for this vehicle yet.', stops: pending });
    }
    if (!pending.length) {
      return res.json({ navigating: false, reason: 'No open stops to navigate to.', stops: [] });
    }

    // OSRM caps waypoints per request; a shift never needs more than this many
    // legs drawn ahead, and the rest redraw as stops are completed.
    const MAX_LEGS = 12;
    const legStops = pending.slice(0, MAX_LEGS);

    const origin = [originLng, originLat];
    const key = navCacheKey(origin, legStops);
    const cached = readNavCache(vehicle.id, key);
    if (cached) return res.json({ ...cached, cached: true });

    const waypoints = [origin, ...legStops.map((s) => [s.longitude, s.latitude])];
    const nav = await navigationRoute(waypoints);

    let cumulativeSeconds = 0;
    const stops = legStops.map((s, i) => {
      const leg = nav.legs[i] || { distanceMeters: 0, durationSeconds: 0 };
      cumulativeSeconds += leg.durationSeconds;
      return {
        ...s,
        legDistanceMeters: leg.distanceMeters,
        legDurationSeconds: leg.durationSeconds,
        etaSeconds: cumulativeSeconds,
        polylineIndex: nav.breakpoints[i] ?? null,
      };
    });

    const payload = {
      navigating: true,
      polyline: nav.polyline,
      breakpoints: nav.breakpoints,
      stops,
      truncatedStops: Math.max(0, pending.length - legStops.length),
      nextStop: stops[0] || null,
      totalDistanceMeters: nav.distanceMeters,
      totalDurationSeconds: nav.durationSeconds,
      // 'fallback' means OSRM was unreachable and the line is approximate —
      // the UI says so rather than passing a zigzag off as road guidance.
      source: nav.source,
      ordering,
      origin: { latitude: originLat, longitude: originLng },
    };

    writeNavCache(vehicle.id, key, payload);
    res.json(payload);
  })
);

/**
 * FEATURE 2: Collection Stops (Tasks)
 * GET /api/driver/tasks?status=
 */
router.get(
  '/tasks',
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);
    const statusQuery = req.query.status ? String(req.query.status).toUpperCase() : 'ALL';

    let statusFilter = { in: ['ASSIGNED', 'IN_PROGRESS'] };
    if (statusQuery === 'COMPLETED') {
      statusFilter = 'RESOLVED';
    } else if (statusQuery === 'PENDING') {
      statusFilter = 'ASSIGNED';
    } else if (statusQuery === 'IN_PROGRESS') {
      statusFilter = 'IN_PROGRESS';
    } else if (statusQuery === 'ALL') {
      statusFilter = { in: ['ASSIGNED', 'IN_PROGRESS', 'RESOLVED'] };
    }

    const [complaints, pendingCount, inProgressCount, completedTodayCount] = await Promise.all([
      prisma.complaint.findMany({
        where: {
          assignedVehicleId: vehicle.id,
          status: statusFilter,
          ...(statusQuery === 'COMPLETED' ? { resolvedAt: { gte: startOfToday() } } : {}),
        },
        include: { ward: true },
        orderBy: [{ isEmergency: 'desc' }, { severity: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.complaint.count({ where: { assignedVehicleId: vehicle.id, status: 'ASSIGNED' } }),
      prisma.complaint.count({ where: { assignedVehicleId: vehicle.id, status: 'IN_PROGRESS' } }),
      prisma.complaint.count({
        where: { assignedVehicleId: vehicle.id, status: 'RESOLVED', resolvedAt: { gte: startOfToday() } },
      }),
    ]);

    const from = { latitude: vehicle.lastLat, longitude: vehicle.lastLng };
    const tasks = complaints.map((c) => {
      const dist = (vehicle.lastLat != null && c.latitude != null) ? distanceKm(from, c) : null;
      return {
        ...serializeComplaint(c),
        distanceKm: dist != null ? Number(dist.toFixed(2)) : null,
      };
    });

    const counts = {
      pending: pendingCount,
      inProgress: inProgressCount,
      completed: completedTodayCount,
      total: pendingCount + inProgressCount + completedTodayCount,
    };

    res.json({ tasks, vehicleId: vehicle.id, total: tasks.length, counts });
  })
);

/**
 * Start task
 * POST /api/driver/tasks/:id/start and POST /api/driver/complaints/:id/start
 */
router.post(
  ['/tasks/:id/start', '/complaints/:id/start'],
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);
    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, assignedVehicleId: vehicle.id },
    });
    if (!complaint) throw new HttpError(404, 'That complaint is not assigned to your vehicle');

    const result = await transition({
      complaintId: complaint.id,
      status: 'IN_PROGRESS',
      actorId: req.user.id,
      note: 'Driver is on site and collection has started',
    });

    res.json(result);
  })
);

/**
 * FEATURE 3: Proof of Work (Clean Photo Upload & Task Resolution)
 * POST /api/driver/tasks/:id/complete and POST /api/driver/complaints/:id/resolve
 */
router.post(
  ['/tasks/:id/complete', '/complaints/:id/resolve'],
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);
    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, assignedVehicleId: vehicle.id },
    });
    if (!complaint) throw new HttpError(404, 'That complaint is not assigned to your vehicle');

    let resolutionPhotoUrl = req.body?.cleanPhotoUrl || req.body?.photoUrl;

    const file = fileFromRequest(req);
    if (file) {
      resolutionPhotoUrl = await persist(file.buffer, file.mimetype, 'resolution');
    }

    const note = req.body?.note?.slice(0, 500) || 'Waste collected and area cleared by driver';

    const payload = await transition({
      complaintId: complaint.id,
      status: 'RESOLVED',
      actorId: req.user.id,
      note,
      extra: { resolutionPhotoUrl, resolutionNote: note },
    });

    // Update the daily route ordered stops in sync
    const route = await prisma.route.findFirst({ where: { vehicleId: vehicle.id, date: today() } });
    if (route) {
      const stops = (route.orderedStops || []).map((s) =>
        s.complaintId === complaint.id ? { ...s, status: 'DONE', doneAt: new Date().toISOString() } : s
      );
      const done = stops.filter((s) => s.status === 'DONE').length;
      await prisma.route.update({
        where: { id: route.id },
        data: {
          orderedStops: stops,
          status: done === stops.length ? 'COMPLETED' : 'IN_PROGRESS',
          ...(done === stops.length ? { completedAt: new Date() } : {}),
        },
      });
    }

    // Broadcast resolution to Officer and Citizen tracking
    emitTo([`truck:${vehicle.id}`, vehicle.wardId ? `ward:${vehicle.wardId}` : null, 'city'], SOCKET_EVENTS.COMPLAINT_UPDATE, payload);

    res.json({ success: true, complaint: payload });
  })
);

/**
 * FEATURE 4: Fuel Consumption Tracker
 * POST /api/driver/fuel-log & GET /api/driver/fuel-log
 */
router.post(
  '/fuel-log',
  writeLimiter,
  upload.single('receipt'),
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);
    const body = z
      .object({
        liters: z.coerce.number().positive().optional(),
        odometerKm: z.coerce.number().positive().optional(),
        cost: z.coerce.number().positive().optional(),
        notes: z.string().max(300).optional(),
      })
      .parse(req.body);

    const file = fileFromRequest(req, 'receipt');
    let receiptUrl = null;
    if (file) {
      receiptUrl = await persist(file.buffer, file.mimetype, 'fuel-receipt');
    }

    // Update vehicle odometer if higher
    if (body.odometerKm && body.odometerKm > vehicle.odometerKm) {
      await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: { odometerKm: body.odometerKm },
      });
    }

    let fuelLog;
    try {
      fuelLog = await prisma.fuelLog.create({
        data: {
          driverId: req.user.id,
          vehicleId: vehicle.id,
          liters: body.liters,
          odometerKm: body.odometerKm,
          cost: body.cost,
          notes: body.notes,
          receiptUrl,
        },
      });
    } catch {
      // Fallback if table creation pending migration
      fuelLog = {
        id: `fuel-${Date.now()}`,
        driverId: req.user.id,
        vehicleId: vehicle.id,
        liters: body.liters,
        odometerKm: body.odometerKm,
        cost: body.cost,
        notes: body.notes,
        loggedAt: new Date().toISOString(),
      };
    }

    res.status(201).json({ success: true, log: fuelLog });
  })
);

router.get(
  '/fuel-log',
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);
    let logs = [];
    try {
      logs = await prisma.fuelLog.findMany({
        where: { driverId: req.user.id },
        orderBy: { loggedAt: 'desc' },
        take: 30,
      });
    } catch {
      logs = [];
    }

    res.json({ logs, vehicleId: vehicle.id, registrationNumber: vehicle.registrationNumber });
  })
);

/**
 * FEATURE 5: Driver SOS
 * POST /api/driver/sos
 */
router.post(
  '/sos',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        reason: z.string().optional(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        message: z.string().max(300).optional(),
      })
      .parse(req.body);

    const vehicle = await prisma.vehicle.findFirst({ where: { driverId: req.user.id }, include: { ward: true } });

    const fullMessage = [body.reason, body.message].filter(Boolean).join(' — ') || 'Driver triggered SOS';

    const alert = await prisma.sosAlert.create({
      data: {
        driverId: req.user.id,
        vehicleId: vehicle?.id,
        latitude: body.latitude,
        longitude: body.longitude,
        message: fullMessage,
      },
    });

    const payload = {
      id: alert.id,
      driver: { id: req.user.id, name: req.user.name, phone: req.user.phone },
      vehicle: vehicle ? { id: vehicle.id, registrationNumber: vehicle.registrationNumber } : null,
      latitude: alert.latitude,
      longitude: alert.longitude,
      message: alert.message,
      status: alert.status,
      createdAt: alert.createdAt,
    };

    emitTo([vehicle?.wardId ? `ward:${vehicle.wardId}` : null, 'city'], SOCKET_EVENTS.SOS_NEW, payload);
    
    if (vehicle?.wardId) {
      await notifyWardOfficers(vehicle.wardId, {
        type: 'EMERGENCY',
        title: `🚨 EMERGENCY SOS from Driver ${req.user.name}`,
        body: fullMessage,
        payload: { sosId: alert.id, latitude: alert.latitude, longitude: alert.longitude },
      });
    }

    res.status(201).json({ success: true, confirmed: true, alert: payload });
  })
);

/**
 * FEATURE 6: End of Shift Summary
 * GET /api/driver/shift-summary & GET /api/driver/summary
 */
router.get(
  ['/shift-summary', '/summary'],
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);
    const dateQuery = req.query.date ? String(req.query.date) : today();

    const [history, resolved, route] = await Promise.all([
      locationHistory(vehicle.id, {}),
      prisma.complaint.findMany({
        where: { assignedVehicleId: vehicle.id, status: 'RESOLVED', resolvedAt: { gte: startOfToday() } },
        select: { id: true, code: true, category: true, resolvedAt: true, createdAt: true, address: true },
        orderBy: { resolvedAt: 'desc' },
      }),
      prisma.route.findFirst({ where: { vehicleId: vehicle.id, date: dateQuery } }),
    ]);

    let fuelLoggedToday = 0;
    try {
      const fuelRecords = await prisma.fuelLog.findMany({
        where: { driverId: req.user.id, loggedAt: { gte: startOfToday() } },
      });
      fuelLoggedToday = fuelRecords.reduce((sum, r) => sum + (r.liters || 0), 0);
    } catch {
      fuelLoggedToday = 0;
    }

    const stops = route?.orderedStops ?? [];
    const minutesOnRoute = history.firstAt
      ? Math.round((new Date(history.lastAt) - new Date(history.firstAt)) / 60_000)
      : 0;

    // The day's shift record, if the driver clocked in — the summary page
    // shows the real start/end alongside the GPS-derived route time.
    const shiftToday = await prisma.driverShift.findFirst({
      where: { driverId: req.user.id, date: dateQuery },
      orderBy: { startedAt: 'desc' },
      include: { vehicle: { select: { id: true, registrationNumber: true } }, ward: { select: { id: true, name: true } } },
    });

    res.json({
      date: dateQuery,
      shift: serializeShift(shiftToday),
      vehicle: { id: vehicle.id, registrationNumber: vehicle.registrationNumber },
      stopsDone: stops.filter((s) => s.status === 'DONE').length,
      stopsTotal: stops.length,
      skipped: stops.filter((s) => s.status === 'SKIPPED').length,
      resolved: resolved.length,
      distanceKm: history.distanceKm,
      plannedKm: route?.distanceKm ?? 0,
      fuelLiters: fuelLoggedToday,
      minutesOnRoute,
      resolvedList: resolved,
      trail: history.points,
    });
  })
);

/**
 * Shift clock — POST /api/driver/shift/start, POST /api/driver/shift/end,
 * GET /api/driver/shift/current, GET /api/driver/shift/history
 *
 * The summary below reports "on shift since" from the day's first GPS ping,
 * which is not the same fact as when the driver actually started. These make
 * it explicit, and make "who is on duty right now" answerable at all.
 */
router.post(
  '/shift/start',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        odometerKm: z.number().min(0).max(2_000_000).optional(),
      })
      .parse(req.body ?? {});

    // A driver with no vehicle can still clock in — the shift is the person's,
    // not the truck's, and refusing would strand a driver waiting on a
    // reassignment with no way to record that they turned up.
    const vehicle = await myVehicle(req.user.id).catch(() => null);
    const { shift, alreadyOpen } = await startShift({ driver: req.user, vehicle, ...body });
    res.status(alreadyOpen ? 200 : 201).json({ ...serializeShift(shift), alreadyOpen });
  })
);

router.post(
  '/shift/end',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        odometerKm: z.number().min(0).max(2_000_000).optional(),
        notes: z.string().max(300).optional(),
      })
      .parse(req.body ?? {});

    const vehicle = await myVehicle(req.user.id).catch(() => null);
    const shift = await endShift({ driver: req.user, vehicle, ...body });
    res.json(serializeShift(shift));
  })
);

router.get(
  '/shift/current',
  asyncHandler(async (req, res) => {
    const shift = await activeShift(req.user.id);
    res.json({ onShift: Boolean(shift), shift: serializeShift(shift) });
  })
);

router.get(
  '/shift/history',
  asyncHandler(async (req, res) => {
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
    res.json({ days, items: await shiftHistory(req.user.id, days) });
  })
);

/**
 * FEATURE 7: Live Location Telemetry Broadcast
 * POST /api/driver/location & POST /api/driver/location/batch
 */
router.post(
  '/location',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        heading: z.number().optional(),
        speed: z.number().optional(),
        accuracy: z.number().optional(),
        ts: z.union([z.string(), z.number()]).optional(),
      })
      .parse(req.body);

    const payload = await ingestLocation({ ...body, driverId: req.user.id });
    res.status(201).json(payload);
  })
);

router.post(
  '/location/batch',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        points: z
          .array(
            z.object({
              latitude: z.number(),
              longitude: z.number(),
              heading: z.number().optional(),
              speed: z.number().optional(),
              ts: z.union([z.string(), z.number()]).optional(),
            })
          )
          .max(500),
      })
      .parse(req.body);

    let accepted = 0;
    for (const point of body.points) {
      await ingestLocation({ ...point, driverId: req.user.id });
      accepted += 1;
    }
    res.json({ accepted });
  })
);

router.post(
  '/stops/:seq/skip',
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);
    const route = await prisma.route.findFirst({ where: { vehicleId: vehicle.id, date: today() } });
    if (!route) throw new HttpError(404, 'No route published for today');

    const seq = Number(req.params.seq);
    const reason = req.body?.reason?.slice(0, 200) || 'Skipped by driver';
    const stops = (route.orderedStops || []).map((s) => (s.seq === seq ? { ...s, status: 'SKIPPED', reason } : s));

    await prisma.route.update({ where: { id: route.id }, data: { orderedStops: stops } });
    res.json({ seq, status: 'SKIPPED', reason });
  })
);

router.post(
  '/status',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { status } = z
      .object({ status: z.enum(['IDLE', 'ON_ROUTE', 'OFFLINE', 'MAINTENANCE']) })
      .parse(req.body);

    const vehicle = await myVehicle(req.user.id);
    const updated = await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status } });

    emitTo([vehicle.wardId ? `ward:${vehicle.wardId}` : null, 'city'], SOCKET_EVENTS.TRUCK_UPDATE, serializeVehicle(updated, vehicle.ward));
    res.json(serializeVehicle(updated, vehicle.ward));
  })
);

router.get(
  '/next-stop',
  asyncHandler(async (req, res) => {
    const vehicle = await myVehicle(req.user.id);
    const route = await prisma.route.findFirst({ where: { vehicleId: vehicle.id, date: today() } });
    const next = (route?.orderedStops ?? []).find((s) => s.status !== 'DONE');
    if (!next) return res.json({ done: true });

    const from = { latitude: vehicle.lastLat, longitude: vehicle.lastLng };
    const km = vehicle.lastLat != null ? distanceKm(from, next) : null;

    return res.json({
      done: false,
      stop: next,
      distanceKm: km != null ? Number(km.toFixed(2)) : null,
      etaMinutes: km != null ? Math.max(1, Math.round((km / 20) * 60)) : null,
    });
  })
);

// ------------------------------------------------ Scheduled Task Operations ----

/** GET /api/driver/scheduled-tasks — List scheduled tasks assigned to this driver */
router.get(
  '/scheduled-tasks',
  asyncHandler(async (req, res) => {
    const tasks = await prisma.scheduledPickupRequest.findMany({
      where: {
        assignedDriverId: req.user.id,
        status: { in: ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'] },
      },
      include: {
        citizen: { select: { id: true, name: true, phone: true } },
        ward: { select: { id: true, name: true } },
      },
      orderBy: { scheduledDate: 'asc' },
    });
    res.json({ items: tasks });
  })
);

/** POST /api/driver/scheduled-tasks/:id/complete — Complete scheduled task with photo proof */
router.post(
  '/scheduled-tasks/:id/complete',
  writeLimiter,
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const task = await prisma.scheduledPickupRequest.findFirst({
      where: { id: req.params.id, assignedDriverId: req.user.id },
      include: { citizen: true },
    });
    if (!task) throw new HttpError(404, 'Scheduled task not found or not assigned to you');

    let completionPhotoUrl = null;
    const file = fileFromRequest(req, 'photo');
    if (file) {
      completionPhotoUrl = await persist(file.buffer, file.mimetype, 'proofs');
    }

    const updated = await prisma.scheduledPickupRequest.update({
      where: { id: task.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        completionPhotoUrl,
        completionNotes: req.body?.notes?.slice(0, 300) || 'Pickup completed successfully.',
      },
    });

    // 1. Award Green Credits to citizen wallet (+25 credits)
    await awardCredits({
      userId: task.citizenId,
      delta: 25,
      reason: `Event Scheduled Pickup Completed (${task.code})`,
      reasonCode: 'CLEANUP_VERIFIED',
    });

    // 2. Notify Citizen
    await notify({
      userId: task.citizenId,
      type: 'CREDIT_AWARDED',
      title: `Scheduled Pickup Completed! +25 Credits`,
      body: `Your scheduled pickup for "${task.eventReason}" has been completed by driver ${req.user.name}. +25 Green Credits added to your wallet!`,
      payload: { requestId: task.id, code: task.code, credits: 25 },
    });

    res.json({ ok: true, status: 'COMPLETED', item: updated });
  })
);

export default router;
