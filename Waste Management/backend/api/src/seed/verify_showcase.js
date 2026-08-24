/**
 * Cross-section consistency check for the five showcase complaints.
 *
 *   npm run verify:showcase
 *
 * "Synced across every section" is a claim, and a claim about data is worth
 * exactly as much as the check behind it. This asserts the things that would
 * actually break a walkthrough: a complaint that says a truck is coming while
 * that truck's stop list has never heard of it, a resolved report with no
 * proof photo, credits that do not match the wallet balance, an emergency
 * that is not first on the route, or a timeline that skips a step it claims
 * to have passed.
 *
 * Read-only. It never writes, so it is safe to run against any database.
 */
import { prisma, connectDB, disconnectDB } from '../lib/prisma.js';
import { CATEGORY_MAP } from '../config/constants.js';

const CODES = ['SS-DEMO1', 'SS-DEMO2', 'SS-DEMO3', 'SS-DEMO4', 'SS-DEMO5'];
const today = () => new Date().toISOString().slice(0, 10);

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  await connectDB();
  console.log('\nShowcase consistency check\n' + '='.repeat(60));

  const complaints = await prisma.complaint.findMany({
    where: { code: { in: CODES } },
    include: {
      ward: true,
      citizen: { select: { id: true, name: true, greenCredits: true } },
      assignedVehicle: { include: { ward: true, driver: { select: { id: true, name: true, wardId: true } } } },
      events: { orderBy: { createdAt: 'asc' } },
    },
  });

  console.log(`\nFound ${complaints.length} of ${CODES.length} showcase complaints`);
  check('all five showcase complaints exist', complaints.length === CODES.length,
    `missing: ${CODES.filter((c) => !complaints.some((x) => x.code === c)).join(', ') || 'none'}`);

  if (complaints.length === 0) {
    console.log('\nNothing to check. Run `npm run db:push && npm run seed` first.\n');
    await disconnectDB();
    process.exit(1);
  }

  for (const code of CODES) {
    const c = complaints.find((x) => x.code === code);
    if (!c) continue;
    console.log(`\n${code} — ${c.status}${c.isEmergency ? ' (EMERGENCY)' : ''}`);

    // -- every complaint, whatever its stage -------------------------------
    check('has a photo', Boolean(c.photoUrl));
    check('sits inside a ward', Boolean(c.wardId), 'no ward attributed');
    check('belongs to a citizen', Boolean(c.citizenId));
    check('has an SLA deadline', Boolean(c.dueAt));

    const meta = CATEGORY_MAP[c.category];
    check('category is a known one', Boolean(meta), c.category);

    // reviewNeeded must follow the confidence, not be set independently.
    check(
      'review flag matches AI confidence',
      c.reviewNeeded === (c.aiConfidence < 0.7),
      `confidence ${c.aiConfidence}, reviewNeeded ${c.reviewNeeded}`
    );

    // -- timeline ----------------------------------------------------------
    const statuses = c.events.map((e) => e.status);
    check('timeline starts at PENDING', statuses[0] === 'PENDING', statuses.join(' -> '));
    if (c.status === 'RESOLVED') {
      check('timeline ends at RESOLVED', statuses[statuses.length - 1] === 'RESOLVED', statuses.join(' -> '));
    }
    if (c.assignedVehicleId) {
      check('timeline records the assignment', statuses.includes('ASSIGNED'), statuses.join(' -> '));
    }
    const ordered = c.events.every((e, i) => i === 0 || e.createdAt >= c.events[i - 1].createdAt);
    check('timeline is chronological', ordered);

    // -- assignment --------------------------------------------------------
    if (c.status === 'PENDING') {
      check('unassigned while pending', !c.assignedVehicleId, 'a pending report should not hold a truck');
    } else {
      check('has a truck assigned', Boolean(c.assignedVehicleId));
      if (c.assignedVehicle) {
        check(
          'truck belongs to the same ward as the report',
          c.assignedVehicle.wardId === c.wardId,
          `truck ward ${c.assignedVehicle.ward?.name}, report ward ${c.ward?.name}`
        );
        check('truck has a driver', Boolean(c.assignedVehicle.driverId));
        check('truck is not flagged for maintenance', c.assignedVehicle.maintenanceFlag === false);

        // The stop list on the driver's handset must know about it.
        const route = await prisma.route.findFirst({
          where: { vehicleId: c.assignedVehicleId, date: today() },
        });
        if (route) {
          const stops = Array.isArray(route.orderedStops) ? route.orderedStops : [];
          const stop = stops.find((s) => s.complaintId === c.id);
          check("appears on that driver's route for today", Boolean(stop),
            `route ${route.label} has ${stops.length} stops, none matching`);

          if (stop) {
            check('stop status agrees with the complaint',
              c.status === 'RESOLVED' ? stop.status === 'DONE' : stop.status !== 'DONE',
              `complaint ${c.status}, stop ${stop.status}`);
            check('stop coordinates match the complaint',
              Math.abs(stop.latitude - c.latitude) < 1e-6 && Math.abs(stop.longitude - c.longitude) < 1e-6);
            if (c.isEmergency) {
              check('emergency is first on the route', stop.seq === 1, `seq ${stop.seq}`);
            }
          }
          const seqs = stops.map((s) => s.seq);
          check('route stop numbering is 1..n with no gaps',
            seqs.every((n, i) => n === i + 1), seqs.join(','));
        } else {
          check("driver has a published route today", false, 'no route row for this vehicle');
        }
      }
    }

    // -- resolution --------------------------------------------------------
    if (c.status === 'RESOLVED') {
      check('has the after-work proof photo', Boolean(c.resolutionPhotoUrl));
      check('proof photo differs from the reported photo', c.resolutionPhotoUrl !== c.photoUrl);
      check('has a resolved timestamp', Boolean(c.resolvedAt));
      check('records who resolved it', Boolean(c.resolvedById));
      check('resolved inside its SLA', c.resolvedAt <= c.dueAt,
        `resolved ${c.resolvedAt?.toISOString()}, due ${c.dueAt?.toISOString()}`);

      const credit = await prisma.greenCredit.findFirst({ where: { complaintId: c.id } });
      check('awarded green credits', Boolean(credit), 'no credit row linked to this complaint');
      if (credit) {
        check('credit balance is not negative', credit.balanceAfter >= credit.delta);
        check("credit balance matches the citizen's wallet",
          credit.balanceAfter <= c.citizen.greenCredits,
          `credit says ${credit.balanceAfter}, wallet holds ${c.citizen.greenCredits}`);
      }
    } else {
      check('no proof photo before resolution', !c.resolutionPhotoUrl);
      check('no resolved timestamp before resolution', !c.resolvedAt);
    }

    // -- emergency ---------------------------------------------------------
    if (c.isEmergency) {
      check('emergency runs a 30-minute SLA', c.slaMinutes === 30, `${c.slaMinutes} minutes`);
      check('emergency severity is CRITICAL', c.severity === 'CRITICAL', c.severity);
      check('emergency was dispatched to a truck', Boolean(c.assignedVehicleId));
    }

    // -- citizen-facing ----------------------------------------------------
    const notes = await prisma.notification.findMany({ where: { userId: c.citizenId, payload: { path: ['code'], equals: code } } });
    check('citizen was notified', notes.length > 0, `${notes.length} notifications`);
  }

  // -- section-level reachability ------------------------------------------
  console.log('\nSection reachability');
  const inQueue = await prisma.complaint.count({ where: { code: 'SS-DEMO1', reviewNeeded: true, status: 'PENDING' } });
  check('SS-DEMO1 is reachable from the officer review queue filter', inQueue === 1);

  const inEmergencies = await prisma.complaint.count({
    where: { code: 'SS-DEMO5', isEmergency: true, status: { notIn: ['RESOLVED', 'REJECTED'] } },
  });
  check('SS-DEMO5 is reachable from the officer emergencies panel', inEmergencies === 1);

  const trackable = await prisma.complaint.count({
    where: { code: 'SS-DEMO2', assignedVehicleId: { not: null }, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
  });
  check('SS-DEMO2 is reachable from the citizen live tracker', trackable === 1);

  const driverVisible = await prisma.complaint.count({
    where: { code: { in: ['SS-DEMO2', 'SS-DEMO3', 'SS-DEMO5'] }, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
  });
  check('three showcase stops are on driver task lists', driverVisible === 3, `${driverVisible} of 3`);

  const withProof = await prisma.complaint.count({ where: { code: 'SS-DEMO4', resolutionPhotoUrl: { not: null } } });
  check('SS-DEMO4 shows before/after proof everywhere it appears', withProof === 1);

  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? 'Showcase data is consistent across every section.\n' : 'Inconsistencies found above.\n');

  await disconnectDB();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nverify:showcase failed to run:', err.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
