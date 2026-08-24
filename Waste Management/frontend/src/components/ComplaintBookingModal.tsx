import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  CheckCircle2,
  ImageIcon,
  Loader2,
  LocateFixed,
  LogIn,
  MapPin,
  Send,
  Siren,
  Trash2,
  X,
} from 'lucide-react';
import { api, errorMessage, tokenStore } from '../lib/api';
import { BaseMap, LocationPicker, CITY_CENTER, snapToCity } from './map/Map';
import { CameraCapture } from './CameraCapture';
import { toast } from './ui';

/**
 * Book a complaint without leaving the chat.
 *
 * The assistant could explain how to file a report but not actually file one,
 * so every conversation ended by telling the user to go somewhere else and
 * start over. This is the same intake the /app/report page performs — same
 * endpoint, same required fields, same validation — presented as one sheet so
 * the answer and the action live in the same place.
 *
 * Layout is one scrolling body between a pinned header and a pinned action
 * bar. On a phone that is the whole viewport (safe-area padded, since the
 * submit button would otherwise sit under the home indicator); from `sm` up
 * it becomes a centred dialog capped at 92vh so it never outgrows a laptop
 * screen either.
 */

const CATEGORIES: { id: string; label: string; emoji: string }[] = [
  { id: 'GARBAGE_PILE', label: 'Garbage pile', emoji: '🗑️' },
  { id: 'OVERFLOWING_BIN', label: 'Overflowing bin', emoji: '🛢️' },
  { id: 'ILLEGAL_DUMPING', label: 'Illegal dumping', emoji: '🚯' },
  { id: 'CONSTRUCTION_DEBRIS', label: 'Debris', emoji: '🧱' },
  { id: 'DEAD_ANIMAL', label: 'Dead animal', emoji: '⚠️' },
  { id: 'MEDICAL_WASTE', label: 'Medical waste', emoji: '🧪' },
  { id: 'SEWAGE_OVERFLOW', label: 'Sewage overflow', emoji: '💧' },
  { id: 'BURNING_WASTE', label: 'Burning waste', emoji: '🔥' },
  { id: 'OTHER', label: 'Other', emoji: '❓' },
];

/** Categories the API treats as health hazards on a 30-minute SLA. */
const EMERGENCY_IDS = new Set(['DEAD_ANIMAL', 'MEDICAL_WASTE', 'SEWAGE_OVERFLOW', 'BURNING_WASTE']);

/** Long edge in px. A modern phone photo is 12MP; uploading that raw over
 *  mobile data is the slowest step in the whole flow by an order of magnitude. */
const MAX_EDGE = 1280;

async function compress(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ?? file;
  } catch {
    // Any decode failure falls back to the original bytes — a bigger upload is
    // strictly better than a failed report.
    return file;
  }
}

