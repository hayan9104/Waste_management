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

/**
 * Processing streams — the axis that decides *which company* takes the load,
 * as opposed to WASTE_CATEGORIES above, which is what the citizen reported.
 */
export const WASTE_STREAMS = [
  { id: 'BIO', label: 'Bio / wet', hint: 'Organic — kitchen, garden, animal remains', tone: 'success' },
  { id: 'NON_BIO', label: 'Non-bio / dry', hint: 'Recyclable — paper, plastic, glass, metal, rubble', tone: 'info' },
  { id: 'HAZARDOUS', label: 'Hazardous', hint: 'Licensed handler only — clinical, chemical, sewage', tone: 'danger' },
  { id: 'E_WASTE', label: 'E-waste', hint: 'Electronics, batteries, cabling', tone: 'warning' },
  { id: 'OTHER', label: 'Mixed / unsorted', hint: 'Needs an officer to determine the stream', tone: 'muted' },
];

export const STREAM_MAP = Object.fromEntries(WASTE_STREAMS.map((s) => [s.id, s]));

/**
 * Incident category -> processing stream.
 *
 * The vision model is trained on incident classes (garbage_pile,
 * medical_waste, ...) and has no head that predicts a processing stream, so
 * the stream is derived from the class it did predict rather than guessed at
 * separately. That keeps one model, one confidence number and one review
 * threshold, instead of a second classifier whose disagreements with the first
 * nobody could adjudicate.
 *
 * `certainty` scales the inherited vision confidence. A class that determines
 * its stream outright (medical waste is hazardous, full stop) keeps the
 * model's own confidence; a class that genuinely spans streams is damped, so
 * an unsorted pile the model was 95% sure about still lands under the 0.70
 * review gate and reaches an officer instead of being auto-routed to a
 * composting plant.
 */
export const STREAM_BY_CATEGORY = {
  MEDICAL_WASTE: { stream: 'HAZARDOUS', certainty: 1 },
  SEWAGE_OVERFLOW: { stream: 'HAZARDOUS', certainty: 1 },
  BURNING_WASTE: { stream: 'HAZARDOUS', certainty: 1 },
  CONSTRUCTION_DEBRIS: { stream: 'NON_BIO', certainty: 1 },
  DEAD_ANIMAL: { stream: 'BIO', certainty: 1 },
  OVERFLOWING_BIN: { stream: 'BIO', certainty: 0.85 },
  // A heap in the street is whatever was thrown on it. The commonest answer is
  // wet organic waste, but often enough it is not, so this never clears the
  // review gate on its own.
  GARBAGE_PILE: { stream: 'BIO', certainty: 0.6 },
  // Fly-tipping is defined by the act, not the contents — the load could be
  // anything, including the e-waste no incident class covers.
  ILLEGAL_DUMPING: { stream: 'OTHER', certainty: 0.4 },
  OTHER: { stream: 'OTHER', certainty: 0.3 },
};

/** Below this, the stream is a suggestion an officer has to confirm. */
export const STREAM_REVIEW_THRESHOLD = 0.7;

/**
 * Nominal weights for the officer's quantity bands, in kg.
 *
 * Volume analytics prefer `actualQuantityKg` recorded at completion; these
 * stand in for handoffs that have not been weighed yet, so a chart covering
 * this week is never blank merely because collection is still in progress.
 * They are estimates and are labelled as such wherever they are charted.
 */
export const QUANTITY_NOMINAL_KG = {
  SMALL: 25,
  MEDIUM: 100,
  LARGE: 400,
};

/**
 * Derive the processing stream from a classified incident category.
 *
 * @param {string|null} category   WasteCategory id
 * @param {number} confidence      0-1, the vision model's confidence in it
 */
export function deriveWasteStream(category, confidence = 0) {
  const rule = STREAM_BY_CATEGORY[category] ?? STREAM_BY_CATEGORY.OTHER;
  const conf = Math.min(1, Math.max(0, Number(confidence) || 0));
  const derived = Number((conf * rule.certainty).toFixed(3));
  return {
    stream: rule.stream,
    confidence: derived,
    reviewNeeded: derived < STREAM_REVIEW_THRESHOLD,
  };
}

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
  /** A complaint handed to a collection truck. */
  ASSIGNMENT_NEW: 'assignment:new',
  /**
   * A complaint handed to a processing company. Deliberately a separate event
   * from ASSIGNMENT_NEW: the driver handsets listen on that one, and waking
   * every truck in the ward for an office-side routing decision would be noise
   * on the one screen that has to stay quiet while someone is driving.
   */
  COMPANY_ASSIGNMENT_CREATED: 'assignment:created',
  COMPANY_ASSIGNMENT_UPDATE: 'assignment:update',
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
  WASTE_STREAMS,
  STREAM_MAP,
  STREAM_BY_CATEGORY,
  STREAM_REVIEW_THRESHOLD,
  QUANTITY_NOMINAL_KG,
  deriveWasteStream,
  EMERGENCY_TYPES,
  COMPLAINT_FLOW,
  SOCKET_EVENTS,
  CREDIT_RULES,
};
