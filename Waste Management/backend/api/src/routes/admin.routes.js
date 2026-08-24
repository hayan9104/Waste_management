import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../middleware/error.js';
import { requirePortal, loadUser } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { audited, recordAudit } from '../middleware/audit.js';
import { prisma } from '../lib/prisma.js';
import { PORTALS, ROLES, WASTE_CATEGORIES } from '../config/constants.js';
import analytics from '../services/analytics.service.js';
import { serializeVehicle, today, locationHistory } from '../services/tracking.service.js';
import { hashPassword } from '../lib/password.js';
import { revokeAllSessions } from '../lib/tokens.js';
import { polygonBBox, polygonCentroid } from '../lib/geo.js';
import { aiHealth } from '../services/ai.service.js';
import { ensureRoadSnappedPolyline } from '../services/routing.service.js';
import env from '../config/env.js';
import { CITY } from '../seed/city.js';
import { wardRoster } from '../services/roster.service.js';
import { shiftBoard } from '../services/shift.service.js';

const router = Router();
router.use(requirePortal(PORTALS.ADMIN), loadUser);

/**
 * FEATURE 1: City-Wide Dashboard
 * GET /api/admin/dashboard & GET /api/admin/overview
 */
router.get(
  ['/dashboard', '/overview'],
  asyncHandler(async (_req, res) => {
    const [kpis, wards, status, categories, officers, drivers, citizens] = await Promise.all([
      analytics.overview(null),
      analytics.wardPerformance(null),
      analytics.statusBreakdown(null),
      analytics.categoryBreakdown(null, 7),
      prisma.user.count({ where: { role: ROLES.OFFICER, isActive: true } }),
      prisma.user.count({ where: { role: ROLES.DRIVER, isActive: true } }),
      prisma.user.count({ where: { role: ROLES.CITIZEN } }),
    ]);
    res.json({
      ...kpis,
      wards,
      statusBreakdown: status,
      categoryBreakdown: categories,
      staff: { officers, drivers, citizens },
    });
  })
);

/**
 * FEATURE 2: Master Fleet Registry & Live Tracking
 * GET /api/admin/fleet
 */
router.get(
  '/fleet',
  asyncHandler(async (req, res) => {
    const vehicles = await prisma.vehicle.findMany({
      where: req.query.wardId ? { wardId: String(req.query.wardId) } : {},
      include: { ward: true, driver: { select: { id: true, name: true, phone: true, isActive: true } } },
      orderBy: { registrationNumber: 'asc' },
    });

    const now = Date.now();
    res.json(
      vehicles.map((v) => {
        const isStale = v.lastPingAt ? (now - new Date(v.lastPingAt).getTime() > 120_000) : true;
        return {
          ...serializeVehicle(v, v.ward),
          driver: v.driver,
          maintenanceFlag: v.maintenanceFlag,
          isOffline: v.status === 'OFFLINE' || isStale,
          lastPingAgeSec: v.lastPingAt ? Math.round((now - new Date(v.lastPingAt).getTime()) / 1000) : null,
        };
      })
    );
  })
);

router.post(
  '/fleet',
  writeLimiter,
  audited('vehicle_create', 'vehicles'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        registrationNumber: z.string().min(4).max(20),
        wardId: z.string().optional(),
        driverId: z.string().optional(),
        model: z.string().optional(),
        capacityKg: z.coerce.number().optional(),
      })
      .parse(req.body);

    const vehicle = await prisma.vehicle.create({ data: body, include: { ward: true, driver: true } });
    res.status(201).json(serializeVehicle(vehicle, vehicle.ward));
  })
);

router.patch(
  '/fleet/:id',
  writeLimiter,
  audited('vehicle_update', 'vehicles'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        wardId: z.string().nullable().optional(),
        driverId: z.string().nullable().optional(),
        status: z.enum(['IDLE', 'ON_ROUTE', 'OFFLINE', 'MAINTENANCE']).optional(),
        maintenanceFlag: z.boolean().optional(),
        model: z.string().optional(),
        capacityKg: z.coerce.number().optional(),
      })
      .parse(req.body);

    const before = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
    if (!before) throw new HttpError(404, 'Vehicle not found');

    const vehicle = await prisma.vehicle.update({
      where: { id: req.params.id },
      data: body,
      include: { ward: true, driver: true },
    });
    await recordAudit({
      actorId: req.user.id,
      action: 'vehicle_update',
      targetTable: 'vehicles',
      targetId: vehicle.id,
      before,
      after: vehicle,
      req,
    });
    res.json(serializeVehicle(vehicle, vehicle.ward));
  })
);

