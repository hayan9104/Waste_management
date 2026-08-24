/**
 * Demo dataset for Safaai Sarathi.
 *
 * Deterministic: same city, same accounts, same 45-day history every run, so a
 * demo is repeatable and the hotspot model has genuine weekday seasonality to
 * forecast from.
 *
 *   npm run db:push && npm run seed
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma, connectDB, disconnectDB } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { polygonBBox } from '../lib/geo.js';
import { CITY, WARDS, wardGeometry, pointInWard, STREETS } from './city.js';
import { WASTE_CATEGORIES, CATEGORY_MAP, CREDIT_RULES, ROLES } from '../config/constants.js';
import { solveLocal, roadSnappedRoute, snapToRoad } from '../services/routing.service.js';
import { persist } from '../middleware/upload.js';

const PASSWORD = 'safaai@2026';
const HISTORY_DAYS = 45;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Real, verified-relevant photos (checked by hand — Unsplash photo IDs are
 * otherwise a coin flip on actual subject matter), downloaded once into the
 * repo rather than hotlinked. A demo dataset that depends on Unsplash's CDN
 * being reachable from every viewer's browser is fragile in a way the real
 * citizen /report flow never is; persisting these through the same storage
 * driver a real upload uses (Supabase in production, local disk otherwise)
 * removes that dependency entirely.
 */
const MOCK_PHOTO_FILES = [
  'mock-05-baled-plastic.jpg',
  'mock-06-dump-site.jpg',
  'mock-07-dumpster-signage.jpg',
  'mock-08-overflow-bin.jpg',
];

/** Uploads each bundled mock photo once through the real storage driver and returns the hosted URLs. */
export async function buildPhotoPool() {
  const pool = [];
  for (const file of MOCK_PHOTO_FILES) {
    const buffer = fs.readFileSync(path.join(__dirname, 'assets', file));
    pool.push(await persist(buffer, 'image/jpeg', 'mock'));
  }
  return pool;
}

/**
 * Real, verified-relevant free stock photos (checked by hand -- Unsplash
 * photo IDs are otherwise a coin flip on actual subject matter). Every
 * seeded complaint gets one; without this the entire demo dataset showed a
 * blank photo slot, which is not what the real citizen /report flow ever
 * produces (a photo is mandatory there).
 */
const CITIZEN_PHOTO_POOL = [
  'https://images.unsplash.com/photo-1584744982491-665216d95f8b?w=800', // hand sanitizer + mask
  'https://images.unsplash.com/photo-1532996122724-e3c354a0b15b?w=800', // colour-coded wheelie bins
  'https://images.unsplash.com/photo-1611284446314-60a58ac0deb9?w=800', // labelled compost/waste/recycle bins
  'https://images.unsplash.com/photo-1573497491765-dccce02b29df?w=800', // plastic pollution in water
  'https://images.unsplash.com/photo-1721622248541-001da7c67fbe?w=800', // baled plastic waste
  'https://images.unsplash.com/photo-1662534264036-7bfa0d35de9c?w=800', // litter-strewn dump site
];

