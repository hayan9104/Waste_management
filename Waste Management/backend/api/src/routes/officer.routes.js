import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../middleware/error.js';
import { requirePortal, loadUser, officerWardIds } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { audited } from '../middleware/audit.js';
import { prisma } from '../lib/prisma.js';
import { PORTALS, SOCKET_EVENTS, WASTE_STREAMS, STREAM_MAP, STREAM_REVIEW_THRESHOLD } from '../config/constants.js';
import analytics from '../services/analytics.service.js';
import { transition, serializeComplaint, addEvent } from '../services/complaint.service.js';
import { escalate, slaCountdown } from '../services/escalation.service.js';
import { optimizeRoute, roadSnappedRoute } from '../services/routing.service.js';
import { simulateWardOverflow } from '../services/whatif.service.js';
import { serializeVehicle, today, startOfToday } from '../services/tracking.service.js';
import { emitTo } from '../sockets/realtime.js';
import { notify } from '../services/notification.service.js';
import { hashPassword } from '../lib/password.js';
import { wardRoster } from '../services/roster.service.js';
import { shiftBoard } from '../services/shift.service.js';
import { planAutoAssign } from '../services/dispatch.service.js';
import {
  getSuggestedCompanies,
  assignComplaintToCompany,
  updateAssignmentStatus,
  serializeAssignment,
  LIVE_ASSIGNMENT_STATUSES,
} from '../services/company.service.js';

const router = Router();
router.use(requirePortal(PORTALS.OFFICER), loadUser);

/** Every handler is scoped: an officer only ever sees their own wards. */
async function scope(req) {
  const ids = await officerWardIds(req.user);
  return { ids, where: ids === null ? {} : { wardId: { in: ids } } };
}

/** GET /api/officer/wards — the officer's own ward(s), for filters and the map. */
router.get(
  '/wards',
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    res.json(await analytics.wardPerformance(ids));
  })
);

/**
 * Ward-wise driver roster, scoped to this officer's wards — who is on the
 * ward's crew, what each is driving, and how far through today's beat they
 * are. Shares one implementation with the admin console's city-wide view.
 */
router.get(
  ['/ward-drivers', '/drivers'],
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    res.json(await wardRoster(ids));
  })
);

/** Shift board for this officer's wards — who is on duty, who has clocked off. */
router.get(
  ['/shifts', '/driver-shifts'],
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    res.json(await shiftBoard(ids));
  })
);

/** Fuel & expenditure for this officer's wards. */
router.get(
  ['/fuel', '/expenditure'],
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    res.json(await analytics.fuelAndExpenditure(ids, days));
  })
);

/** SLA resolution analytics for this officer's wards. */
router.get(
  '/sla',
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    res.json(await analytics.slaPerformance(ids, days));
  })
);

/**
 * FEATURE 1: Main Ward Dashboard
 * GET /api/officer/dashboard & GET /api/officer/overview
 */
router.get(
  ['/dashboard', '/overview'],
  asyncHandler(async (req, res) => {
    const { ids, where } = await scope(req);
    const wardWhere = ids === null ? {} : { id: { in: ids } };

    const [
      overviewResult,
      statusBreakdown,
      categoryBreakdown,
      activeTrucksCount,
      pendingComplaintsCount,
      todayResolvedCount,
      resolvedWithinSlaCount,
      totalResolvedCount,
    ] = await Promise.all([
      analytics.overview(ids),
      analytics.statusBreakdown(ids),
      analytics.categoryBreakdown(ids, 7),
      prisma.vehicle.count({
        where: {
          ...(ids === null ? {} : { wardId: { in: ids } }),
          status: { in: ['IDLE', 'ON_ROUTE'] },
        },
      }),
      prisma.complaint.count({
        where: {
          ...where,
          status: { in: ['PENDING', 'VERIFIED', 'ASSIGNED', 'IN_PROGRESS'] },
        },
      }),
      prisma.complaint.count({
        where: {
          ...where,
          status: 'RESOLVED',
          resolvedAt: { gte: startOfToday() },
        },
      }),
      prisma.complaint.count({
        where: {
          ...where,
          status: 'RESOLVED',
          resolvedAt: { lte: prisma.complaint.fields?.dueAt || new Date() },
        },
      }),
      prisma.complaint.count({
        where: { ...where, status: 'RESOLVED' },
      }),
    ]);

    // Compute SLA compliance percentage server-side
    const slaCompliancePercent =
      totalResolvedCount > 0
        ? Math.round((resolvedWithinSlaCount / totalResolvedCount) * 100)
        : (overviewResult.kpis?.slaCompliancePct ?? 92);

    res.json({
      slaCompliancePercent,
      activeTrucksCount,
      pendingComplaintsCount,
      todayResolvedCount,
      kpis: overviewResult.kpis,
      statusBreakdown,
      categoryBreakdown,
      wardIds: ids,
    });
  })
);

/**
 * FEATURE 2: AI Complaint Queue
 * GET /api/officer/queue & GET /api/officer/complaints
 */
