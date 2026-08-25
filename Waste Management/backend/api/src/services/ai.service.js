import axios from 'axios';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { CATEGORY_MAP, WASTE_CATEGORIES, STREAM_MAP, deriveWasteStream } from '../config/constants.js';

const client = axios.create({ baseURL: env.aiServiceUrl, timeout: 15000 });

/**
 * The two AI backends this project ships speak different dialects, and only
 * one of them can be running on AI_SERVICE_URL at a time:
 *
 *   backend/vision (Python/YOLO)  POST /api/classify-waste   field: file
 *       -> { status, predicted_category, confidence: 0-100, needs_manual_review }
 *   backend/ai     (Node stand-in) POST /vision/classify     field: image
 *       -> { category, confidence: 0-1, modelVersion, alternatives, detections }
 *
 * Asking for one shape and getting the other is not a soft failure -- it is
 * three separate silent wrong answers, so both are tried and both are
 * normalised to one contract before anything downstream sees them.
 */
const CLASSIFY_ENDPOINTS = [
  { path: '/api/classify-waste', field: 'file' },
  { path: '/vision/classify', field: 'image' },
];

/**
 * Folds either backend's response into the canonical shape
 * `{ modelVersion, category, confidence, alternatives, detections }`.
 *
 * Two traps live here. The category key differs (`category` vs
 * `predicted_category`), so reading only the first silently classified every
 * photo as OTHER. And the confidence *scale* differs: the Python service
 * returns a percentage (92.5), while every consumer compares against
 * AI_CONFIDENCE_AUTO_APPROVE on a 0-1 scale -- so an unnormalised 92.5 clears
 * a 0.7 gate unconditionally, auto-approving literally every report, and
 * renders as "9250%" in the UI. Anything above 1 is therefore a percentage.
 */
export function normalizeClassification(data, { latencyMs }) {
  const category = data?.category ?? data?.predicted_category ?? data?.label ?? null;

  let confidence = Number(data?.confidence ?? 0);
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence > 1) confidence /= 100;
  confidence = Math.min(1, Math.max(0, confidence));

  const normalizedCategory = category ? String(category).trim().toUpperCase() : null;

  /**
   * The processing stream rides along with the classification.
   *
   * A downstream caller that has the category already has everything needed to
   * work out the stream, so deriving it here means there is exactly one place
   * that decides — rather than each of the citizen intake path, the officer
   * re-classify path and the seed script arriving at their own answer.
   *
   * The service is allowed to send its own `waste_stream` if a future model
   * gains that head; when it does, it wins over the derivation.
   */
  const declaredStream = data?.waste_stream ?? data?.wasteStream ?? null;
  const derived = deriveWasteStream(normalizedCategory, confidence);
  const stream = declaredStream
    ? { stream: String(declaredStream).trim().toUpperCase(), confidence: Number(confidence.toFixed(3)) }
    : derived;

  return {
    modelVersion: data?.modelVersion ?? data?.model_version ?? 'vision-service',
    engine: data?.engine ?? null,
    category: normalizedCategory,
    label: data?.label ?? null,
    confidence: Number(confidence.toFixed(3)),
    wasteStream: STREAM_MAP[stream.stream] ? stream.stream : 'OTHER',
    wasteStreamConfidence: stream.confidence,
    wasteStreamDerived: !declaredStream,
    alternatives: Array.isArray(data?.alternatives) ? data.alternatives : [],
    detections: Array.isArray(data?.detections) ? data.detections : [],
    needsManualReview: data?.needs_manual_review ?? data?.needsManualReview ?? null,
    remark: data?.remark ?? null,
    latencyMs: data?.latencyMs ?? latencyMs,
  };
}

export async function classifyWaste({ buffer, mimetype = 'image/jpeg', filename = 'photo.jpg', hint }) {
  const started = Date.now();
  const failures = [];

  for (const { path, field } of CLASSIFY_ENDPOINTS) {
    try {
      const form = new FormData();
      form.append(field, new Blob([buffer], { type: mimetype }), filename);
      if (hint) form.append('hint', hint);

      const { data } = await client.post(path, form);
      const result = normalizeClassification(data, { latencyMs: Date.now() - started });
      // A 200 with no usable category is not a successful classification --
      // treat it as this endpoint being the wrong dialect and try the other.
      if (!result.category) {
        failures.push(`${path}: 200 but no category in response`);
        continue;
      }
      return { ...result, degraded: false, endpoint: path };
    } catch (err) {
      failures.push(`${path}: ${err.response?.status || err.code || err.message}`);
    }
  }

  return {
    ...localClassify(buffer, hint),
    latencyMs: Date.now() - started,
    degraded: true,
    degradedReason: `Vision service unusable at ${env.aiServiceUrl} (${failures.join('; ')}) — deterministic fallback engaged`,
  };
}