/** Deterministic PRNG so every run produces the identical city. */
function rng(seed) {
  let a = 0;
  for (let i = 0; i < String(seed).length; i += 1) a = (a * 31 + String(seed).charCodeAt(i)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const intBetween = (r, min, max) => Math.floor(min + r() * (max - min + 1));
const round6 = (n) => Number(n.toFixed(6));

/**
 * Real streets, not open fields. Per ward, road-snap a small set of
 * candidate points once via OSRM and cache the results — cheap and fast
 * (~20 requests per ward), unlike snapping every one of the ~1,500 seeded
 * complaints individually. Falls back to the unsnapped jittered points for
 * any ward where OSRM is unreachable, so a seed run never hard-fails on a
 * flaky public demo server.
 */
async function buildWardAnchors(wards) {
  const anchors = [];
  for (const { index } of wards) {
    const candidates = Array.from({ length: 24 }, (_, n) => pointInWard(index, n * 5));
    const snapped = [];
    for (let i = 0; i < candidates.length; i += 6) {
      const batch = candidates.slice(i, i + 6);
      const results = await Promise.all(batch.map((p) => snapToRoad(p.latitude, p.longitude)));
      for (const res of results) {
        if (res && res.distanceMeters <= 250) snapped.push({ latitude: res.latitude, longitude: res.longitude });
      }
    }
    anchors[index] = snapped.length ? snapped : candidates;
  }
  console.log(`[seed] road-snapped anchors ready for ${wards.length} wards`);
  return anchors;
}

/** A point near a real road in this ward, with a small offset so repeated picks don't overlap exactly. */
function pointNear(anchors, index, n) {
  const list = anchors[index];
  const base = list[n % list.length];
  return {
    latitude: round6(base.latitude + jitterSmall(index * 97 + n, 0.0003)),
    longitude: round6(base.longitude + jitterSmall(index * 53 + n * 3, 0.0003)),
  };
}
function jitterSmall(seed, scale) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * scale;
}

const FIRST_NAMES = ['Priya', 'Rohit', 'Anjali', 'Mehul', 'Kiran', 'Nisha', 'Jignesh', 'Bhavna', 'Harsh', 'Devika', 'Ramesh', 'Falguni'];
const LAST_NAMES = ['Patel', 'Shah', 'Desai', 'Mehta', 'Chauhan', 'Trivedi', 'Solanki', 'Parmar', 'Joshi', 'Vasava'];

async function wipe() {
  // Order matters: children before parents.
  await prisma.scheduledPickupRequest.deleteMany();
  await prisma.greenCredit.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.escalation.deleteMany();
  await prisma.complaintDuplicate.deleteMany();
  await prisma.complaintEvent.deleteMany();
  await prisma.complaint.deleteMany();
  await prisma.vehicleLocation.deleteMany();
  await prisma.driverShift.deleteMany();
  await prisma.fuelLog.deleteMany();
  await prisma.route.deleteMany();
  await prisma.sosAlert.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.hotspotPrediction.deleteMany();
  await prisma.emergencyContact.deleteMany();
  await prisma.wardOfficer.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.emailToken.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.oAuthIdentity.deleteMany();
  await prisma.modelHealthSample.deleteMany();
  await prisma.user.deleteMany();
  await prisma.ward.deleteMany();
  console.log('[seed] cleared existing data');
}

async function main() {
  await connectDB();
  await wipe();

  const CITIZEN_PHOTO_POOL = await buildPhotoPool();
  console.log(`[seed] mock photo pool hosted: ${CITIZEN_PHOTO_POOL.length} images`);

  const passwordHash = await hashPassword(PASSWORD);

  // ------------------------------------------------------------- wards ----
  const wards = [];
  for (let i = 0; i < WARDS.length; i += 1) {
    const spec = WARDS[i];
    const { boundary, center } = wardGeometry(i);
    const bbox = polygonBBox(boundary);

    const ward = await prisma.ward.create({
      data: {
        name: spec.name,
        code: spec.code,
        zone: spec.zone,
        population: spec.population,
        households: Math.round(spec.population / 4.4),
        boundary,
        centerLat: center.latitude,
        centerLng: center.longitude,
        ...bbox,
        slaMinutes: 1440,
      },
    });
    wards.push({ ward, index: i });
  }
  console.log(`[seed] ${wards.length} wards`);
  const wardAnchors = await buildWardAnchors(wards);

  // ------------------------------------------------------------- staff ----
  const admin = await prisma.user.create({
    data: {
      name: 'Commissioner H. Patel',
      email: 'admin@safaai.gov.in',
      phone: '9900000001',
      role: ROLES.ADMIN,
      passwordHash,
      emailVerifiedAt: new Date(),
      avatarColor: '#0f766e',
    },
  });
  const admin2 = await prisma.user.create({
    data: {
      name: 'Dy. Commissioner R. Shah',
      email: 'admin2@safaai.gov.in',
      phone: '9900000002',
      role: ROLES.ADMIN,
      passwordHash,
      emailVerifiedAt: new Date(),
      avatarColor: '#115e59',
    },
  });

  const officers = [];
  for (let i = 0; i < 4; i += 1) {
    const r = rng(`officer-${i}`);
    const scoped = [wards[i * 2], wards[i * 2 + 1]].filter(Boolean);
    const officer = await prisma.user.create({
      data: {
        name: `${pick(r, FIRST_NAMES)} ${pick(r, LAST_NAMES)} (Ward Officer)`,
        email: `officer${i + 1}@safaai.gov.in`,
        phone: `98000000${String(i + 1).padStart(2, '0')}`,
        role: ROLES.OFFICER,
        passwordHash,
        emailVerifiedAt: new Date(),
        wardId: scoped[0]?.ward.id,
        avatarColor: '#f59e0b',
      },
    });
    await prisma.wardOfficer.createMany({
      data: scoped.map((w, k) => ({ wardId: w.ward.id, officerId: officer.id, isPrimary: k === 0 })),
    });
    officers.push(officer);
  }

  // ---------------------------------------------------- drivers + fleet ----
  /**
   * Every ward runs a crew of 4-5 drivers, each with their own truck, rather
   * than the single driver-per-ward the demo started with. A ward is a whole
   * shift's worth of work: one handset carrying the entire ward backlog is
   * not what the officer's fleet view, the ward-wise driver roster or the
   * route optimiser are actually for, and it made "reassign to another
   * driver" impossible to demonstrate at all.
   *
   * Crew size alternates 4/5 by ward so the roster is not suspiciously
   * uniform, and `crews[wardIndex]` keeps each ward's trucks addressable --
   * several seeding steps below need "a truck from ward w", which a flat
   * array indexed by ward can no longer answer.
   */
  const CREW_MIN = 4;
  const vehicles = [];
  const crews = [];
  let driverSeq = 0;

  for (let i = 0; i < wards.length; i += 1) {
    const { ward, index } = wards[i];
    const crewSize = CREW_MIN + (i % 2);
    const crew = [];

    for (let k = 0; k < crewSize; k += 1) {
      driverSeq += 1;
      const r = rng(`driver-${i}-${k}`);

      const driver = await prisma.user.create({
        data: {
          name: `${pick(r, FIRST_NAMES)} ${pick(r, LAST_NAMES)}`,
          email: `driver${driverSeq}@safaai.gov.in`,
          phone: `97000000${String(driverSeq).padStart(2, '0')}`,
          role: ROLES.DRIVER,
          passwordHash,
          emailVerifiedAt: new Date(),
          wardId: ward.id,
          avatarColor: '#0ea5e9',
        },
      });

      // Each truck parks at its own depot offset so a ward's crew does not
      // stack into one pin on the fleet map.
      const depot = pointNear(wardAnchors, index, k);
      // Exactly one truck in the city is down for maintenance -- enough to
      // exercise the flagged-vehicle paths without making the fleet look
      // broken. A flagged truck cannot simultaneously be "on route" (the
      // simulator itself refuses to drive one), so status is derived from
      // the flag rather than rolled independently.
      const maintenanceFlag = i === 6 && k === 2;
      const status = maintenanceFlag ? 'MAINTENANCE' : k === crewSize - 1 ? 'IDLE' : 'ON_ROUTE';
      const vehicle = await prisma.vehicle.create({
        data: {
          // GJ-18 is Gandhinagar's RTO series.
          registrationNumber: `GJ 18 ${String.fromCharCode(65 + i)}${String.fromCharCode(65 + k)} ${1000 + i * 137 + k * 13}`,
          wardId: ward.id,
          driverId: driver.id,
          status,
          model: pick(r, ['Tata Ace', 'Mahindra Jeeto', 'Ashok Leyland Dost', 'Tata 407']),
          capacityKg: intBetween(r, 900, 3200),
          maintenanceFlag,
          lastLat: depot.latitude,
          lastLng: depot.longitude,
          lastHeading: intBetween(r, 0, 359),
          lastSpeed: 0,
          lastPingAt: new Date(),
        },
      });

      const entry = { vehicle, ward, index, driver, slot: k };
      crew.push(entry);
      vehicles.push(entry);
    }

    crews.push(crew);
  }

  /** Deterministically picks one of a ward's crew -- same input, same driver. */
  const crewMember = (wardIdx, n) => {
    const crew = crews[wardIdx];
    return crew[Math.abs(n) % crew.length];
  };

  console.log(
    `[seed] ${officers.length} officers, ${vehicles.length} drivers + vehicles across ${crews.length} wards ` +
      `(${crews.map((c) => c.length).join('/')} per ward)`
  );

  // ---------------------------------------------------------- citizens ----
  const citizens = [];
  for (let i = 0; i < 24; i += 1) {
    const r = rng(`citizen-${i}`);
    const { ward } = wards[i % wards.length];
    const citizen = await prisma.user.create({
      data: {
        name: `${pick(r, FIRST_NAMES)} ${pick(r, LAST_NAMES)}`,
        email: i < 4 ? `citizen${i + 1}@safaai.gov.in` : `resident${i + 1}@example.com`,
        phone: `96000000${String(i + 1).padStart(2, '0')}`,
        role: ROLES.CITIZEN,
        passwordHash,
        emailVerifiedAt: new Date(),
        wardId: ward.id,
        language: pick(r, ['en', 'hi', 'gu', 'gu']),
        avatarColor: '#16a34a',
      },
    });
    citizens.push(citizen);
  }
  console.log(`[seed] ${citizens.length} citizens`);

  // ---------------------------------------------------------- history ----
  /**
   * 45 days of complaints with genuine weekday seasonality (markets on
   * weekends produce more) so the hotspot forecast has a real pattern to find.
   */
  let created = 0;
  let resolvedCount = 0;
  const creditTally = new Map();

  for (let d = HISTORY_DAYS; d >= 1; d -= 1) {
    const day = new Date();
    day.setDate(day.getDate() - d);
    day.setHours(7, 0, 0, 0);
    const weekday = day.getDay();

    for (let w = 0; w < wards.length; w += 1) {
      const { ward, index } = wards[w];
      const r = rng(`complaints-${ward.code}-${d}`);

      // Weekend and market-day uplift, plus a per-ward base rate.
      const base = 2 + (index % 3);
      const weekendBoost = weekday === 0 || weekday === 6 ? 2.2 : 1;
      /**
       * The last five days are the ones that stay open, and a ward now fields
       * a 4-5 truck crew. At the historical baseline that backlog dealt out
       * to barely one stop per driver, so most of the crew would sign in to
       * an empty route. Recent days run hotter so every truck gets a real
       * beat; the 40 days behind them keep the flat baseline the trend and
       * hotspot charts are read against.
       */
      const recentUplift = d <= 5 ? 2.2 : 1;
      const count = Math.max(0, Math.round(base * weekendBoost * recentUplift * (0.6 + r() * 0.9)));

      for (let k = 0; k < count; k += 1) {
        const spec = pick(r, WASTE_CATEGORIES);
        const meta = CATEGORY_MAP[spec.id];
        const citizen = citizens[intBetween(r, 0, citizens.length - 1)];
        const point = pointNear(wardAnchors, index, d * 13 + k * 7);

        const createdAt = new Date(day.getTime() + intBetween(r, 0, 11 * 60) * 60_000);
        const confidence = Number((0.45 + r() * 0.52).toFixed(3));
        const autoApproved = confidence >= 0.7;

        /**
         * Older complaints are closed so the SLA and trend charts have depth;
         * the last five days keep a realistic open backlog, which is what the
         * officer queue, emergency panel and route optimiser actually need.
         */
        const shouldResolve = d > 5 ? true : r() > 0.45;
        const resolutionMinutes = Math.round(meta.slaMinutes * (0.35 + r() * 0.95));
        const resolvedAt = shouldResolve ? new Date(createdAt.getTime() + resolutionMinutes * 60_000) : null;
        const status = resolvedAt ? 'RESOLVED' : pick(r, ['PENDING', 'VERIFIED', 'VERIFIED', 'ASSIGNED', 'IN_PROGRESS']);

        // A real photo is mandatory on the actual citizen /report flow -- match that here too.
        const photoUrl = pick(r, CITIZEN_PHOTO_POOL);
        const resolutionPhotoUrl = resolvedAt
          ? pick(r, CITIZEN_PHOTO_POOL.filter((p) => p !== photoUrl))
          : null;

        // Spread the ward's history across its whole crew so per-driver
        // performance, fuel and SLA numbers differ from each other.
        const handler = crewMember(w, created + k);
        const vehicle = handler.vehicle;
        const complaint = await prisma.complaint.create({
          data: {
            code: `SS-${(created + 1000).toString(36).toUpperCase().padStart(5, '0')}`,
            citizenId: citizen.id,
            wardId: ward.id,
            category: spec.id,
            // The model is not always right — roughly one in eight is corrected
            // by an officer, so Model Health shows a believable agreement rate
            // rather than a flat 100%.
            aiCategory: r() > 0.88 ? pick(r, WASTE_CATEGORIES).id : spec.id,
            aiConfidence: confidence,
            aiVerified: autoApproved,
            reviewNeeded: !autoApproved,
            fraudScore: Number((r() * 0.35).toFixed(3)),
            status,
            severity: meta.severity,
            isEmergency: meta.emergency,
            channel: pick(r, ['WEB', 'APP', 'APP', 'WHATSAPP']),
            description: `${meta.label} reported near ${pick(r, STREETS)}`,
            latitude: point.latitude,
            longitude: point.longitude,
            address: `${intBetween(r, 1, 240)}, ${pick(r, STREETS)}, ${ward.name}`,
            photoUrl,
            resolutionPhotoUrl,
            slaMinutes: meta.slaMinutes,
            dueAt: new Date(createdAt.getTime() + meta.slaMinutes * 60_000),
            createdAt,
            updatedAt: resolvedAt || createdAt,
            resolvedAt,
            resolvedById: resolvedAt ? handler.driver.id : null,
            assignedVehicleId: ['ASSIGNED', 'IN_PROGRESS'].includes(status) || resolvedAt ? vehicle?.id : null,
            assignedAt: ['ASSIGNED', 'IN_PROGRESS'].includes(status) || resolvedAt ? createdAt : null,
          },
        });

        // Timeline entries so the citizen's status view has real history.
        const events = [{ status: 'PENDING', note: 'Report received', at: createdAt }];
        if (autoApproved) events.push({ status: 'VERIFIED', note: `AI verified (${Math.round(confidence * 100)}%)`, at: new Date(createdAt.getTime() + 60_000) });
        if (resolvedAt) {
          events.push({ status: 'ASSIGNED', note: `Assigned to ${vehicle?.registrationNumber}`, at: new Date(createdAt.getTime() + 15 * 60_000) });
          events.push({ status: 'RESOLVED', note: 'Cleared by crew, photo proof attached', at: resolvedAt });
        }
        await prisma.complaintEvent.createMany({
          data: events.map((e) => ({ complaintId: complaint.id, status: e.status, note: e.note, createdAt: e.at })),
        });

        const credit = resolvedAt ? CREDIT_RULES.reportSubmitted + CREDIT_RULES.reportResolved : CREDIT_RULES.reportSubmitted;
        creditTally.set(citizen.id, (creditTally.get(citizen.id) || 0) + credit);
        created += 1;
        if (resolvedAt) resolvedCount += 1;
      }
    }
  }
  console.log(`[seed] ${created} complaints (${resolvedCount} resolved) across ${HISTORY_DAYS} days`);

  // Credit ledgers reflecting that history.
  for (const [userId, total] of creditTally) {
    await prisma.user.update({ where: { id: userId }, data: { greenCredits: total } });
    await prisma.greenCredit.create({
      data: {
        userId,
        delta: total,
        balanceAfter: total,
        reason: 'Historical reporting activity',
        reasonCode: 'seed',
      },
    });
  }

  /**
   * The demo citizens each get one fresh, assigned complaint so the live truck
   * tracker has something to follow the moment a judge signs in. Without this
   * the flagship "your truck arrives in 12 minutes" card can be empty purely by
   * chance.
   */
  for (let i = 0; i < 4; i += 1) {
    const citizen = citizens[i];
    const home = vehicles.find((v) => v.ward.id === citizen.wardId) ?? vehicles[i % vehicles.length];
    const r = rng(`demo-active-${i}`);
    const spec = pick(r, WASTE_CATEGORIES.filter((c) => !CATEGORY_MAP[c.id].emergency));
    const meta = CATEGORY_MAP[spec.id];
    const point = pointNear(wardAnchors, home.index, 900 + i);
    const createdAt = new Date(Date.now() - intBetween(r, 40, 180) * 60_000);

    created += 1;
    await prisma.complaint.create({
      data: {
        code: `SS-DEMO${i + 1}`,
        citizenId: citizen.id,
        wardId: home.ward.id,
        category: spec.id,
        aiCategory: spec.id,
        aiConfidence: 0.82,
        aiVerified: true,
        status: 'ASSIGNED',
        severity: meta.severity,
        isEmergency: false,
        channel: 'APP',
        description: `${meta.label} reported near ${pick(r, STREETS)}`,
        latitude: point.latitude,
        longitude: point.longitude,
        address: `${intBetween(r, 1, 240)}, ${pick(r, STREETS)}, ${home.ward.name}`,
        photoUrl: pick(r, CITIZEN_PHOTO_POOL),
        slaMinutes: meta.slaMinutes,
        dueAt: new Date(createdAt.getTime() + meta.slaMinutes * 60_000),
        createdAt,
        assignedVehicleId: home.vehicle.id,
        assignedAt: new Date(createdAt.getTime() + 12 * 60_000),
        events: {
          create: [
            { status: 'PENDING', note: 'Report received', createdAt },
            { status: 'VERIFIED', note: 'AI verified (82%)', createdAt: new Date(createdAt.getTime() + 60_000) },
            {
              status: 'ASSIGNED',
              note: `Assigned to ${home.vehicle.registrationNumber}`,
              createdAt: new Date(createdAt.getTime() + 12 * 60_000),
            },
          ],
        },
      },
    });
  }

  // Two live emergencies so the officer's countdown panel is never empty.
  for (let i = 0; i < 2; i += 1) {
    const home = crews[i * 3][0];
    const r = rng(`demo-emergency-${i}`);
    const spec = i === 0 ? CATEGORY_MAP.DEAD_ANIMAL : CATEGORY_MAP.MEDICAL_WASTE;
    const point = pointNear(wardAnchors, home.index, 500 + i);
    const createdAt = new Date(Date.now() - intBetween(r, 5, 22) * 60_000);

    created += 1;
    await prisma.complaint.create({
      data: {
        code: `SS-SOS${i + 1}`,
        citizenId: citizens[(i + 5) % citizens.length].id,
        wardId: home.ward.id,
        category: spec.id,
        aiCategory: spec.id,
        aiConfidence: 0.91,
        aiVerified: true,
        status: 'PENDING',
        severity: 'CRITICAL',
        isEmergency: true,
        channel: 'APP',
        description: `${spec.label} reported on ${pick(r, STREETS)} — needs immediate clearance`,
        latitude: point.latitude,
        longitude: point.longitude,
        address: `${pick(r, STREETS)}, ${home.ward.name}`,
        photoUrl: pick(r, CITIZEN_PHOTO_POOL),
        slaMinutes: 30,
        dueAt: new Date(createdAt.getTime() + 30 * 60_000),
        createdAt,
        events: { create: [{ status: 'PENDING', note: 'Emergency reported', createdAt }] },
      },
    });
  }

  // ------------------------------------------------ today's live routes ----
  /**
   * One published route per active truck, not one per ward. The ward's open
   * backlog is dealt round-robin across its crew, so every driver signs in to
   * their own beat instead of the whole ward's list landing on one handset --
   * and the officer's fleet map shows several trucks working a ward at once,
   * which is the thing that was impossible to demonstrate before.
   */
  let routes = 0;
  for (let w = 0; w < wards.length; w += 1) {
    const { ward, index } = wards[w];
    /**
     * Only trucks that are actually rostered on today get a route. The ward's
     * spare (IDLE) and its maintenance truck are deliberately left without
     * one: the simulator drives any vehicle that has a published route and
     * only refuses maintenance-flagged ones, so handing the spare a route
     * would put a truck labelled "idle" visibly in motion on the fleet map.
     */
    const crew = crews[w].filter((c) => !c.vehicle.maintenanceFlag && c.vehicle.status !== 'IDLE');
    if (!crew.length) continue;

    const open = await prisma.complaint.findMany({
      where: { wardId: ward.id, status: { in: ['VERIFIED', 'ASSIGNED', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'asc' },
      take: crew.length * 6,
    });
    if (open.length < 2) continue;

    // Deal round-robin rather than slicing in blocks: slicing would hand one
    // driver every oldest complaint in the ward and leave the last driver the
    // newest, which is not how a supervisor splits a shift.
    const buckets = crew.map(() => []);
    open.forEach((c, i) => buckets[i % crew.length].push(c));

    for (let k = 0; k < crew.length; k += 1) {
      const { vehicle } = crew[k];
      const mine = buckets[k];
      // A one-stop "route" is not a route -- leave that truck idle instead.
      if (mine.length < 2) continue;

      const depot = pointNear(wardAnchors, index, k);
      const solved = solveLocal({
        depot: { coordinates: [depot.longitude, depot.latitude] },
        stops: mine.map((c) => ({
          complaintId: c.id,
          code: c.code,
          label: c.address,
          category: c.category,
          severity: c.severity,
          isEmergency: c.isEmergency,
          latitude: c.latitude,
          longitude: c.longitude,
          reportedAt: c.createdAt,
        })),
      });

      const { polyline, breakpoints } = await roadSnappedRoute(solved.polyline);
      const stops = solved.stops.map((st, i) => ({ ...st, polylineIndex: breakpoints[i] ?? null }));

      await prisma.route.create({
        data: {
          vehicleId: vehicle.id,
          driverId: vehicle.driverId,
          wardId: ward.id,
          date: new Date().toISOString().slice(0, 10),
          status: 'PUBLISHED',
          label: `${ward.name} beat ${k + 1}`,
          orderedStops: stops,
          polylineGeometry: polyline,
          distanceKm: solved.distanceKm,
          baselineKm: solved.baselineKm,
          savedKm: solved.savedKm,
          durationMin: solved.durationMin,
          fuelSaved: solved.fuelSaved,
          co2SavedKg: solved.co2SavedKg,
          solver: solved.solver,
        },
      });

      await prisma.complaint.updateMany({
        where: { id: { in: mine.map((c) => c.id) }, status: 'VERIFIED' },
        data: { assignedVehicleId: vehicle.id, status: 'ASSIGNED', assignedAt: new Date() },
      });
      routes += 1;
    }
  }
  console.log(`[seed] ${routes} optimised routes published for today across ${wards.length} wards`);


  // ------------------------------------------------- showcase complaints ----
  /**
   * Five hand-built complaints, one frozen at each stage of the lifecycle.
   *
   * The 45 days of generated history give the charts something real to read,
   * but they are random: there is no guarantee that a walkthrough will find a
   * report sitting in review, another with a truck en route, and a third
   * closed with before/after proof. These five are pinned to the top of every
   * list with fixed codes so a demo can be walked in order, and every row that
   * refers to them is written from the same source of truth -- the complaint,
   * its timeline, the route stop, the assigned truck, the citizen's credits
   * and notifications all agree, because they are derived here rather than
   * generated independently.
   *
   * SS-DEMO1  pending, AI unsure          -> officer review queue
   * SS-DEMO2  verified + assigned         -> citizen live-tracks the truck
   * SS-DEMO3  in progress                 -> driver on site
   * SS-DEMO4  resolved with proof photos  -> before/after + credits awarded
   * SS-DEMO5  emergency, auto-dispatched  -> 30-minute clock, stop 1
   */
  const todayKeyForShowcase = new Date().toISOString().slice(0, 10);

  /**
   * Only trucks that actually have a route today can carry a showcase stop.
   *
   * Picking any ON_ROUTE crew member is not enough: a truck whose share of the
   * ward backlog came to fewer than two stops is deliberately left routeless
   * above, and assigning a demo complaint to it produces exactly the defect
   * this data exists to avoid -- the complaint insists a truck is coming while
   * that driver's stop list has never heard of it.
   */
  const routedToday = await prisma.route.findMany({
    where: { date: todayKeyForShowcase },
    select: { id: true, vehicleId: true },
  });
  const routeByVehicle = new Map(routedToday.map((r) => [r.vehicleId, r]));
  const routedCrew = vehicles.filter((v) => routeByVehicle.has(v.vehicle.id));
  if (routedCrew.length === 0) {
    console.warn('[seed] no routes published today — showcase stops will not appear on any handset');
  }

  const SHOWCASE = [
    {
      code: 'SS-DEMO1',
      stage: 'PENDING',
      category: 'GARBAGE_PILE',
      confidence: 0.52,
      minutesAgo: 25,
      street: 'Ch Road',
      description: 'Pile of household waste dumped at the corner, growing since yesterday.',
    },
    {
      code: 'SS-DEMO2',
      stage: 'ASSIGNED',
      category: 'OVERFLOWING_BIN',
      confidence: 0.91,
      minutesAgo: 95,
      street: 'Sector 7 Circle Road',
      description: 'Community bin overflowing onto the footpath outside the market.',
    },
    {
      code: 'SS-DEMO3',
      stage: 'IN_PROGRESS',
      category: 'ILLEGAL_DUMPING',
      confidence: 0.87,
      minutesAgo: 150,
      street: 'Kudasan Main Road',
      description: 'Construction and household waste tipped on the roadside overnight.',
    },
    {
      code: 'SS-DEMO4',
      stage: 'RESOLVED',
      category: 'CONSTRUCTION_DEBRIS',
      confidence: 0.94,
      minutesAgo: 320,
      street: 'Gh Road',
      description: 'Rubble left behind after a shop renovation, blocking half the lane.',
    },
    {
      code: 'SS-DEMO5',
      stage: 'EMERGENCY',
      category: 'MEDICAL_WASTE',
      confidence: 0.96,
      minutesAgo: 8,
      street: 'Sector 16 Ch Road',
      description: 'Used syringes and dressings dumped beside the clinic gate.',
    },
  ];

  const showcaseIds = [];
  for (let i = 0; i < SHOWCASE.length; i += 1) {
    const spec = SHOWCASE[i];
    const r = rng('showcase-' + spec.code);
    const meta = CATEGORY_MAP[spec.category];
    const citizen = citizens[i % 4]; // the four named citizen logins
    // A truck with a real route today, so the stop lands on a handset the
    // driver can actually open. The ward is taken from the truck rather than
    // chosen separately, so the report, the truck and the ward always agree
    // — the verifier asserts exactly that.
    const handler = routedCrew.length ? routedCrew[i % routedCrew.length] : crews[i % wards.length][0];
    const { ward, index } = handler;

    const createdAt = new Date(Date.now() - spec.minutesAgo * 60_000);
    const point = pointNear(wardAnchors, index, 7000 + i * 31);
    const emergency = spec.stage === 'EMERGENCY';
    const slaMinutes = emergency ? 30 : meta.slaMinutes;
    const assigned = spec.stage !== 'PENDING';
    const resolved = spec.stage === 'RESOLVED';
    const resolvedAt = resolved ? new Date(createdAt.getTime() + 210 * 60_000) : null;

    const photoUrl = CITIZEN_PHOTO_POOL[i % CITIZEN_PHOTO_POOL.length];
    const resolutionPhotoUrl = resolved
      ? CITIZEN_PHOTO_POOL[(i + 1) % CITIZEN_PHOTO_POOL.length]
      : null;

    const status = emergency ? 'ASSIGNED' : spec.stage === 'RESOLVED' ? 'RESOLVED' : spec.stage;

    const complaint = await prisma.complaint.create({
      data: {
        code: spec.code,
        citizenId: citizen.id,
        wardId: ward.id,
        category: spec.category,
        aiCategory: spec.category,
        aiConfidence: spec.confidence,
        // Below the auto-approve gate is exactly what "needs a human" means,
        // so the flag is derived from the score rather than set by hand.
        aiVerified: spec.confidence >= 0.7,
        reviewNeeded: spec.confidence < 0.7,
        fraudScore: Number((r() * 0.12).toFixed(3)),
        status,
        severity: emergency ? 'CRITICAL' : meta.severity,
        isEmergency: emergency,
        channel: 'APP',
        description: spec.description,
        latitude: point.latitude,
        longitude: point.longitude,
        address: intBetween(r, 1, 120) + ', ' + spec.street + ', ' + ward.name,
        photoUrl,
        resolutionPhotoUrl,
        slaMinutes,
        dueAt: new Date(createdAt.getTime() + slaMinutes * 60_000),
        createdAt,
        updatedAt: resolvedAt || createdAt,
        resolvedAt,
        resolvedById: resolved ? handler.driver.id : null,
        assignedVehicleId: assigned ? handler.vehicle.id : null,
        assignedAt: assigned ? new Date(createdAt.getTime() + 6 * 60_000) : null,
      },
    });
    showcaseIds.push(complaint.id);

    // Timeline: only the steps this stage has actually reached.
    const events = [{ status: 'PENDING', note: 'Report received from citizen app', at: createdAt }];
    if (spec.confidence >= 0.7) {
      events.push({
        status: 'VERIFIED',
        note: 'AI verified as ' + meta.label + ' (' + Math.round(spec.confidence * 100) + '% confidence)',
        at: new Date(createdAt.getTime() + 60_000),
      });
    }
    if (emergency) {
      events.push({
        status: 'ASSIGNED',
        note: 'Emergency auto-dispatched to ' + handler.vehicle.registrationNumber + ' — ward officer paged',
        at: new Date(createdAt.getTime() + 2 * 60_000),
      });
    } else if (assigned) {
      events.push({
        status: 'ASSIGNED',
        note: 'Assigned to ' + handler.vehicle.registrationNumber + ' (' + handler.driver.name + ')',
        at: new Date(createdAt.getTime() + 6 * 60_000),
      });
    }
    if (spec.stage === 'IN_PROGRESS') {
      events.push({ status: 'IN_PROGRESS', note: 'Driver is on site and collection has started', at: new Date(createdAt.getTime() + 40 * 60_000) });
    }
    if (resolved) {
      events.push({ status: 'IN_PROGRESS', note: 'Driver is on site and collection has started', at: new Date(createdAt.getTime() + 150 * 60_000) });
      events.push({ status: 'RESOLVED', note: 'Cleared by crew, photo proof attached', at: resolvedAt });
    }
    await prisma.complaintEvent.createMany({
      data: events.map((e) => ({ complaintId: complaint.id, status: e.status, note: e.note, createdAt: e.at })),
    });

    // The citizen's own notification trail, matching those same steps.
    const notes = [
      {
        type: 'COMPLAINT_UPDATE',
        title: 'Report ' + spec.code + ' received',
        body: spec.confidence >= 0.7 ? 'AI verified as ' + meta.label + '. Assigning a vehicle shortly.' : 'Received. An officer will verify it shortly.',
        at: createdAt,
      },
    ];
    if (assigned) {
      notes.push({
        type: 'ASSIGNMENT',
        title: emergency ? 'Truck dispatched for ' + spec.code : spec.code + ' assigned to a vehicle',
        body: 'Vehicle ' + handler.vehicle.registrationNumber + ' is on the way. You can track it live.',
        at: new Date(createdAt.getTime() + 6 * 60_000),
      });
    }
    if (resolved) {
      notes.push({
        type: 'CREDIT_AWARDED',
        title: spec.code + ' resolved — credits added',
        body: 'The site was cleared and photo proof attached. +' + (CREDIT_RULES.reportSubmitted + CREDIT_RULES.reportResolved) + ' Green Credits.',
        at: resolvedAt,
      });
    }
    await prisma.notification.createMany({
      data: notes.map((n) => ({ userId: citizen.id, type: n.type, title: n.title, body: n.body, payload: { complaintId: complaint.id, code: spec.code }, createdAt: n.at })),
    });

    if (resolved) {
      // Credits are flushed above from the generated history, so this one is
      // added on top of the balance rather than overwriting it.
      const delta = CREDIT_RULES.reportSubmitted + CREDIT_RULES.reportResolved;
      const fresh = await prisma.user.update({
        where: { id: citizen.id },
        data: { greenCredits: { increment: delta } },
        select: { greenCredits: true },
      });
      await prisma.greenCredit.create({
        data: {
          userId: citizen.id,
          delta,
          balanceAfter: fresh.greenCredits,
          reason: 'Report ' + spec.code + ' resolved with photo proof',
          reasonCode: 'report_resolved',
          complaintId: complaint.id,
          createdAt: resolvedAt,
        },
      });
    }

    // Put it on the driver's actual route for today, so the stop list, the map
    // and the complaint agree instead of telling three different stories.
    if (assigned) {
      const routeRef = routeByVehicle.get(handler.vehicle.id);
      const route = routeRef ? await prisma.route.findUnique({ where: { id: routeRef.id } }) : null;
      if (route) {
        const existing = Array.isArray(route.orderedStops) ? route.orderedStops : [];
        const stop = {
          complaintId: complaint.id,
          code: spec.code,
          label: complaint.address,
          category: spec.category,
          severity: complaint.severity,
          isEmergency: emergency,
          reportedAt: createdAt,
          latitude: point.latitude,
          longitude: point.longitude,
          serviceMin: 10,
          etaMin: 0,
          eta: null,
          legKm: null,
          status: resolved ? 'DONE' : 'PENDING',
          ...(resolved ? { doneAt: resolvedAt.toISOString() } : {}),
        };
        // Emergencies go to the front, exactly as live auto-dispatch does.
        const merged = emergency ? [stop, ...existing] : [...existing, stop];
        await prisma.route.update({
          where: { id: route.id },
          data: { orderedStops: merged.map((st, n) => ({ ...st, seq: n + 1 })) },
        });
      }
    }
  }
  console.log('[seed] ' + showcaseIds.length + ' showcase complaints (SS-DEMO1..SS-DEMO' + SHOWCASE.length + ') pinned to the top');

  // ------------------------------------------------------ driver shifts ----
  /**
   * A week of clock-in/clock-out history per driver, plus today's state.
   *
   * Without seeded shifts the whole feature reads as broken rather than
   * empty: the officer's shift board shows nobody on duty in a city where
   * every truck is visibly driving, and the driver summary has no history to
   * compare today against.
   *
   * Today deliberately splits three ways so all three states are visible on
   * one screen: trucks on route are clocked in, the ward spare worked a
   * morning and clocked off, and the maintenance truck never turned up.
   */
  const SHIFT_HISTORY_DAYS = 7;
  // Same key shape the routes above use, so a shift and its route join on it.
  const todayKey = new Date().toISOString().slice(0, 10);
  let shiftsCreated = 0;

  for (const { vehicle, ward, driver } of vehicles) {
    const r = rng(`shift-${vehicle.id}`);

    for (let d = SHIFT_HISTORY_DAYS; d >= 1; d -= 1) {
      // Sunday is the weekly off, so the board is not suspiciously uniform.
      const day = new Date();
      day.setDate(day.getDate() - d);
      if (day.getDay() === 0) continue;

      const startedAt = new Date(day);
      startedAt.setHours(intBetween(r, 6, 8), intBetween(r, 0, 59), 0, 0);
      const endedAt = new Date(startedAt.getTime() + intBetween(r, 7 * 60, 9 * 60) * 60_000);

      await prisma.driverShift.create({
        data: {
          driverId: driver.id,
          vehicleId: vehicle.id,
          wardId: ward.id,
          date: startedAt.toISOString().slice(0, 10),
          startedAt,
          endedAt,
          startOdometerKm: null,
          endOdometerKm: null,
          distanceKm: Number((18 + r() * 42).toFixed(1)),
          stopsDone: intBetween(r, 3, 9),
          status: 'ENDED',
        },
      });
      shiftsCreated += 1;
    }

    if (vehicle.maintenanceFlag) continue; // off the road, nobody clocked in

    const startedAt = new Date();
    startedAt.setHours(intBetween(r, 6, 8), intBetween(r, 0, 59), 0, 0);
    const isSpare = vehicle.status === 'IDLE';

    await prisma.driverShift.create({
      data: {
        driverId: driver.id,
        vehicleId: vehicle.id,
        wardId: ward.id,
        date: todayKey,
        startedAt,
        // The spare crew worked a morning and went home; everyone else is
        // still out, which is what makes the trucks on the map moving.
        endedAt: isSpare ? new Date(startedAt.getTime() + intBetween(r, 4 * 60, 6 * 60) * 60_000) : null,
        distanceKm: isSpare ? Number((10 + r() * 20).toFixed(1)) : null,
        stopsDone: isSpare ? intBetween(r, 2, 5) : 0,
        status: isSpare ? 'ENDED' : 'ACTIVE',
      },
    });
    shiftsCreated += 1;
  }
  console.log(`[seed] ${shiftsCreated} driver shifts (${SHIFT_HISTORY_DAYS}-day history + today)`);

  // -------------------------------------------------------- fuel logs ----
  /**
   * Diesel fill-ups per truck across the same window as the shifts.
   *
   * Nothing seeded fuel logs before, so every fuel and expenditure panel in
   * the product read zero -- the analytics were never broken, they had no
   * rows to read. A reviewer opening "Fuel & Expenditure" saw an empty page
   * and could only conclude the feature did not work.
   *
   * A deliberate minority of entries have litres but no cost. That is what
   * real driver-entered logs look like (the pump receipt goes missing), and
   * it exercises the coverage counters that keep a cheap-looking month
   * distinguishable from a badly-logged one.
   */
  const DIESEL_PER_LITRE = 94.5; // Gujarat pump price, near enough for a demo
  const FUEL_HISTORY_DAYS = 30;
  let fuelEntries = 0;

  for (const { vehicle, driver } of vehicles) {
    if (vehicle.maintenanceFlag) continue; // off the road, not burning diesel
    const r = rng(`fuel-${vehicle.id}`);

    // Roughly every third day, which is what a 900-3200 kg truck on a ward
    // beat actually needs rather than a tidy daily entry.
    let odometer = intBetween(r, 18_000, 96_000);
    for (let d = FUEL_HISTORY_DAYS; d >= 1; d -= 3) {
      const loggedAt = new Date();
      loggedAt.setDate(loggedAt.getDate() - d);
      loggedAt.setHours(intBetween(r, 7, 18), intBetween(r, 0, 59), 0, 0);

      const liters = Number((22 + r() * 26).toFixed(1));
      odometer += intBetween(r, 90, 190);

      // ~1 in 6 fill-ups is logged without a cost.
      const hasCost = r() > 0.17;

      await prisma.fuelLog.create({
        data: {
          driverId: driver.id,
          vehicleId: vehicle.id,
          liters,
          odometerKm: odometer,
          cost: hasCost ? Number((liters * DIESEL_PER_LITRE * (0.97 + r() * 0.06)).toFixed(0)) : null,
          notes: hasCost ? null : 'Receipt not collected',
          loggedAt,
        },
      });
      fuelEntries += 1;
    }

    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { odometerKm: odometer } });
  }
  console.log(`[seed] ${fuelEntries} fuel log entries across ${FUEL_HISTORY_DAYS} days`);

  // -------------------------------------------------------- audit trail ----
  /**
   * Audit entries for the privileged actions the seeded history implies.
   *
   * The wipe clears audit_logs, so a freshly seeded database showed an empty
   * audit page -- which reads as "this feature does not work" rather than
   * "nothing has happened yet". These mirror decisions the seeded data already
   * asserts were made: an officer verified this complaint, assigned that
   * vehicle, escalated the overdue one. Nothing is invented that the rest of
   * the dataset does not already claim happened.
   *
   * Deliberately NOT seeded: destructive actions (reseed, delete-by-code,
   * user blocks). A fabricated record of someone deleting citizen reports is
   * not demo colour, it is a false accusation sitting in an immutable log.
   */
  const auditSamples = [];
  const auditables = await prisma.complaint.findMany({
    where: { status: { in: ['VERIFIED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED'] } },
    select: { id: true, code: true, wardId: true, status: true, createdAt: true, assignedVehicleId: true },
    orderBy: { createdAt: 'desc' },
    take: 90,
  });

  const officerForWard = new Map();
  for (let i = 0; i < officers.length; i += 1) {
    for (const w of [wards[i * 2], wards[i * 2 + 1]].filter(Boolean)) {
      officerForWard.set(w.ward.id, officers[i]);
    }
  }

  for (let i = 0; i < auditables.length; i += 1) {
    const c = auditables[i];
    const actor = officerForWard.get(c.wardId) ?? officers[i % officers.length];
    const r = rng(`audit-${c.id}`);
    const at = new Date(c.createdAt.getTime() + intBetween(r, 5, 90) * 60_000);

    auditSamples.push({
      actorId: actor.id,
      action: 'complaint_verify',
      targetTable: 'complaints',
      targetId: c.id,
      before: { status: 'PENDING', reviewNeeded: true },
      after: { status: 'VERIFIED', code: c.code },
      ip: `10.${intBetween(r, 10, 40)}.${intBetween(r, 0, 255)}.${intBetween(r, 2, 254)}`,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SafaaiSarathi/Officer',
      createdAt: at,
    });

    if (c.assignedVehicleId) {
      auditSamples.push({
        actorId: actor.id,
        action: 'complaint_assign',
        targetTable: 'complaints',
        targetId: c.id,
        before: { status: 'VERIFIED', assignedVehicleId: null },
        after: { status: 'ASSIGNED', assignedVehicleId: c.assignedVehicleId, code: c.code },
        ip: `10.${intBetween(r, 10, 40)}.${intBetween(r, 0, 255)}.${intBetween(r, 2, 254)}`,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SafaaiSarathi/Officer',
        createdAt: new Date(at.getTime() + intBetween(r, 2, 30) * 60_000),
      });
    }
  }

  // Ward and fleet administration by the two admin accounts.
  for (let i = 0; i < wards.length; i += 1) {
    const r = rng(`audit-ward-${i}`);
    const at = new Date(Date.now() - intBetween(r, 2, 40) * 86_400_000);
    auditSamples.push({
      actorId: (i % 2 === 0 ? admin : admin2).id,
      action: 'ward_update',
      targetTable: 'wards',
      targetId: wards[i].ward.id,
      before: { slaMinutes: 1440 },
      after: { slaMinutes: 1440, name: wards[i].ward.name },
      ip: `10.8.${intBetween(r, 0, 255)}.${intBetween(r, 2, 254)}`,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SafaaiSarathi/Admin',
      createdAt: at,
    });
  }

  for (const { vehicle, driver } of vehicles.slice(0, 12)) {
    const r = rng(`audit-veh-${vehicle.id}`);
    auditSamples.push({
      actorId: admin.id,
      action: 'vehicle_create',
      targetTable: 'vehicles',
      targetId: vehicle.id,
      after: { registrationNumber: vehicle.registrationNumber, driverId: driver.id },
      ip: `10.8.${intBetween(r, 0, 255)}.${intBetween(r, 2, 254)}`,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SafaaiSarathi/Admin',
      createdAt: new Date(Date.now() - intBetween(r, 20, 60) * 86_400_000),
    });
  }

  await prisma.auditLog.createMany({ data: auditSamples });
  console.log(`[seed] ${auditSamples.length} audit log entries`);

  // ------------------------------------------ scheduled pickup requests ----
  /**
   * Advance event-pickup bookings (the "Schedule Event" feature) across the
   * full status lifecycle, including two COMPLETED ones with real proof
   * photos. Without this the feature had zero demo rows -- every seeded
   * account's "My Scheduled Pickups" page, and the matching officer/driver
   * queues, showed permanently empty no matter which login a judge used.
   */
  const EVENT_REASONS = [
    'Wedding Reception', 'Diwali Society Deep-Clean', 'Kitchen Renovation',
    'Birthday Party Cleanup', 'Garba Night Prep', 'Housewarming Function',
    'Society Annual Function', 'Bathroom Renovation Debris', 'Ganesh Visarjan Cleanup', 'Society AGM Cleanup',
  ];
  const SCHEDULE_CATEGORY_OPTIONS = ['Organic', 'Plastic/Recyclable', 'Construction Debris', 'E-waste', 'Hazardous', 'Mixed/General'];
  const SCHEDULE_SPECS = [
    { status: 'PENDING_REVIEW', daysFromNow: 3 },
    { status: 'PENDING_REVIEW', daysFromNow: 6 },
    { status: 'APPROVED_SCHEDULED', daysFromNow: 4 },
    { status: 'ASSIGNED', daysFromNow: 2 },
    { status: 'ASSIGNED', daysFromNow: 8 },
    { status: 'IN_PROGRESS', daysFromNow: 0 },
    { status: 'COMPLETED', daysFromNow: -3 },
    { status: 'COMPLETED', daysFromNow: -9 },
    { status: 'REJECTED', daysFromNow: 5 },
    { status: 'CANCELLED', daysFromNow: 7 },
  ];

  let scheduledCount = 0;
  for (let i = 0; i < SCHEDULE_SPECS.length; i += 1) {
    const spec = SCHEDULE_SPECS[i];
    const r = rng(`scheduled-${i}`);
    const citizenIdx = (i * 5 + 2) % citizens.length;
    const citizen = citizens[citizenIdx];
    const { ward, index } = wards[citizenIdx % wards.length];
    const home = crews[index][0];
    const point = pointNear(wardAnchors, index, 5000 + i * 11);

    const scheduledDate = new Date();
    scheduledDate.setDate(scheduledDate.getDate() + spec.daysFromNow);
    scheduledDate.setHours(intBetween(r, 7, 18), 0, 0, 0);
    const createdAt = new Date(scheduledDate.getTime() - intBetween(r, 2, 5) * 86_400_000);

    const catCount = intBetween(r, 1, 3);
    const categories = Array.from(new Set(Array.from({ length: catCount }, () => pick(r, SCHEDULE_CATEGORY_OPTIONS))));

    const isAssigned = ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'].includes(spec.status);
    const isCompleted = spec.status === 'COMPLETED';
    const completedAt = isCompleted ? new Date(scheduledDate.getTime() + intBetween(r, 60, 240) * 60_000) : null;
    // A real photo is mandatory on the actual driver completion flow -- match that here too.
    const completionPhotoUrl = isCompleted ? pick(r, CITIZEN_PHOTO_POOL) : null;

    scheduledCount += 1;
    await prisma.scheduledPickupRequest.create({
      data: {
        code: `SP-${(scheduledCount + 400).toString(36).toUpperCase().padStart(5, '0')}`,
        citizenId: citizen.id,
        wardId: ward.id,
        locationType: pick(r, ['MY_HOME', 'COMMON_PLOT_SOCIETY']),
        address: `${intBetween(r, 1, 240)}, ${pick(r, STREETS)}, ${ward.name}`,
        latitude: point.latitude,
        longitude: point.longitude,
        eventReason: EVENT_REASONS[i % EVENT_REASONS.length],
        expectedCategories: categories,
        expectedQuantity: pick(r, ['SMALL', 'MEDIUM', 'LARGE']),
        scheduledDate,
        scheduledTimeSlot: pick(r, ['MORNING', 'AFTERNOON', 'EVENING']),
        additionalNotes: r() > 0.5 ? `Please enter from Gate #${intBetween(r, 1, 4)}, security will guide you.` : null,
        status: spec.status,
        rejectionReason:
          spec.status === 'REJECTED'
            ? 'No compactor available in this ward on the requested date — please pick another slot.'
            : null,
        assignedDriverId: isAssigned ? home.driver.id : null,
        assignedVehicleId: isAssigned ? home.vehicle.id : null,
        assignedById: isAssigned ? officers[index % officers.length].id : null,
        assignedAt: isAssigned ? new Date(scheduledDate.getTime() - 86_400_000) : null,
        completedAt,
        completionPhotoUrl,
        completionNotes: isCompleted ? 'Cleared and area sanitised. Citizen awarded Green Credits.' : null,
        createdAt,
        updatedAt: completedAt || createdAt,
      },
    });
  }
  console.log(`[seed] ${scheduledCount} scheduled event-pickup requests across the full status lifecycle`);

  // ------------------------------------------------- emergency contacts ----
  /**
   * The three-digit national numbers are genuine. The municipal numbers are
   * demo placeholders on Gandhinagar's 079 STD code — swap them for the real
   * GMC directory before any live deployment.
   */
  const contacts = [
    { name: 'GMC Sanitation Helpline', category: 'helpline', phone: '079-23227900' },
    { name: 'Fire & Emergency Services', category: 'fire', phone: '101' },
    { name: 'Ambulance', category: 'hospital', phone: '108' },
    { name: 'Police Control Room', category: 'police', phone: '100' },
    { name: 'Animal Control — GMC', category: 'animal_control', phone: '079-23224466' },
    { name: 'Pest Control Cell', category: 'pest_control', phone: '079-23223311' },
    { name: 'Dead Animal Removal Squad', category: 'animal_control', phone: '079-23225913' },
    { name: 'GMC Health Department', category: 'helpline', phone: '079-23223751' },
  ];
  await prisma.emergencyContact.createMany({ data: contacts.map((c) => ({ ...c, isCityWide: true })) });

  // Ward-specific sanitation offices.
  await prisma.emergencyContact.createMany({
    data: wards.map(({ ward }, i) => ({
      name: `${ward.name} Zonal Sanitation Office`,
      category: 'helpline',
      phone: `079-232${String(20000 + i * 137).slice(0, 5)}`,
      wardId: ward.id,
      isCityWide: false,
    })),
  });

  console.log(`
  Safaai Sarathi demo data ready.

  Password for every seeded account: ${PASSWORD}

    Portal    Login page          Account
    -------   -----------------   ----------------------------
    Citizen   /login              citizen1@safaai.gov.in
    Driver    /driver/login       driver1 .. driver${vehicles.length} @safaai.gov.in
                                  (or OTP on 9700000001 .. 97000000${String(vehicles.length).padStart(2, "0")})
    Officer   /officer/login      officer1@safaai.gov.in
    Admin     /admin/login        admin@safaai.gov.in

  ${CITY.name}, ${CITY.state} — ${wards.length} wards, ${vehicles.length} drivers + vehicles
  (${crews.map((c) => c.length).join("/")} per ward), ${created} complaints, ${routes} live routes,
  ${shiftsCreated} shifts, ${fuelEntries} fuel entries.
`);

  return {
    city: `${CITY.name}, ${CITY.state}`,
    wards: wards.length,
    vehicles: vehicles.length,
    drivers: vehicles.length,
    crewPerWard: crews.map((c) => c.length),
    complaints: created,
    routes,
    scheduledPickups: scheduledCount,
  };
}

export { main as runSeed };

// CLI entrypoint only (`npm run seed`) -- disconnecting/exiting here would be
// wrong if this module is instead imported and called from a long-running
// process (the admin re-seed API route), since that shares the same Prisma
// client the rest of the server depends on for every other request.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then(async () => {
      await disconnectDB();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[seed] failed:', err);
      await disconnectDB().catch(() => {});
      process.exit(1);
    });
}