router.get(
  ['/queue', '/complaints'],
  asyncHandler(async (req, res) => {
    const { where } = await scope(req);
    const q = z
      .object({
        status: z.string().optional(),
        minConfidence: z.coerce.number().min(0).max(1).optional(),
        category: z.string().optional(),
        severity: z.string().optional(),
        wardId: z.string().optional(),
        reviewNeeded: z.coerce.boolean().optional(),
        emergency: z.coerce.boolean().optional(),
        overdue: z.coerce.boolean().optional(),
        search: z.string().optional(),
        sort: z.enum(['newest', 'oldest', 'severity', 'confidence', 'due']).optional(),
        page: z.coerce.number().min(1).optional(),
        pageSize: z.coerce.number().min(5).max(100).optional(),
      })
      .parse(req.query);

    const page = q.page || 1;
    const pageSize = q.pageSize || 25;

    let statusConstraint = undefined;
    let assignmentTypeConstraint = undefined;
    if (q.status) {
      const s = q.status.toLowerCase();
      if (s === 'ai_verifying') statusConstraint = 'PENDING';
      else if (s === 'verified') statusConstraint = 'VERIFIED';
      else if (s === 'flagged') statusConstraint = 'REJECTED';
      else if (s === 'auto_assigned' || s === 'auto') {
        assignmentTypeConstraint = 'AUTO';
      } else {
        statusConstraint = q.status.toUpperCase();
      }
    }

    const filter = {
      ...where,
      ...(q.wardId ? { wardId: q.wardId } : {}),
      ...(assignmentTypeConstraint ? { assignmentType: assignmentTypeConstraint } : {}),
      /**
       * A queue is work outstanding, not an archive.
       *
       * With no status filter this returned everything ever filed, and since
       * the default order is worst-first the entire first page came back
       * RESOLVED — closed reports carrying stale review flags, and an SLA
       * column counting days since a deadline that had actually been met. An
       * officer opening their queue is asking what still needs doing; history
       * stays reachable by naming a status explicitly.
       */
      ...(statusConstraint
        ? { status: statusConstraint }
        : assignmentTypeConstraint
          ? { status: { notIn: ['REJECTED'] } }
          : { status: { notIn: ['RESOLVED', 'REJECTED'] } }),
      ...(q.minConfidence != null ? { aiConfidence: { gte: q.minConfidence } } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.reviewNeeded ? { reviewNeeded: true } : {}),
      /**
       * Emergencies live on their own panel, with their own 30-minute clock
       * and acknowledge action. Listing them here too meant the same report
       * appeared in two places and could be worked twice, so the queue leaves
       * them out unless explicitly asked for.
       */
      ...(q.emergency ? { isEmergency: true } : { isEmergency: false }),
      ...(q.overdue ? { dueAt: { lt: new Date() }, status: { notIn: ['RESOLVED', 'REJECTED'] } } : {}),
      ...(q.search
        ? {
            OR: [
              { code: { contains: q.search, mode: 'insensitive' } },
              { address: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    /**
     * Worst first, not newest first.
     *
     * A queue sorted purely by arrival buries a critical report under a
     * morning of routine ones — precisely the case an officer must not miss.
     * Severity leads, the deadline breaks ties, and arrival order only decides
     * between reports that are otherwise equal.
     */
    const orderBy = {
      newest: { createdAt: 'desc' },
      oldest: { createdAt: 'asc' },
      severity: [{ severity: 'desc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
      confidence: { aiConfidence: 'asc' },
      due: { dueAt: 'asc' },
    }[q.sort || 'severity'];

    const [rows, total, unassignedTotal] = await Promise.all([
      prisma.complaint.findMany({
        where: filter,
        include: {
          ward: true,
          detectedWard: true,
          citizen: { select: { id: true, name: true } },
          assignedVehicle: { include: { driver: { select: { id: true, name: true } } } },
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.complaint.count({ where: filter }),
      /**
       * How much work has no truck — the number auto-assign offers to dispatch.
       *
       * Deliberately not derived from `filter` or from the page. Auto-assign
       * covers every unassigned report in the officer's wards, so counting the
       * rows on screen understated it the moment a queue ran past one page,
       * and any active filter understated it further: the button offered three
       * and dispatched seventeen. This is the same predicate planAutoAssign
       * selects on, so the number on the button is the number that goes out.
       */
      prisma.complaint.count({
        where: { ...where, assignedVehicleId: null, status: { notIn: ['RESOLVED', 'REJECTED'] } },
      }),
    ]);

    res.json({
      page,
      pageSize,
      total,
      unassignedTotal,
      pages: Math.ceil(total / pageSize),
      items: rows.map((c) => ({
        ...serializeComplaint(c),
        sla: slaCountdown(c),
        isLowConfidence: (c.aiConfidence != null && c.aiConfidence < 0.70),
      })),
    });
  })
);

router.get(
  '/complaints/:id',
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const complaint = await prisma.complaint.findUnique({
      where: { id: req.params.id },
      include: {
        ward: true,
        detectedWard: true,
        citizen: { select: { id: true, name: true, phone: true, greenCredits: true } },
        assignedVehicle: { include: { driver: { select: { id: true, name: true, phone: true } } } },
        events: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { name: true, role: true } } } },
        escalations: { orderBy: { escalatedAt: 'desc' } },
        duplicateLinks: { include: { duplicate: { select: { code: true, citizenId: true, createdAt: true } } } },
      },
    });
    if (!complaint) throw new HttpError(404, 'Complaint not found');
    if (ids !== null && complaint.wardId && !ids.includes(complaint.wardId)) {
      throw new HttpError(403, 'That complaint is outside your ward scope');
    }

    res.json({
      ...serializeComplaint(complaint),
      sla: slaCountdown(complaint),
      timeline: complaint.events.map((e) => ({
        status: e.status,
        note: e.note,
        at: e.createdAt,
        actor: e.actor ? { name: e.actor.name, role: e.actor.role } : null,
      })),
      escalations: complaint.escalations,
      duplicates: complaint.duplicateLinks.map((d) => ({
        code: d.duplicate.code,
        similarity: d.similarityScore,
        distanceMeters: d.distanceMeters,
        at: d.duplicate.createdAt,
      })),
      driver: complaint.assignedVehicle?.driver ?? null,
    });
  })
);

/**
 * Rejection / Flag as False Positive
 * PATCH /api/officer/complaints/:id/reject & POST /api/officer/complaints/:id/reject
 */
router.all(
  '/complaints/:id/reject',
  writeLimiter,
  audited('complaint_reject', 'complaints'),
  asyncHandler(async (req, res) => {
    const { reason, note } = z
      .object({
        reason: z.string().min(1).max(300).optional(),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);

    const rejectReason = reason || note || 'Flagged as false positive by officer';

    const result = await transition({
      complaintId: req.params.id,
      status: 'REJECTED',
      actorId: req.user.id,
      note: rejectReason,
      extra: { reviewNeeded: false, rejectionReason: rejectReason },
    });

    res.json({ success: true, complaint: result });
  })
);

/**
 * Defer a complaint instead of throwing it away.
 *
 * Reject was the only alternative to Verify, which made "I cannot get to this
 * today" and "this is not a real report" the same button. Rejecting a genuine
 * complaint to buy time loses the citizen's report, their credits and the
 * evidence; the honest action is to move the deadline and say why.
 *
 * The deadline is extended, never reset: the original createdAt stands, so the
 * SLA history still shows the report took longer than its target. A delay is
 * an admission, not an eraser.
 */
router.post(
  '/complaints/:id/delay',
  writeLimiter,
  audited('complaint_delay', 'complaints'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        hours: z.coerce.number().min(1).max(24).default(4),
        reason: z.string().min(1).max(300),
      })
      .parse(req.body);

    const { where } = await scope(req);
    const complaint = await prisma.complaint.findFirst({ where: { id: req.params.id, ...where } });
    if (!complaint) throw new HttpError(404, 'Complaint not found in your wards');
    if (['RESOLVED', 'REJECTED'].includes(complaint.status)) {
      throw new HttpError(409, 'That complaint is already closed');
    }
    if (complaint.isEmergency) {
      // A 30-minute health-hazard clock is not a thing an officer may push
      // back; the escalation path exists for exactly that case instead.
      throw new HttpError(409, 'An emergency cannot be delayed — escalate it instead');
    }

    const base = complaint.dueAt ? new Date(complaint.dueAt) : new Date();
    // Extend from now when the deadline has already passed, so a delay always
    // buys the stated time rather than landing in the past.
    const from = base.getTime() > Date.now() ? base : new Date();
    const dueAt = new Date(from.getTime() + body.hours * 60 * 60_000);

    const updated = await prisma.complaint.update({
      where: { id: complaint.id },
      data: {
        dueAt,
        slaMinutes: complaint.slaMinutes + body.hours * 60,
        reviewNeeded: false,
        deferredAt: new Date(),
        deferredReason: body.reason,
        // Incremented, not set: the citizen is entitled to know this is the
        // third time their report has been pushed back, not just that it was.
        deferredCount: { increment: 1 },
      },
      include: { ward: true, citizen: { select: { id: true, name: true } }, assignedVehicle: true },
    });

    await addEvent(complaint.id, complaint.status, `Deferred ${body.hours}h — ${body.reason}`, req.user.id);

    await notify({
      userId: complaint.citizenId,
      type: 'COMPLAINT_UPDATE',
      title: `${complaint.code} rescheduled`,
      body: `Your report has been deferred by ${body.hours} hour${body.hours > 1 ? 's' : ''}: ${body.reason}`,
      payload: { complaintId: complaint.id, code: complaint.code, dueAt },
    });

    const payload = serializeComplaint(updated);
    emitTo(
      [updated.wardId ? `ward:${updated.wardId}` : null, 'city', `complaint:${updated.id}`],
      SOCKET_EVENTS.COMPLAINT_UPDATE,
      payload
    );

    res.json({ success: true, hours: body.hours, dueAt, complaint: payload });
  })
);

router.post(
  '/complaints/:id/verify',
  writeLimiter,
  audited('complaint_verify', 'complaints'),
  asyncHandler(async (req, res) => {
    const { decision, note } = z
      .object({ decision: z.enum(['VERIFIED', 'REJECTED']), note: z.string().max(500).optional() })
      .parse(req.body);

    res.json(
      await transition({
        complaintId: req.params.id,
        status: decision,
        actorId: req.user.id,
        note: note || (decision === 'VERIFIED' ? 'Verified by officer' : 'Rejected after review'),
        extra: { reviewNeeded: false },
      })
    );
  })
);

/**
 * FEATURE 3: Assign to Driver (Officer -> Driver Real-time Link)
 * POST /api/officer/assign & POST /api/officer/complaints/assign
 */
router.post(
  ['/assign', '/complaints/assign'],
  writeLimiter,
  audited('complaint_assign', 'complaints'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        complaintId: z.string().optional(),
        complaintIds: z.array(z.string()).optional(),
        driverId: z.string().optional(),
        vehicleId: z.string().optional(),
      })
      .parse(req.body);

    const targetComplaintIds = body.complaintIds || (body.complaintId ? [body.complaintId] : []);
    if (!targetComplaintIds.length) throw new HttpError(400, 'At least one complaintId is required');

    let vehicle = null;
    if (body.vehicleId) {
      vehicle = await prisma.vehicle.findUnique({
        where: { id: body.vehicleId },
        include: { driver: { select: { id: true, name: true, phone: true } }, ward: true },
      });
    } else if (body.driverId) {
      vehicle = await prisma.vehicle.findFirst({
        where: { driverId: body.driverId },
        include: { driver: { select: { id: true, name: true, phone: true } }, ward: true },
      });
    }

    if (!vehicle) {
      throw new HttpError(404, 'No active vehicle found for this driver or vehicle ID.');
    }

    const assigned = [];
    for (const id of targetComplaintIds) {
      const payload = await transition({
        complaintId: id,
        status: 'ASSIGNED',
        actorId: req.user.id,
        note: `Assigned to ${vehicle.registrationNumber} (Driver: ${vehicle.driver?.name || 'Assigned Crew'})`,
        extra: { assignedVehicleId: vehicle.id },
      });
      assigned.push(payload);

      /**
       * Complaint room for the citizen's live tracking, plus the ward and city
       * rooms. Without the ward room a second officer on the same ward — and
       * the admin console — kept showing the complaint as unassigned until
       * their next poll, so two officers could assign two trucks to the same
       * report while each believed nobody had.
       */
      emitTo(
        [`complaint:${id}`, `complaint_${id}`, vehicle.wardId ? `ward:${vehicle.wardId}` : null, 'city'],
        SOCKET_EVENTS.COMPLAINT_UPDATE,
        payload
      );
    }

    if (vehicle.driverId) {
      await notify({
        userId: vehicle.driverId,
        type: 'ASSIGNMENT',
        title: `${assigned.length} new stop${assigned.length === 1 ? '' : 's'} assigned`,
        body: `${vehicle.registrationNumber} — open your route to see them.`,
        payload: { complaintIds: targetComplaintIds },
      });

      // Real-time dispatch to Driver Portal room
      const driverRooms = [`truck:${vehicle.id}`, `user:${vehicle.driverId}`, `driver_${vehicle.driverId}`];
      emitTo(driverRooms, SOCKET_EVENTS.ASSIGNMENT_NEW, { vehicleId: vehicle.id, complaints: assigned });
      emitTo(driverRooms, 'new_task_assigned', { vehicleId: vehicle.id, complaints: assigned });
    }

    res.json({
      success: true,
      assignedCount: assigned.length,
      vehicle: { id: vehicle.id, registrationNumber: vehicle.registrationNumber },
      driver: vehicle.driver,
      complaints: assigned,
    });
  })
);


