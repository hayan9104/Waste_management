import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  ClipboardList,
  Fuel,
  Loader2,
  LogIn,
  LogOut,
  MapPin,
  Play,
  Siren,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { api, errorMessage, tokenStore } from '../lib/api';
import { CameraCapture } from './CameraCapture';
import { Badge, toast } from './ui';
import { CITY_CENTER, snapToCity } from './map/Map';
import { formatDuration, timeAgo } from '../lib/format';

/**
 * Every driver action, reachable from the assistant.
 *
 * A driver is one-handed in a cab, and the actions they need are spread over
 * four different screens (stops, route, fuel, SOS, summary). The assistant can
 * already answer "how do I close a stop" — this makes it able to close one,
 * so the answer and the action are one tap apart instead of a navigation.
 *
 * Deliberately a mode machine rather than separate modals: on a phone these
 * are all the same full-screen sheet, and a back arrow between them is far
 * cheaper for the driver than closing one overlay to open another.
 */

type Mode = 'menu' | 'stops' | 'complete' | 'fuel' | 'sos' | 'summary';

const SOS_REASONS = [
  { id: 'breakdown', label: 'Vehicle breakdown' },
  { id: 'accident', label: 'Road accident' },
  { id: 'fuel', label: 'Out of fuel' },
  { id: 'medical', label: 'Medical emergency' },
  { id: 'other', label: 'Other urgent help' },
];

