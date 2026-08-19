import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Navigation,
  MapPin,
  Route as RouteIcon,
  Fuel,
  Clock,
  CheckCircle2,
  ArrowRight,
  Truck,
  ShieldAlert,
  Compass,
  Phone,
  Camera,
  Loader2,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, Meter, Modal, toast } from '../../components/ui';
import { BaseMap, TruckMarker, RouteLine, StopDot, FollowTarget } from '../../components/map/Map';
import { useSocket, SOCKET_EVENTS } from '../../lib/socket';
import { CATEGORY_LABELS, formatDistance, timeAgo, distanceMeters } from '../../lib/format';
import { useT } from '../../lib/i18n';

/** How close (metres) the driver's live GPS must be before a stop can be marked collected. */
const COLLECT_RADIUS_M = 150;

export default function DriverRoute() {
  const t = useT();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [live, setLive] = useState<{ latitude: number; longitude: number; heading?: number } | null>(null);
  const [follow, setFollow] = useState(true);
  const [resolving, setResolving] = useState<any | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [note, setNote] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['driver', 'shift'],
    queryFn: async () => (await api('driver').get('/driver/shift')).data,
    refetchInterval: 30_000,
  });

  /*
    Road-following guidance from wherever the truck is right now. Keyed on the
    position rounded to ~110 m so driving redraws the line but a jittery GPS fix
    does not — matching the server's own cache window, which matters because the
    default OSRM is a shared public server.
  */
  const navKey = live ? `${live.latitude.toFixed(3)},${live.longitude.toFixed(3)}` : 'no-fix';
  const navigation = useQuery({
    queryKey: ['driver', 'navigation', navKey],
    enabled: Boolean(live),
    queryFn: async () =>
      (await api('driver').get('/driver/navigation', { params: { lat: live!.latitude, lng: live!.longitude } })).data,
    refetchInterval: 60_000,
    staleTime: 45_000,
    placeholderData: (prev: any) => prev,
  });

  const vehicleId = data?.vehicle?.id;

  useSocket('driver', vehicleId ? [`truck:${vehicleId}`] : [], {
    [SOCKET_EVENTS.TRUCK_UPDATE]: (payload: any) => {
      if (payload?.latitude == null) return;
      setLive({ latitude: payload.latitude, longitude: payload.longitude, heading: payload.heading });
    },
    [SOCKET_EVENTS.ASSIGNMENT_NEW]: () => refetch(),
    new_task_assigned: () => refetch(),
  });

  useEffect(() => {
    if (data?.vehicle?.latitude != null && !live) {
      setLive({
        latitude: data.vehicle.latitude,
        longitude: data.vehicle.longitude,
        heading: data.vehicle.heading,
      });
    }
  }, [data, live]);

  const assignedStops = useMemo(() => {
    if (data?.route?.stops?.length) return data.route.stops;
    if (data?.assignedComplaints?.length) {
      return data.assignedComplaints.map((c: any, idx: number) => ({
        seq: idx + 1,
        complaintId: c.id,
        code: c.code,
        label: c.address || c.code,
        category: c.category,
        latitude: c.latitude,
        longitude: c.longitude,
        status: c.status,
        isEmergency: c.isEmergency,
        reportedAt: c.createdAt,
      }));
    }
    return [];
  }, [data]);

  const resolve = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      if (photo) form.append('photo', photo);
      if (note) form.append('note', note);
      return (await api('driver').post(`/driver/tasks/${resolving.complaintId}/complete`, form)).data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['driver'] });
      toast.success('Stop marked collected — citizen awarded Green Credits.');
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

  const nav = navigation.data?.navigating ? navigation.data : null;

  /*
    The drawn line, in order of preference:

      1. Live navigation — real streets from the truck's current position
         through the stops still open. This is what a driver actually follows.
      2. The day's published route, sliced at the last completed stop so the
         leg already covered drops off instead of staying drawn.
      3. Straight segments between stops. Only reachable when OSRM is down AND
         no route was ever published; it cuts across blocks, so the HUD says
         the guidance is approximate rather than pretending otherwise.
  */
  const polyline = useMemo(() => {
    const remaining = assignedStops.filter((s: any) => s.status !== 'DONE');
    if (!remaining.length) return [];

    if (nav?.polyline?.length > 1) return nav.polyline;

    const done = assignedStops.filter((s: any) => s.status === 'DONE');
    const full = data?.route?.polyline;
    if (Array.isArray(full) && full.length > 1) {
      const lastDoneIdx = done.length
        ? Math.max(...done.map((s: any) => (typeof s.polylineIndex === 'number' ? s.polylineIndex : 0)))
        : 0;
      const sliced = full.slice(lastDoneIdx);
      if (sliced.length > 1) return sliced;
    }

    const pts: [number, number][] = remaining.map((s: any) => [s.longitude, s.latitude]);
    if (live) pts.unshift([live.longitude, live.latitude]);
    return pts;
  }, [data, assignedStops, live, nav]);

  /** True only when we are drawing straight lines through buildings. */
  const approximateGuidance = !nav && Boolean(live) && !(data?.route?.polyline?.length > 1);

  const nextStop = data?.nextStop || assignedStops.find((s: any) => s.status !== 'DONE');

  if (isLoading) return <Loading label="Loading route navigation…" />;
  if (error) return <ErrorState message="Could not load your shift" onRetry={() => refetch()} />;

  const centre: [number, number] = live
    ? [live.latitude, live.longitude]
    : polyline[0]
      ? [polyline[0][1], polyline[0][0]]
      : [23.0225, 72.5714];

  const resolvedCount = assignedStops.filter((s: any) => s.status === 'DONE').length;
  const totalStops = assignedStops.length;
  const progressPct = totalStops > 0 ? (resolvedCount / totalStops) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* Top Breadcrumb & Stats Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
            <Truck className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-fluid-lg font-bold tracking-tight text-ink">
              {data?.vehicle?.registrationNumber || 'Driver Navigation'}
            </h1>
            <p className="text-fluid-xs text-muted">
              Ward: <span className="font-semibold text-ink">{data?.vehicle?.ward?.name || 'Assigned Zone'}</span> ·
              Status: <span className="text-brand font-semibold">{data?.vehicle?.status || 'ON_ROUTE'}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="rounded-xl border border-line bg-elevated px-3 py-1.5 text-fluid-xs">
            <span className="text-muted">Completed: </span>
            <span className="font-bold text-ink">
              {resolvedCount} / {totalStops}
            </span>
          </div>
          <Link to="/driver/stops" className="btn-primary btn-sm">
            View All Tasks <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      {!assignedStops.length ? (
        <Card className="p-8 text-center">
          <EmptyState
            title="No active stops assigned"
            hint="When your ward officer assigns new collection tasks, they will appear here live with turn-by-turn guidance."
            icon={<RouteIcon className="h-10 w-10 text-brand" />}
          />
        </Card>
      ) : (
        /* Multi-Column Desktop Grid */
        <div className="grid gap-5 lg:grid-cols-12 items-start">
          {/* Left Column: Interactive Map & Live HUD (7 of 12 cols on desktop) */}
          <div className="lg:col-span-7 xl:col-span-8 space-y-4">
            <Card className="overflow-hidden p-0 shadow-md">
              <div className="relative isolate h-[55dvh] min-h-[380px] w-full lg:h-[580px]">
                <BaseMap center={centre} zoom={15} satellite>
                  <FollowTarget latitude={live?.latitude} longitude={live?.longitude} enabled={follow} />
                  {polyline.length > 1 && <RouteLine polyline={polyline} />}
                  {(() => {
                    let nextMarked = false;
                    return assignedStops.map((stop: any) => {
                      const isDone = stop.status === 'DONE';
                      const status: 'done' | 'next' | 'queued' = isDone ? 'done' : nextMarked ? 'queued' : 'next';
                      if (!isDone) nextMarked = true;
                      const distM = !isDone && live ? distanceMeters(live, stop) : null;
                      const inRange = distM != null && distM <= COLLECT_RADIUS_M;
                      return (
                        <StopDot
                          key={stop.seq}
                          latitude={stop.latitude}
                          longitude={stop.longitude}
                          seq={stop.seq}
                          status={status}
                          label={
                            <div className="min-w-[220px] space-y-2 p-1">
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                                    isDone
                                      ? 'bg-ok/15 text-ok'
                                      : status === 'next'
                                        ? 'bg-danger/15 text-danger'
                                        : 'bg-sunken text-muted'
                                  }`}
                                >
                                  {isDone ? 'Completed' : status === 'next' ? 'Next stop' : 'Queued'}
                                </span>
                                {stop.isEmergency && <Badge tone="danger">Emergency</Badge>}
                              </div>
                              <p className="text-fluid-sm font-bold leading-snug text-ink">
                                {stop.seq}. {stop.label}
                              </p>
                              <p className="text-fluid-xs text-muted">
                                {t(`category.${stop.category}`) || stop.category}
                              </p>
                              {stop.reportedAt && (
                                <p className="flex items-center gap-1 text-[11px] text-faint">
                                  <Clock className="h-3 w-3" /> Reported {timeAgo(stop.reportedAt)}
                                </p>
                              )}
                              {!isDone && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => setResolving(stop)}
                                    disabled={!inRange}
                                    title={!inRange ? 'Get closer to this stop to mark it collected' : undefined}
                                    className={`btn-sm mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg font-bold shadow-xs ${
                                      inRange
                                        ? 'bg-ok text-white hover:bg-ok/90'
                                        : 'cursor-not-allowed bg-sunken text-faint'
                                    }`}
                                  >
                                    <Camera className="h-3.5 w-3.5" /> Mark Collected
                                  </button>
                                  {!inRange && (
                                    <p className="text-center text-[10px] text-faint">
                                      {distM == null
                                        ? 'Waiting for your GPS location…'
                                        : `Get within ${COLLECT_RADIUS_M}m — ${formatDistance(distM)} away`}
                                    </p>
                                  )}
                                </>
                              )}
                            </div>
                          }
                        />
                      );
                    });
                  })()}
                  {live && (
                    <TruckMarker latitude={live.latitude} longitude={live.longitude} heading={live.heading ?? 0} />
                  )}
                </BaseMap>

                {/* GPS HUD Overlay on Top Left */}
                <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-xl border border-line bg-surface/90 px-3 py-2 shadow-md backdrop-blur">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75"></span>
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ok"></span>
                  </span>
                  <span className="text-[11px] font-bold text-ink uppercase tracking-wider">
                    {live ? 'GPS Live Connected' : 'Acquiring GPS…'}
                  </span>
                </div>

                {/* Say it plainly when the drawn line is not real road geometry,
                    rather than letting a driver try to follow it. */}
                {(approximateGuidance || nav?.source === 'fallback') && (
                  <div className="absolute left-3 right-3 top-14 z-10 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/15 px-3 py-2 text-[11px] font-semibold text-warn backdrop-blur">
                    <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>Road guidance unavailable — the line shown is a direct approximation, not a drivable route.</span>
                  </div>
                )}

                {/* Free Pan / Following Button on Bottom Right */}
                <button
                  type="button"
                  onClick={() => setFollow((v) => !v)}
                  className={`absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded-xl border px-3 py-2 text-fluid-xs font-semibold shadow-lift backdrop-blur transition ${
                    follow ? 'border-brand bg-brand text-brand-ink' : 'border-line bg-surface/90 text-muted'
                  }`}
                >
                  <Navigation className="h-4 w-4" />
                  {follow ? 'Following Truck' : 'Free Pan Mode'}
                </button>
              </div>

              {/* Progress Meter bar */}
              <div className="border-t border-line bg-elevated/50 p-4">
                <Meter
                  value={progressPct}
                  tone="brand"
                  label={`${resolvedCount} of ${totalStops} stops completed (${Math.round(progressPct)}%)`}
                />
              </div>
            </Card>
          </div>

          {/* Right Column: Active Task & Queue (5 of 12 cols on desktop) */}
          <div className="lg:col-span-5 xl:col-span-4 space-y-4">
            {/* Current Active Stop Card */}
            {nextStop ? (
              <Card className="relative overflow-hidden border-brand/40 bg-gradient-to-br from-surface to-brand/5 p-5 shadow-md">
                <div className="flex items-center justify-between gap-2 border-b border-line/60 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-brand-ink text-fluid-xs font-bold">
                      {nextStop.seq}
                    </span>
                    <h2 className="text-fluid-sm font-bold uppercase tracking-wider text-muted">Next Stop in Queue</h2>
                  </div>
                  <Badge tone={nextStop.isEmergency ? 'danger' : 'brand'}>
                    {nextStop.isEmergency ? 'Emergency' : 'Standard'}
                  </Badge>
                </div>

                <div className="mt-3.5 space-y-2">
                  <p className="text-fluid-base font-bold text-ink leading-snug">{nextStop.label}</p>
                  <p className="text-fluid-xs text-muted">
                    Category: <strong className="text-ink">{t(`category.${nextStop.category}`)}</strong>
                  </p>
                  {nextStop.code && (
                    <p className="font-mono text-fluid-xs text-muted">Ticket: #{nextStop.code}</p>
                  )}
                </div>

                {/* Driving distance and time along the road, from OSRM — not a
                    straight-line estimate, so it matches what the map draws. */}
                {nav?.nextStop && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-line bg-surface p-2.5 text-center">
                      <span className="block text-fluid-lg font-extrabold tabular-nums text-brand">
                        {formatDistance(nav.nextStop.legDistanceMeters)}
                      </span>
                      <span className="text-[11px] font-semibold text-muted">By road</span>
                    </div>
                    <div className="rounded-xl border border-line bg-surface p-2.5 text-center">
                      <span className="block text-fluid-lg font-extrabold tabular-nums text-ink">
                        {Math.max(1, Math.round(nav.nextStop.legDurationSeconds / 60))} min
                      </span>
                      <span className="text-[11px] font-semibold text-muted">Drive time</span>
                    </div>
                  </div>
                )}

                {nav && nav.stops.length > 1 && (
                  <p className="mt-2 text-center text-[11px] text-faint">
                    Whole run: {formatDistance(nav.totalDistanceMeters)} ·{' '}
                    {Math.round(nav.totalDurationSeconds / 60)} min across {nav.stops.length} stops
                    {nav.truncatedStops > 0 && ` (+${nav.truncatedStops} more after these)`}
                  </p>
                )}

                <div className="mt-4 flex gap-2">
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${nextStop.latitude},${nextStop.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 text-fluid-xs font-bold shadow-sm"
                  >
                    <Navigation className="h-4 w-4" /> Start Turn-by-Turn GPS
                  </a>
                  <Link
                    to="/driver/stops"
                    className="btn-ghost flex items-center justify-center rounded-xl border border-line px-3.5 text-fluid-xs font-semibold"
                  >
                    Complete
                  </Link>
                </div>
              </Card>
            ) : (
              <Card className="p-5 text-center border-ok/30 bg-ok/5">
                <CheckCircle2 className="mx-auto h-8 w-8 text-ok" />
                <h3 className="mt-2 text-fluid-sm font-bold text-ink">All Assigned Stops Complete!</h3>
                <p className="text-fluid-xs text-muted mt-1">
                  Great job! You have cleared all tasks in your queue. Check back for new dispatches.
                </p>
              </Card>
            )}

            {/* Sequential Stops Queue */}
            <Card className="overflow-hidden p-0 shadow-sm">
              <div className="flex items-center justify-between border-b border-line px-4 py-3 bg-sunken/40">
                <h3 className="text-fluid-xs font-bold uppercase tracking-wider text-muted">Stops Itinerary</h3>
                <span className="text-[11px] font-semibold text-brand">{totalStops} locations</span>
              </div>

              <div className="divide-y divide-line max-h-[340px] overflow-y-auto">
                {assignedStops.map((stop: any) => {
                  const isDone = stop.status === 'DONE';
                  const isCurrent = nextStop?.seq === stop.seq;

                  return (
                    <div
                      key={stop.seq}
                      className={`flex items-center justify-between p-3.5 transition ${
                        isCurrent ? 'bg-brand/10' : 'hover:bg-sunken/50'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                        <span
                          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-fluid-xs font-bold ${
                            isDone
                              ? 'bg-ok/20 text-ok'
                              : isCurrent
                                ? 'bg-brand text-brand-ink'
                                : 'bg-sunken text-muted'
                          }`}
                        >
                          {isDone ? '✓' : stop.seq}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={`text-fluid-xs font-semibold truncate ${isDone ? 'line-through text-muted' : 'text-ink'}`}>
                            {stop.label}
                          </p>
                          <p className="text-[10px] text-muted">
                            {t(`category.${stop.category}`)} · {stop.code || 'Assigned'}
                          </p>
                        </div>
                      </div>

                      <Badge tone={isDone ? 'ok' : stop.isEmergency ? 'danger' : isCurrent ? 'brand' : 'neutral'}>
                        {isDone ? 'Done' : isCurrent ? 'Current' : 'Pending'}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Quick Actions Support */}
            <div className="grid grid-cols-2 gap-2.5">
              <Link
                to="/driver/fuel"
                className="flex items-center gap-2 rounded-xl border border-line bg-elevated p-3 text-fluid-xs font-semibold text-ink transition hover:bg-sunken shadow-xs"
              >
                <Fuel className="h-4 w-4 text-brand" />
                <span>Log Fuel / Km</span>
              </Link>
              <Link
                to="/driver/sos"
                className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-fluid-xs font-semibold text-danger transition hover:bg-danger/20 shadow-xs"
              >
                <ShieldAlert className="h-4 w-4" />
                <span>Emergency SOS</span>
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Completion modal — opened from a stop's map popup ("Mark Collected"). */}
      {resolving && (
        <Modal
          open={Boolean(resolving)}
          onClose={closeSheet}
          title={`Proof of Cleanup: Stop ${resolving.seq}`}
          footer={
            <div className="flex w-full gap-2">
              <button type="button" onClick={closeSheet} className="btn-ghost flex-1 rounded-xl">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => resolve.mutate()}
                disabled={resolve.isPending}
                className="btn-primary flex flex-1 items-center justify-center gap-1.5 rounded-xl font-bold"
              >
                {resolve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Submit Proof
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setPhoto(f);
                  setPreview(URL.createObjectURL(f));
                }
              }}
            />

            {preview ? (
              <div className="relative overflow-hidden rounded-2xl border border-line">
                <img src={preview} alt="Clean proof" className="h-48 w-full object-cover" />
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="absolute bottom-2 right-2 rounded-xl bg-black/70 px-3 py-1.5 text-fluid-xs font-bold text-white backdrop-blur"
                >
                  Retake Photo
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand/40 bg-brand/5 text-brand transition hover:bg-brand/10"
              >
                <Camera className="h-8 w-8" />
                <span className="text-fluid-xs font-bold">Take Clean Proof Photo</span>
              </button>
            )}

            <div>
              <label className="label" htmlFor="route-note">
                Cleanup Note (Optional)
              </label>
              <textarea
                id="route-note"
                className="field h-20 resize-none text-fluid-xs"
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