export function ComplaintBookingModal({
  open,
  onClose,
  onBooked,
}: {
  open: boolean;
  onClose: () => void;
  /** Fires with the ticket code so the caller can echo it back into the chat. */
  onBooked?: (code: string, id: string) => void;
}) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ code: string; id: string } | null>(null);

  const signedIn = Boolean(tokenStore.get('citizen'));

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setPosition({ lat: CITY_CENTER[0], lng: CITY_CENTER[1] });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const snapped = snapToCity(pos.coords.latitude, pos.coords.longitude);
        if (snapped.moved) toast.warn('You appear to be outside Gandhinagar — the pin was moved into the city.');
        setPosition({ lat: snapped.lat, lng: snapped.lng });
        setLocating(false);
      },
      () => {
        setPosition({ lat: CITY_CENTER[0], lng: CITY_CENTER[1] });
        setLocating(false);
        toast.warn('Could not read GPS — drag the pin to the exact spot.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, []);

  // Fresh sheet each time it opens; a stale half-filled report from an hour
  // ago is worse than starting clean.
  useEffect(() => {
    if (!open) return;
    setDone(null);
    setBusy(false);
    if (!position) locate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  // The chat panel already locks the body below lg; this covers the desktop
  // case where the page behind would otherwise scroll under the dialog.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function attach(file: File) {
    if (preview) URL.revokeObjectURL(preview);
    setPhoto(file);
    setPreview(URL.createObjectURL(file));
    // The photo and the location should describe the same moment, not wherever
    // the user happened to be when the sheet first opened.
    locate();
  }

  function clearPhoto() {
    if (preview) URL.revokeObjectURL(preview);
    setPhoto(null);
    setPreview('');
    if (fileInput.current) fileInput.current.value = '';
  }

  const canSubmit = Boolean(photo && category && position) && !busy;

  async function submit() {
    if (!canSubmit || !photo || !position) return;
    setBusy(true);
    try {
      const form = new FormData();
      const blob = await compress(photo);
      form.append('photo', blob, 'report.jpg');
      form.append('userCategory', category);
      form.append('latitude', String(position.lat));
      form.append('longitude', String(position.lng));
      if (description.trim()) form.append('description', description.trim());
      // Sent explicitly: the report page omits this, which is why real
      // complaints arrive with a null address and the driver's stop list shows
      // "Reported Location" instead of somewhere they can navigate to.
      if (address.trim()) form.append('address', address.trim());
      form.append('channel', 'APP');

      const { data } = await api('citizen').post('/citizen/complaints', form);
      const code = data?.complaint?.code ?? '';
      const id = data?.complaint?.id ?? '';

      await queryClient.invalidateQueries({ queryKey: ['citizen'] });
      setDone({ code, id });
      onBooked?.(code, id);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not file the report'));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const isEmergency = EMERGENCY_IDS.has(category);

  return (
    <>
      <div
        className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm"
        onClick={() => !busy && onClose()}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="File a waste complaint"
        tabIndex={-1}
        className="fixed inset-0 z-[91] flex flex-col overflow-hidden bg-surface outline-none
                   sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92vh] sm:w-[min(38rem,calc(100vw-2rem))]
                   sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:border sm:border-line sm:shadow-2xl"
      >
        {/* Header — pinned, notch-safe on a full-screen phone sheet. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-brand px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] text-brand-ink sm:pt-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/20">
              <Camera className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-fluid-sm font-bold leading-tight">Book a complaint</h3>
              <p className="truncate text-[11px] opacity-85">Photo, category and location — about 30 seconds</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Close"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/25 bg-white/15 transition hover:bg-white/30 active:scale-95"
          >
            <X className="h-5 w-5" strokeWidth={2.5} />
          </button>
        </div>

        {/* ---------------------------------------------------------------- */}
        {!signedIn ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/10 text-brand">
              <LogIn className="h-7 w-7" />
            </span>
            <h4 className="text-fluid-base font-bold">Sign in to file a report</h4>
            <p className="max-w-xs text-fluid-xs text-muted">
              A report is tied to your account so you can track it and receive the Green Credits when it is resolved.
            </p>
            <a href="/login" className="btn-primary btn-sm mt-1">
              <LogIn className="h-3.5 w-3.5" /> Go to sign in
            </a>
          </div>
        ) : done ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <span className="grid h-16 w-16 place-items-center rounded-full bg-ok/10 text-ok">
              <CheckCircle2 className="h-9 w-9" />
            </span>
            <h4 className="text-fluid-lg font-bold">Report filed</h4>
            <p className="font-mono text-fluid-base font-bold text-brand">{done.code}</p>
            <p className="max-w-xs text-fluid-xs text-muted">
              Our AI has triaged it and the ward officer has it in their queue. You can follow every status change from
              My Reports.
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <a href={`/app/complaints/${done.id}`} className="btn-primary btn-sm">
                Track this report
              </a>
              <button type="button" onClick={onClose} className="btn-ghost btn-sm">
                Back to chat
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Body — the only scrolling region. */}
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
              {/* 1 — Photo */}
              <section>
                <SectionHead n={1} title="Photo of the waste" required hint="Required — our AI reads the category from it" />
                {preview ? (
                  <div className="relative overflow-hidden rounded-2xl border border-line">
                    <img src={preview} alt="Your report" className="aspect-[4/3] w-full object-cover" />
                    <button
                      type="button"
                      onClick={clearPhoto}
                      className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
                      aria-label="Remove photo"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setCameraOpen(true)}
                      className="flex min-h-touch flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-brand/50 bg-brand/5 p-4 text-brand transition hover:bg-brand/10"
                    >
                      <Camera className="h-6 w-6" />
                      <span className="text-fluid-xs font-semibold">Take photo</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      className="flex min-h-touch flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line bg-sunken p-4 text-muted transition hover:border-brand hover:text-brand"
                    >
                      <ImageIcon className="h-6 w-6" />
                      <span className="text-fluid-xs font-semibold">Choose file</span>
                    </button>
                  </div>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) attach(f);
                  }}
                />
              </section>

              {/* 2 — Category */}
              <section>
                <SectionHead n={2} title="What is it?" required hint="Tap the closest match — the AI double-checks it" />
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCategory(c.id)}
                      aria-pressed={category === c.id}
                      className={`flex min-h-[2.25rem] items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-fluid-xs font-medium transition ${
                        category === c.id
                          ? 'border-brand bg-brand/10 text-brand'
                          : 'border-line bg-elevated text-muted hover:border-brand/50 hover:text-ink'
                      }`}
                    >
                      <span aria-hidden="true">{c.emoji}</span>
                      {c.label}
                    </button>
                  ))}
                </div>
                {isEmergency && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-xl border border-danger/30 bg-danger/5 p-2.5 text-fluid-xs text-danger">
                    <Siren className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    This is a health hazard. It skips the queue on a 30-minute clock, the nearest truck is dispatched
                    automatically and the ward officer is paged.
                  </p>
                )}
              </section>

              {/* 3 — Location */}
              <section>
                <SectionHead
                  n={3}
                  title="Where is it?"
                  required
                  hint="Tap the map to move the pin to the exact spot"
                />
                <div className="overflow-hidden rounded-2xl border border-line">
                  <div className="h-44 w-full sm:h-52">
                    <BaseMap
                      center={position ? [position.lat, position.lng] : CITY_CENTER}
                      zoom={position ? 16 : 13}
                      satellite={false}
                    >
                      {position && (
                        <LocationPicker
                          latitude={position.lat}
                          longitude={position.lng}
                          onChange={(lat, lng) => setPosition({ lat, lng })}
                        />
                      )}
                    </BaseMap>
                  </div>
                  <div className="flex items-center gap-2 border-t border-line bg-sunken/50 px-2.5 py-2">
                    <button
                      type="button"
                      onClick={locate}
                      disabled={locating}
                      className="btn-ghost btn-sm shrink-0"
                    >
                      {locating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LocateFixed className="h-3.5 w-3.5" />}
                      Use my GPS
                    </button>
                    <span className="ml-auto truncate font-mono text-[11px] text-muted">
                      {position ? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}` : 'Locating…'}
                    </span>
                  </div>
                </div>

                <label className="label mt-2.5 block" htmlFor="cb-address">
                  Landmark / address <span className="font-normal text-faint">(optional, helps the driver find it)</span>
                </label>
                <div className="relative">
                  <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
                  <input
                    id="cb-address"
                    className="field pl-9"
                    placeholder="e.g. Near Sector 16 bus stop"
                    value={address}
                    maxLength={300}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </div>
              </section>

              {/* 4 — Description */}
              <section>
                <SectionHead n={4} title="Anything else?" hint="Optional — what the photo cannot show" />
                <textarea
                  className="field min-h-[5rem] resize-y"
                  placeholder="e.g. Been lying here for three days, smell is bad in the evening"
                  value={description}
                  maxLength={1000}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <p className="mt-1 text-right text-[11px] text-faint">{description.length}/1000</p>
              </section>
            </div>

            {/* Action bar — pinned, and padded clear of the home indicator. */}
            <div className="shrink-0 border-t border-line bg-surface p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-3">
              {!canSubmit && !busy && (
                <p className="mb-2 text-center text-[11px] text-muted">
                  {!photo ? 'Add a photo to continue' : !category ? 'Pick a category to continue' : 'Waiting for your location…'}
                </p>
              )}
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="btn-primary flex w-full items-center justify-center gap-2 py-3 text-fluid-sm font-semibold disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {busy ? 'Filing your report…' : 'Submit complaint'}
              </button>
            </div>
          </>
        )}
      </div>

      <CameraCapture
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(f) => {
          setCameraOpen(false);
          attach(f);
        }}
      />
    </>
  );
}

function SectionHead({
  n,
  title,
  hint,
  required,
}: {
  n: number;
  title: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div className="mb-2 flex items-start gap-2">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand/10 text-[11px] font-bold text-brand">
        {n}
      </span>
      <div className="min-w-0">
        <h4 className="text-fluid-sm font-semibold leading-tight">
          {title}
          {required && <span className="ml-1 text-danger">*</span>}
        </h4>
        {hint && <p className="text-[11px] text-muted">{hint}</p>}
      </div>
    </div>
  );
}