/** Fraud/troll scoring. Features are computed from data we actually hold. */
export async function scoreFraud(features) {
  try {
    const { data } = await client.post('/fraud/score', features, { timeout: 6000 });
    return { ...data, degraded: false };
  } catch {
    return { ...localFraudScore(features), degraded: true };
  }
}

/** Hotspot forecast for a ward. */
export async function predictHotspots(payload) {
  try {
    const { data } = await client.post('/hotspot/predict', payload, { timeout: 12000 });
    return { ...data, degraded: false };
  } catch (err) {
    return { predictions: [], degraded: true, degradedReason: err.code || err.message };
  }
}

export async function aiHealth() {
  try {
    const { data } = await client.get('/', { timeout: 3500 });
    return {
      reachable: true,
      url: env.aiServiceUrl,
      status: 'healthy',
      activeModel: 'YOLOv8 Custom Waste Classifier (safaai_best.pt)',
      classes: ['overflowing_bin', 'dead_animal', 'medical_waste', 'construction_debris', 'illegal_dumping', 'garbage_pile'],
      ...data,
    };
  } catch (err) {
    try {
      const { data } = await client.get('/health', { timeout: 3500 });
      return {
        reachable: true,
        url: env.aiServiceUrl,
        status: 'healthy',
        activeModel: 'YOLOv8 Custom Waste Classifier (safaai_best.pt)',
        classes: ['overflowing_bin', 'dead_animal', 'medical_waste', 'construction_debris', 'illegal_dumping', 'garbage_pile'],
        ...data,
      };
    } catch {
      return {
        reachable: false,
        url: env.aiServiceUrl,
        error: err.code || err.message,
        fallbackActive: true,
      };
    }
  }
}

/**
 * Local fallback classifier — deterministic on the image bytes, so the same
 * photo always yields the same category. Never claims high confidence.
 */
export function localClassify(buffer, hint) {
  /**
   * The stream is attached here as well as in normalizeClassification, because
   * this path never goes through it — classifyWaste spreads this object
   * straight into its return when the vision service is unreachable. Leaving
   * it out meant every complaint filed during an outage was stored with no
   * stream at all, and those are exactly the ones an officer most needs to
   * see flagged for review.
   */
  const withStream = (category, confidence) => {
    const derived = deriveWasteStream(category, confidence);
    return {
      modelVersion: 'fallback-v1',
      category,
      confidence: Number(confidence.toFixed(3)),
      wasteStream: STREAM_MAP[derived.stream] ? derived.stream : 'OTHER',
      wasteStreamConfidence: derived.confidence,
      wasteStreamDerived: true,
      alternatives: [],
      detections: [],
    };
  };

  if (hint && CATEGORY_MAP[hint]) return withStream(hint, 0.55);

  const digest = crypto.createHash('sha256').update(buffer ?? Buffer.from('safaai')).digest();
  const category = WASTE_CATEGORIES[digest[0] % WASTE_CATEGORIES.length].id;
  const confidence = 0.42 + (digest[1] / 255) * 0.22; // deliberately below the auto-approve gate

  return withStream(category, confidence);
}

/**
 * Logistic-style fraud score over real signals.
 */
export function localFraudScore(f = {}) {
  const signals = [];
  let score = 0.05;

  if (f.samePhotoHashCount > 1) {
    score += 0.45;
    signals.push('exact_duplicate_photo_hash');
  }
  if (f.rapidSubmissionsInWard5m > 3) {
    score += 0.25;
    signals.push('velocity_burst_ward');
  }
  if (f.reportedFarFromUserWard) {
    score += 0.15;
    signals.push('out_of_ward_citizen');
  }
  if (f.exifMissing) {
    score += 0.05;
    signals.push('stripped_exif');
  }

  score = Math.min(0.99, Number(score.toFixed(3)));
  return {
    score,
    flagged: score >= 0.6,
    signals,
    modelVersion: 'rule_heuristic_v1',
  };
}
