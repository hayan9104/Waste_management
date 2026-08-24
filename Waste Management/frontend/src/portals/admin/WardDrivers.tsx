import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, Truck, Users, Radio, TriangleAlert, Phone, MapPin, SatelliteDish, X } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, Meter, SectionTitle, Stat } from '../../components/ui';
import { BaseMap, TruckMarker, RouteLine, StopDot, FitBounds, CITY_CENTER } from '../../components/map/Map';
import { timeAgo } from '../../lib/format';

/** Signal quality as reported by the handset, not merely whether it is on. */
type GpsHealth = {
  status: 'GOOD' | 'FAIR' | 'PATCHY' | 'POOR' | 'OFFLINE' | 'NO_SIGNAL';
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  lastPingAgeSec: number | null;
  fixes: number;
  expectedFixes: number;
  dropouts: number;
  medianGapSec: number | null;
  accuracyM: number | null;
  accuracyReported: boolean;
  windowMinutes: number;
  speedKmph: number | null;
};

type RosterDriver = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  isActive: boolean;
  avatarColor: string;
  lastLoginAt: string | null;
  vehicle: {
    id: string;
    registrationNumber: string;
    model: string;
    status: string;
    maintenanceFlag: boolean;
    latitude: number | null;
    longitude: number | null;
  } | null;
  isOffline: boolean;
  lastPingAgeSec: number | null;
  route: {
    id: string;
    label: string;
    status: string;
    distanceKm: number | null;
    stopsTotal: number;
    stopsDone: number;
    progressPct: number;
    polyline: [number, number][];
    stops: { seq: number; code: string | null; label: string | null; latitude: number; longitude: number; status: string; isEmergency: boolean }[];
  } | null;
  gps: GpsHealth | null;
  sos: { id: string; createdAt: string; message: string | null } | null;
  shift: {
    id: string;
    status: 'ACTIVE' | 'ON_BREAK' | 'ENDED';
    startedAt: string;
    endedAt: string | null;
    distanceKm: number | null;
    stopsDone: number;
    breakMinutes: number | null;
  } | null;
  onDuty: boolean;
  onBreak: boolean;
};

type RosterWard = {
  ward: { id: string; name: string; code: string; zone: string | null };
  driverCount: number;
  activeCount: number;
  onDutyCount: number;
  onBreakCount: number;
  onRouteCount: number;
  drivers: RosterDriver[];
};

/**
 * Ward-wise driver roster.
 *
 * The fleet page is keyed by vehicle and user management is a flat directory,
 * so "who crews ward W, and what is each of them doing right now" had no home.
 * This groups by ward first and driver second, which is the order a city
 * supervisor actually asks the question in.
 */
