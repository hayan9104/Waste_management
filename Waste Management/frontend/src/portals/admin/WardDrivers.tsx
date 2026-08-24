import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, Truck, Users, Radio, TriangleAlert, Phone, MapPin } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, Meter, SectionTitle, Stat } from '../../components/ui';
import { timeAgo } from '../../lib/format';

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
  } | null;
  sos: { id: string; createdAt: string; message: string | null } | null;
  shift: {
    id: string;
    status: 'ACTIVE' | 'ENDED';
    startedAt: string;
    endedAt: string | null;
    distanceKm: number | null;
    stopsDone: number;
  } | null;
  onDuty: boolean;
};

type RosterWard = {
  ward: { id: string; name: string; code: string; zone: string | null };
  driverCount: number;
  activeCount: number;
  onDutyCount: number;
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
    };
  }, [data]);

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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
          label="Open SOS"
          value={totals.sos}
          icon={<TriangleAlert className="h-4 w-4" />}
          tone={totals.sos ? 'danger' : 'neutral'}
        />
      </div>

      {wards.length === 0 ? (
        <EmptyState
          title="No drivers match that search"
          hint="Clear the filter to see every ward's crew."
          icon={<Users className="h-8 w-8" />}
        />
      ) : (
        wards.map(({ ward, driverCount, onDutyCount, onRouteCount, drivers }) => (
          <Card key={ward.id} className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-sunken/60 px-4 py-3">
              <span className="font-mono text-fluid-xs text-muted">{ward.code}</span>
              <h3 className="text-fluid-sm font-bold">{ward.name}</h3>
              {ward.zone && <span className="text-fluid-xs text-faint">{ward.zone}</span>}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <Badge tone="brand">{driverCount} drivers</Badge>
                <Badge tone={onDutyCount ? 'ok' : 'neutral'}>{onDutyCount} on duty</Badge>
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
                      <Badge tone={d.onDuty ? 'brand' : d.shift?.status === 'ENDED' ? 'neutral' : 'warn'}>
                        {d.onDuty
                          ? `On duty · ${timeAgo(d.shift!.startedAt)}`
                          : d.shift?.status === 'ENDED'
                            ? 'Clocked off'
                            : 'Not clocked in'}
                      </Badge>
                      {d.vehicle?.maintenanceFlag && <Badge tone="warn">Maintenance</Badge>}
                      <Badge tone={d.isOffline ? 'neutral' : 'ok'}>
                        {d.isOffline
                          ? d.lastPingAgeSec == null
                            ? 'Never pinged'
                            : `Offline · ${timeAgo(new Date(Date.now() - d.lastPingAgeSec * 1000).toISOString())}`
                          : 'Live'}
                      </Badge>
                      {d.vehicle && (
                        <Link to={`/admin/fleet?vehicle=${d.vehicle.id}`} className="btn-ghost btn-sm">
                          Track
                        </Link>
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
