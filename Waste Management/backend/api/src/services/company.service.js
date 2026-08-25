import { prisma } from '../lib/prisma.js';
import { roadKm } from '../lib/geo.js';
import { HttpError } from '../middleware/error.js';
import { emitTo } from '../sockets/realtime.js';
import { recordAudit } from '../middleware/audit.js';
import { notify } from './notification.service.js';
import { addEvent } from './complaint.service.js';
import { SOCKET_EVENTS, STREAM_MAP, QUANTITY_NOMINAL_KG } from '../config/constants.js';

/**
 * Handing a complaint to the firm that will actually process it.
 *
 * The corporation's own trucks lift waste; they do not dispose of it. Which
 * processor receives a load is a licensing question — a composting plant
 * cannot lawfully take clinical waste however close it is — so this is a
 * separate decision from which truck collects, made on a separate axis
 * (`WasteStream`), and recorded separately so the admin can answer "who sent
 * what where" months later.
 */

/** Kilograms this handoff represents, weighed if known, estimated if not. */
export function assignmentKg(assignment) {
  if (assignment?.actualQuantityKg != null) return assignment.actualQuantityKg;
  return QUANTITY_NOMINAL_KG[assignment?.estimatedQuantity] ?? QUANTITY_NOMINAL_KG.MEDIUM;
}

export function serializeCompany(company, extra = {}) {
  if (!company) return null;
  return {
    id: company.id,
    name: company.name,
    code: company.code,
    contactName: company.contactName ?? null,
    contactPhone: company.contactPhone,
    contactEmail: company.contactEmail ?? null,
    address: company.address ?? null,
    acceptedStreams: company.acceptedStreams ?? [],
    acceptedStreamLabels: (company.acceptedStreams ?? []).map((s) => STREAM_MAP[s]?.label ?? s),
    capacityKgPerDay: company.capacityKgPerDay,
    latitude: company.latitude ?? null,
    longitude: company.longitude ?? null,
    isCityWide: company.isCityWide,
    status: company.status,
    wardIds: company.wards?.map((w) => w.wardId) ?? [],
    wards: company.wards?.map((w) => (w.ward ? { id: w.ward.id, name: w.ward.name, code: w.ward.code } : null)).filter(Boolean) ?? [],
    createdAt: company.createdAt,
    ...extra,
  };
}

export function serializeAssignment(a, extra = {}) {
  if (!a) return null;
  return {
    id: a.id,
    complaintId: a.complaintId,
    complaint: a.complaint
      ? {
          id: a.complaint.id,
          code: a.complaint.code,
          category: a.complaint.category,
          severity: a.complaint.severity,
          address: a.complaint.address,
          status: a.complaint.status,
          wardId: a.complaint.wardId,
          ward: a.complaint.ward ? { id: a.complaint.ward.id, name: a.complaint.ward.name, code: a.complaint.ward.code } : null,
          createdAt: a.complaint.createdAt,
          dueAt: a.complaint.dueAt,
        }
      : null,
    companyId: a.companyId,
    company: a.company ? { id: a.company.id, name: a.company.name, code: a.company.code } : null,
    assignedById: a.assignedById,
    assignedBy: a.assignedBy ? { id: a.assignedBy.id, name: a.assignedBy.name } : null,
    status: a.status,
    wasteStream: a.wasteStream,
    wasteStreamLabel: STREAM_MAP[a.wasteStream]?.label ?? a.wasteStream,
    estimatedQuantity: a.estimatedQuantity,
    actualQuantityKg: a.actualQuantityKg ?? null,
    /** Weighed or estimated — the charts use this, and say which it was. */
    quantityKg: assignmentKg(a),
    quantityIsEstimate: a.actualQuantityKg == null,
    note: a.note ?? null,
    pickedAt: a.pickedAt,
    completedAt: a.completedAt,
    cancelledAt: a.cancelledAt,
    cancelReason: a.cancelReason ?? null,
    createdAt: a.createdAt,
    ...extra,
  };
}

