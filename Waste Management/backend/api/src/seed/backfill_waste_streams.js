/**
 * Bring an existing database up to the waste-stream feature — without wiping it.
 *
 * `npm run seed` drops and recreates everything, which is right for a laptop
 * and catastrophic for the deployed demo: it would delete the citizens, the
 * reports and the audit trail that the live site is showing. This does the
 * three things a running database actually needs and nothing else:
 *
 *   1. registers the processing companies, keyed on their code so a second
 *      run updates rather than duplicates;
 *   2. fills in `wasteStream` for reports filed before the column existed,
 *      using the same derivation the live classifier uses;
 *   3. optionally routes a handful of already-resolved reports so the admin
 *      volume charts are not empty on the first visit.
 *
 * Every step is idempotent and additive. Nothing is deleted, and re-running it
 * is safe.
 *
 *   node src/seed/backfill_waste_streams.js            # companies + streams
 *   node src/seed/backfill_waste_streams.js --handoffs # also seed sample handoffs
 */
import { prisma } from '../lib/prisma.js';
import { deriveWasteStream, QUANTITY_NOMINAL_KG } from '../config/constants.js';

const WITH_HANDOFFS = process.argv.includes('--handoffs');

/** Same registry the full seed installs, minus anything laptop-specific. */
const COMPANIES = [
  {
    code: 'GRN-BIO-01',
    name: 'Gandhinagar Green Compost',
    contactName: 'Rakesh Patel',
    contactPhone: '9825011001',
    contactEmail: 'ops@grncompost.example',
    address: 'Plot 14, Sector 28 Industrial Estate',
    acceptedStreams: ['BIO'],
    capacityKgPerDay: 4000,
    isCityWide: true,
  },
  {
    code: 'SBH-DRY-02',
    name: 'Sabarmati Dry Recovery',
    contactName: 'Nita Shah',
    contactPhone: '9825011002',
    contactEmail: 'dispatch@sabarmatidry.example',
    address: 'Survey 88, Kudasan Link Road',
    acceptedStreams: ['NON_BIO', 'E_WASTE'],
    capacityKgPerDay: 6000,
    isCityWide: true,
  },
  {
    code: 'CTY-MIX-03',
    name: 'Civic Mixed Handling',
    contactName: 'Imran Qureshi',
    contactPhone: '9825011003',
    address: 'Transfer Station, Sector 30',
    acceptedStreams: ['BIO', 'NON_BIO', 'OTHER'],
    capacityKgPerDay: 9000,
    isCityWide: true,
  },
  {
    code: 'HAZ-MED-04',
    name: 'Saurashtra Biomedical Disposal',
    contactName: 'Dr. Anand Rao',
    contactPhone: '9825011004',
    contactEmail: 'control@saurashtrabmd.example',
    address: 'Licensed Facility, Chhatral GIDC',
    acceptedStreams: ['HAZARDOUS'],
    capacityKgPerDay: 900,
    isCityWide: true,
  },
  {
    code: 'EWS-TEC-05',
    name: 'Tec-Recycle E-Waste',
    contactName: 'Freny Mistry',
    contactPhone: '9825011005',
    address: 'Unit 7, Infocity Road',
    acceptedStreams: ['E_WASTE'],
    capacityKgPerDay: 1200,
    isCityWide: true,
  },
];

async function upsertCompanies() {
  let created = 0;
  let updated = 0;
  for (const c of COMPANIES) {
    const existing = await prisma.company.findUnique({ where: { code: c.code } });
    await prisma.company.upsert({
      where: { code: c.code },
      // Coverage rows are left alone on update: an operator may have narrowed a
      // company to specific wards by hand, and a backfill must not undo that.
      create: { ...c, contactEmail: c.contactEmail ?? null },
      update: {
        name: c.name,
        contactName: c.contactName ?? null,
        contactPhone: c.contactPhone,
        contactEmail: c.contactEmail ?? null,
        address: c.address ?? null,
        acceptedStreams: c.acceptedStreams,
        capacityKgPerDay: c.capacityKgPerDay,
      },
    });
    existing ? (updated += 1) : (created += 1);
  }
  console.log(`[backfill] companies: ${created} created, ${updated} updated`);
}