/** GET /api/admin/fleet/:id/route — today's published route for one vehicle, with stop-by-stop status. */
router.get(
  '/fleet/:id/route',
  asyncHandler(async (req, res) => {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: req.params.id },
      include: { ward: true, driver: { select: { id: true, name: true, phone: true } } },
    });
    if (!vehicle) throw new HttpError(404, 'Vehicle not found');

    const [route, history] = await Promise.all([
      prisma.route.findFirst({ where: { vehicleId: vehicle.id, date: today() } }),
      locationHistory(vehicle.id, {}),
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
            polyline,
            distanceKm: route.distanceKm,
            durationMin: route.durationMin,
            solver: route.solver,
          }
        : null,
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
      stopsDone: stops.filter((s) => s.status === 'DONE').length,
      stopsTotal: stops.length,
      // The vehicle's actual GPS breadcrumb today — where it has really been,
      // as opposed to `route.polyline` which is the planned path.
      trail: history.points.map((p) => [p.longitude, p.latitude]),
      trailDistanceKm: history.distanceKm,
    });
  })
);

/**
 * FEATURE 3: User & Staff Management
 * GET /api/admin/users, POST /api/admin/users, PATCH /api/admin/users/:id, PATCH /api/admin/users/:id/block
 */
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        role: z.enum(['CITIZEN', 'DRIVER', 'OFFICER', 'ADMIN']).optional(),
        wardId: z.string().optional(),
        search: z.string().optional(),
        page: z.coerce.number().min(1).optional(),
        pageSize: z.coerce.number().min(5).max(100).optional(),
      })
      .parse(req.query);

    const page = q.page || 1;
    const pageSize = q.pageSize || 25;
    const where = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.wardId ? { wardId: q.wardId } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { email: { contains: q.search, mode: 'insensitive' } },
              { phone: { contains: q.search } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          wardId: true,
          greenCredits: true,
          lastLoginAt: true,
          createdAt: true,
          twoFactorEnabled: true,
          ward: { select: { name: true, code: true } },
          officerWards: { select: { ward: { select: { id: true, name: true, code: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ page, pageSize, total, pages: Math.ceil(total / pageSize), items });
  })
);

router.post(
  '/users',
  writeLimiter,
  audited('user_create', 'users'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).max(80),
        email: z.string().email().optional(),
        phone: z.string().min(8).max(15).optional(),
        role: z.enum(['DRIVER', 'OFFICER', 'ADMIN']),
        password: z.string().min(8),
        wardId: z.string().optional(),
        wardIds: z.array(z.string()).optional(),
      })
      .parse(req.body);

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email?.toLowerCase(),
        phone: body.phone,
        role: body.role,
        passwordHash: await hashPassword(body.password),
        wardId: body.wardId,
        emailVerifiedAt: new Date(),
      },
    });

    if (body.role === ROLES.OFFICER && body.wardIds?.length) {
      await prisma.wardOfficer.createMany({
        data: body.wardIds.map((wardId, i) => ({ wardId, officerId: user.id, isPrimary: i === 0 })),
        skipDuplicates: true,
      });
    }

    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
  })
);

/** Block / Unblock user with instant session invalidation and audit logging */
router.patch(
  ['/users/:id/block', '/users/:id/toggle-block'],
  writeLimiter,
  asyncHandler(async (req, res) => {
    const before = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!before) throw new HttpError(404, 'User not found');
    if (before.id === req.user.id) {
      throw new HttpError(400, 'You cannot block your own admin account');
    }

    const nextState = !before.isActive;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: nextState },
    });

    if (!nextState) {
      await revokeAllSessions(user.id);
    }

    await recordAudit({
      actorId: req.user.id,
      action: nextState ? 'user_unblock' : 'user_block',
      targetTable: 'users',
      targetId: user.id,
      before: { isActive: before.isActive },
      after: { isActive: user.isActive },
      req,
    });

    res.json({ id: user.id, name: user.name, isActive: user.isActive });
  })
);

