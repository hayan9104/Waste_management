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
  Sparkles,
  Trash2,
  Lock,
  X,
} from 'lucide-react';
import { api, errorMessage, tokenStore } from '../lib/api';
import { BaseMap, PinMarker, FollowTarget, CITY_CENTER, snapToCity } from './map/Map';
import { CameraCapture } from './CameraCapture';
import { toast } from './ui';

/**
 * Book a complaint without leaving the chat.
 *
 * Spacious desktop-friendly rectangular intake modal with 2-column layout,
 * synchronized camera + GPS auto-detection, and locked pinpoint accuracy.
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

/** Long edge in px. */
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
        if (snapped.moved) toast.warn('You appear to be outside Gandhinagar — the pin was snapped to the city.');
        setPosition({ lat: snapped.lat, lng: snapped.lng });
        setLocating(false);
      },
      () => {
        setPosition({ lat: CITY_CENTER[0], lng: CITY_CENTER[1] });
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setBusy(false);
    locate();
  }, [open, locate]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

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
        className="fixed inset-0 z-[90] bg-black/65 backdrop-blur-sm transition-opacity"
        onClick={() => !busy && onClose()}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="File a direct waste complaint"
        tabIndex={-1}
        className="fixed inset-0 z-[91] flex flex-col overflow-hidden bg-surface outline-none
                   md:inset-auto md:left-1/2 md:top-1/2 md:h-auto md:max-h-[90vh] 
                   md:w-[min(64rem,calc(100vw-2rem))] lg:w-[min(72rem,calc(100vw-3rem))]
                   md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-3xl md:border md:border-line md:shadow-2xl"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-brand px-5 py-3.5 text-brand-ink">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/20 shadow-inner">
              <Camera className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-fluid-base font-bold leading-tight">Book a Direct Complaint</h3>
                <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-white/25 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                  <Sparkles className="h-3 w-3" /> AI Quick Intake
                </span>
              </div>
              <p className="truncate text-xs opacity-90">Instant AI photo triage with auto-detected GPS location</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/25 bg-white/15 transition hover:bg-white/30 active:scale-95 cursor-pointer"
          >
            <X className="h-5 w-5" strokeWidth={2.5} />
          </button>
        </div>

        {/* Content Body */}
        {!signedIn ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
            <span className="grid h-16 w-16 place-items-center rounded-2xl bg-brand/10 text-brand">
              <LogIn className="h-8 w-8" />
            </span>
            <h4 className="text-fluid-lg font-bold text-ink">Sign in to file a report</h4>
            <p className="max-w-md text-fluid-xs text-muted">
              Reports are linked to your citizen account so you can track driver arrival in real time and receive Green
              Credits once resolved.
            </p>
            <a href="/login" className="btn-primary btn-md mt-2">
              <LogIn className="h-4 w-4" /> Go to sign in
            </a>
          </div>
        ) : done ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
            <span className="grid h-16 w-16 place-items-center rounded-full bg-ok/10 text-ok">
              <CheckCircle2 className="h-10 w-10" />
            </span>
            <h4 className="text-fluid-xl font-bold text-ink">Complaint Registered Successfully</h4>
            <div className="rounded-xl border border-line bg-sunken px-4 py-2">
              <span className="text-xs text-muted">Ticket Code:</span>{' '}
              <span className="font-mono text-fluid-base font-bold text-brand">{done.code}</span>
            </div>
            <p className="max-w-md text-fluid-xs text-muted">
              Our AI has triaged your report and assigned it to the nearest municipal collection vehicle.
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-3">
              <a href={`/app/complaints/${done.id}`} className="btn-primary btn-md">
                Track Live Status
              </a>
              <button type="button" onClick={onClose} className="btn-ghost btn-md">
                Back to chat
              </button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
              {/* LEFT COLUMN: Photo & Location (6 cols on desktop) */}
              <div className="md:col-span-6 space-y-5">
                {/* 1 — Photo */}
                <section className="space-y-2">
                  <SectionHead
                    n={1}
                    title="Photo of the waste"
                    required
                    hint="Required — our AI reads the waste category and severity"
                  />
                  {preview ? (
                    <div className="relative overflow-hidden rounded-2xl border border-line bg-black/5 shadow-xs">
                      <img src={preview} alt="Captured waste proof" className="aspect-[16/10] w-full object-cover" />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 flex items-center justify-between text-white">
                        <span className="text-xs font-semibold flex items-center gap-1.5">
                          <CheckCircle2 className="h-3.5 w-3.5 text-ok" /> Evidence Attached
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              locate();
                              setCameraOpen(true);
                            }}
                            className="rounded-lg bg-white/20 px-2.5 py-1 text-[11px] font-semibold backdrop-blur hover:bg-white/30 cursor-pointer"
                          >
                            Retake
                          </button>
                          <button
                            type="button"
                            onClick={clearPhoto}
                            className="grid h-7 w-7 place-items-center rounded-lg bg-danger/80 text-white hover:bg-danger cursor-pointer"
                            aria-label="Remove photo"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          locate();
                          setCameraOpen(true);
                        }}
                        className="flex min-h-[7.5rem] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand/50 bg-brand/5 p-4 text-brand transition hover:bg-brand/10 cursor-pointer"
                      >
                        <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand text-brand-ink shadow-sm">
                          <Camera className="h-5 w-5" />
                        </span>
                        <span className="text-fluid-xs font-bold">Take Live Photo</span>
                        <span className="text-[10px] text-muted">Auto-detects GPS</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          locate();
                          fileInput.current?.click();
                        }}
                        className="flex min-h-[7.5rem] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line bg-sunken p-4 text-muted transition hover:border-brand hover:text-brand cursor-pointer"
                      >
                        <span className="grid h-10 w-10 place-items-center rounded-xl bg-elevated text-muted shadow-sm">
                          <ImageIcon className="h-5 w-5" />
                        </span>
                        <span className="text-fluid-xs font-bold">Choose File</span>
                        <span className="text-[10px] text-faint">JPG, PNG, WebP</span>
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

                {/* 3 — Auto-detected Location (Non-editable, Locked) */}
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <SectionHead
                      n={3}
                      title="Auto-Detected GPS Location"
                      required
                      hint="Auto-locked from your device GPS for accurate truck dispatch"
                    />
                    <span className="inline-flex items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 text-[10px] font-bold text-ok">
                      <Lock className="h-3 w-3" /> Auto-Locked
                    </span>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-xs">
                    <div className="h-44 w-full">
                      <BaseMap
                        center={position ? [position.lat, position.lng] : CITY_CENTER}
                        zoom={position ? 16 : 13}
                        satellite={true}
                      >
                        {position && (
                          <>
                            <PinMarker
                              latitude={position.lat}
                              longitude={position.lng}
                              label="Auto-Detected GPS Location (Locked)"
                            />
                            <FollowTarget latitude={position.lat} longitude={position.lng} />
                          </>
                        )}
                      </BaseMap>
                    </div>
                    <div className="flex items-center justify-between border-t border-line bg-sunken/60 px-3 py-2 text-fluid-xs">
                      <button
                        type="button"
                        onClick={locate}
                        disabled={locating}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-elevated px-2.5 py-1 text-fluid-xs font-semibold text-ink hover:bg-sunken shadow-2xs cursor-pointer"
                      >
                        {locating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LocateFixed className="h-3.5 w-3.5 text-brand" />}
                        <span>Refresh GPS Fix</span>
                      </button>
                      <span className="font-mono text-[11px] font-medium text-muted">
                        {position ? `📍 ${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}` : 'Detecting GPS…'}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1 pt-1">
                    <label className="text-[11px] font-semibold text-muted" htmlFor="cb-address">
                      Landmark / Street Note <span className="font-normal text-faint">(Optional)</span>
                    </label>
                    <div className="relative">
                      <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
                      <input
                        id="cb-address"
                        className="field pl-9 py-2 text-fluid-xs"
                        placeholder="e.g. Near Sector 16 Community Center, behind milk booth"
                        value={address}
                        maxLength={300}
                        onChange={(e) => setAddress(e.target.value)}
                      />
                    </div>
                  </div>
                </section>
              </div>

              {/* RIGHT COLUMN: Category, Description & Submit (6 cols on desktop) */}
              <div className="md:col-span-6 space-y-5 flex flex-col justify-between">
                <div className="space-y-5">
                  {/* 2 — Category */}
                  <section className="space-y-2">
                    <SectionHead
                      n={2}
                      title="What is it?"
                      required
                      hint="Select the closest waste type — AI will verify upon upload"
                    />
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {CATEGORIES.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setCategory(c.id)}
                          aria-pressed={category === c.id}
                          className={`flex items-center gap-2 rounded-xl border p-2.5 text-left text-fluid-xs font-semibold transition cursor-pointer ${
                            category === c.id
                              ? 'border-brand bg-brand/10 text-brand ring-1 ring-brand/30 shadow-xs'
                              : 'border-line bg-elevated text-muted hover:border-brand/40 hover:text-ink'
                          }`}
                        >
                          <span className="text-base" aria-hidden="true">{c.emoji}</span>
                          <span className="truncate">{c.label}</span>
                        </button>
                      ))}
                    </div>

                    {isEmergency && (
                      <div className="mt-2 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-fluid-xs text-danger">
                        <Siren className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          <p className="font-bold">🚨 30-Minute Priority Health Hazard</p>
                          <p className="text-[11px] opacity-90">
                            Dispatched directly to the nearest municipal truck with ward officer notification.
                          </p>
                        </div>
                      </div>
                    )}
                  </section>

                  {/* 4 — Description */}
                  <section className="space-y-1.5">
                    <SectionHead n={4} title="Additional Notes" hint="Optional — describe specific access or urgency" />
                    <textarea
                      className="field min-h-[4.5rem] w-full resize-none text-fluid-xs py-2"
                      placeholder="e.g. Garbage overflowing for 2 days, dogs scattering waste around the street"
                      value={description}
                      maxLength={1000}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                    <p className="text-right text-[10px] text-faint">{description.length}/1000</p>
                  </section>

                  {/* Green Credits Perk Card */}
                  <div className="flex items-center gap-3 rounded-2xl border border-brand/20 bg-brand/5 p-3 text-fluid-xs text-brand">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand text-brand-ink">
                      <Sparkles className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold">Earn +20 Green Credits</p>
                      <p className="text-[11px] text-muted">
                        Automatically credited to your wallet once collection is verified with driver proof photo.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Submit Action Bar */}
                <div className="border-t border-line pt-4 space-y-2">
                  {!canSubmit && !busy && (
                    <p className="text-center text-[11px] font-medium text-muted">
                      {!photo
                        ? '⚠️ Please attach or capture a waste photo'
                        : !category
                        ? '⚠️ Please select a waste category'
                        : '📍 Waiting for GPS location lock…'}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!canSubmit}
                    className="btn-primary flex w-full items-center justify-center gap-2 py-3 text-fluid-sm font-bold shadow-md shadow-brand/20 disabled:opacity-50 cursor-pointer"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    <span>{busy ? 'Filing official complaint…' : 'Submit Complaint'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
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
    <div className="flex items-start gap-2">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand/10 text-[11px] font-bold text-brand">
        {n}
      </span>
      <div className="min-w-0">
        <h4 className="text-fluid-xs font-bold leading-tight text-ink">
          {title}
          {required && <span className="ml-1 text-danger">*</span>}
        </h4>
        {hint && <p className="text-[11px] text-muted">{hint}</p>}
      </div>
    </div>
  );
}