async function backfillStreams() {
  const pending = await prisma.complaint.findMany({
    where: { wasteStream: null },
    select: { id: true, category: true, aiConfidence: true },
  });
  if (!pending.length) {
    console.log('[backfill] every report already has a stream');
    return;
  }

  /**
   * Grouped into one update per (stream, confidence) pair rather than one per
   * report: a live database can hold tens of thousands of complaints, and a
   * round trip each would take the API's connection pool down with it.
   */
  const buckets = new Map();
  for (const c of pending) {
    const d = deriveWasteStream(c.category, c.aiConfidence ?? 0);
    const key = `${d.stream}|${d.confidence}`;
    const b = buckets.get(key) ?? { stream: d.stream, confidence: d.confidence, ids: [] };
    b.ids.push(c.id);
    buckets.set(key, b);
  }

  let done = 0;
  for (const b of buckets.values()) {
    // Guarded on wasteStream still being null so a concurrent officer override
    // during the backfill is never overwritten.
    const r = await prisma.complaint.updateMany({
      where: { id: { in: b.ids }, wasteStream: null },
      data: { wasteStream: b.stream, wasteStreamConfidence: b.confidence },
    });
    done += r.count;
  }
  console.log(`[backfill] waste streams filled on ${done} report${done === 1 ? '' : 's'} (${buckets.size} groups)`);
}

async function sampleHandoffs() {
  const officers = await prisma.user.findMany({
    where: { role: 'OFFICER', isActive: true },
    select: { id: true, officerWards: { select: { wardId: true } } },
  });
  const officerByWard = new Map();
  for (const o of officers) for (const w of o.officerWards) if (!officerByWard.has(w.wardId)) officerByWard.set(w.wardId, o.id);
  if (!officerByWard.size) {
    console.log('[backfill] no ward officers — skipping sample handoffs');
    return;
  }

  const companies = await prisma.company.findMany({ where: { status: 'ACTIVE' } });

  // Resolved reports only: routing open work would silently take it off the
  // officers' categorization queue, which is not this script's business.
  const candidates = await prisma.complaint.findMany({
    where: {
      status: 'RESOLVED',
      wasteStream: { not: null },
      companyAssignments: { none: {} },
    },
    select: { id: true, wardId: true, wasteStream: true, resolvedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 400,
  });

  /**
   * The daily cap counts handoffs that are already there.
   *
   * Seeding it empty made the script only *look* idempotent: no report ever
   * got a second handoff, but each run topped every day back up to the cap
   * using reports the previous run had passed over, so running it twice added
   * another forty-five rows. Counting what exists first makes a second run a
   * genuine no-op.
   */
  const perDay = new Map();
  for (const a of await prisma.complaintAssignment.findMany({ select: { createdAt: true } })) {
    const day = a.createdAt.toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  let made = 0;
  for (const c of candidates) {
    const officerId = officerByWard.get(c.wardId);
    if (!officerId) continue;
    const eligible = companies.filter((co) => co.acceptedStreams.includes(c.wasteStream));
    if (!eligible.length) continue;

    const at = c.resolvedAt ?? c.createdAt;
    const day = at.toISOString().slice(0, 10);
    const onDay = perDay.get(day) ?? 0;
    if (onDay >= 8) continue;
    perDay.set(day, onDay + 1);

    const company = eligible[made % eligible.length];
    const band = ['SMALL', 'MEDIUM', 'MEDIUM', 'LARGE'][made % 4];
    await prisma.complaintAssignment.create({
      data: {
        complaintId: c.id,
        companyId: company.id,
        assignedById: officerId,
        status: 'COMPLETED',
        wasteStream: c.wasteStream,
        estimatedQuantity: band,
        actualQuantityKg: Number((QUANTITY_NOMINAL_KG[band] * (0.8 + ((made % 7) / 10))).toFixed(1)),
        pickedAt: at,
        completedAt: at,
        createdAt: at,
        updatedAt: at,
      },
    });
    made += 1;
  }
  console.log(`[backfill] ${made} sample handoffs across ${perDay.size} days`);
}

async function main() {
  console.log('[backfill] starting — nothing will be deleted');
  await upsertCompanies();
  await backfillStreams();
  if (WITH_HANDOFFS) await sampleHandoffs();
  else console.log('[backfill] sample handoffs skipped (pass --handoffs to include them)');

  const [companies, streamed, unstreamed, handoffs] = await Promise.all([
    prisma.company.count(),
    prisma.complaint.count({ where: { wasteStream: { not: null } } }),
    prisma.complaint.count({ where: { wasteStream: null } }),
    prisma.complaintAssignment.count(),
  ]);
  console.log(
    `\n[backfill] done — ${companies} companies, ${streamed} reports streamed ` +
      `(${unstreamed} still unclassified), ${handoffs} handoffs on record`
  );
}

main()
  .catch((err) => {
    console.error('[backfill] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
