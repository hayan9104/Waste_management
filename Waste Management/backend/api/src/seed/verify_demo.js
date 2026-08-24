/**
 * Every-section demo check.
 *
 *   npm run verify:demo      (needs the API running)
 *
 * verify_showcase.js goes deep on the five pinned complaints. This goes wide:
 * it signs in to all four portals as a judge would and asserts that every
 * section a walkthrough opens actually has rows behind it, and that the
 * numbers two portals show for the same fact agree.
 *
 * The failures this exists to catch are the quiet ones — a panel that renders
 * an empty state because its query returned nothing, or two screens
 * disagreeing about the same shift. Both look fine until someone opens them
 * side by side in front of an audience.
 *
 * Read-only: it performs no writes.
 */
const BASE = process.env.API_URL || 'http://localhost:5100/api';
const PASSWORD = process.env.SEED_PASSWORD || 'safaai@2026';

/** Gandhinagar centre — the citizen feed is a radius query and needs a point. */
const HERE = { latitude: 23.2156, longitude: 72.6369 };

const ACCOUNTS = {
  citizen: ['citizen', 'citizen1@safaai.gov.in'],
  driver: ['driver', 'driver1@safaai.gov.in'],
  officer: ['officer', 'officer1@safaai.gov.in'],
  admin: ['admin', 'admin@safaai.gov.in'],
};

/**
 * [path, minimum rows, which field to count].
 *
 * The minimum is per section rather than a blanket number because scope
 * legitimately differs: a ward officer owns two of the eight wards, so a
 * by-ward breakdown of two is correct for them and would be a bug for the
 * commissioner.
 */
const SECTIONS = {
  citizen: [
    ['/citizen/home', 1, 'activeComplaints'],
    [`/citizen/feed?latitude=${HERE.latitude}&longitude=${HERE.longitude}`, 5, 'rows'],
    ['/citizen/complaints', 5, 'rows'],
    ['/citizen/credits', 5, 'history'],
    ['/citizen/leaderboard', 5, 'top'],
    ['/citizen/directory', 5, 'rows'],
    ['/citizen/notifications', 5, 'rows'],
    ['/citizen/scheduled-pickup', 5, 'items'],
    ['/citizen/categories', 5, 'rows'],
  ],
  driver: [
    ['/driver/route', 2, 'stops'],
    ['/driver/tasks', 5, 'tasks'],
    ['/driver/fuel-log', 5, 'logs'],
    ['/driver/shift/current', 1, 'shift.breaks'],
    ['/driver/shift/history', 5, 'items'],
    ['/driver/scheduled-tasks', 5, 'items'],
    ['/driver/shift-summary', 1, 'resolvedList'],
  ],
  officer: [
    ['/officer/wards', 1, 'rows'],
    ['/officer/queue', 5, 'items'],
    ['/officer/sla', 5, 'byCategory'],
    ['/officer/fleet', 5, 'rows'],
    ['/officer/ward-drivers', 1, 'rows'],
    ['/officer/shifts', 5, 'onDuty'],
    ['/officer/fuel', 5, 'recent'],
    ['/officer/emergencies', 5, 'driverSos'],
    // Ward-scoped, like /officer/wards above: a two-ward officer seeing five
    // escalations would mean ~20 city-wide, which contradicts the compliance
    // figure on the same screen. The commissioner's view is the wide one.
    ['/officer/escalations', 1, 'rows'],
    ['/officer/analytics', 5, 'categories'],
    ['/officer/hotspots', 5, 'points'],
    ['/officer/scheduled-requests', 5, 'items'],
  ],
  admin: [
    ['/admin/dashboard', 5, 'wards'],
    ['/admin/fleet', 5, 'rows'],
    ['/admin/users', 5, 'items'],
    ['/admin/wards', 5, 'rows'],
    ['/admin/live-routes', 5, 'rows'],
    ['/admin/ward-drivers', 5, 'rows'],
    ['/admin/shifts', 5, 'onDuty'],
    ['/admin/fuel', 5, 'recent'],
    ['/admin/sla', 5, 'byCategory'],
    ['/admin/audit-logs', 5, 'items'],
    ['/admin/model-health', 5, 'daily'],
    ['/admin/analytics', 5, 'categories'],
    ['/admin/hotspots', 5, 'predictions'],
    ['/admin/exports', 5, 'rows'],
    ['/admin/categories', 5, 'rows'],
  ],
};

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Reads "a.b" out of a payload, treating a bare array response as `rows`. */
function countAt(body, path) {
  if (Array.isArray(body) && path === 'rows') return body.length;
  let node = body;
  for (const key of path.split('.')) {
    if (node == null) return null;
    node = node[key];
  }
  return Array.isArray(node) ? node.length : node == null ? null : 1;
}