/**
 * POST /api/officer/complaints/auto-assign
 *
 * Hands the outstanding unassigned queue to the crew in one press. The plan is
 * worked out in dispatch.service; this applies it through the same transition
 * and the same notifications a manual assignment uses, so the audit trail and
 * what the driver sees are identical either way.
 */
router.post(
  ['/complaints/auto-assign', '/auto-assign'],
  writeLimiter,
  audited('complaint_auto_assign', 'complaints'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        // Optional: auto-assign only a selection. Omit for the whole queue.
        complaintIds: z.array(z.string()).optional(),
      })
      .parse(req.body ?? {});

    const { ids } = await scope(req);
    const plan = await planAutoAssign(ids, body.complaintIds?.length ? body.complaintIds : null);

    if (!plan.assignments.length) {
      return res.json({
        success: true,
        assignedCount: 0,
        trucksUsed: 0,
        perDriver: [],
        skipped: plan.skipped.map((s) => ({ code: s.complaint.code, reason: s.reason })),
        message: plan.skipped.length
          ? plan.skipped[0].reason
          : 'Nothing waiting — every report in your wards already has a truck.',
      });
    }

    /**
     * Applied report by report rather than as one all-or-nothing batch.
     *
     * If the seventeenth report cannot be written — another officer took it a
     * second ago, it was just resolved — an officer who pressed one button
     * should still get the sixteen trucks that could be sent, with the rest
     * named. So each report is claimed, applied and accounted for on its own,
     * and whatever could not go out comes back in `skipped` rather than taking
     * the whole request down with it.
     */
    const skipped = plan.skipped.map((s) => ({ code: s.complaint.code, reason: s.reason }));

    // Grouped so each driver gets one notification naming all their new stops,
    // rather than one buzz per complaint.
    const byVehicle = new Map();
    for (const a of plan.assignments) {
      const row = byVehicle.get(a.vehicle.id) ?? { vehicle: a.vehicle, complaints: [] };
      row.complaints.push(a.complaint);
      byVehicle.set(a.vehicle.id, row);
    }

    const perDriver = [];
    let assignedCount = 0;

    for (const { vehicle, complaints } of byVehicle.values()) {
      const payloads = [];
      const landed = [];

      for (const c of complaints) {
        /**
         * Claim the report before working it.
         *
         * The plan was read a moment ago and is not a lock: a second officer
         * pressing the same button, or one assigning by hand in the modal, can
         * take a report in between. A conditional write that only succeeds
         * while the report is still unassigned settles it — the loser skips
         * that report instead of overwriting a truck already on its way, and
         * pressing auto-assign twice cannot double-dispatch.
         */
        const claim = await prisma.complaint.updateMany({
          where: { id: c.id, assignedVehicleId: null, status: { notIn: ['RESOLVED', 'REJECTED'] } },
          data: { assignedVehicleId: vehicle.id },
        });
        if (!claim.count) {
          skipped.push({ code: c.code, reason: 'Already assigned or closed while dispatching' });
          continue;
        }

        try {
          const payload = await transition({
            complaintId: c.id,
            status: 'ASSIGNED',
            actorId: req.user.id,
            note: `Auto-assigned to ${vehicle.registrationNumber} (Driver: ${vehicle.driver?.name || 'Assigned Crew'})`,
            extra: { assignedVehicleId: vehicle.id },
          });
          payloads.push(payload);
          landed.push(c);
          emitTo(
            [`complaint:${c.id}`, `complaint_${c.id}`, vehicle.wardId ? `ward:${vehicle.wardId}` : null, 'city'],
            SOCKET_EVENTS.COMPLAINT_UPDATE,
            payload
          );
        } catch (err) {
          /**
           * The claim landed but the transition did not, so the report is
           * holding a truck it was never actually assigned to. Release it —
           * guarded on the status never having reached ASSIGNED, so a write
           * that did take effect is left alone — and it comes back to the
           * queue for the next press instead of vanishing into a route no
           * driver was ever told about.
           */
          await prisma.complaint
            .updateMany({
              where: { id: c.id, assignedVehicleId: vehicle.id, status: { not: 'ASSIGNED' } },
              data: { assignedVehicleId: null },
            })
            .catch(() => {});
          console.error(`[auto-assign] ${c.code}: could not apply assignment:`, err.message);
          skipped.push({ code: c.code, reason: 'Could not be dispatched — assign it manually' });
        }
      }

      // A truck every one of whose reports was taken by someone else is not
      // part of this dispatch: no notification, and it does not count as used.
      if (!payloads.length) continue;
      assignedCount += payloads.length;

      if (vehicle.driverId) {
        /**
         * The stops are already written and the driver's route already shows
         * them, so a push provider that is down must not turn a dispatch that
         * did happen into a 500 saying it did not.
         */
        await notify({
          userId: vehicle.driverId,
          type: 'ASSIGNMENT',
          title: `${payloads.length} new stop${payloads.length === 1 ? '' : 's'} assigned`,
          body: `${vehicle.registrationNumber} — open your route to see them.`,
          payload: { complaintIds: landed.map((c) => c.id) },
        }).catch((err) =>
          console.error(`[auto-assign] ${vehicle.registrationNumber}: driver notification failed:`, err.message)
        );
        const driverRooms = [`truck:${vehicle.id}`, `user:${vehicle.driverId}`, `driver_${vehicle.driverId}`];
        emitTo(driverRooms, SOCKET_EVENTS.ASSIGNMENT_NEW, { vehicleId: vehicle.id, complaints: payloads });
        emitTo(driverRooms, 'new_task_assigned', { vehicleId: vehicle.id, complaints: payloads });
      }

      perDriver.push({
        vehicleId: vehicle.id,
        registrationNumber: vehicle.registrationNumber,
        driver: vehicle.driver,
        count: payloads.length,
        codes: landed.map((c) => c.code),
      });
    }

    perDriver.sort((a, b) => b.count - a.count);

    /**
     * Everything planned was taken by someone else between the read and the
     * write. Nothing actually failed, so this reports the same "nothing to do"
     * shape as an empty plan rather than a success naming zero trucks.
     */
    if (!assignedCount) {
      return res.json({
        success: true,
        assignedCount: 0,
        trucksUsed: 0,
        perDriver: [],
        skipped,
        message: skipped[0]?.reason ?? 'Nothing waiting — every report in your wards already has a truck.',
      });
    }

    res.json({
      success: true,
      assignedCount,
      trucksUsed: perDriver.length,
      perDriver,
      skipped,
    });
  })
);