router.patch(
  '/users/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).max(80).optional(),
        isActive: z.boolean().optional(),
        role: z.enum(['CITIZEN', 'DRIVER', 'OFFICER', 'ADMIN']).optional(),
        wardId: z.string().nullable().optional(),
        wardIds: z.array(z.string()).optional(),
        password: z.string().min(8).optional(),
      })
      .parse(req.body);

    const before = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!before) throw new HttpError(404, 'User not found');
    if (before.id === req.user.id && body.isActive === false) {
      throw new HttpError(400, 'You cannot deactivate your own account');
    }

    const { wardIds, password, ...rest } = body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) },
    });

    if (wardIds) {
      await prisma.wardOfficer.deleteMany({ where: { officerId: user.id } });
      if (wardIds.length) {
        await prisma.wardOfficer.createMany({
          data: wardIds.map((wardId, i) => ({ wardId, officerId: user.id, isPrimary: i === 0 })),
          skipDuplicates: true,
        });
      }
    }

    if (body.isActive === false || body.role || password) await revokeAllSessions(user.id);

    await recordAudit({
      actorId: req.user.id,
      action: 'user_update',
      targetTable: 'users',
      targetId: user.id,
      before: { role: before.role, isActive: before.isActive, wardId: before.wardId },
      after: { role: user.role, isActive: user.isActive, wardId: user.wardId },
      req,
    });

    res.json({ id: user.id, name: user.name, role: user.role, isActive: user.isActive });
  })
);

/**
 * FEATURE 4: Ward Boundaries & Settings
 * GET /api/admin/wards, POST /api/admin/wards, PATCH /api/admin/wards/:id
 */
router.get(
  '/wards',
  asyncHandler(async (_req, res) => res.json(await analytics.wardPerformance(null)))
);

router.post(
  '/wards',
  writeLimiter,
  audited('ward_upsert', 'wards'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        id: z.string().optional(),
        name: z.string().min(2),
        code: z.string().min(1),
        zone: z.string().optional(),
        population: z.coerce.number().optional(),
        slaMinutes: z.coerce.number().optional(),
        boundary: z.object({
          type: z.literal('Polygon'),
          coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
        }),
      })
      .parse(req.body);

    const bbox = polygonBBox(body.boundary);
    const centre = polygonCentroid(body.boundary);
    const data = {
      name: body.name,
      code: body.code,
      zone: body.zone || 'Zone 1',
      population: body.population ?? 0,
      slaMinutes: body.slaMinutes ?? 1440,
      boundary: body.boundary,
      centerLat: centre.latitude,
      centerLng: centre.longitude,
      ...bbox,
    };

    const ward = body.id
      ? await prisma.ward.update({ where: { id: body.id }, data })
      : await prisma.ward.create({ data });

    res.status(body.id ? 200 : 201).json(ward);
  })
);

router.patch(
  '/wards/:id',
  writeLimiter,
  audited('ward_update', 'wards'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).optional(),
        code: z.string().min(1).optional(),
        zone: z.string().optional(),
        population: z.coerce.number().optional(),
        slaMinutes: z.coerce.number().optional(),
        boundary: z
          .object({
            type: z.literal('Polygon'),
            coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
          })
          .optional(),
      })
      .parse(req.body);

    let geoUpdates = {};
    if (body.boundary) {
      const bbox = polygonBBox(body.boundary);
      const centre = polygonCentroid(body.boundary);
      geoUpdates = {
        boundary: body.boundary,
        centerLat: centre.latitude,
        centerLng: centre.longitude,
        ...bbox,
      };
    }

    const ward = await prisma.ward.update({
      where: { id: req.params.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.code ? { code: body.code } : {}),
        ...(body.zone ? { zone: body.zone } : {}),
        ...(body.population != null ? { population: body.population } : {}),
        ...(body.slaMinutes != null ? { slaMinutes: body.slaMinutes } : {}),
        ...geoUpdates,
      },
    });

    res.json(ward);
  })
);

/**
 * FEATURE 5: Compliance & Audit Exports
 * GET /api/admin/exports & GET /api/admin/export/compliance
 */