async function login(portal, email) {
  const res = await fetch(`${BASE}/auth/${portal}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.accessToken) throw new Error(`${portal} login failed (${res.status}) ${JSON.stringify(body).slice(0, 120)}`);
  return { authorization: `Bearer ${body.accessToken}` };
}

const getJson = async (headers, path) => {
  const res = await fetch(BASE + path, { headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON is a failure below */ }
  return { status: res.status, body, text };
};

async function main() {
  console.log(`\nDemo data check — every section, all four portals\n${'='.repeat(64)}`);

  const tokens = {};
  for (const [portal, [loginPortal, email]] of Object.entries(ACCOUNTS)) {
    tokens[portal] = await login(loginPortal, email);
  }

  for (const [portal, sections] of Object.entries(SECTIONS)) {
    console.log(`\n${portal.toUpperCase()}`);
    for (const [path, min, field] of sections) {
      const { status, body, text } = await getJson(tokens[portal], path);
      if (status !== 200) {
        check(`${path} responds`, false, `HTTP ${status} ${text.slice(0, 90)}`);
        continue;
      }
      const n = countAt(body, field);
      check(`${path} → ${field} >= ${min}`, typeof n === 'number' && n >= min, `got ${n}`);
    }
  }

  // ------------------------------------------------ cross-portal agreement --
  console.log(`\nCROSS-PORTAL SYNC`);

  // A driver's own summary and their live shift describe one shift; they used
  // to disagree because only one of the two queries loaded the break rows.
  const cur = (await getJson(tokens.driver, '/driver/shift/current')).body;
  const sum = (await getJson(tokens.driver, '/driver/shift-summary')).body;
  check('driver shift/current and shift-summary are the same shift',
    cur?.shift?.id === sum?.shift?.id, `${cur?.shift?.id} vs ${sum?.shift?.id}`);
  check('…and report the same break minutes',
    cur?.shift?.breakMinutes === sum?.shift?.breakMinutes,
    `${cur?.shift?.breakMinutes} vs ${sum?.shift?.breakMinutes}`);

  // The ward roster and the shift board are two views of one set of shifts.
  const wards = (await getJson(tokens.admin, '/admin/ward-drivers')).body;
  const board = (await getJson(tokens.admin, '/admin/shifts')).body;
  const roster = (Array.isArray(wards) ? wards : []).flatMap((w) => w.drivers ?? []);
  const rosterBreaks = roster.filter((d) => d.onBreak);
  const boardBreaks = (board?.onDuty ?? []).filter((s) => s.onBreak);
  check('roster and shift board agree on who is on break',
    rosterBreaks.length === boardBreaks.length, `${rosterBreaks.length} vs ${boardBreaks.length}`);
  const boardMins = new Map(boardBreaks.map((s) => [s.driver?.id, s.breakMinutes]));
  check('…and on how long each has been stood down',
    rosterBreaks.every((d) => boardMins.get(d.id) === d.shift?.breakMinutes),
    rosterBreaks.filter((d) => boardMins.get(d.id) !== d.shift?.breakMinutes)
      .map((d) => d.name).join(', '));
  check('at least one driver is on a break right now', rosterBreaks.length >= 1,
    'nothing to demonstrate on the shift board');

  // Every truck that is meant to be working has a beat, or a driver signs in
  // to an empty screen — which is what a judge would open first.
  const fleet = (await getJson(tokens.admin, '/admin/fleet')).body;
  const routes = (await getJson(tokens.admin, '/admin/live-routes')).body;
  const working = (fleet?.rows ?? []).filter((v) => !v.maintenanceFlag && v.status !== 'IDLE');
  const routed = new Set((routes?.rows ?? []).map((r) => r.vehicle?.id ?? r.vehicleId));
  const idle = working.filter((v) => !routed.has(v.id));
  check('every working truck has a route today', idle.length === 0,
    `${idle.length} without: ${idle.slice(0, 4).map((v) => v.registrationNumber).join(', ')}`);

  // GPS health has to be measured, not assumed: a fleet that is uniformly
  // "Strong signal" is the signature of no ping data at all.
  const grades = new Set(roster.map((d) => d.gps?.status).filter(Boolean));
  check('GPS health shows more than one grade across the fleet', grades.size >= 3,
    `grades seen: ${[...grades].join(', ') || 'none'}`);

  console.log(`\n${'='.repeat(64)}\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nSome sections are empty or disagree. Re-run `npm run seed`, and if it\n' +
      'persists the section itself is querying for something the seed never makes.\n');
    process.exit(1);
  }
  console.log('Every section has data and the portals agree.\n');
}

main().catch((err) => {
  console.error(`\nverify:demo could not run — ${err.message}`);
  console.error('Is the API up? It defaults to http://localhost:5100/api (override with API_URL).\n');
  process.exit(1);
});