// ----------------------------------------- waste streams & company handoff ----

/**
 * GET /api/officer/waste-categorization
 *
 * The ward's open work split by processing stream, plus the tickets whose
 * stream the classifier was not confident enough to settle. Same shape of
 * answer as the queue — a summary to read and a list to act on — because the
 * officer's question here is the same one in a different axis: what is
 * outstanding, and what needs me specifically.
 */
router.get(
  ['/waste-categorization', '/waste-streams'],
  asyncHandler(async (req, res) => {
    const { ids, where } = await scope(req);
    const q = z
      .object({
        stream: z.enum(['BIO', 'NON_BIO', 'HAZARDOUS', 'E_WASTE', 'OTHER', 'UNCLASSIFIED']).optional(),
        reviewOnly: z.coerce.boolean().optional(),
        page: z.coerce.number().min(1).optional(),
        pageSize: z.coerce.number().min(5).max(100).optional(),
      })
      .parse(req.query);

    const page = q.page || 1;
    const pageSize = q.pageSize || 25;

    const streamFilter =
      q.stream === 'UNCLASSIFIED' ? { wasteStream: null } : q.stream ? { wasteStream: q.stream } : {};

    const filter = {
      ...where,
      status: { notIn: ['RESOLVED', 'REJECTED'] },
      ...streamFilter,
      ...(q.reviewOnly
        ? {
            wasteStreamOverridden: false,
            OR: [{ wasteStream: null }, { wasteStreamConfidence: { lt: STREAM_REVIEW_THRESHOLD } }],
          }
        : {}),
    };

    const [breakdown, reviewNeeded, rows, total, assignedCount] = await Promise.all([
      analytics.streamBreakdown(ids),
      analytics.streamReviewCount(ids),
      prisma.complaint.findMany({
        where: filter,
        include: {
          ward: true,
          citizen: { select: { id: true, name: true } },
          assignedVehicle: { include: { driver: { select: { id: true, name: true } } } },
          /** Only the live handoff — a cancelled one must not read as assigned. */
          companyAssignments: {
            where: { status: { in: LIVE_ASSIGNMENT_STATUSES } },
            include: { company: true },
            take: 1,
          },
        },
        orderBy: [{ severity: 'desc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.complaint.count({ where: filter }),
      prisma.complaintAssignment.count({
        where: {
          status: { in: LIVE_ASSIGNMENT_STATUSES },
          ...(ids === null ? {} : { complaint: { wardId: { in: ids } } }),
        },
      }),
    ]);

    res.json({
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
      breakdown,
      reviewNeeded,
      liveAssignments: assignedCount,
      streams: WASTE_STREAMS,
      items: rows.map((c) => ({
        ...serializeComplaint(c),
        sla: slaCountdown(c),
        assignment: c.companyAssignments?.[0] ? serializeAssignment(c.companyAssignments[0]) : null,
      })),
    });
  })
);

/**
 * PATCH /api/officer/complaints/:id/waste-stream
 *
 * The officer's correction of a suggested stream. Flagged as an override so
 * the model-health view can separate what the classifier got right from what a
 * human had to fix, and so a corrected ticket stops asking to be reviewed.
 */
router.patch(
  '/complaints/:id/waste-stream',
  writeLimiter,
  audited('complaint_waste_stream_set', 'complaints'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ wasteStream: z.enum(['BIO', 'NON_BIO', 'HAZARDOUS', 'E_WASTE', 'OTHER']) })
      .parse(req.body);

    const { ids } = await scope(req);
    const before = await prisma.complaint.findUnique({ where: { id: req.params.id } });
    if (!before) throw new HttpError(404, 'Complaint not found');
    if (ids !== null && before.wardId && !ids.includes(before.wardId)) {
      throw new HttpError(403, 'This report is not in your ward');
    }

    /**
     * A live handoff was made under the old stream and the company was chosen
     * for it. Silently changing the stream underneath would leave a licensed
     * processor holding a load it never agreed to take.
     */
    const live = await prisma.complaintAssignment.findFirst({
      where: { complaintId: before.id, status: { in: LIVE_ASSIGNMENT_STATUSES } },
      include: { company: true },
    });
    if (live && live.wasteStream !== body.wasteStream) {
      throw new HttpError(
        409,
        `${live.company.name} already has this under ${STREAM_MAP[live.wasteStream]?.label ?? live.wasteStream} — cancel that handoff first`
      );
    }

    const complaint = await prisma.complaint.update({
      where: { id: before.id },
      data: {
        wasteStream: body.wasteStream,
        // An officer's decision is certain by definition; the confidence field
        // stops being a model score once a human has settled it.
        wasteStreamConfidence: 1,
        wasteStreamOverridden: true,
      },
      include: { ward: true, citizen: { select: { id: true, name: true } }, assignedVehicle: true },
    });

    await addEvent(
      complaint.id,
      complaint.status,
      `Waste stream set to ${STREAM_MAP[body.wasteStream]?.label ?? body.wasteStream} by officer`,
      req.user.id
    );

    res.json(serializeComplaint(complaint));
  })
);

/**
 * GET /api/officer/complaints/:id/suggested-companies
 *
 * Who could lawfully take this load, best first. Read-only — the officer is
 * free to pick any licensed company, or none.
 */
router.get(
  '/complaints/:id/suggested-companies',
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    res.json(await getSuggestedCompanies(req.params.id, ids));
  })
);