export default function WardDrivers() {
  const [q, setQ] = useState('');
  /** The driver whose beat is drawn on the map; null closes it. */
  const [tracking, setTracking] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery<RosterWard[]>({
    queryKey: ['admin', 'ward-drivers'],
    queryFn: async () => (await api('admin').get('/admin/ward-drivers')).data,
    // The roster carries live ping age and route progress, so it goes stale fast.
    refetchInterval: 20_000,
  });

  const wards = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data;
    return data
      .map((w) => ({
        ...w,
        drivers: w.drivers.filter(
          (d) =>
            d.name.toLowerCase().includes(needle) ||
            (d.phone ?? '').includes(needle) ||
            (d.vehicle?.registrationNumber ?? '').toLowerCase().includes(needle)
        ),
      }))
      .filter((w) => w.drivers.length > 0 || w.ward.name.toLowerCase().includes(needle));
  }, [data, q]);

  const totals = useMemo(() => {
    const all = data ?? [];
    return {
      wards: all.length,
      drivers: all.reduce((n, w) => n + w.driverCount, 0),
      active: all.reduce((n, w) => n + w.activeCount, 0),
      onDuty: all.reduce((n, w) => n + w.onDutyCount, 0),
      onRoute: all.reduce((n, w) => n + w.onRouteCount, 0),
      sos: all.reduce((n, w) => n + w.drivers.filter((d) => d.sos).length, 0),
      weakGps: all.reduce(
        (n, w) => n + w.drivers.filter((d) => d.gps && ['FAIR', 'PATCHY', 'POOR'].includes(d.gps.status)).length,
        0
      ),
    };
  }, [data]);

  const tracked = useMemo(
    () => (data ?? []).flatMap((w) => w.drivers).find((d) => d.id === tracking) ?? null,
    [data, tracking]
  );

  if (isLoading) return <Loading label="Loading ward rosters…" />;
  if (error) return <ErrorState message="Could not load the ward driver roster" onRetry={() => refetch()} />;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Ward-wise drivers"
        subtitle="Every ward's crew, their truck, and how far through today's beat they are"
        action={
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              className="field pl-9"
              placeholder="Driver, phone or vehicle no."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Wards" value={totals.wards} icon={<MapPin className="h-4 w-4" />} tone="info" />
        <Stat
          label="Drivers"
          value={totals.drivers}
          hint={totals.wards ? `${(totals.drivers / totals.wards).toFixed(1)} per ward` : undefined}
          icon={<Users className="h-4 w-4" />}
          tone="brand"
        />
        <Stat
          label="On duty"
          value={totals.onDuty}
          hint={`${totals.active} handsets pinging`}
          icon={<Radio className="h-4 w-4" />}
          tone={totals.onDuty ? 'ok' : 'warn'}
        />
        <Stat
          label="Weak GPS"
          value={totals.weakGps}
          hint="Reporting, but not reliably"
          icon={<SatelliteDish className="h-4 w-4" />}
          tone={totals.weakGps ? 'warn' : 'ok'}
        />
        <Stat
          label="Open SOS"
          value={totals.sos}
          icon={<TriangleAlert className="h-4 w-4" />}
          tone={totals.sos ? 'danger' : 'neutral'}
        />
      </div>


      {/* Live beat for one driver.
          Drawn only on request rather than for everyone at once: forty-four
          polylines on one canvas is unreadable, and the question a supervisor
          actually asks is about a particular driver. */}
      {tracked && (
        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-sunken/60 px-4 py-3">
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-fluid-xs font-bold text-white"
              style={{ backgroundColor: tracked.avatarColor }}
            >
              {tracked.name.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-fluid-sm font-bold">{tracked.name}</p>
              <p className="truncate font-mono text-fluid-xs text-muted">
                {tracked.vehicle?.registrationNumber ?? 'No vehicle'}
                {tracked.route ? ` · ${tracked.route.label}` : ' · no route today'}
              </p>
            </div>
            {tracked.gps && <Badge tone={tracked.gps.tone}>{tracked.gps.label}</Badge>}
            <button
              type="button"
              onClick={() => setTracking(null)}
              className="btn-ghost btn-sm ml-auto"
              aria-label="Close live route"
            >
              <X className="h-3.5 w-3.5" /> Close
            </button>
          </div>

          <div className="h-[42dvh] min-h-[280px] w-full">
            <BaseMap
              center={
                tracked.vehicle?.latitude != null && tracked.vehicle?.longitude != null
                  ? [tracked.vehicle.latitude, tracked.vehicle.longitude]
                  : CITY_CENTER
              }
              zoom={14}
              satellite
            >
              <FitBounds
                points={[
                  ...(tracked.route?.stops ?? []).map((st) => [st.latitude, st.longitude] as [number, number]),
                  ...(tracked.vehicle?.latitude != null && tracked.vehicle?.longitude != null
                    ? [[tracked.vehicle.latitude, tracked.vehicle.longitude] as [number, number]]
                    : []),
                ]}
              />

              {(tracked.route?.polyline?.length ?? 0) > 1 && (
                <RouteLine polyline={tracked.route!.polyline} progressIndex={tracked.route!.stopsDone} />
              )}

              {(tracked.route?.stops ?? []).map((st, i, arr) => {
                const done = st.status === 'DONE';
                const firstOpen = arr.findIndex((x) => x.status !== 'DONE');
                return (
                  <StopDot
                    key={st.seq}
                    latitude={st.latitude}
                    longitude={st.longitude}
                    seq={st.seq}
                    status={done ? 'done' : i === firstOpen ? 'next' : 'queued'}
                    label={`${st.seq}. ${st.label ?? st.code ?? 'Stop'} — ${done ? 'Collected' : i === firstOpen ? 'Next stop' : 'Queued'}`}
                  />
                );
              })}

              {tracked.vehicle?.latitude != null && tracked.vehicle?.longitude != null && (
                <TruckMarker
                  latitude={tracked.vehicle.latitude}
                  longitude={tracked.vehicle.longitude}
                  active={!tracked.isOffline}
                  variant="tracker"
                >
                  <div className="space-y-0.5">
                    <p className="font-semibold">{tracked.vehicle.registrationNumber}</p>
                    <p className="text-xs text-muted">{tracked.name}</p>
                    <p className="text-xs">{tracked.gps?.label ?? 'No signal data'}</p>
                  </div>
                </TruckMarker>
              )}
            </BaseMap>
          </div>

          {/* The numbers behind the grade, so it can be argued with. */}
          {tracked.gps && (
            <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
              <GpsFact label="Accuracy" value={tracked.gps.accuracyReported ? `±${tracked.gps.accuracyM} m` : 'Not reported'} />
              {/* Count and cadence, not a ratio against an expected total: the
                  expectation is extrapolated from the median gap and a truck
                  reports far more often while driving than while working a
                  stop, so "55 of ~147" read as a fault on a healthy truck. */}
              <GpsFact
                label={`Fixes / ${tracked.gps.windowMinutes} min`}
                value={
                  tracked.gps.medianGapSec
                    ? `${tracked.gps.fixes} · every ${tracked.gps.medianGapSec}s`
                    : String(tracked.gps.fixes)
                }
              />
              <GpsFact label="Dropouts" value={String(tracked.gps.dropouts)} />
              <GpsFact
                label="Last fix"
                value={tracked.gps.lastPingAgeSec == null ? 'never' : `${tracked.gps.lastPingAgeSec}s ago`}
              />
            </div>
          )}
        </Card>
      )}

      {wards.length === 0 ? (
        <EmptyState
          title="No drivers match that search"
          hint="Clear the filter to see every ward's crew."
          icon={<Users className="h-8 w-8" />}
        />
      ) : (
        wards.map(({ ward, driverCount, onDutyCount, onBreakCount, onRouteCount, drivers }) => (
          <Card key={ward.id} className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-sunken/60 px-4 py-3">
              <span className="font-mono text-fluid-xs text-muted">{ward.code}</span>
              <h3 className="text-fluid-sm font-bold">{ward.name}</h3>
              {ward.zone && <span className="text-fluid-xs text-faint">{ward.zone}</span>}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <Badge tone="brand">{driverCount} drivers</Badge>
                <Badge tone={onDutyCount ? 'ok' : 'neutral'}>{onDutyCount} on duty</Badge>
                {onBreakCount > 0 && <Badge tone="warn">{onBreakCount} on break</Badge>}
                <Badge tone={onRouteCount ? 'info' : 'neutral'}>{onRouteCount} on beat</Badge>
              </div>
            </div>

            {drivers.length === 0 ? (
              <p className="px-4 py-6 text-center text-fluid-xs text-muted">No drivers assigned to this ward.</p>
            ) : (
              <ul className="divide-y divide-line">
                {drivers.map((d) => (
                  <li key={d.id} className="grid gap-3 px-4 py-3 sm:grid-cols-12 sm:items-center">
                    <div className="flex min-w-0 items-center gap-2.5 sm:col-span-4">
                      <span
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-fluid-xs font-bold text-white"
                        style={{ backgroundColor: d.avatarColor }}
                      >
                        {d.name.slice(0, 1)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-fluid-sm font-semibold">{d.name}</p>
                        <p className="truncate text-fluid-xs text-muted">
                          {d.phone ? (
                            <a href={`tel:${d.phone}`} className="inline-flex items-center gap-1 hover:text-brand">
                              <Phone className="h-3 w-3" /> {d.phone}
                            </a>
                          ) : (
                            '—'
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="min-w-0 sm:col-span-3">
                      {d.vehicle ? (
                        <>
                          <p className="flex items-center gap-1.5 truncate font-mono text-fluid-xs font-semibold">
                            <Truck className="h-3.5 w-3.5 shrink-0 text-muted" />
                            {d.vehicle.registrationNumber}
                          </p>
                          <p className="truncate text-fluid-xs text-muted">{d.vehicle.model}</p>
                        </>
                      ) : (
                        <p className="text-fluid-xs text-faint">No vehicle assigned</p>
                      )}
                    </div>

                    <div className="sm:col-span-3">
                      {d.route ? (
                        <>
                          <div className="flex items-center justify-between gap-2 text-fluid-xs">
                            <span className="truncate text-muted">{d.route.label}</span>
                            <span className="shrink-0 font-semibold tabular-nums">
                              {d.route.stopsDone}/{d.route.stopsTotal}
                            </span>
                          </div>
                          <Meter value={d.route.progressPct} tone={d.route.progressPct === 100 ? 'ok' : 'brand'} />
                        </>
                      ) : (
                        <p className="text-fluid-xs text-faint">No route published today</p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 sm:col-span-2 sm:justify-end">
                      {d.sos && <Badge tone="danger">SOS</Badge>}
                      {!d.isActive && <Badge tone="neutral">Blocked</Badge>}
<Badge tone={d.onBreak ? 'warn' : d.onDuty ? 'brand' : d.shift?.status === 'ENDED' ? 'neutral' : 'warn'}>
                        {d.onBreak
                          ? 'On break'
                          : d.onDuty
                            ? `On duty · ${timeAgo(d.shift!.startedAt)}`
                            : d.shift?.status === 'ENDED'
                              ? 'Clocked off'
                              : 'Not clocked in'}
                      </Badge>
                      {d.vehicle?.maintenanceFlag && <Badge tone="warn">Maintenance</Badge>}
                      {/* The GPS badge below states this same fact with the
                          measurement behind it, so the old Live/Offline chip
                          only added a second wording of the same thing — and
                          the two could read differently for one truck, which
                          is worse than either alone. Kept only for a truck
                          with no telemetry at all. */}
                      {!d.gps && (
                        <Badge tone={d.isOffline ? 'neutral' : 'ok'}>{d.isOffline ? 'Offline' : 'Live'}</Badge>
                      )}
                      {d.gps && (
                        <Badge tone={d.gps.tone}>
                          <SatelliteDish className="h-3 w-3" /> {d.gps.label}
                        </Badge>
                      )}
                      {d.vehicle && (
                        <button
                          type="button"
                          onClick={() => setTracking(tracking === d.id ? null : d.id)}
                          aria-pressed={tracking === d.id}
                          className={`btn-ghost btn-sm ${tracking === d.id ? 'border-brand text-brand' : ''}`}
                        >
                          <MapPin className="h-3.5 w-3.5" />
                          {tracking === d.id ? 'Hide route' : 'Live route'}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

/** One measured GPS figure, shown so the grade above it can be argued with. */
function GpsFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-elevated px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-fluid-xs font-semibold tabular-nums">{value}</p>
    </div>
  );
}