/** Statuses that mean a handoff is still the live one for its complaint. */
export const LIVE_ASSIGNMENT_STATUSES = ['PENDING_PICKUP', 'PICKED'];

const companyInclude = { wards: { include: { ward: true } } };

const assignmentInclude = {
  company: true,
  assignedBy: { select: { id: true, name: true } },
  complaint: { include: { ward: true } },
};

/**
 * Which companies could take this complaint, best first.
 *
 * Licensing is a filter, not a ranking input: a company that does not accept
 * the stream is not a worse option, it is not an option, so it never appears
 * even when it is next door and empty. Everything that survives that filter is
 * then ordered by whether it serves the ward, how much of today's intake it
 * has left, and how far the load has to travel.
 *
 * Returns a plan and writes nothing, so the caller can show it to an officer
 * who is free to ignore it and pick another company.
 *
 * @param {string} complaintId
 * @param {string[]|null} wardIds  officer's wards, or null for city-wide scope
 */
export async function getSuggestedCompanies(complaintId, wardIds = null) {
  const complaint = await prisma.complaint.findUnique({
    where: { id: complaintId },
    include: { ward: true },
  });
  if (!complaint) throw new HttpError(404, 'Complaint not found');
  if (wardIds !== null && complaint.wardId && !wardIds.includes(complaint.wardId)) {
    throw new HttpError(403, 'This report is not in your ward');
  }

  /**
   * An unclassified complaint is not an error — it is the ordinary state of
   * anything filed before the stream existed, and of anything the classifier
   * could not call. Fall back to OTHER so the officer still gets the companies
   * that handle mixed loads rather than an empty list and no explanation.
   */
  const stream = complaint.wasteStream ?? 'OTHER';

  const companies = await prisma.company.findMany({
    where: {
      status: 'ACTIVE',
      acceptedStreams: { has: stream },
      ...(complaint.wardId
        ? { OR: [{ isCityWide: true }, { wards: { some: { wardId: complaint.wardId } } }] }
        : {}),
    },
    include: companyInclude,
  });

  if (!companies.length) {
    return {
      complaintId,
      wasteStream: stream,
      wasteStreamLabel: STREAM_MAP[stream]?.label ?? stream,
      wasteStreamConfidence: complaint.wasteStreamConfidence ?? 0,
      suggestions: [],
      reason: `No active company is licensed for ${STREAM_MAP[stream]?.label ?? stream} in this ward`,
    };
  }

  // Today's committed load per company, so a processor that has already been
  // sent its daily intake ranks below one that has room.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const todays = await prisma.complaintAssignment.findMany({
    where: {
      companyId: { in: companies.map((c) => c.id) },
      createdAt: { gte: startOfToday },
      status: { not: 'CANCELLED' },
    },
    select: { companyId: true, estimatedQuantity: true, actualQuantityKg: true },
  });

  const committed = new Map(companies.map((c) => [c.id, 0]));
  for (const row of todays) {
    committed.set(row.companyId, (committed.get(row.companyId) ?? 0) + assignmentKg(row));
  }

  const point = { latitude: complaint.latitude, longitude: complaint.longitude };

  const suggestions = companies
    .map((company) => {
      const usedKg = committed.get(company.id) ?? 0;
      const capacity = company.capacityKgPerDay || 0;
      // A company with no stated capacity is treated as unconstrained rather
      // than as full — an unset number is missing data, not a limit of zero.
      const headroomRatio = capacity > 0 ? Math.max(0, 1 - usedKg / capacity) : 1;
      const km =
        company.latitude != null && company.longitude != null
          ? Number(roadKm(point, { latitude: company.latitude, longitude: company.longitude }).toFixed(2))
          : null;

      return {
        company: serializeCompany(company),
        servesWard: company.isCityWide || company.wards.some((w) => w.wardId === complaint.wardId),
        committedKgToday: Math.round(usedKg),
        capacityKgPerDay: capacity,
        headroomRatio: Number(headroomRatio.toFixed(3)),
        atCapacity: capacity > 0 && usedKg >= capacity,
        km,
      };
    })
    .sort((a, b) => {
      // A company named for this ward before a city-wide one: the ward
      // contract is the arrangement that exists on paper.
      if (a.servesWard !== b.servesWard) return a.servesWard ? -1 : 1;
      // Then room to actually take it. Never a hard exclusion — a ward with a
      // single licensed hazardous handler must stay assignable when it is
      // full, with the pressure shown rather than the option removed.
      if (a.atCapacity !== b.atCapacity) return a.atCapacity ? 1 : -1;
      if (Math.abs(a.headroomRatio - b.headroomRatio) > 0.05) return b.headroomRatio - a.headroomRatio;
      if (a.km == null) return 1;
      if (b.km == null) return -1;
      return a.km - b.km;
    });

  return {
    complaintId,
    wasteStream: stream,
    wasteStreamLabel: STREAM_MAP[stream]?.label ?? stream,
    wasteStreamConfidence: complaint.wasteStreamConfidence ?? 0,
    wasteStreamInferred: complaint.wasteStream == null,
    suggestions,
    reason: null,
  };
}