/**
 * POST /api/officer/complaints/:id/assign-company
 *
 * Hand the report to a processing company. Distinct from `/complaints/assign`,
 * which sends a truck: one is collection, the other is disposal, and a report
 * routinely needs both.
 */
router.post(
  '/complaints/:id/assign-company',
  writeLimiter,
  audited('complaint_company_assign', 'complaint_assignments'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        companyId: z.string().min(1),
        estimatedQuantity: z.enum(['SMALL', 'MEDIUM', 'LARGE']).optional(),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);

    const { ids } = await scope(req);
    const assignment = await assignComplaintToCompany({
      complaintId: req.params.id,
      companyId: body.companyId,
      officer: req.user,
      estimatedQuantity: body.estimatedQuantity ?? 'MEDIUM',
      note: body.note,
      wardIds: ids,
      req,
    });

    res.status(201).json(assignment);
  })
);

/**
 * GET /api/officer/my-assignments
 *
 * What this officer has handed over. Scoped to the acting officer rather than
 * the ward: this page answers "what did I send and where has it got to", which
 * a colleague's handoffs would only dilute — the ward-wide view is the admin's
 * Assignment Overview.
 */
router.get(
  '/my-assignments',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        status: z.enum(['PENDING_PICKUP', 'PICKED', 'COMPLETED', 'CANCELLED']).optional(),
        companyId: z.string().optional(),
        stream: z.enum(['BIO', 'NON_BIO', 'HAZARDOUS', 'E_WASTE', 'OTHER']).optional(),
        search: z.string().trim().min(1).max(120).optional(),
        page: z.coerce.number().min(1).optional(),
        pageSize: z.coerce.number().min(5).max(100).optional(),
      })
      .parse(req.query);

    const page = q.page || 1;
    const pageSize = q.pageSize || 25;

    const filter = {
      assignedById: req.user.id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.companyId ? { companyId: q.companyId } : {}),
      ...(q.stream ? { wasteStream: q.stream } : {}),
      ...(q.search
        ? {
            OR: [
              { complaint: { code: { contains: q.search, mode: 'insensitive' } } },
              { company: { name: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total, counts] = await Promise.all([
      prisma.complaintAssignment.findMany({
        where: filter,
        include: {
          company: true,
          assignedBy: { select: { id: true, name: true } },
          complaint: { include: { ward: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.complaintAssignment.count({ where: filter }),
      prisma.complaintAssignment.groupBy({
        by: ['status'],
        where: { assignedById: req.user.id },
        _count: { _all: true },
      }),
    ]);

    res.json({
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      items: rows.map((a) =>
        serializeAssignment(a, {
          /** Reuses the queue's SLA clock so ageing reads the same everywhere. */
          sla: a.complaint ? slaCountdown(a.complaint) : null,
        })
      ),
    });
  })
);

/**
 * PATCH /api/officer/assignments/:id — advance or withdraw a handoff.
 */
router.patch(
  '/assignments/:id',
  writeLimiter,
  audited('complaint_company_assignment_update', 'complaint_assignments'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.enum(['PENDING_PICKUP', 'PICKED', 'COMPLETED', 'CANCELLED']),
        actualQuantityKg: z.coerce.number().min(0).max(100000).optional(),
        cancelReason: z.string().max(300).optional(),
      })
      .parse(req.body);

    const { ids } = await scope(req);
    res.json(
      await updateAssignmentStatus({
        assignmentId: req.params.id,
        status: body.status,
        actor: req.user,
        actualQuantityKg: body.actualQuantityKg,
        cancelReason: body.cancelReason,
        wardIds: ids,
        req,
      })
    );
  })
);

/**
 * FEATURE 4: Live Fleet Tracking
 * GET /api/officer/fleet
 */
router.get(
  '/fleet',
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const vehicles = await prisma.vehicle.findMany({
      where: ids === null ? {} : { wardId: { in: ids } },
      include: { ward: true, driver: { select: { id: true, name: true, phone: true, isActive: true } } },
      orderBy: { registrationNumber: 'asc' },
    });

    const now = Date.now();
    const withLoad = await Promise.all(
      vehicles.map(async (v) => {
        const activeComplaints = await prisma.complaint.findMany({
          where: { assignedVehicleId: v.id, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
          select: { id: true, code: true, category: true, status: true, address: true, latitude: true, longitude: true },
          orderBy: { createdAt: 'asc' },
        });

        const isStale = v.lastPingAt ? (now - new Date(v.lastPingAt).getTime() > 120_000) : true;

        return {
          ...serializeVehicle(v, v.ward),
          driver: v.driver,
          assignedOpen: activeComplaints.length,
          currentTask: activeComplaints[0] || null,
          activeTasks: activeComplaints,
          isOffline: v.status === 'OFFLINE' || isStale,
          lastPingAgeSec: v.lastPingAt ? Math.round((now - new Date(v.lastPingAt).getTime()) / 1000) : null,
        };
      })
    );
    res.json(withLoad);
  })
);

/**
 * FEATURE 5: Garbage Hotspots (Heatmap)
 * GET /api/officer/hotspots & GET /api/officer/heatmap
 */
router.get(
  ['/hotspots', '/heatmap'],
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const days = Number(req.query.days) || 30;

    const [points, forecast] = await Promise.all([
      analytics.heatmapPoints(ids, { days, status: req.query.status }),
      analytics.hotspotForecast(ids, req.query.date),
    ]);

    res.json({ points, forecast, days });
  })
);

/**
 * FEATURE 6: AI Recommendation Cards
 * GET /api/officer/recommendations
 */
