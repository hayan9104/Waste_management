import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clock,
  MapPin,
  Route as RouteIcon,
  Fuel,
  Truck,
  Calendar,
  AlertTriangle,
  LogIn,
  LogOut,
  Loader2,
  Coffee,
  Play,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, SectionTitle, Stat, toast } from '../../components/ui';
import { BaseMap, RouteLine } from '../../components/map/Map';
import { CATEGORY_LABELS, formatDateTime, formatDuration } from '../../lib/format';
import { useT } from '../../lib/i18n';

export default function DriverSummary() {
  const t = useT();
  const queryClient = useQueryClient();
  const [endNotes, setEndNotes] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['driver', 'summary'],
    queryFn: async () => (await api('driver').get('/driver/summary')).data,
  });

  const current = useQuery({
    queryKey: ['driver', 'shift', 'current'],
    queryFn: async () => (await api('driver').get('/driver/shift/current')).data,
    // The elapsed clock is rendered from startedAt, so this only needs to
    // catch a shift started or ended on another device.
    refetchInterval: 60_000,
  });

  /** One GPS fix for the clock-in/out, best effort — never blocks the action. */
  function fix(): Promise<{ latitude?: number; longitude?: number }> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({});
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve({}),
        { enableHighAccuracy: true, timeout: 6000 }
      );
    });
  }

  const startShift = useMutation({
    mutationFn: async () => (await api('driver').post('/driver/shift/start', await fix())).data,
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['driver'] });
      toast.success(res.alreadyOpen ? 'You were already clocked in' : 'Shift started — you are on duty');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not start your shift')),
  });

  const startBreak = useMutation({
    mutationFn: async () => (await api('driver').post('/driver/shift/break/start', await fix())).data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['driver'] });
      toast.success('On break — your truck is parked and your officer can see you are resting');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not start your break')),
  });

  const endBreak = useMutation({
    mutationFn: async () => (await api('driver').post('/driver/shift/break/end')).data,
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['driver'] });
      toast.success(`Back on duty — ${formatDuration(res.breakMinutes ?? 0)} of break so far`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not end your break')),
  });

  const endShift = useMutation({
    mutationFn: async () =>
      (await api('driver').post('/driver/shift/end', { ...(await fix()), notes: endNotes || undefined })).data,
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['driver'] });
      setEndNotes('');
      toast.success(`Shift ended — ${formatDuration(res.minutes ?? 0)} on duty, ${res.distanceKm ?? 0} km driven`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not end your shift')),
  });

  if (isLoading) return <Loading label="Loading shift summary…" />;
  if (error) return <ErrorState message="Could not load your shift summary" onRetry={() => refetch()} />;

  const trail: [number, number][] = (data.trail ?? []).map((p: any) => [p.latitude, p.longitude]);

  return (
    <div className="space-y-6">
      {/* Shift Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
            <Truck className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-fluid-xl font-bold tracking-tight text-ink">Daily Shift Summary</h1>
            <p className="text-fluid-xs text-muted">
              Vehicle: <strong className="text-ink">{data.vehicle.registrationNumber}</strong> · Shift Date: {data.date}
            </p>
          </div>
        </div>

{/* Three states, and none of them is inferred from GPS. A live GPS signal
           only means the handset is reporting; it says nothing about whether
           the driver has clocked in, and conflating the two is what made the
           old badge claim "Shift Active" for a driver who never started one. */}
        <Badge
          tone={
            current.data?.shift?.onBreak
              ? 'warn'
              : current.data?.onShift
                ? 'ok'
                : data.shift?.status === 'ENDED'
                  ? 'neutral'
                  : 'warn'
          }
          className="text-fluid-xs font-bold py-1 px-3"
        >
          {current.data?.shift?.onBreak
            ? 'On break'
            : current.data?.onShift
              ? 'On duty'
              : data.shift?.status === 'ENDED'
                ? 'Shift ended'
                : 'Not clocked in'}
        </Badge>
      </div>

      {/* Shift clock. The start/end times are the driver's own record of the
          day, which is why they are stated plainly rather than inferred from
          GPS activity the way the route timings below are. */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-fluid-sm font-bold">
              <Clock className="h-4 w-4 text-brand" /> Shift clock
            </h2>
            {current.data?.onShift ? (
              <p className="mt-1 text-fluid-xs text-muted">
                Clocked in at <strong className="text-ink">{formatDateTime(current.data.shift.startedAt)}</strong> ·{' '}
                {formatDuration(current.data.shift.workedMinutes ?? 0)} worked
                {(current.data.shift.breakMinutes ?? 0) > 0 && (
                  <> · {formatDuration(current.data.shift.breakMinutes)} rest</>
                )}
                {current.data.shift.onBreak && (
                  <> · <strong className="text-warn">on break since {formatDateTime(current.data.shift.breakStartedAt)}</strong></>
                )}
              </p>
            ) : data.shift?.status === 'ENDED' ? (
              <p className="mt-1 text-fluid-xs text-muted">
                {formatDateTime(data.shift.startedAt)} → {formatDateTime(data.shift.endedAt)} ·{' '}
                {formatDuration(data.shift.workedMinutes ?? data.shift.minutes ?? 0)} worked
                {(data.shift.breakMinutes ?? 0) > 0 && <> · {formatDuration(data.shift.breakMinutes)} rest</>} ·{' '}
                {data.shift.distanceKm ?? 0} km · {data.shift.stopsDone ?? 0} stops
              </p>
            ) : (
              <p className="mt-1 text-fluid-xs text-muted">
                You have not clocked in today. Your ward officer sees on-duty crew from this.
              </p>
            )}
          </div>

          {current.data?.onShift ? (
            <div className="flex shrink-0 flex-wrap gap-2">
              {current.data.shift?.onBreak ? (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={endBreak.isPending}
                  onClick={() => endBreak.mutate()}
                >
                  {endBreak.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Back on duty
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  disabled={startBreak.isPending}
                  onClick={() => startBreak.mutate()}
                >
                  {startBreak.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Coffee className="h-3.5 w-3.5" />}
                  Take a break
                </button>
              )}
              <button
                type="button"
                className="btn-danger btn-sm"
                disabled={endShift.isPending}
                onClick={() => endShift.mutate()}
              >
                {endShift.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
                End shift
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn-primary btn-sm shrink-0"
              disabled={startShift.isPending}
              onClick={() => startShift.mutate()}
            >
              {startShift.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
              Start shift
            </button>
          )}
        </div>

        {current.data?.onShift && (
          <input
            className="field mt-3 text-fluid-xs"
            placeholder="End-of-shift note (optional) — breakdown, handover, anything the officer should know"
            value={endNotes}
            onChange={(e) => setEndNotes(e.target.value)}
            maxLength={300}
          />
        )}
      </Card>

      {/* KPI Stats Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Stops Done"
          value={`${data.stopsDone} / ${data.stopsTotal}`}
          icon={<MapPin className="h-4 w-4" />}
        />
        <Stat
          label="Resolved"
          value={data.resolved}
          tone="ok"
          icon={<CheckCircle2 className="h-4 w-4 text-ok" />}
        />
        <Stat
          label="Distance Driven"
          value={`${data.distanceKm} km`}
          hint={`${data.plannedKm} km planned`}
          icon={<RouteIcon className="h-4 w-4 text-brand" />}
        />
        <Stat
          label="Fuel Used"
          value={`${data.fuelLiters || 0} L`}
          icon={<Fuel className="h-4 w-4 text-warn" />}
        />
        <Stat
          label="Time On Route"
          value={formatDuration(data.minutesOnRoute)}
          icon={<Clock className="h-4 w-4" />}
        />
      </div>

      {/* Responsive 2-Column Content Layout */}
      <div className="grid gap-6 lg:grid-cols-2 items-start">
        {/* Left Column: GPS Trail Map */}
        <section className="space-y-3">
          <SectionTitle
            title="GPS Route Audit"
            subtitle="Recorded path and trajectory from truck onboard telemetry"
          />
          <Card className="overflow-hidden p-0 shadow-sm">
            <div className="h-72 sm:h-96 w-full">
              {trail.length > 0 ? (
                <BaseMap center={[trail[0][0], trail[0][1]]} zoom={14} scrollWheelZoom={false}>
                  <RouteLine polyline={trail} progressIndex={trail.length - 1} />
                </BaseMap>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-fluid-xs text-muted">
                  GPS trail is being recorded as the truck moves.
                </div>
              )}
            </div>
          </Card>
        </section>

        {/* Right Column: Resolved Stops List */}
        <section className="space-y-3">
          <SectionTitle
            title="Resolved Complaints Today"
            subtitle="Tickets resolved and confirmed with proof photo"
          />
          {data.resolvedList?.length === 0 ? (
            <Card className="p-8 text-center">
              <EmptyState
                title="Nothing closed yet today"
                hint="Complaints you mark as collected will appear here with timestamps."
                icon={<CheckCircle2 className="h-8 w-8 text-muted" />}
              />
            </Card>
          ) : (
            <Card className="divide-y divide-line p-0 shadow-sm max-h-96 overflow-y-auto">
              {data.resolvedList.map((c: any) => (
                <div key={c.code} className="flex items-center gap-3 px-4 py-3.5 hover:bg-sunken/40 transition">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ok/10 text-ok">
                    <CheckCircle2 className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-fluid-sm font-bold text-ink">{t(`category.${c.category}`)}</p>
                    <p className="font-mono text-fluid-xs text-muted">#{c.code}</p>
                  </div>
                  <span className="shrink-0 text-fluid-xs text-muted font-medium">
                    {formatDateTime(c.resolvedAt)}
                  </span>
                </div>
              ))}
            </Card>
          )}

          {data.skipped > 0 && (
            <div className="flex items-center gap-2.5 rounded-xl border border-warn/30 bg-warn/10 p-3.5 text-fluid-xs text-warn">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                {data.skipped} stop{data.skipped === 1 ? '' : 's'} skipped today — ward officer has been notified.
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