/**
 * Hand one complaint to one company.
 *
 * Guarded against a second live handoff on the same complaint: two officers
 * looking at the same ticket would otherwise both assign it, and two
 * processors would arrive for one pile. The existing handoff has to be
 * cancelled explicitly before another can be made, which keeps the withdrawal
 * in the record instead of overwriting it.
 */
export async function assignComplaintToCompany({
  complaintId,
  companyId,
  officer,
  estimatedQuantity = 'MEDIUM',
  note,
  wardIds = null,
  req,
}) {
  const complaint = await prisma.complaint.findUnique({ where: { id: complaintId }, include: { ward: true } });
  if (!complaint) throw new HttpError(404, 'Complaint not found');
  if (wardIds !== null && complaint.wardId && !wardIds.includes(complaint.wardId)) {
    throw new HttpError(403, 'This report is not in your ward');
  }
  if (['RESOLVED', 'REJECTED'].includes(complaint.status)) {
    throw new HttpError(409, 'This report is already closed');
  }

  const company = await prisma.company.findUnique({ where: { id: companyId }, include: companyInclude });
  if (!company) throw new HttpError(404, 'Company not found');
  if (company.status !== 'ACTIVE') throw new HttpError(409, `${company.name} is not active`);

  const stream = complaint.wasteStream ?? 'OTHER';
  /**
   * The licence is checked here and not only in the UI.
   *
   * The suggestion list already filters on it, but an officer can override the
   * suggestion, and "override" must mean choosing a different licensed company
   * — never sending clinical waste to a composting plant because the request
   * was hand-made or the page was stale.
   */
  if (!company.acceptedStreams.includes(stream)) {
    throw new HttpError(
      422,
      `${company.name} is not licensed for ${STREAM_MAP[stream]?.label ?? stream}`
    );
  }

  const existing = await prisma.complaintAssignment.findFirst({
    where: { complaintId, status: { in: LIVE_ASSIGNMENT_STATUSES } },
    include: { company: true },
  });
  if (existing) {
    throw new HttpError(409, `Already handed to ${existing.company.name} — cancel that first`);
  }

  const assignment = await prisma.complaintAssignment.create({
    data: {
      complaintId,
      companyId,
      assignedById: officer.id,
      wasteStream: stream,
      estimatedQuantity,
      note: note || null,
    },
    include: assignmentInclude,
  });

  await addEvent(
    complaintId,
    complaint.status,
    `Handed to ${company.name} (${STREAM_MAP[stream]?.label ?? stream}) for processing`,
    officer.id
  );

  await recordAudit({
    actorId: officer.id,
    action: 'complaint_company_assign',
    targetTable: 'complaint_assignments',
    targetId: assignment.id,
    after: {
      complaintId,
      complaintCode: complaint.code,
      companyId,
      companyName: company.name,
      wasteStream: stream,
      estimatedQuantity,
    },
    req,
  });

  const payload = serializeAssignment(assignment);
  broadcastAssignment(SOCKET_EVENTS.COMPANY_ASSIGNMENT_CREATED, payload, complaint.wardId);

  // The officers who own the ward hear about it; the driver handsets do not,
  // because nothing about their route changed.
  await notifyWardOfficersOfAssignment(complaint, company, officer);

  return payload;
}