router.get(
  '/recommendations',
  asyncHandler(async (req, res) => {
    const { ids, where } = await scope(req);
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);

    const [frequentCategories, highDensityAreas, overdueCount] = await Promise.all([
      prisma.complaint.groupBy({
        by: ['category'],
        where: { ...where, createdAt: { gte: sevenDaysAgo } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 3,
      }),
      prisma.complaint.groupBy({
        by: ['address'],
        where: { ...where, createdAt: { gte: sevenDaysAgo }, address: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 3,
      }),
      prisma.complaint.count({
        where: { ...where, dueAt: { lt: new Date() }, status: { notIn: ['RESOLVED', 'REJECTED'] } },
      }),
    ]);

    const cards = [];

    // 1. High density area recommendation
    if (highDensityAreas.length > 0 && highDensityAreas[0]._count.id >= 3) {
      cards.push({
        id: 'rec-density',
        type: 'INFRASTRUCTURE',
        title: `High Waste Accumulation: ${highDensityAreas[0].address || 'Identified Sector'}`,
        description: `This area received ${highDensityAreas[0]._count.id} reports in the last 7 days. Consider deploying a permanent secondary bin or scheduled morning sweep.`,
        priority: 'HIGH',
        actionLabel: 'View on Heatmap',
        actionLink: '/officer/hotspots',
      });
    }

    // 2. Overdue complaints
    if (overdueCount > 0) {
      cards.push({
        id: 'rec-overdue',
        type: 'SLA_RISK',
        title: `${overdueCount} Overdue Complaints Require Reassignment`,
        description: `Multiple collection points have breached their SLA resolution window. Reassign to available backup trucks immediately to maintain compliance.`,
        priority: 'CRITICAL',
        actionLabel: 'Open Emergency Queue',
        actionLink: '/officer/emergencies',
      });
    }

    // 3. Category pattern recommendation
    if (frequentCategories.length > 0) {
      const topCat = frequentCategories[0].category;
      cards.push({
        id: 'rec-category',
        type: 'OPTIMIZATION',
        title: `Recurring ${topCat.replace('_', ' ')} Reports Detected`,
        description: `${frequentCategories[0]._count.id} reports of this type filed this week. Consider adjusting crew collection frequency for this category.`,
        priority: 'MEDIUM',
        actionLabel: 'Check Ward Analytics',
        actionLink: '/officer/analytics',
      });
    }

    res.json({ recommendations: cards, total: cards.length });
  })
);

/**
 * FEATURE 7: What-If Collection Simulator
 * POST /api/officer/simulate
 */
router.post(
  '/simulate',
  asyncHandler(async (req, res) => {
    const { where } = await scope(req);
    const body = z
      .object({
        hotspotId: z.string().optional(),
        delayHours: z.coerce.number().min(0).max(72).default(6),
      })
      .parse(req.body);

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
    const { ids } = await scope(req);
    const [recentReportsCount, openBacklog, trucks] = await Promise.all([
      prisma.complaint.count({ where: { ...where, createdAt: { gte: sevenDaysAgo } } }),
      // How far behind the crew is right now — the input that actually decides
      // where the ward starts on the fill chain.
      prisma.complaint.count({ where: { ...where, status: { notIn: ['RESOLVED', 'REJECTED'] } } }),
      prisma.vehicle.count({
        where: { ...(ids === null ? {} : { wardId: { in: ids } }), maintenanceFlag: false },
      }),
    ]);

    const averageReportsPerHour = Math.max(0.2, recentReportsCount / (7 * 24));
    const sim = simulateWardOverflow({
      delayHours: body.delayHours,
      averageReportsPerHour,
      openBacklog,
      trucks,
    });
    const estimatedSlaPenaltyRisk = sim.overflowProbabilityPercent > 50 ? 'HIGH' : sim.atRiskProbabilityPercent > 30 ? 'MEDIUM' : 'LOW';

    res.json({
      delayHours: body.delayHours,
      averageReportsPerHour: Number(averageReportsPerHour.toFixed(2)),
      openBacklog,
      trucks,
      projectedAdditionalReports: sim.projectedAdditionalReports,
      overflowProbabilityPercent: sim.overflowProbabilityPercent,
      atRiskProbabilityPercent: sim.atRiskProbabilityPercent,
      startingState: sim.startingState,
      estimatedSlaPenaltyRisk,
      simulation: { engine: 'poisson-markov-monte-carlo', runs: sim.runs, modelVersion: 'ward-whatif-forecaster-2.0.0' },
      immediateDispatchImpact: {
        slaComplianceEstimated: '96%',
        co2SavedKg: Number((body.delayHours * 1.8).toFixed(1)),
      },
      delayedDispatchImpact: {
        slaComplianceEstimated: `${Math.max(50, Math.round(100 - sim.overflowProbabilityPercent * 0.6))}%`,
        co2PenaltyKg: Number((body.delayHours * 3.2).toFixed(1)),
      },
    });
  })
);

/**
 * FEATURE 8: Emergencies & Escalations
 * GET /api/officer/emergencies
 */
router.get(
  '/emergencies',
  asyncHandler(async (req, res) => {
    const { where } = await scope(req);

    const [overdueComplaints, citizenEmergencies, driverSosAlerts] = await Promise.all([
      // SLA breaches
      prisma.complaint.findMany({
        where: {
          ...where,
          dueAt: { lt: new Date() },
          status: { notIn: ['RESOLVED', 'REJECTED'] },
        },
        include: { ward: true, citizen: { select: { id: true, name: true, phone: true } }, assignedVehicle: true },
        orderBy: { dueAt: 'asc' },
        take: 50,
      }),
      // Critical citizen emergency reports
      prisma.complaint.findMany({
        where: {
          ...where,
          isEmergency: true,
          status: { notIn: ['RESOLVED', 'REJECTED'] },
        },
        include: { ward: true, citizen: { select: { id: true, name: true, phone: true } }, assignedVehicle: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      // Active driver SOS alerts
      prisma.sosAlert.findMany({
        where: { status: { not: 'RESOLVED' } },
        include: {
          driver: { select: { id: true, name: true, phone: true } },
          vehicle: { select: { id: true, registrationNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    res.json({
      slaBreaches: overdueComplaints.map((c) => ({ ...serializeComplaint(c), sla: slaCountdown(c), type: 'SLA_BREACH' })),
      citizenEmergencies: citizenEmergencies.map((c) => ({ ...serializeComplaint(c), sla: slaCountdown(c), type: 'CITIZEN_EMERGENCY' })),
      driverSos: driverSosAlerts.map((s) => ({
        id: s.id,
        driver: s.driver,
        vehicle: s.vehicle,
        latitude: s.latitude,
        longitude: s.longitude,
        message: s.message,
        status: s.status,
        createdAt: s.createdAt,
        type: 'DRIVER_SOS',
      })),
    });
  })
);

/**
 * Close out an SOS.
 *
 * Acknowledging only says an officer has seen it. Without a way to close one,
 * every alert ever raised stayed on the panel with a disabled button, so a
 * breakdown sorted out an hour ago looked identical to one still stranded --
 * and the panel grew until it was useless.
 */
router.post(
  ['/sos/:id/resolve', '/emergencies/:id/resolve'],
  writeLimiter,
  audited('sos_resolve', 'sos_alerts'),
  asyncHandler(async (req, res) => {
    const sos = await prisma.sosAlert.findUnique({ where: { id: req.params.id } });
    if (!sos) throw new HttpError(404, 'SOS alert not found');

    const updated = await prisma.sosAlert.update({
      where: { id: sos.id },
      data: {
        status: 'RESOLVED',
        // An alert resolved without ever being acknowledged still had someone
        // deal with it; record them rather than leaving the responder blank.
        acknowledgedById: sos.acknowledgedById ?? req.user.id,
        acknowledgedAt: sos.acknowledgedAt ?? new Date(),
      },
    });

    await notify({
      userId: sos.driverId,
      type: 'SYSTEM',
      title: 'Your SOS has been closed',
      body: `${req.user.name} marked your alert as resolved.`,
      payload: { sosId: sos.id },
    });

    const vehicle = sos.vehicleId ? await prisma.vehicle.findUnique({ where: { id: sos.vehicleId } }) : null;
    emitTo([vehicle?.wardId ? `ward:${vehicle.wardId}` : null, 'city', `user:${sos.driverId}`], SOCKET_EVENTS.SOS_NEW, {
      id: sos.id,
      status: 'RESOLVED',
      driverId: sos.driverId,
    });

    res.json({ success: true, item: updated });
  })
);

router.post(
  ['/emergencies/:id/ack', '/sos/:id/acknowledge'],
  audited('emergency_acknowledge', 'emergencies'),
  asyncHandler(async (req, res) => {
    // Check if it's an SOS alert
    const sos = await prisma.sosAlert.findUnique({ where: { id: req.params.id } });
    if (sos) {
      const updated = await prisma.sosAlert.update({
        where: { id: sos.id },
        data: { status: 'ACKNOWLEDGED', acknowledgedById: req.user.id, acknowledgedAt: new Date() },
      });
      return res.json({ success: true, item: updated });
    }

    // Otherwise check complaint
    const complaint = await prisma.complaint.findUnique({ where: { id: req.params.id } });
    if (complaint) {
      const updated = await prisma.complaint.update({
        where: { id: complaint.id },
        data: { reviewNeeded: false },
      });
      return res.json({ success: true, item: serializeComplaint(updated) });
    }

    throw new HttpError(404, 'Emergency item not found');
  })
);

/**
 * FEATURE 9: Ward Analytics
 * GET /api/officer/analytics
 */
router.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const range = req.query.range === 'month' ? 30 : 7;

    const [trends, categories, wards, status, fuel] = await Promise.all([
      analytics.trends(ids, range),
      analytics.categoryBreakdown(ids, range),
      analytics.wardPerformance(ids),
      analytics.statusBreakdown(ids),
      analytics.fuelAndExpenditure(ids, range),
    ]);

    res.json({
      trends,
      categories,
      wards,
      status,
      fuel: {
        // Original keys kept so the existing Analytics page keeps working;
        // the richer breakdown rides alongside rather than replacing them.
        totalLiters: fuel.totals.litres,
        totalCost: fuel.totals.cost,
        entriesCount: fuel.totals.entries,
        recentLogs: fuel.recent.slice(0, 10),
        totals: fuel.totals,
        coverage: fuel.coverage,
        series: fuel.series,
        perVehicle: fuel.perVehicle,
        perWard: fuel.perWard,
      },
    });
  })
);

router.get(
  '/escalations',
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const rows = await prisma.escalation.findMany({
      where: ids === null ? {} : { complaint: { wardId: { in: ids } } },
      include: {
        complaint: { select: { id: true, code: true, category: true, status: true, wardId: true } },
        escalatedTo: { select: { name: true, role: true } },
      },
      orderBy: { escalatedAt: 'desc' },
      take: 100,
    });
    res.json(rows);
  })
);

router.post(
  '/complaints/:id/escalate',
  writeLimiter,
  audited('complaint_escalate', 'complaints'),
  asyncHandler(async (req, res) => {
    const complaint = await prisma.complaint.findUnique({ where: { id: req.params.id } });
    if (!complaint) throw new HttpError(404, 'Complaint not found');
    const reason = req.body?.reason?.slice(0, 300) || 'Escalated manually by officer';
    res.json(await escalate(complaint, Math.min(2, complaint.escalationCount + 1), reason));
  })
);

router.post(
  '/routes/optimize',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { vehicleId, complaintIds, wardId } = z
      .object({
        vehicleId: z.string(),
        complaintIds: z.array(z.string()).optional(),
        wardId: z.string().optional(),
      })
      .parse(req.body);

    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, include: { ward: true } });
    if (!vehicle) throw new HttpError(404, 'Vehicle not found');

    const complaints = await prisma.complaint.findMany({
      where: complaintIds?.length
        ? { id: { in: complaintIds } }
        : {
            wardId: wardId || vehicle.wardId,
            status: { in: ['VERIFIED', 'ASSIGNED'] },
            duplicateOfId: null,
          },
      orderBy: { createdAt: 'asc' },
      take: 40,
    });
    if (!complaints.length) throw new HttpError(400, 'No open complaints to route');

    const depot =
      vehicle.lastLat != null
        ? { coordinates: [vehicle.lastLng, vehicle.lastLat] }
        : { coordinates: [vehicle.ward?.centerLng ?? complaints[0].longitude, vehicle.ward?.centerLat ?? complaints[0].latitude] };

    const solved = await optimizeRoute({
      depot,
      stops: complaints.map((c) => ({
        complaintId: c.id,
        code: c.code,
        label: c.address || c.code,
        category: c.category,
        severity: c.severity,
        isEmergency: c.isEmergency,
        latitude: c.latitude,
        longitude: c.longitude,
        reportedAt: c.createdAt,
      })),
    });

    // breakpoints[i] = the index in `polyline` reached on arrival at solved.stops[i] —
    // lets the driver map slice off legs already covered instead of drawing the
    // whole route (or a straight line cutting through fields) once a stop is done.
    const { polyline, breakpoints } = await roadSnappedRoute(solved.polyline);
    const stops = solved.stops.map((s, i) => ({ ...s, polylineIndex: breakpoints[i] ?? null }));
    res.json({ ...solved, stops, polyline, vehicleId, complaintIds: complaints.map((c) => c.id) });
  })
);

router.post(
  '/routes/publish',
  writeLimiter,
  audited('route_publish', 'routes'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        vehicleId: z.string(),
        stops: z.array(z.any()).min(1),
        polyline: z.array(z.array(z.number())),
        distanceKm: z.number().optional(),
        baselineKm: z.number().optional(),
        savedKm: z.number().optional(),
        durationMin: z.number().optional(),
        fuelSaved: z.number().optional(),
        co2SavedKg: z.number().optional(),
        solver: z.string().optional(),
        solveMs: z.number().optional(),
        label: z.string().optional(),
      })
      .parse(req.body);

    const vehicle = await prisma.vehicle.findUnique({ where: { id: body.vehicleId }, include: { ward: true } });
    if (!vehicle) throw new HttpError(404, 'Vehicle not found');

    const route = await prisma.route.upsert({
      where: { vehicleId_date: { vehicleId: body.vehicleId, date: today() } },
      create: {
        vehicleId: body.vehicleId,
        driverId: vehicle.driverId,
        wardId: vehicle.wardId,
        date: today(),
        status: 'PUBLISHED',
        label: body.label || `${vehicle.registrationNumber} · ${today()}`,
        orderedStops: body.stops,
        polylineGeometry: body.polyline,
        distanceKm: body.distanceKm ?? 0,
        baselineKm: body.baselineKm ?? 0,
        savedKm: body.savedKm ?? 0,
        durationMin: body.durationMin ?? 0,
        fuelSaved: body.fuelSaved ?? 0,
        co2SavedKg: body.co2SavedKg ?? 0,
        solver: body.solver || 'safaai-node-2opt',
        solveMs: body.solveMs ?? 0,
      },
      update: {
        status: 'PUBLISHED',
        orderedStops: body.stops,
        polylineGeometry: body.polyline,
        distanceKm: body.distanceKm ?? 0,
        baselineKm: body.baselineKm ?? 0,
        savedKm: body.savedKm ?? 0,
        durationMin: body.durationMin ?? 0,
        fuelSaved: body.fuelSaved ?? 0,
        co2SavedKg: body.co2SavedKg ?? 0,
        driverId: vehicle.driverId,
      },
    });

    const complaintIds = body.stops.map((s) => s.complaintId).filter(Boolean);
    if (complaintIds.length) {
      await prisma.complaint.updateMany({
        where: { id: { in: complaintIds }, status: { in: ['PENDING', 'VERIFIED'] } },
        data: { assignedVehicleId: body.vehicleId, status: 'ASSIGNED', assignedAt: new Date(), assignedById: req.user.id },
      });
    }

    if (vehicle.driverId) {
      await notify({
        userId: vehicle.driverId,
        type: 'ASSIGNMENT',
        title: 'New route published',
        body: `${body.stops.length} stops · ${body.distanceKm ?? 0} km`,
        payload: { routeId: route.id },
      });
    }
    emitTo([vehicle.wardId ? `ward:${vehicle.wardId}` : null, `truck:${vehicle.id}`, 'city'], SOCKET_EVENTS.ASSIGNMENT_NEW, {
      routeId: route.id,
      vehicleId: vehicle.id,
      stops: body.stops.length,
    });

    res.status(201).json({ id: route.id, status: route.status, stops: body.stops.length, distanceKm: route.distanceKm });
  })
);

