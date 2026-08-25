import { prisma } from '../lib/prisma.js';
import { deriveWasteStream } from '../config/constants.js';

/**
 * Make the waste-stream feature usable the moment it is deployed.
 *
 * Adding `wasteStream` to `complaints` gives every report that already existed
 * a null — the column is new, nothing has ever written to it. On a fresh
 * laptop the seed fills it in, but a running deployment is not reseeded, so
 * the first thing an officer saw after the release was a page where every row
 * read "Not classified" and every confidence bar was empty. That is not a
 * classifier failing; it is a column nobody has populated yet.
 *
 * Requiring an operator to remember a one-off script for that is a bad trade:
 * the work is derived, cheap and has exactly one correct answer, so the server
 * does it itself on boot.
 *
 * Both steps are guarded so a second boot is a no-op, and neither ever deletes
 * or overwrites anything a human decided.
 */

/** Seeded only when the registry is completely empty — see ensureCompanies. */
const BOOTSTRAP_COMPANIES = [
  { code: 'GRN-BIO-01', name: 'Gandhinagar Green Compost', contactName: 'Rakesh Patel', contactPhone: '9825011001', contactEmail: 'ops@grncompost.example', address: 'Plot 14, Sector 28 Industrial Estate', acceptedStreams: ['BIO'], capacityKgPerDay: 4000, isCityWide: true },
  { code: 'SBH-DRY-02', name: 'Sabarmati Dry Recovery', contactName: 'Nita Shah', contactPhone: '9825011002', contactEmail: 'dispatch@sabarmatidry.example', address: 'Survey 88, Kudasan Link Road', acceptedStreams: ['NON_BIO', 'E_WASTE'], capacityKgPerDay: 6000, isCityWide: true },
  { code: 'CTY-MIX-03', name: 'Civic Mixed Handling', contactName: 'Imran Qureshi', contactPhone: '9825011003', address: 'Transfer Station, Sector 30', acceptedStreams: ['BIO', 'NON_BIO', 'OTHER'], capacityKgPerDay: 9000, isCityWide: true },
  { code: 'HAZ-MED-04', name: 'Saurashtra Biomedical Disposal', contactName: 'Dr. Anand Rao', contactPhone: '9825011004', contactEmail: 'control@saurashtrabmd.example', address: 'Licensed Facility, Chhatral GIDC', acceptedStreams: ['HAZARDOUS'], capacityKgPerDay: 900, isCityWide: true },
  { code: 'EWS-TEC-05', name: 'Tec-Recycle E-Waste', contactName: 'Freny Mistry', contactPhone: '9825011005', address: 'Unit 7, Infocity Road', acceptedStreams: ['E_WASTE'], capacityKgPerDay: 1200, isCityWide: true },
  { code: 'OLD-BIO-06', name: 'Northside Organics (contract ended)', contactPhone: '9825011006', acceptedStreams: ['BIO'], capacityKgPerDay: 2000, isCityWide: true, status: 'INACTIVE' },
];

/**
 * Fill `wasteStream` on reports that have never had one.
 *
 * Only ever writes where the column is null, so an officer's correction and a
 * classifier's own answer are both left alone. Batched into one update per
 * distinct (stream, confidence) pair rather than one per report — a live
 * database can hold tens of thousands of complaints and a round trip each
 * would hold the connection pool open through the whole of startup.
 */
export async function ensureWasteStreams({ batchSize = 5000 } = {}) {
  const pending = await prisma.complaint.findMany({
    where: { wasteStream: null },
    select: { id: true, category: true, aiConfidence: true },
    take: batchSize,
  });
  if (!pending.length) return { filled: 0 };

  const buckets = new Map();
  for (const c of pending) {
    const d = deriveWasteStream(c.category, c.aiConfidence ?? 0);
    const key = `${d.stream}|${d.confidence}`;
    const b = buckets.get(key) ?? { stream: d.stream, confidence: d.confidence, ids: [] };
    b.ids.push(c.id);
    buckets.set(key, b);
  }

  let filled = 0;
  for (const b of buckets.values()) {
    const r = await prisma.complaint.updateMany({
      where: { id: { in: b.ids }, wasteStream: null },
      data: { wasteStream: b.stream, wasteStreamConfidence: b.confidence },
    });
    filled += r.count;
  }
  return { filled, remaining: pending.length === batchSize };
}

/**
 * Install the processing companies, but only into an empty registry.
 *
 * Gated on the table being genuinely empty rather than upserting by code: an
 * admin who retires a company must not find it back after the next restart.
 * Empty means the feature cannot function at all — no report can be handed to
 * anyone — so seeding there is the difference between a working console and a
 * dead button, whereas seeding into a curated registry would be vandalism.
 */
export async function ensureCompanies() {
  const existing = await prisma.company.count();
  if (existing > 0) return { created: 0, skipped: true };

  for (const c of BOOTSTRAP_COMPANIES) {
    await prisma.company.create({ data: { ...c, contactEmail: c.contactEmail ?? null } });
  }
  return { created: BOOTSTRAP_COMPANIES.length, skipped: false };
}

/**
 * Called once from bootstrap. Never throws: the API must still come up if this
 * cannot run — a server that refuses to start because a backfill failed is a
 * worse outage than the blank column it was trying to fix.
 */
export async function bootstrapWasteStreams() {
  try {
    const companies = await ensureCompanies();
    if (companies.created) console.log(`[waste-stream] registry was empty — installed ${companies.created} processing companies`);

    const streams = await ensureWasteStreams();
    if (streams.filled) {
      console.log(
        `[waste-stream] classified ${streams.filled} report${streams.filled === 1 ? '' : 's'} that predate the column` +
          (streams.remaining ? ' (more remain — they fill in on the next restart)' : '')
      );
    }
  } catch (err) {
    console.error('[waste-stream] bootstrap skipped:', err.message);
  }
}

export default { bootstrapWasteStreams, ensureWasteStreams, ensureCompanies };