/** Move a handoff along its lifecycle. */
export async function updateAssignmentStatus({ assignmentId, status, actor, actualQuantityKg, cancelReason, wardIds = null, req }) {
  const before = await prisma.complaintAssignment.findUnique({
    where: { id: assignmentId },
    include: assignmentInclude,
  });
  if (!before) throw new HttpError(404, 'Assignment not found');
  if (wardIds !== null && before.complaint?.wardId && !wardIds.includes(before.complaint.wardId)) {
    throw new HttpError(403, 'This handoff is not in your ward');
  }
  if (before.status === status) return serializeAssignment(before);
  if (['COMPLETED', 'CANCELLED'].includes(before.status)) {
    throw new HttpError(409, `This handoff is already ${before.status.toLowerCase()}`);
  }

  const now = new Date();
  const assignment = await prisma.complaintAssignment.update({
    where: { id: assignmentId },
    data: {
      status,
      ...(status === 'PICKED' ? { pickedAt: now } : {}),
      ...(status === 'COMPLETED' ? { completedAt: now, pickedAt: before.pickedAt ?? now } : {}),
      ...(status === 'CANCELLED' ? { cancelledAt: now, cancelReason: cancelReason || null } : {}),
      ...(actualQuantityKg != null ? { actualQuantityKg } : {}),
    },
    include: assignmentInclude,
  });

  await recordAudit({
    actorId: actor.id,
    action: 'complaint_company_assignment_update',
    targetTable: 'complaint_assignments',
    targetId: assignment.id,
    before: { status: before.status },
    after: { status, actualQuantityKg: assignment.actualQuantityKg, cancelReason: assignment.cancelReason },
    req,
  });

  const payload = serializeAssignment(assignment);
  broadcastAssignment(SOCKET_EVENTS.COMPANY_ASSIGNMENT_UPDATE, payload, assignment.complaint?.wardId);
  return payload;
}

/**
 * Push a handoff at the rooms that care.
 *
 * The admin console watches the city room so its Assignment Overview updates
 * without a poll; the ward room carries it to the officers who own the report.
 */
function broadcastAssignment(event, payload, wardId) {
  emitTo([wardId ? `ward:${wardId}` : null, 'city', `complaint:${payload.complaintId}`], event, payload);
}

async function notifyWardOfficersOfAssignment(complaint, company, actingOfficer) {
  if (!complaint.wardId) return;
  try {
    const officers = await prisma.wardOfficer.findMany({
      where: { wardId: complaint.wardId },
      select: { officerId: true },
    });
    await Promise.all(
      officers
        // The officer who pressed the button already knows.
        .filter((o) => o.officerId !== actingOfficer.id)
        .map((o) =>
          notify({
            userId: o.officerId,
            type: 'ASSIGNMENT',
            title: `${complaint.code} sent to ${company.name}`,
            body: `${actingOfficer.name} handed it over for processing.`,
            payload: { complaintId: complaint.id, companyId: company.id },
          })
        )
    );
  } catch (err) {
    // The handoff is written and broadcast; a notification fan-out that fails
    // must not roll that back or 500 the officer who made it.
    console.error('[company] officer notification fan-out failed:', err.message);
  }
}

export default {
  getSuggestedCompanies,
  assignComplaintToCompany,
  updateAssignmentStatus,
  serializeCompany,
  serializeAssignment,
  assignmentKg,
  LIVE_ASSIGNMENT_STATUSES,
};