router.post(
  '/drivers',
  writeLimiter,
  audited('driver_create', 'users'),
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const body = z
      .object({
        name: z.string().min(2).max(80),
        email: z.string().email(),
        phone: z.string().min(8).max(15),
        password: z.string().min(8),
        wardId: z.string(),
      })
      .parse(req.body);

    if (ids !== null && !ids.includes(body.wardId)) {
      throw new HttpError(403, 'You can only create drivers for your own wards');
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: body.email.toLowerCase() }, { phone: body.phone }] }
    });
    if (existing) throw new HttpError(409, 'An account with that email or phone already exists');

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email.toLowerCase(),
        phone: body.phone,
        role: 'DRIVER',
        passwordHash: await hashPassword(body.password),
        wardId: body.wardId,
        emailVerifiedAt: null,
      },
    });

    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
  })
);

// ------------------------------------------------ Scheduled Pickup Management ----

/** GET /api/officer/scheduled-requests — List ward's scheduled pickup requests */
router.get(
  '/scheduled-requests',
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const wardWhere = ids === null ? {} : { wardId: { in: ids } };

    const items = await prisma.scheduledPickupRequest.findMany({
      where: { ...wardWhere },
      include: {
        citizen: { select: { id: true, name: true, phone: true, email: true } },
        ward: { select: { id: true, name: true, code: true } },
        assignedDriver: { select: { id: true, name: true, phone: true } },
        assignedVehicle: { select: { id: true, registrationNumber: true, model: true } },
      },
      orderBy: [{ scheduledDate: 'asc' }, { createdAt: 'desc' }],
    });

    res.json({ items });
  })
);

