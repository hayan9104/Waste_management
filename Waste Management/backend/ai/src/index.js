import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { classify, embed, similarity, forecast, fraudScore, loadModels, MODEL, CATEGORIES } from './models.js';
import { describe } from './imageFeatures.js';

const PORT = Number(process.env.PORT || process.env.AI_PORT || 8100);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '14mb' }));

const stats = { classify: 0, fraud: 0, hotspot: 0, embed: 0, totalMs: 0, startedAt: Date.now() };

/**
 * Root health, matching backend/vision's `GET /`.
 *
 * The API's aiHealth() probes `/` first and only falls back to `/health`,
 * so without this the Node stand-in reported as degraded on its first probe
 * even while it was answering classifications perfectly well.
 */
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'safaai-sarathi-ai',
    message: 'Safaai Sarathi AI stand-in is running.',
    models: MODEL,
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'safaai-sarathi-ai',
    models: MODEL,
    categories: CATEGORIES.length,
    requests: stats,
    avgClassifyMs: stats.classify ? Number((stats.totalMs / stats.classify).toFixed(1)) : 0,
    uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
    note: 'Classifier and duplicate models are documented stand-ins unless ONNX_MODEL_PATH is set; hotspot and fraud are real computations.',
  });
});

app.get('/categories', (_req, res) => res.json(CATEGORIES));

/**
 * POST /vision/classify and POST /api/classify-waste — multipart image, or
 * JSON { image: dataURL }.
 *
 * Two paths and two accepted field names on purpose: the API client was
 * written against backend/vision's route shape (`/api/classify-waste`, field
 * `file`) while this service only ever exposed `/vision/classify` with field
 * `image`. Whichever of the two services is running, the caller should not
 * have to care -- so this one answers to both.
 */
app.post(
  ['/vision/classify', '/api/classify-waste'],
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]),
  (req, res) => {
    const buffer = bufferFrom(req);
    if (!buffer) return res.status(400).json({ error: 'An image file or base64 data URL is required' });

    const result = classify(buffer, req.body?.hint);
    stats.classify += 1;
    stats.totalMs += result.latencyMs;
    return res.json(result);
  }
);

/** Embedding for duplicate detection. */
app.post('/vision/embed', upload.single('image'), (req, res) => {
  const buffer = bufferFrom(req);
  if (!buffer) return res.status(400).json({ error: 'An image is required' });
  stats.embed += 1;
  return res.json(embed(buffer));
});

/** Compare two embeddings (or two images) for duplicate merging. */
app.post('/vision/similarity', upload.fields([{ name: 'a' }, { name: 'b' }]), (req, res) => {
  const a = req.files?.a?.[0] ? embed(req.files.a[0].buffer) : req.body?.a;
  const b = req.files?.b?.[0] ? embed(req.files.b[0].buffer) : req.body?.b;
  if (!a || !b) return res.status(400).json({ error: 'Two embeddings or two images are required' });
  return res.json({ similarity: similarity(a, b), modelVersion: MODEL.duplicate.name });
});

/** Image quality/metadata only — used by the fraud feature builder. */
app.post('/vision/features', upload.single('image'), (req, res) => {
  const buffer = bufferFrom(req);
  if (!buffer) return res.status(400).json({ error: 'An image is required' });
  return res.json(describe(buffer));
});

/** POST /fraud/score — features in, calibrated probability out. */
app.post('/fraud/score', (req, res) => {
  stats.fraud += 1;
  res.json(fraudScore(req.body || {}));
});

/** POST /hotspot/predict — per-ward daily counts in, tomorrow's risk out. */
app.post('/hotspot/predict', (req, res) => {
  const { series, forDate } = req.body || {};
  if (!Array.isArray(series)) return res.status(400).json({ error: 'series[] is required' });
  stats.hotspot += 1;
  return res.json(forecast({ series, forDate: forDate || new Date(Date.now() + 864e5).toISOString().slice(0, 10) }));
});

function bufferFrom(req) {
  // upload.single() fills req.file; upload.fields() fills req.files keyed by
  // field name. The classify route accepts either `image` or `file`, so both
  // shapes have to be read here or a multipart upload silently arrives empty
  // and the caller gets a 400 for a photo it definitely sent.
  if (req.file?.buffer) return req.file.buffer;
  const fielded = req.files?.image?.[0]?.buffer ?? req.files?.file?.[0]?.buffer;
  if (fielded) return fielded;

  const dataUrl = req.body?.image ?? req.body?.file;
  if (typeof dataUrl === 'string') {
    const payload = dataUrl.startsWith('data:') ? dataUrl.split(',')[1] : dataUrl;
    try {
      return Buffer.from(payload, 'base64');
    } catch {
      return null;
    }
  }
  return null;
}

app.use((err, _req, res, _next) => {
  console.error('[ai]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

loadModels().finally(() => {
  app.listen(PORT, () => {
    console.log(`
  Safaai Sarathi AI    http://localhost:${PORT}
  Classifier           ${MODEL.classifier.name} (${MODEL.classifier.engine})
  Hotspot              ${MODEL.hotspot.name} (${MODEL.hotspot.engine})
  Fraud                ${MODEL.fraud.name} (${MODEL.fraud.engine})
`);
  });
});
