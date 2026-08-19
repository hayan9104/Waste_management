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
  { id: 'GARBAGE_PILE', label: 'Garbage pile', emergency: false, severity: 'MEDIUM', slaMinutes: 1440 },
  { id: 'OVERFLOWING_BIN', label: 'Overflowing bin', emergency: false, severity: 'MEDIUM', slaMinutes: 720 },
  { id: 'DEAD_ANIMAL', label: 'Dead animal', emergency: true, severity: 'CRITICAL', slaMinutes: 120 },
  { id: 'CONSTRUCTION_DEBRIS', label: 'Construction debris', emergency: false, severity: 'LOW', slaMinutes: 2880 },
  { id: 'MEDICAL_WASTE', label: 'Medical waste', emergency: true, severity: 'CRITICAL', slaMinutes: 120 },
  { id: 'ILLEGAL_DUMPING', label: 'Illegal dumping', emergency: false, severity: 'HIGH', slaMinutes: 720 },
  { id: 'SEWAGE_OVERFLOW', label: 'Sewage overflow', emergency: true, severity: 'HIGH', slaMinutes: 240 },
  { id: 'BURNING_WASTE', label: 'Burning waste', emergency: true, severity: 'HIGH', slaMinutes: 120 },
  { id: 'OTHER', label: 'Other', emergency: false, severity: 'LOW', slaMinutes: 2880 },
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

/**
 * Real, verified-relevant free stock photos (checked by hand — Unsplash photo
 * IDs are otherwise a coin flip on actual subject matter). Used to backfill
 * any seeded/demo complaint whose photoUrl never got set — a real citizen
 * report always has a photo (the /report endpoint requires one), so a demo
 * record without one is a gap to fill, not a state to render honestly.
 */
export const CITIZEN_PHOTO_POOL = [
  'https://images.unsplash.com/photo-1584744982491-665216d95f8b?w=800', // hand sanitizer + mask
  'https://images.unsplash.com/photo-1532996122724-e3c354a0b15b?w=800', // colour-coded wheelie bins
  'https://images.unsplash.com/photo-1611284446314-60a58ac0deb9?w=800', // labelled compost/waste/recycle bins
  'https://images.unsplash.com/photo-1573497491765-dccce02b29df?w=800', // plastic pollution in water
  'https://images.unsplash.com/photo-1721622248541-001da7c67fbe?w=800', // baled plastic waste
  'https://images.unsplash.com/photo-1662534264036-7bfa0d35de9c?w=800', // litter-strewn dump site
];

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
  CITIZEN_PHOTO_POOL,
};