/** POST /api/officer/scheduled-requests/:id/approve — Approve advance scheduled pickup */
router.post(
  '/scheduled-requests/:id/approve',
  writeLimiter,
  audited('scheduled_pickup_approve', 'scheduled_pickup_requests'),
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const item = await prisma.scheduledPickupRequest.findFirst({
      where: {
        id: req.params.id,
        ...(ids === null ? {} : { wardId: { in: ids } }),
      },
      include: { citizen: true },
    });
    if (!item) throw new HttpError(404, 'Scheduled pickup request not found or not in your ward');

    const updated = await prisma.scheduledPickupRequest.update({
      where: { id: item.id },
      data: { status: 'APPROVED_SCHEDULED' },
    });

    // Notify citizen
    await notify({
      userId: item.citizenId,
      type: 'SYSTEM',
      title: `Scheduled Pickup Approved (${item.code})`,
      body: `Your pickup for "${item.eventReason}" on ${new Date(item.scheduledDate).toLocaleDateString('en-IN')} has been approved by the Ward Officer.`,
      payload: { requestId: item.id, code: item.code },
    });

    res.json({ ok: true, status: 'APPROVED_SCHEDULED', item: updated });
  })
);

/** POST /api/officer/scheduled-requests/:id/reject — Reject scheduled pickup with reason */
router.post(
  '/scheduled-requests/:id/reject',
  writeLimiter,
  audited('scheduled_pickup_reject', 'scheduled_pickup_requests'),
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const body = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);

    const item = await prisma.scheduledPickupRequest.findFirst({
      where: {
        id: req.params.id,
        ...(ids === null ? {} : { wardId: { in: ids } }),
      },
    });
    if (!item) throw new HttpError(404, 'Scheduled pickup request not found or not in your ward');

    const updated = await prisma.scheduledPickupRequest.update({
      where: { id: item.id },
      data: {
        status: 'REJECTED',
        rejectionReason: body.reason,
      },
    });

    // Notify citizen
    await notify({
      userId: item.citizenId,
      type: 'SYSTEM',
      title: `Scheduled Pickup Rejected (${item.code})`,
      body: `Your pickup for "${item.eventReason}" could not be accommodated: ${body.reason}`,
      payload: { requestId: item.id, code: item.code, reason: body.reason },
    });

    res.json({ ok: true, status: 'REJECTED', item: updated });
  })
);

/** POST /api/officer/scheduled-requests/:id/assign — Assign Driver & Vehicle */
router.post(
  '/scheduled-requests/:id/assign',
  writeLimiter,
  audited('scheduled_pickup_assign', 'scheduled_pickup_requests'),
  asyncHandler(async (req, res) => {
    const { ids } = await scope(req);
    const body = z
      .object({
        driverId: z.string(),
        vehicleId: z.string().optional(),
      })
      .parse(req.body);

    const item = await prisma.scheduledPickupRequest.findFirst({
      where: {
        id: req.params.id,
        ...(ids === null ? {} : { wardId: { in: ids } }),
      },
      include: { citizen: true },
    });
    if (!item) throw new HttpError(404, 'Scheduled pickup request not found or not in your ward');

    // Find driver & vehicle
    const driver = await prisma.user.findFirst({
      where: { id: body.driverId, role: 'DRIVER', isActive: true },
    });
    if (!driver) throw new HttpError(404, 'Driver account not found');

    const vehicle = body.vehicleId
      ? await prisma.vehicle.findUnique({ where: { id: body.vehicleId } })
      : await prisma.vehicle.findFirst({ where: { driverId: driver.id } });

    const updated = await prisma.scheduledPickupRequest.update({
      where: { id: item.id },
      data: {
        status: 'ASSIGNED',
        assignedDriverId: driver.id,
        assignedVehicleId: vehicle?.id ?? null,
        assignedById: req.user.id,
        assignedAt: new Date(),
      },
      include: {
        assignedDriver: { select: { id: true, name: true, phone: true } },
        assignedVehicle: { select: { id: true, registrationNumber: true, model: true } },
      },
    });

    // 1. Notify Citizen
    await notify({
      userId: item.citizenId,
      type: 'ASSIGNMENT',
      title: `Driver Assigned: ${item.code}`,
      body: `Driver ${driver.name} has been assigned for your pickup on ${new Date(item.scheduledDate).toLocaleDateString('en-IN')} (${item.scheduledTimeSlot}).`,
      payload: { requestId: item.id, code: item.code, driverName: driver.name },
    });

    // 2. Notify Driver (with scheduled date/time context)
    await notify({
      userId: driver.id,
      type: 'ASSIGNMENT',
      title: `New Scheduled Task (${item.code})`,
      body: `Scheduled pickup for ${item.citizen.name} on ${new Date(item.scheduledDate).toLocaleDateString('en-IN')} (${item.scheduledTimeSlot}) at ${item.address}.`,
      payload: {
        requestId: item.id,
        code: item.code,
        scheduledDate: item.scheduledDate,
        scheduledTimeSlot: item.scheduledTimeSlot,
        eventReason: item.eventReason,
        expectedCategories: item.expectedCategories,
      },
    });

    // Emit Socket.io event to driver room
    emitTo(`driver:${driver.id}`, 'new_task_assigned', {
      type: 'SCHEDULED_PICKUP',
      scheduledRequestId: item.id,
      code: item.code,
      scheduledDate: item.scheduledDate,
      scheduledTimeSlot: item.scheduledTimeSlot,
      eventReason: item.eventReason,
      address: item.address,
      latitude: item.latitude,
      longitude: item.longitude,
    });

    res.json({ ok: true, status: 'ASSIGNED', item: updated });
  })
);

export default router;
