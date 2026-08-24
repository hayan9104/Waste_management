/** Shared domain vocabulary — one source of truth for API, AI service and web. */

export const ROLES = {
  CITIZEN: 'CITIZEN',
  DRIVER: 'DRIVER',
  OFFICER: 'OFFICER',
  ADMIN: 'ADMIN',
};

/**
 * Portal namespaces. A token minted for one portal cannot be used on another
 * (plan §3): the `aud` claim is checked against the namespace on every request.
 */
export const PORTALS = {
  CITIZEN: 'citizen',
  DRIVER: 'driver',
  OFFICER: 'officer',
  ADMIN: 'admin',
};

export const ROLE_PORTAL = {
  [ROLES.CITIZEN]: PORTALS.CITIZEN,
  [ROLES.DRIVER]: PORTALS.DRIVER,
  [ROLES.OFFICER]: PORTALS.OFFICER,
  [ROLES.ADMIN]: PORTALS.ADMIN,
};

export const WASTE_CATEGORIES = [
/**
 * Working SLA windows, not policy maxima.
 *
 * These were a day for a garbage pile and two days for debris. The officer's
 * countdown shows the whole window, so a report could sit nearly untouched
 * and still read as comfortably in time — the clock pushed nobody, which is
 * the opposite of what an SLA is for. Every emergency category now runs the
 * same 30-minute clock the red button already promised the citizen, and the
 * routine ones are hours rather than days.
 */
  { id: 'GARBAGE_PILE', label: 'Garbage pile', emergency: false, severity: 'MEDIUM', slaMinutes: 240 },
  { id: 'OVERFLOWING_BIN', label: 'Overflowing bin', emergency: false, severity: 'MEDIUM', slaMinutes: 180 },
  { id: 'DEAD_ANIMAL', label: 'Dead animal', emergency: true, severity: 'CRITICAL', slaMinutes: 30 },
  { id: 'CONSTRUCTION_DEBRIS', label: 'Construction debris', emergency: false, severity: 'LOW', slaMinutes: 480 },
  { id: 'MEDICAL_WASTE', label: 'Medical waste', emergency: true, severity: 'CRITICAL', slaMinutes: 30 },
  { id: 'ILLEGAL_DUMPING', label: 'Illegal dumping', emergency: false, severity: 'HIGH', slaMinutes: 240 },
  { id: 'SEWAGE_OVERFLOW', label: 'Sewage overflow', emergency: true, severity: 'CRITICAL', slaMinutes: 30 },
  { id: 'BURNING_WASTE', label: 'Burning waste', emergency: true, severity: 'CRITICAL', slaMinutes: 30 },
  { id: 'OTHER', label: 'Other', emergency: false, severity: 'LOW', slaMinutes: 480 },
];

export const CATEGORY_MAP = Object.fromEntries(WASTE_CATEGORIES.map((c) => [c.id, c]));

/** The red-button options on the citizen Emergency Report screen (plan §2.1). */
export const EMERGENCY_TYPES = ['DEAD_ANIMAL', 'MEDICAL_WASTE', 'BURNING_WASTE', 'SEWAGE_OVERFLOW'];

export const COMPLAINT_FLOW = ['PENDING', 'VERIFIED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED'];

export const SOCKET_EVENTS = {
  TRUCK_UPDATE: 'truck:update',
  DRIVER_LOCATION: 'driver:location',
  COMPLAINT_NEW: 'complaint:new',
  COMPLAINT_UPDATE: 'complaint:update',
  EMERGENCY_NEW: 'emergency:new',
  ESCALATION_NEW: 'escalation:new',
  ASSIGNMENT_NEW: 'assignment:new',
  SOS_NEW: 'sos:new',
  NOTIFICATION: 'notification:new',
  STATS_UPDATE: 'stats:update',
};

/** Green credits — awarded from verified evidence, never granted by the UI. */
export const CREDIT_RULES = {
  version: 'credits-v1',
  reportSubmitted: 5,
  reportVerified: 15,
  reportResolved: 10,
  emergencyVerified: 25,
  duplicateReport: 2,
  fakeReport: -20,
};

export default {
  ROLES,
  PORTALS,
  ROLE_PORTAL,
  WASTE_CATEGORIES,
  CATEGORY_MAP,
  EMERGENCY_TYPES,
  COMPLAINT_FLOW,
  SOCKET_EVENTS,
  CREDIT_RULES,
};
