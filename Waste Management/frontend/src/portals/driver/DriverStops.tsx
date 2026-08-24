import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  CheckCircle2,
  Loader2,
  Navigation,
  Play,
  RefreshCw,
  AlertCircle,
  Clock,
  ListChecks,
  MapPin,
  FileCheck,
  Truck,
  CalendarDays,
} from 'lucide-react';
import { api, assetUrl, errorMessage } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, EvidencePhoto, Loading, Modal, toast } from '../../components/ui';
import { LocationModal } from '../../components/LocationModal';
import { CameraCapture } from '../../components/CameraCapture';
import { STATUS_TONE, timeAgo } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useSocket, SOCKET_EVENTS } from '../../lib/socket';

export default function DriverStops() {
  const t = useT();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED'>('ALL');
  const todayStr = new Date().toISOString().slice(0, 10);
  const [dateFilter, setDateFilter] = useState<string>(todayStr);
  // Defaults to showing every date, not just today's. A task is created the
  // moment a citizen reports it and can sit pending for days before an
  // officer assigns it — scoping the driver's worklist to "created today"
  // silently hid real pending and just-completed work that happened to be
  // reported (or resolved) on an earlier day.
  const [allDates, setAllDates] = useState(true);
  const [resolving, setResolving] = useState<any | null>(null);
  const [locating, setLocating] = useState<any | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [note, setNote] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['driver', 'tasks', filter],
    queryFn: async () => {
      const [res1, res2] = await Promise.all([
        api('driver').get(`/driver/tasks?status=${filter}`),
        api('driver').get('/driver/scheduled-tasks'),
      ]);

      const normalTasks = res1.data?.tasks || [];
      const scheduledTasks = (res2.data?.items || []).map((st: any) => ({
        ...st,
        isScheduled: true,
        category: 'SCHEDULED_PICKUP',
        description: `${st.eventReason} (Load: ${st.expectedQuantity})`,
      }));

      // Filter scheduled tasks based on status tab
      const filteredScheduled = scheduledTasks.filter((st: any) => {
        if (filter === 'ALL') return true;
        if (filter === 'PENDING') return st.status === 'ASSIGNED';
        if (filter === 'IN_PROGRESS') return st.status === 'IN_PROGRESS';
        if (filter === 'COMPLETED') return st.status === 'COMPLETED';
        return true;
      });

      const base = res1.data?.counts || { total: 0, pending: 0, inProgress: 0, completed: 0 };
      const counts = {
        total: base.total + scheduledTasks.length,
        pending: base.pending + scheduledTasks.filter((s: any) => s.status === 'ASSIGNED').length,
        inProgress: base.inProgress + scheduledTasks.filter((s: any) => s.status === 'IN_PROGRESS').length,
        completed: base.completed + scheduledTasks.filter((s: any) => s.status === 'COMPLETED').length,
      };

      return {
        ...res1.data,
        tasks: [...normalTasks, ...filteredScheduled],
        scheduledCount: scheduledTasks.length,
        counts,
      };
    },
    refetchInterval: 20_000,
  });

  const vehicleId = data?.vehicleId;

  // Real-time task assignment listener over Socket.io
  useSocket('driver', vehicleId ? [`truck:${vehicleId}`] : [], {
    [SOCKET_EVENTS.ASSIGNMENT_NEW]: () => {
      queryClient.invalidateQueries({ queryKey: ['driver'] });
      playNotificationSound();
      toast.info('🔔 New collection task assigned by Ward Officer!');
    },
    new_task_assigned: () => {
      queryClient.invalidateQueries({ queryKey: ['driver'] });
      playNotificationSound();
      toast.info('🔔 New task dispatched to your truck!');
    },
    [SOCKET_EVENTS.COMPLAINT_UPDATE]: () => {
      queryClient.invalidateQueries({ queryKey: ['driver'] });
    },
  });

  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
    } catch {
      /* ignore */
    }
  }

  const start = useMutation({
    mutationFn: async (id: string) => (await api('driver').post(`/driver/tasks/${id}/start`)).data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['driver'] });
      toast.success('Collection started — citizen notified');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const resolve = useMutation({
    mutationFn: async () => {
      if (!photo) throw new Error('Please take a clean-up proof photo first.');
      const form = new FormData();
      form.append('photo', photo);
      if (note) form.append('note', note);

      if (resolving.isScheduled) {
        return (await api('driver').post(`/driver/scheduled-tasks/${resolving.id}/complete`, form)).data;
      }
      return (await api('driver').post(`/driver/tasks/${resolving.id}/complete`, form)).data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['driver'] });
      toast.success('Task marked collected with clean photo proof! Citizen awarded Green Credits.');
      closeSheet();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function closeSheet() {
    setResolving(null);
    setPhoto(null);
    setPreview('');
    setNote('');
  }

  const allTasks = data?.tasks ?? [];

  const tasks = useMemo(() => {
    if (allDates) return allTasks;
    return allTasks.filter((task: any) => {
      const day = task.isScheduled ? task.scheduledDate : task.createdAt;
      return day && String(day).slice(0, 10) === dateFilter;
    });
  }, [allTasks, allDates, dateFilter]);

  const counts = useMemo(() => {
    if (allDates) return data?.counts ?? { total: 0, pending: 0, inProgress: 0, completed: 0 };
    return {
      total: tasks.length,
      pending: tasks.filter((t: any) => t.status === 'ASSIGNED').length,
      inProgress: tasks.filter((t: any) => t.status === 'IN_PROGRESS').length,
      completed: tasks.filter((t: any) => t.status === 'RESOLVED' || t.status === 'COMPLETED').length,
    };
  }, [tasks, allDates, data?.counts]);

  if (isLoading) return <Loading label="Loading assigned stops…" />;
  if (error) return <ErrorState message="Could not load your tasks" onRetry={() => refetch()} />;

  return (
    <div className="space-y-5">
      {/* Top Header & Refresh.
          The title owns its own line on a phone, with the three controls
          below it as a tidy 2-column grid — flex-wrapping them alongside the
          heading left a ragged, half-empty row and pushed "Refresh" onto its
          own line at 360px. */}
      <div className="space-y-3 border-b border-line pb-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:space-y-0">
        <div className="min-w-0">
          <h1 className="text-fluid-xl font-bold tracking-tight text-ink">Collection Tasks</h1>
          <p className="text-fluid-xs text-muted">
            {counts.total} total stops assigned · Updates in real-time via Socket.io
          </p>
        </div>

        <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
          <div className="col-span-2 flex min-h-touch items-center gap-1.5 rounded-xl border border-line bg-elevated px-2.5 py-1.5 shadow-xs sm:col-span-1 sm:min-h-0">
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-brand" />
            <input
              type="date"
              value={dateFilter}
              onChange={(e) => {
                setDateFilter(e.target.value);
                setAllDates(false);
              }}
              className="w-full min-w-0 bg-transparent text-fluid-xs font-semibold text-ink outline-none sm:w-auto"
            />
          </div>
          <button
            type="button"
            onClick={() => setAllDates((v) => !v)}
            className={`btn-sm min-h-touch justify-center rounded-xl border px-3 text-fluid-xs font-semibold transition sm:min-h-0 ${
              allDates ? 'border-brand bg-brand text-brand-ink' : 'border-line bg-elevated text-muted hover:bg-sunken'
            }`}
          >
            All Dates
          </button>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="btn-ghost btn-sm flex min-h-touch items-center justify-center gap-1.5 rounded-xl border border-line bg-elevated shadow-xs sm:min-h-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin text-brand' : 'text-muted'}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Responsive Layout Grid */}
      <div className="grid gap-5 lg:grid-cols-12 items-start">
        {/* Left Column: Tasks List & Filters (8 of 12 cols) */}
        <div className="lg:col-span-8 space-y-4">
          {/* Filter Bar — 2x2 on a phone so every label reads in full; one row
              from sm up. Four pills in a row measure ~430px and used to force
              a sideways scroll that hid "Completed" off the edge. */}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {(
              [
                { id: 'ALL', label: 'All Tasks', count: counts.total },
                { id: 'PENDING', label: 'Assigned', count: counts.pending },
                { id: 'IN_PROGRESS', label: 'In Progress', count: counts.inProgress },
                { id: 'COMPLETED', label: 'Completed', count: counts.completed },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`flex min-h-touch items-center justify-center gap-1.5 rounded-xl px-3 text-fluid-xs font-semibold transition sm:min-h-0 sm:px-3.5 sm:py-1.5 ${
                  filter === tab.id
                    ? 'bg-brand text-brand-ink shadow-sm'
                    : 'border border-line bg-elevated text-muted hover:bg-sunken hover:text-ink'
                }`}
              >
                <span className="truncate whitespace-nowrap">{tab.label}</span>
                <span
                  className={`shrink-0 rounded-full px-1.5 text-[10px] font-bold leading-4 ${
                    filter === tab.id ? 'bg-brand-ink/20 text-brand-ink' : 'bg-sunken text-muted'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* Tasks Container */}
          {!tasks.length ? (
            <Card className="p-8 text-center">
              <EmptyState
                title="No tasks in this view"
                hint="When an officer assigns collection stops, they appear here instantly without refreshing."
                icon={<CheckCircle2 className="h-10 w-10 text-ok" />}
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {tasks.map((task: any) => {
                const isEmergency = task.isEmergency || task.priority === 'CRITICAL';
                const isDone = task.status === 'RESOLVED' || task.status === 'COMPLETED';
                const inProg = task.status === 'IN_PROGRESS';

                return (
                  <Card
                    key={task.id}
                    className={`overflow-hidden border p-4 sm:p-5 transition shadow-xs hover:shadow-md ${
                      isEmergency ? 'border-danger/40 bg-danger/5' : inProg ? 'border-brand/40 bg-brand/5' : 'bg-surface'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-fluid-xs font-bold text-ink">#{task.code}</span>
                          <Badge tone={STATUS_TONE[task.status] || 'neutral'}>{task.status}</Badge>
                          {isEmergency && <Badge tone="danger">Emergency (30m SLA)</Badge>}
                          {task.isScheduled && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 border border-brand/40 px-2.5 py-0.5 text-[10px] font-bold text-brand shadow-xs">
                              🗓️ Scheduled — {new Date(task.scheduledDate).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })} ({task.scheduledTimeSlot})
                            </span>
                          )}
                          <span className="text-[11px] text-muted">{timeAgo(task.createdAt)}</span>
                        </div>

                        <h3 className="text-fluid-base font-bold text-ink leading-snug">
                          {task.isScheduled ? task.eventReason : (t(`category.${task.category}`) || task.category)}
                        </h3>

                        <p className="flex items-center gap-1.5 text-fluid-xs text-muted">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-brand" />
                          <span className="truncate">{task.address || 'Reported Location'}</span>
                        </p>

                        {task.description && (
                          <p className="rounded-lg bg-sunken/60 p-2 text-fluid-xs text-muted italic">
                            "{task.description}"
                          </p>
                        )}
                      </div>

                      {/* Photo Thumbnail if available */}
                      {task.photoUrl && (
                        <a
                          href={assetUrl(task.photoUrl) ?? undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 overflow-hidden rounded-xl border border-line"
                        >
                          <EvidencePhoto
                            src={assetUrl(task.photoUrl)}
                            alt="Waste photo"
                            className="h-20 w-20 sm:h-24 sm:w-24 object-cover transition hover:scale-105"
                          />
                        </a>
                      )}
                    </div>

                    {/* Action Bar */}
                    {/* Action bar — full-width thumb targets stacked on a
                        phone, split left/right once there's room for a
                        single row. */}
                    <div className="mt-4 flex flex-col gap-2 border-t border-line/60 pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                      <button
                        type="button"
                        onClick={() => setLocating(task)}
                        className="btn-ghost btn-sm flex min-h-touch items-center justify-center gap-1.5 rounded-xl border border-line text-fluid-xs font-semibold hover:bg-sunken sm:min-h-0"
                      >
                        <Navigation className="h-3.5 w-3.5 text-brand" /> Locate on Map
                      </button>

                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        {!isDone && !inProg && (
                          <button
                            type="button"
                            onClick={() => start.mutate(task.id)}
                            disabled={start.isPending}
                            className="btn-primary btn-sm flex min-h-touch items-center justify-center gap-1.5 rounded-xl sm:min-h-0"
                          >
                            <Play className="h-3.5 w-3.5" /> Start Trip
                          </button>
                        )}

                        {!isDone && (
                          <button
                            type="button"
                            onClick={() => setResolving(task)}
                            className="btn-sm flex min-h-touch items-center justify-center gap-1.5 rounded-xl bg-ok text-white font-bold shadow-xs hover:bg-ok/90 sm:min-h-0"
                          >
                            <Camera className="h-3.5 w-3.5" /> Mark Collected
                          </button>
                        )}

                        {isDone && (
                          <span className="flex items-center justify-center gap-1 text-fluid-xs font-bold text-ok">
                            <CheckCircle2 className="h-4 w-4" /> Cleaned & Verified
                          </span>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Column: Driver KPI Summary & Guidelines (4 of 12 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <Card className="p-5 shadow-xs border-brand/20 bg-gradient-to-br from-surface to-brand/5">
            <h2 className="text-fluid-xs font-bold uppercase tracking-wider text-muted">Today's Shift Progress</h2>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-line bg-surface p-3 text-center">
                <span className="block text-fluid-xl font-extrabold text-brand tabular-nums">{counts.completed}</span>
                <span className="text-[11px] font-semibold text-muted">Completed</span>
              </div>
              <div className="rounded-xl border border-line bg-surface p-3 text-center">
                <span className="block text-fluid-xl font-extrabold text-warn tabular-nums">{counts.pending + counts.inProgress}</span>
                <span className="text-[11px] font-semibold text-muted">Pending</span>
              </div>
            </div>
          </Card>

          <Card className="p-5 shadow-xs space-y-3">
            <div className="flex items-center gap-2">
              <FileCheck className="h-5 w-5 text-brand" />
              <h3 className="text-fluid-sm font-bold">Clean-Up Protocol</h3>
            </div>
            <ul className="space-y-2 text-fluid-xs text-muted leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-brand/10 text-[10px] font-bold text-brand mt-0.5">1</span>
                <span>Reach the marked GPS coordinate and hit <strong>Start Trip</strong>.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-brand/10 text-[10px] font-bold text-brand mt-0.5">2</span>
                <span>Safely load all waste into the collection compactor / truck.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-brand/10 text-[10px] font-bold text-brand mt-0.5">3</span>
                <span>Take a clear photo of the <strong>cleaned location</strong> as verification proof.</span>
              </li>
            </ul>
          </Card>
        </div>
      </div>

      {/* Locate-on-map popup — no more leaving the app for a single pin. */}
      {locating && (
        <LocationModal
          open={Boolean(locating)}
          onClose={() => setLocating(null)}
          latitude={locating.latitude}
          longitude={locating.longitude}
          title={`#${locating.code}`}
          subtitle={locating.address || 'Reported location'}
        />
      )}

      {/* Completion Modal */}
      {resolving && (
        <Modal
          open={Boolean(resolving)}
          onClose={closeSheet}
          title={`Proof of Cleanup: #${resolving.code}`}
          footer={
            <div className="flex gap-2 w-full">
              <button type="button" onClick={closeSheet} className="btn-ghost flex-1 rounded-xl">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => resolve.mutate()}
                disabled={!photo || resolve.isPending}
                className="btn-primary flex-1 flex items-center justify-center gap-1.5 rounded-xl font-bold"
              >
                {resolve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Submit Proof
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <p className="text-fluid-xs text-muted">
              Upload a clear photo of the cleaned site to notify the citizen and complete this ticket.
            </p>

            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setPhoto(f);
                  setPreview(URL.createObjectURL(f));
                }
              }}
            />
            <CameraCapture
              open={cameraOpen}
              onClose={() => setCameraOpen(false)}
              onCapture={(f) => {
                setCameraOpen(false);
                setPhoto(f);
                setPreview(URL.createObjectURL(f));
              }}
            />

            {preview ? (
              <div className="relative overflow-hidden rounded-2xl border border-line">
                <img src={preview} alt="Clean proof" className="h-48 w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setCameraOpen(true)}
                  className="absolute bottom-2 right-2 rounded-xl bg-black/70 px-3 py-1.5 text-fluid-xs font-bold text-white backdrop-blur"
                >
                  Retake Photo
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand/40 bg-brand/5 text-brand transition hover:bg-brand/10"
              >
                <Camera className="h-8 w-8" />
                <span className="text-fluid-xs font-bold">Take Clean Proof Photo</span>
              </button>
            )}
            {!preview && (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="block w-full text-center text-fluid-xs font-semibold text-muted underline decoration-dotted underline-offset-4 hover:text-brand"
              >
                Or choose an existing photo instead
              </button>
            )}

            <div>
              <label className="label" htmlFor="driver-note">
                Cleanup Note (Optional)
              </label>
              <textarea
                id="driver-note"
                className="field resize-none h-20 text-fluid-xs"
                placeholder="e.g. Cleared 250kg debris, area sanitized."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