router.get(
  ['/exports', '/export/compliance'],
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days) || 30;
    const wards = await analytics.wardPerformance(null);
    const trends = await analytics.trends(null, days);
    const categories = await analytics.categoryBreakdown(null, days);

    const rows = wards.map((w) => ({
      wardCode: w.code,
      wardName: w.name,
      zone: w.zone,
      population: w.population,
      complaintsReported: w.reported7d,
      complaintsResolved: w.resolved7d,
      openComplaints: w.openComplaints,
      emergencies: w.emergencies7d,
      slaCompliancePct: w.slaCompliancePct,
      avgResolutionMinutes: w.avgResolutionMinutes,
      vehiclesDeployed: w.vehicles,
    }));

    const totals = rows.reduce(
      (acc, r) => ({
        complaintsReported: acc.complaintsReported + r.complaintsReported,
        complaintsResolved: acc.complaintsResolved + r.complaintsResolved,
        openComplaints: acc.openComplaints + r.openComplaints,
        emergencies: acc.emergencies + r.emergencies,
      }),
      { complaintsReported: 0, complaintsResolved: 0, openComplaints: 0, emergencies: 0 }
    );

    if (req.query.format === 'csv' || req.query.type === 'csv') {
      const header = Object.keys(rows[0] || { wardCode: '' }).join(',');
      const csv = [header, ...rows.map((r) => Object.values(r).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="safaai-compliance-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(csv);
    }

    return res.json({
      title: 'SWM Rules ward-wise compliance summary',
      generatedAt: new Date(),
      periodDays: days,
      city: CITY.name,
      rows,
      totals: {
        ...totals,
        resolutionRatePct: totals.complaintsReported
          ? Math.round((totals.complaintsResolved / totals.complaintsReported) * 100)
          : 0,
      },
      trends,
      categories,
    });
  })
);

/**
 * FEATURE 6: Audit Logs
 * GET /api/admin/audit-logs & GET /api/admin/audit
 */
router.get(
  ['/audit-logs', '/audit'],
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        actorId: z.string().optional(),
        action: z.string().optional(),
        targetTable: z.string().optional(),
        page: z.coerce.number().min(1).optional(),
        pageSize: z.coerce.number().min(5).max(200).optional(),
      })
      .parse(req.query);

    const page = q.page || 1;
    const pageSize = q.pageSize || 50;
    const where = {
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: { contains: q.action, mode: 'insensitive' } } : {}),
      ...(q.targetTable ? { targetTable: q.targetTable } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { name: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ page, pageSize, total, pages: Math.ceil(total / pageSize), items });
  })
);

/**
 * FEATURE 7: AI Model Health Monitoring
 * GET /api/admin/model-health
 */
router.get(
  '/model-health',
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days) || 14;
    const [health, ai] = await Promise.all([analytics.modelHealth(days), aiHealth()]);
    const models = await analytics.perModelHealth(days, !!ai.reachable);

    // Check low-confidence proportion flagged/rejected by officers
    const [totalPredictions, rejectedPredictions] = await Promise.all([
      prisma.complaint.count({
        where: { createdAt: { gte: new Date(Date.now() - days * 86400_000) } },
      }),
      prisma.complaint.count({
        where: {
          createdAt: { gte: new Date(Date.now() - days * 86400_000) },
          status: 'REJECTED',
        },
      }),
    ]);

    const falsePositiveRate =
      totalPredictions > 0
        ? Number(((rejectedPredictions / totalPredictions) * 100).toFixed(1))
        : 0;

    res.json({
      ...health,
      totalPredictions,
      rejectedPredictions,
      falsePositiveRate,
      service: ai,
      models,
    });
  })
);

router.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days) || 30;
    const [trends, categories, wards, status] = await Promise.all([
      analytics.trends(null, days),
      analytics.categoryBreakdown(null, days),
      analytics.wardPerformance(null),
      analytics.statusBreakdown(null),
    ]);
    res.json({ days, trends, categories, wards, status });
  })
);

router.get(
  '/hotspots',
  asyncHandler(async (req, res) => res.json(await analytics.hotspotForecast(null, req.query.date)))
);

