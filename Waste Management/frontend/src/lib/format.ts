export const CATEGORY_LABELS: Record<string, string> = {
  GARBAGE_PILE: 'Garbage pile',
  OVERFLOWING_BIN: 'Overflowing bin',
  DEAD_ANIMAL: 'Dead animal',
  CONSTRUCTION_DEBRIS: 'Construction debris',
  MEDICAL_WASTE: 'Medical waste',
  ILLEGAL_DUMPING: 'Illegal dumping',
  SEWAGE_OVERFLOW: 'Sewage overflow',
  BURNING_WASTE: 'Burning waste',
  OTHER: 'Other',
};

export const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending',
  VERIFIED: 'Verified',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  REJECTED: 'Rejected',
};

/** Status colour is identical in every portal so the coding is learnable. */
export const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'ok' | 'danger'> = {
  PENDING: 'neutral',
  VERIFIED: 'info',
  ASSIGNED: 'info',
  IN_PROGRESS: 'warn',
  RESOLVED: 'ok',
  REJECTED: 'danger',
};

export const SEVERITY_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warn',
  CRITICAL: 'danger',
};

/**
 * Processing streams — which company may take the load, as distinct from
 * CATEGORY_LABELS above, which is what the citizen reported seeing.
 */
export const STREAM_LABELS: Record<string, string> = {
  BIO: 'Bio / wet',
  NON_BIO: 'Non-bio / dry',
  HAZARDOUS: 'Hazardous',
  E_WASTE: 'E-waste',
  OTHER: 'Mixed / unsorted',
  UNCLASSIFIED: 'Not yet classified',
};

export const STREAM_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'ok' | 'danger'> = {
  BIO: 'ok',
  NON_BIO: 'info',
  HAZARDOUS: 'danger',
  E_WASTE: 'warn',
  OTHER: 'neutral',
  UNCLASSIFIED: 'neutral',
};

/** Chart colours, keyed so a stream is the same colour in every chart. */
export const STREAM_COLOR: Record<string, string> = {
  BIO: '#16a34a',
  NON_BIO: '#0ea5e9',
  HAZARDOUS: '#ef4444',
  E_WASTE: '#f59e0b',
  OTHER: '#a855f7',
  UNCLASSIFIED: '#94a3b8',
};

export const ASSIGNMENT_STATUS_LABELS: Record<string, string> = {
  PENDING_PICKUP: 'Awaiting pickup',
  PICKED: 'Picked up',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const ASSIGNMENT_STATUS_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'ok' | 'danger'> = {
  PENDING_PICKUP: 'warn',
  PICKED: 'info',
  COMPLETED: 'ok',
  CANCELLED: 'neutral',
};

export const QUANTITY_LABELS: Record<string, string> = {
  SMALL: 'Small (~25kg)',
  MEDIUM: 'Medium (~100kg)',
  LARGE: 'Large (~400kg)',
};

/** Kilograms, rounded the way a weighbridge slip would read. */
export const formatKg = (kg?: number | null) => {
  if (kg == null) return '—';
  if (kg >= 1000) return `${(kg / 1000).toFixed(kg >= 10_000 ? 0 : 1)} t`;
  return `${Math.round(kg)} kg`;
};

export function timeAgo(input?: string | Date | null): string {
  if (!input) return '—';
  const then = new Date(input).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (Number.isNaN(seconds)) return '—';
  if (Math.abs(seconds) < 60) return seconds >= 0 ? 'just now' : 'in a moment';

  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
  ];
  let value = seconds;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  for (const [step, name] of units) {
    if (Math.abs(value) < step) break;
    value = Math.round(value / step);
    unit = name;
  }
  return new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' }).format(-value, unit);
}

export function formatDateTime(input?: string | Date | null): string {
  if (!input) return '—';
  return new Date(input).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(input?: string | Date | null): string {
  if (!input) return '—';
  return new Date(input).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDuration(minutes?: number | null): string {
  if (minutes == null) return '—';
  const abs = Math.abs(minutes);
  if (abs < 60) return `${Math.round(minutes)} min`;
  if (abs < 1440) {
    const h = Math.floor(abs / 60);
    const m = Math.round(abs % 60);
    return `${minutes < 0 ? '-' : ''}${h}h${m ? ` ${m}m` : ''}`;
  }
  return `${(minutes / 1440).toFixed(1)} days`;
}

export const formatDistance = (metres?: number | null) =>
  metres == null ? '—' : metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;

/** Great-circle distance in metres — used client-side for GPS-proximity gates. */
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const formatNumber = (n?: number | null) =>
  n == null ? '—' : new Intl.NumberFormat('en-IN').format(Math.round(n));

export const pct = (n?: number | null) => (n == null ? '—' : `${Math.round(n)}%`);

export const initials = (name?: string) =>
  (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

/** Confidence phrasing that never overstates the model. */
export function confidenceLabel(confidence: number, threshold = 0.7) {
  if (confidence >= threshold) return { label: 'AI verified', tone: 'ok' as const };
  if (confidence >= 0.45) return { label: 'Needs review', tone: 'warn' as const };
  return { label: 'Low confidence', tone: 'danger' as const };
}

/**
 * Analyzes photo luminance and contrast to prevent black screens,
 * covered lenses, solid colors, or blank test images from being submitted.
 */
export async function validateWastePhoto(file: File): Promise<{ valid: boolean; reason?: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { valid: true };
    ctx.drawImage(bitmap, 0, 0, 64, 64);
    const imgData = ctx.getImageData(0, 0, 64, 64).data;

    let totalLuminance = 0;
    let minLum = 255;
    let maxLum = 0;
    const numPixels = 64 * 64;

    for (let i = 0; i < imgData.length; i += 4) {
      const r = imgData[i];
      const g = imgData[i + 1];
      const b = imgData[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      totalLuminance += lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const avgLuminance = totalLuminance / numPixels;
    const variance = maxLum - minLum;

    // Pitch black or covered lens
    if (avgLuminance < 16) {
      return {
        valid: false,
        reason: 'The captured image appears completely dark or covered. Please point your camera directly at the actual garbage site with sufficient lighting.',
      };
    }

    // Solid blank color or completely washed out
    if (variance < 8 && (avgLuminance < 30 || avgLuminance > 230)) {
      return {
        valid: false,
        reason: 'The photo appears blank or obscured. Please capture a genuine and clear photo of the civic waste issue.',
      };
    }

    return { valid: true };
  } catch {
    return { valid: true };
  }
}
