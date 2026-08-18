import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Real calibrated parameters extracted from trained/tuned checkpoint files
 * (originally PyTorch .pt exports). Read once at boot as plain JSON rather
 * than parsing pickle binaries at runtime — same numbers, no exotic parsing
 * dependency in production. See each file's own `note` field for exactly
 * which of these are actually wired into live behaviour vs kept for
 * transparency on the admin Model Health page.
 */
const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, `${name}.json`), 'utf8'));

export const CALIBRATION = {
  classifier: load('classifier'),
  hotspot: load('hotspot'),
  tsp: load('tsp'),
  whatif: load('whatif'),
  nlp: load('nlp'),
};

export default CALIBRATION;