/**
 * Every truck's route for today in one response, for the city-wide overlay.
 *
 * /fleet/:id/route answers "show me this one truck", which is the wrong shape
 * for a command centre: with 4-5 trucks per ward the interesting question is
 * where all of them are working at once, and clicking each in turn to build
 * that picture in your head is not an answer.
 *
 * Polylines are decimated to at most MAX_OVERVIEW_POINTS before being sent.
 * Road-snapped OSRM geometry runs to several hundred points per route, and
 * thirty of those is megabytes of JSON to draw lines a few pixels wide at
 * city zoom. The selected route is still fetched at full fidelity through
 * /fleet/:id/route, so detail is never lost where it is actually visible.
 */
const MAX_OVERVIEW_POINTS = 120;

function decimate(points, max = MAX_OVERVIEW_POINTS) {
  if (!Array.isArray(points) || points.length <= max) return points ?? [];
  const step = Math.ceil(points.length / max);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  // Always keep the true endpoint, or the drawn line stops short of the depot.
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

router.get(
  ['/live-routes', '/fleet/routes'],
  asyncHandler(async (req, res) => {
    const routes = await prisma.route.findMany({
      where: {
        date: today(),
        status: { in: ['PUBLISHED', 'IN_PROGRESS'] },
        ...(req.query.wardId ? { wardId: String(req.query.wardId) } : {}),
      },
      include: {
        vehicle: { select: { id: true, registrationNumber: true, status: true, lastLat: true, lastLng: true, lastPingAt: true } },
        driver: { select: { id: true, name: true, phone: true } },
        ward: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ wardId: 'asc' }, { label: 'asc' }],
    });

    const now = Date.now();
    res.json(
      routes.map((r) => {
        const stops = Array.isArray(r.orderedStops) ? r.orderedStops : [];
        const done = stops.filter((st) => st.status === 'DONE').length;
        const pingAgeSec = r.vehicle?.lastPingAt
          ? Math.round((now - new Date(r.vehicle.lastPingAt).getTime()) / 1000)
          : null;

        return {
          id: r.id,
          label: r.label,
          status: r.status,
          ward: r.ward,
          driver: r.driver,
          vehicle: r.vehicle && {
            id: r.vehicle.id,
            registrationNumber: r.vehicle.registrationNumber,
            status: r.vehicle.status,
            latitude: r.vehicle.lastLat,
            longitude: r.vehicle.lastLng,
            isOffline: pingAgeSec == null || pingAgeSec > 120,
          },
          distanceKm: r.distanceKm,
          durationMin: r.durationMin,
          stopsTotal: stops.length,
          stopsDone: done,
          progressPct: stops.length ? Math.round((done / stops.length) * 100) : 0,
          hasEmergency: stops.some((st) => st.isEmergency && st.status !== 'DONE'),
          polyline: decimate(r.polylineGeometry),
          /** Stop coordinates only — the overlay draws dots, not stop detail. */
          stops: stops.map((st) => ({
            seq: st.seq,
            latitude: st.latitude,
            longitude: st.longitude,
            status: st.status ?? 'PENDING',
            isEmergency: Boolean(st.isEmergency),
          })),
        };
      })
    );
  })
);

router.get('/categories', (_req, res) => res.json(WASTE_CATEGORIES));

/**
 * Ward-wise driver roster — every ward with its crew, each driver's truck,
 * today's route progress and whether their handset is still reporting.
 * /fleet answers this per vehicle and /users answers it as a flat directory;
 * neither one answers "show me ward W's drivers", which is what both the
 * admin console and the ward officer actually ask.
 */
router.get(
  ['/ward-drivers', '/wards/drivers'],
  asyncHandler(async (_req, res) => res.json(await wardRoster(null)))
);

/** Who is clocked on across the city right now, and who has already finished. */
router.get(
  ['/shifts', '/driver-shifts'],
  asyncHandler(async (_req, res) => res.json(await shiftBoard(null)))
);

/**
 * Fuel & expenditure — city-wide spend, litres, cost per km and the worst
 * offenders by vehicle and ward.
 */
router.get(
  ['/fuel', '/analytics/fuel', '/expenditure'],
  asyncHandler(async (req, res) => {
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    res.json(await analytics.fuelAndExpenditure(null, days));
  })
);

/** SLA resolution analytics — compliance trend, per category and per ward. */
router.get(
  ['/sla', '/analytics/sla'],
  asyncHandler(async (req, res) => {
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    res.json(await analytics.slaPerformance(null, days));
  })
);