export function DriverAssistantSheet({
  open,
  initialMode = 'menu',
  onClose,
  onEvent,
}: {
  open: boolean;
  initialMode?: Mode;
  onClose: () => void;
  /** Reports back what happened so the assistant can say it in the chat. */
  onEvent?: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<Mode>(initialMode);
  const [busy, setBusy] = useState(false);

  // complete-a-stop
  const [task, setTask] = useState<any | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [note, setNote] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);

  // fuel
  const [litres, setLitres] = useState('');
  const [cost, setCost] = useState('');
  const [odometer, setOdometer] = useState('');

  // sos
  const [sosReason, setSosReason] = useState('breakdown');
  const [sosMessage, setSosMessage] = useState('');
  const [sosArmed, setSosArmed] = useState(false);

  const signedIn = Boolean(tokenStore.get('driver'));

  const tasks = useQuery({
    queryKey: ['driver', 'assistant', 'tasks'],
    queryFn: async () => (await api('driver').get('/driver/tasks', { params: { status: 'ALL' } })).data,
    enabled: open && signedIn && (mode === 'stops' || mode === 'complete' || mode === 'menu'),
  });

  const shift = useQuery({
    queryKey: ['driver', 'assistant', 'shift'],
    queryFn: async () => (await api('driver').get('/driver/shift/current')).data,
    enabled: open && signedIn,
  });

  const summary = useQuery({
    queryKey: ['driver', 'assistant', 'summary'],
    queryFn: async () => (await api('driver').get('/driver/summary')).data,
    enabled: open && signedIn && mode === 'summary',
  });

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setSosArmed(false);
      panelRef.current?.focus();
    }
  }, [open, initialMode]);

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

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['driver'] }),
    [queryClient]
  );

  /** Best-effort GPS; never blocks an action, least of all an SOS. */
  function fix(): Promise<{ latitude: number; longitude: number }> {
    return new Promise((resolve) => {
      const fallback = { latitude: CITY_CENTER[0], longitude: CITY_CENTER[1] };
      if (!navigator.geolocation) return resolve(fallback);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const s = snapToCity(pos.coords.latitude, pos.coords.longitude);
          resolve({ latitude: s.lat, longitude: s.lng });
        },
        () => resolve(fallback),
        { enableHighAccuracy: true, timeout: 6000 }
      );
    });
  }

  async function run<T>(fn: () => Promise<T>, failure: string): Promise<T | null> {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      toast.error(errorMessage(err, failure));
      return null;
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- actions --
  async function toggleShift() {
    const onShift = shift.data?.onShift;
    const res = await run(async () => {
      const body = await fix();
      const path = onShift ? '/driver/shift/end' : '/driver/shift/start';
      return (await api('driver').post(path, body)).data;
    }, onShift ? 'Could not end your shift' : 'Could not start your shift');
    if (!res) return;
    await refresh();
    const msg = onShift
      ? `Shift ended — ${formatDuration(res.minutes ?? 0)} on duty, ${res.distanceKm ?? 0} km driven.`
      : 'Shift started. You are now on duty and your ward officer can see you.';
    toast.success(msg);
    onEvent?.(msg);
  }

  async function startTask(t: any) {
    const res = await run(
      async () => (await api('driver').post(`/driver/tasks/${t.id}/start`)).data,
      'Could not start that task'
    );
    if (!res) return;
    await refresh();
    const msg = `Started ${t.code}. Take the proof photo when the site is clear.`;
    toast.success(msg);
    onEvent?.(msg);
  }

  async function completeTask() {
    if (!task || !photo) return;
    const res = await run(async () => {
      const form = new FormData();
      form.append('photo', photo);
      if (note.trim()) form.append('note', note.trim());
      return (await api('driver').post(`/driver/tasks/${task.id}/complete`, form)).data;
    }, 'Could not close that task');
    if (!res) return;
    await refresh();
    const msg = `${task.code} closed with photo proof. The citizen has been credited.`;
    toast.success(msg);
    onEvent?.(msg);
    clearPhoto();
    setNote('');
    setTask(null);
    setMode('stops');
  }

  async function logFuel() {
    const res = await run(async () => {
      const body: Record<string, number | string> = {};
      if (litres) body.liters = Number(litres);
      if (cost) body.cost = Number(cost);
      if (odometer) body.odometerKm = Number(odometer);
      return (await api('driver').post('/driver/fuel-log', body)).data;
    }, 'Could not save the fuel entry');
    if (!res) return;
    await refresh();
    const msg = `Fuel logged${litres ? ` — ${litres} L` : ''}${cost ? `, ₹${cost}` : ''}.`;
    toast.success(msg);
    onEvent?.(msg);
    setLitres('');
    setCost('');
    setOdometer('');
    setMode('menu');
  }

  async function raiseSos() {
    const res = await run(async () => {
      const pos = await fix();
      return (
        await api('driver').post('/driver/sos', {
          reason: sosReason,
          message: sosMessage.trim() || undefined,
          ...pos,
        })
      ).data;
    }, 'Could not raise the SOS — call your control room directly');
    if (!res) return;
    await refresh();
    const msg = 'SOS raised. Your ward officer has been paged with your location.';
    toast.success(msg);
    onEvent?.(msg);
    setSosMessage('');
    setSosArmed(false);
    setMode('menu');
  }

  // ------------------------------------------------------------------ photo --
  function attach(file: File) {
    if (preview) URL.revokeObjectURL(preview);
    setPhoto(file);
    setPreview(URL.createObjectURL(file));
  }
  function clearPhoto() {
    if (preview) URL.revokeObjectURL(preview);
    setPhoto(null);
    setPreview('');
  }

  if (!open) return null;

  const onShift = Boolean(shift.data?.onShift);
  const list: any[] = tasks.data?.tasks ?? [];
  const openTasks = list.filter((t) => t.status !== 'RESOLVED');

  const TITLES: Record<Mode, string> = {
    menu: 'Driver assistant',
    stops: "Today's stops",
    complete: 'Close this stop',
    fuel: 'Log a fuel fill-up',
    sos: 'Raise an SOS',
    summary: 'Your day so far',
  };

  return (
    <>
      <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm" onClick={() => !busy && onClose()} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[mode]}
        tabIndex={-1}
        className="fixed inset-0 z-[91] flex flex-col overflow-hidden bg-surface outline-none
                   sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92vh] sm:w-[min(34rem,calc(100vw-2rem))]
                   sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:border sm:border-line sm:shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-brand px-3 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] text-brand-ink sm:pt-3">
          {mode !== 'menu' ? (
            <button
              type="button"
              onClick={() => setMode(mode === 'complete' ? 'stops' : 'menu')}
              aria-label="Back"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/25 bg-white/15 transition hover:bg-white/30 active:scale-95"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/20">
              <ClipboardList className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-fluid-sm font-bold leading-tight">{TITLES[mode]}</h3>
            <p className="truncate text-[11px] opacity-85">
              {onShift ? 'On duty' : 'Not clocked in'}
              {shift.data?.shift?.vehicle?.registrationNumber ? ` · ${shift.data.shift.vehicle.registrationNumber}` : ''}
            </p>
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

        {!signedIn ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/10 text-brand">
              <LogIn className="h-7 w-7" />
            </span>
            <h4 className="text-fluid-base font-bold">Sign in to your driver account</h4>
            <p className="max-w-xs text-fluid-xs text-muted">
              These actions are recorded against your name and vehicle, so they need your driver login.
            </p>
            <a href="/driver/login" className="btn-primary btn-sm mt-1">
              <LogIn className="h-3.5 w-3.5" /> Driver sign in
            </a>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {/* ------------------------------------------------------- MENU -- */}
            {mode === 'menu' && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={toggleShift}
                  disabled={busy}
                  className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition disabled:opacity-50 ${
                    onShift ? 'border-danger/40 bg-danger/5 hover:bg-danger/10' : 'border-brand/40 bg-brand/5 hover:bg-brand/10'
                  }`}
                >
                  <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${onShift ? 'bg-danger/10 text-danger' : 'bg-brand/10 text-brand'}`}>
                    {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : onShift ? <LogOut className="h-5 w-5" /> : <LogIn className="h-5 w-5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-fluid-sm font-semibold">{onShift ? 'End shift' : 'Start shift'}</span>
                    <span className="block text-fluid-xs text-muted">
                      {onShift
                        ? `On duty ${formatDuration(shift.data?.shift?.minutes ?? 0)} — tap to clock out`
                        : 'Clock in so your ward officer can see you on duty'}
                    </span>
                  </span>
                </button>

                <MenuItem
                  icon={<ClipboardList className="h-5 w-5" />}
                  title="My stops"
                  subtitle={`${openTasks.length} still open today`}
                  onClick={() => setMode('stops')}
                />
                <MenuItem
                  icon={<Camera className="h-5 w-5" />}
                  title="Complete a stop"
                  subtitle="Close a task with its proof photo"
                  onClick={() => setMode('stops')}
                />
                <MenuItem
                  icon={<Fuel className="h-5 w-5" />}
                  title="Log fuel"
                  subtitle="Litres, cost and odometer"
                  onClick={() => setMode('fuel')}
                />
                <MenuItem
                  icon={<CheckCircle2 className="h-5 w-5" />}
                  title="Your day so far"
                  subtitle="Stops done, distance, fuel"
                  onClick={() => setMode('summary')}
                />
                <MenuItem
                  icon={<Siren className="h-5 w-5" />}
                  title="Raise SOS"
                  subtitle="Breakdown, accident or unsafe situation"
                  tone="danger"
                  onClick={() => setMode('sos')}
                />
              </div>
            )}

            {/* ------------------------------------------------------ STOPS -- */}
            {mode === 'stops' && (
              <>
                {tasks.isLoading ? (
                  <p className="py-10 text-center text-fluid-xs text-muted">Loading your stops…</p>
                ) : openTasks.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-12 text-center">
                    <CheckCircle2 className="h-10 w-10 text-ok" />
                    <p className="text-fluid-sm font-semibold">Nothing left open</p>
                    <p className="text-fluid-xs text-muted">Every stop assigned to your truck today is done.</p>
                  </div>
                ) : (
                  <ul className="space-y-2.5">
                    {openTasks.map((t) => (
                      <li key={t.id} className="rounded-2xl border border-line bg-elevated p-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-fluid-xs font-semibold">{t.code}</span>
                          {t.isEmergency && <Badge tone="danger">Emergency</Badge>}
                          <Badge tone={t.status === 'IN_PROGRESS' ? 'info' : 'neutral'}>{t.status}</Badge>
                          {t.distanceKm != null && (
                            <span className="ml-auto text-fluid-xs text-muted">{t.distanceKm} km</span>
                          )}
                        </div>
                        <p className="mt-1 flex items-start gap-1.5 text-fluid-xs text-muted">
                          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0">{t.address || 'Reported location'}</span>
                        </p>
                        <div className="mt-2.5 flex gap-2">
                          {t.status !== 'IN_PROGRESS' && (
                            <button
                              type="button"
                              onClick={() => startTask(t)}
                              disabled={busy}
                              className="btn-ghost btn-sm flex-1 disabled:opacity-50"
                            >
                              <Play className="h-3.5 w-3.5" /> Start
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setTask(t);
                              clearPhoto();
                              setNote('');
                              setMode('complete');
                            }}
                            className="btn-primary btn-sm flex-1"
                          >
                            <Camera className="h-3.5 w-3.5" /> Close with photo
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {/* --------------------------------------------------- COMPLETE -- */}
            {mode === 'complete' && task && (
              <div className="space-y-4">
                <div className="rounded-2xl border border-line bg-sunken/50 p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-fluid-xs font-semibold">{task.code}</span>
                    {task.isEmergency && <Badge tone="danger">Emergency</Badge>}
                  </div>
                  <p className="mt-1 text-fluid-xs text-muted">{task.address || 'Reported location'}</p>
                </div>

                <div>
                  <h4 className="text-fluid-sm font-semibold">
                    Photo of the cleared site <span className="text-danger">*</span>
                  </h4>
                  <p className="mb-2 text-[11px] text-muted">
                    Required. The citizen and your ward officer both see this as proof the work was done.
                  </p>
                  {preview ? (
                    <div className="relative overflow-hidden rounded-2xl border border-ok/50">
                      <img src={preview} alt="Cleared site" className="aspect-[4/3] w-full object-cover" />
                      <button
                        type="button"
                        onClick={clearPhoto}
                        aria-label="Remove photo"
                        className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setCameraOpen(true)}
                      className="flex min-h-touch w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-brand/50 bg-brand/5 p-6 text-brand transition hover:bg-brand/10"
                    >
                      <Camera className="h-7 w-7" />
                      <span className="text-fluid-xs font-semibold">Take proof photo</span>
                    </button>
                  )}
                </div>

                <div>
                  <label className="label" htmlFor="da-note">Note <span className="font-normal text-faint">(optional)</span></label>
                  <textarea
                    id="da-note"
                    className="field min-h-[4rem] resize-y"
                    placeholder="e.g. Bin was overflowing, cleared and swept"
                    value={note}
                    maxLength={500}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* ------------------------------------------------------- FUEL -- */}
            {mode === 'fuel' && (
              <div className="space-y-3">
                <Field label="Litres" value={litres} onChange={setLitres} placeholder="e.g. 32.5" inputMode="decimal" />
                <Field label="Cost (₹)" value={cost} onChange={setCost} placeholder="e.g. 3050" inputMode="decimal" />
                <Field label="Odometer (km)" value={odometer} onChange={setOdometer} placeholder="e.g. 48210" inputMode="numeric" />
                <p className="text-[11px] text-muted">
                  Enter whatever the receipt shows. A fill-up logged without a cost still counts the litres — it is
                  reported separately rather than guessed at.
                </p>
              </div>
            )}

            {/* -------------------------------------------------------- SOS -- */}
            {mode === 'sos' && (
              <div className="space-y-4">
                <div className="flex items-start gap-2 rounded-2xl border border-danger/30 bg-danger/5 p-3 text-fluid-xs text-danger">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>This pages your ward officer immediately with your live location. Use it for a real emergency.</p>
                </div>

                <div>
                  <p className="label">What is wrong?</p>
                  <div className="flex flex-wrap gap-1.5">
                    {SOS_REASONS.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setSosReason(r.id)}
                        aria-pressed={sosReason === r.id}
                        className={`min-h-[2.25rem] rounded-xl border px-3 py-1.5 text-fluid-xs font-medium transition ${
                          sosReason === r.id
                            ? 'border-danger bg-danger/10 text-danger'
                            : 'border-line bg-elevated text-muted hover:border-danger/50'
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="label" htmlFor="da-sos">Anything else? <span className="font-normal text-faint">(optional)</span></label>
                  <textarea
                    id="da-sos"
                    className="field min-h-[4rem] resize-y"
                    placeholder="e.g. Rear tyre burst on Ch Road, truck blocking one lane"
                    value={sosMessage}
                    maxLength={300}
                    onChange={(e) => setSosMessage(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* ---------------------------------------------------- SUMMARY -- */}
            {mode === 'summary' && (
              <>
                {summary.isLoading ? (
                  <p className="py-10 text-center text-fluid-xs text-muted">Loading…</p>
                ) : summary.data ? (
                  <div className="grid grid-cols-2 gap-3">
                    <Tile label="Stops done" value={`${summary.data.stopsDone} / ${summary.data.stopsTotal}`} />
                    <Tile label="Resolved" value={summary.data.resolved} />
                    <Tile label="Distance" value={`${summary.data.distanceKm ?? 0} km`} />
                    <Tile label="Fuel logged" value={`${summary.data.fuelLiters ?? 0} L`} />
                    <Tile label="Time on route" value={formatDuration(summary.data.minutesOnRoute ?? 0)} />
                    <Tile
                      label="Shift"
                      value={
                        summary.data.shift
                          ? summary.data.shift.status === 'ACTIVE'
                            ? `On duty ${formatDuration(summary.data.shift.minutes ?? 0)}`
                            : `Ended ${timeAgo(summary.data.shift.endedAt)}`
                          : 'Not clocked in'
                      }
                    />
                  </div>
                ) : (
                  <p className="py-10 text-center text-fluid-xs text-muted">No summary available yet.</p>
                )}
              </>
            )}
          </div>
        )}

        {/* Action bar — only for the modes that submit something. */}
        {signedIn && (mode === 'complete' || mode === 'fuel' || mode === 'sos') && (
          <div className="shrink-0 border-t border-line bg-surface p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-3">
            {mode === 'complete' && (
              <>
                {!photo && <p className="mb-2 text-center text-[11px] text-muted">Take the proof photo to close this stop</p>}
                <button
                  type="button"
                  onClick={completeTask}
                  disabled={!photo || busy}
                  className="btn-primary flex w-full items-center justify-center gap-2 py-3 text-fluid-sm font-semibold disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Mark collected
                </button>
              </>
            )}

            {mode === 'fuel' && (
              <button
                type="button"
                onClick={logFuel}
                disabled={busy || (!litres && !cost && !odometer)}
                className="btn-primary flex w-full items-center justify-center gap-2 py-3 text-fluid-sm font-semibold disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fuel className="h-4 w-4" />}
                Save fuel entry
              </button>
            )}

            {mode === 'sos' && (
              /* Two taps on purpose. Everything else here is undoable; paging
                 the control room is not, and a mis-tap in a moving cab is a
                 realistic way to do it. */
              !sosArmed ? (
                <button
                  type="button"
                  onClick={() => setSosArmed(true)}
                  className="btn-danger flex w-full items-center justify-center gap-2 py-3 text-fluid-sm font-semibold"
                >
                  <Siren className="h-4 w-4" /> Raise SOS
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-center text-[11px] font-semibold text-danger">
                    Confirm — your ward officer will be paged now
                  </p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setSosArmed(false)} className="btn-ghost btn-sm flex-1 py-3">
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={raiseSos}
                      disabled={busy}
                      className="btn-danger flex flex-1 items-center justify-center gap-2 py-3 text-fluid-sm font-bold disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Siren className="h-4 w-4" />}
                      Send SOS
                    </button>
                  </div>
                </div>
              )
            )}
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

function MenuItem({
  icon,
  title,
  subtitle,
  onClick,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition ${
        tone === 'danger' ? 'border-danger/40 bg-danger/5 hover:bg-danger/10' : 'border-line bg-elevated hover:border-brand/50 hover:bg-sunken'
      }`}
    >
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-brand/10 text-brand'}`}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-fluid-sm font-semibold">{title}</span>
        <span className="block text-fluid-xs text-muted">{subtitle}</span>
      </span>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: 'decimal' | 'numeric';
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        className="field"
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
      />
    </div>
  );
}

function Tile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-elevated p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-fluid-base font-bold tabular-nums">{value}</p>
    </div>
  );
}