/**
 * Re-seed the demo dataset (plan §8 note: routes are stored per calendar day,
 * so a fresh morning has none until this runs). Wipes and recreates
 * everything deterministically -- same shape the CLI `npm run seed` produces.
 * Fires in the background rather than blocking the request/response cycle:
 * this can take several minutes against a pooled connection with real OSRM
 * road-snapping per route, well past any reasonable HTTP timeout. Progress
 * and the final summary land in the server's own logs.
 */
router.post(
  '/reseed-demo-data',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { runSeed } = await import('../seed/seed.js');
    res.json({ ok: true, message: 'Re-seed started in the background. This can take a few minutes -- check the server Logs for progress and a final summary.' });

    runSeed()
      .then((summary) => console.log('[admin] re-seed complete:', JSON.stringify(summary)))
      .catch((err) => console.error('[admin] re-seed failed:', err));
  })
);

/**
 * Backfills photoUrl on any complaint that was seeded before the mock photo
 * pool existed (or otherwise never got one) — targeted and additive, unlike
 * /reseed-demo-data it never wipes anything, so it's safe to run against a
 * database that already has real live-tested state on it.
 *
 * Fire-and-forget like /reseed-demo-data: a database with months of seeded
 * history can mean thousands of individual complaint rows, each needing its
 * own UPDATE (a random per-row pick isn't expressible as one updateMany) —
 * comfortably past any HTTP request timeout, so the response returns
 * immediately and the real work logs its progress server-side.
 */
router.post(
  '/backfill-photos',
  writeLimiter,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, message: 'Photo backfill started in the background -- check the server Logs for progress and a final summary.' });

    (async () => {
      const { buildPhotoPool } = await import('../seed/seed.js');
      const pool = await buildPhotoPool();
      const pick = () => pool[Math.floor(Math.random() * pool.length)];

      const missingPhoto = await prisma.complaint.findMany({ where: { photoUrl: null }, select: { id: true } });
      for (const { id } of missingPhoto) {
        await prisma.complaint.update({ where: { id }, data: { photoUrl: pick() } });
      }

      const missingResolutionPhoto = await prisma.complaint.findMany({
        where: { status: 'RESOLVED', resolutionPhotoUrl: null },
        select: { id: true },
      });
      for (const { id } of missingResolutionPhoto) {
        await prisma.complaint.update({ where: { id }, data: { resolutionPhotoUrl: pick() } });
      }

      console.log(
        `[admin] photo backfill complete: ${missingPhoto.length} photoUrl, ${missingResolutionPhoto.length} resolutionPhotoUrl`
      );
    })().catch((err) => console.error('[admin] photo backfill failed:', err));
  })
);

/**
 * Deletes complaints whose photo is genuinely unrecoverable: local-disk
 * uploads (photoUrl starting with /uploads/) whose file no longer exists on
 * this container. Render's disk is ephemeral and gets wiped on every
 * redeploy, so a citizen report submitted while STORAGE_DRIVER=local is
 * permanently lost the next time the API redeploys -- unlike the missing-
 * photo backfill, there's no photo to backfill here, just a dead reference,
 * so the honest outcome is removing the orphaned report rather than
 * pretending it has evidence it doesn't.
 */
router.post(
  '/cleanup-broken-photo-complaints',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const candidates = await prisma.complaint.findMany({
      where: { photoUrl: { startsWith: '/uploads/' } },
      select: { id: true, code: true, photoUrl: true },
    });

    const toDelete = candidates.filter((c) => {
      const filePath = path.join(env.uploadDir, path.basename(c.photoUrl));
      return !fs.existsSync(filePath);
    });

    for (const c of toDelete) {
      await prisma.complaint.delete({ where: { id: c.id } });
    }

    res.json({
      ok: true,
      checked: candidates.length,
      deleted: toDelete.length,
      deletedCodes: toDelete.map((c) => c.code),
    });
  })
);

/** Deletes specific complaints by ticket code — a precise, small-blast-radius tool, unlike the broader cleanup jobs above. */
router.post(
  '/delete-complaints-by-code',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { codes } = z.object({ codes: z.array(z.string()).min(1).max(20) }).parse(req.body);

    const matches = await prisma.complaint.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    for (const { id } of matches) {
      await prisma.complaint.delete({ where: { id } });
    }

    res.json({ ok: true, requested: codes, deleted: matches.map((c) => c.code) });
  })
);

export default router;
