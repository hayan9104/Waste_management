import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Fuel, IndianRupee, Gauge, TriangleAlert, Route as RouteIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, SectionTitle, Stat } from '../../components/ui';

/**
 * Fuel & expenditure.
 *
 * Litres and rupees are different scales, so they get two charts rather than
 * one chart with two y-axes — a dual axis lets the reader infer a relationship
 * from whatever crossing point the scaling happens to produce.
 *
 * Ratios (km/l, cost/km) are null rather than 0 wherever there is nothing to
 * divide by, and render as "—". A truck with no logged fuel showing "0.00 km/l"
 * reads as catastrophically thirsty rather than as unreported.
 */

const COST = '#0ea5e9';
const LITRES = '#6366f1';

const rupees = (n: number | null | undefined) =>
  n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`;

export default function FuelExpenditure({ scope = 'admin' }: { scope?: 'admin' | 'officer' }) {
  const [days, setDays] = useState(30);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [scope, 'fuel', days],
    queryFn: async () => (await api(scope).get(`/${scope}/fuel`, { params: { days } })).data,
  });

  if (isLoading) return <Loading label="Loading fuel & expenditure…" />;
  if (error) return <ErrorState message="Could not load fuel analytics" onRetry={() => refetch()} />;

  const axis = { fontSize: 11, fill: 'rgb(var(--muted))' };
  const tooltipStyle = {
    background: 'rgb(var(--elevated))',
    border: '1px solid rgb(var(--line))',
    borderRadius: 12,
    fontSize: 12,
    color: 'rgb(var(--ink))',
  };
  const t = data.totals;
  const cov = data.coverage;
  const short = (d: string) => d.slice(5);

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Fuel & expenditure"
        subtitle={`Diesel spend and efficiency across the fleet · last ${days} days`}
        action={
          <div className="flex gap-1.5">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`chip transition ${days === d ? 'border-brand bg-brand/10 text-brand' : 'text-muted hover:bg-sunken'}`}
              >
                {d}d
              </button>
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Total spend" value={rupees(t.cost)} hint={`${rupees(t.avgCostPerDay)}/day`} icon={<IndianRupee className="h-4 w-4" />} tone="brand" />
        <Stat label="Diesel" value={`${t.litres.toLocaleString('en-IN')} L`} hint={`${t.entries} fill-ups`} icon={<Fuel className="h-4 w-4" />} tone="info" />
        <Stat label="Distance" value={`${Math.round(t.km).toLocaleString('en-IN')} km`} icon={<RouteIcon className="h-4 w-4" />} tone="neutral" />
        <Stat label="Efficiency" value={t.kmPerLitre != null ? `${t.kmPerLitre} km/L` : '—'} hint="Fleet average" icon={<Gauge className="h-4 w-4" />} tone="ok" />
        <Stat label="Cost per km" value={t.costPerKm != null ? `₹${t.costPerKm}` : '—'} icon={<IndianRupee className="h-4 w-4" />} tone="warn" />
      </div>

      {/* Coverage is stated rather than assumed. A month can look cheap because
          diesel was cheap, or because half the crew never logged a receipt —
          those are opposite conclusions from the same total. */}
      {(cov.entriesMissingCost > 0 || cov.vehiclesWithNoEntries > 0) && (
        <Card className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-warn/30 bg-warn/5 p-3">
          <TriangleAlert className="h-4 w-4 shrink-0 text-warn" />
          <p className="text-fluid-xs text-muted">
            Totals cover <strong className="text-ink">{t.vehiclesReporting} of {t.fleetSize}</strong> trucks.
            {cov.vehiclesWithNoEntries > 0 && ` ${cov.vehiclesWithNoEntries} logged no fuel at all.`}
            {cov.entriesMissingCost > 0 && ` ${cov.entriesMissingCost} fill-ups recorded litres but no cost, so spend is understated.`}
          </p>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <h3 className="text-fluid-sm font-semibold">Daily spend</h3>
          <p className="mb-2 text-fluid-xs text-muted">Rupees logged per day</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.series} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="fuelCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COST} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={COST} stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={axis} tickFormatter={short} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={axis} tickLine={false} axisLine={false} width={52} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [rupees(v), 'Spend']} />
                <Area type="monotone" dataKey="cost" stroke={COST} strokeWidth={2} fill="url(#fuelCost)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="text-fluid-sm font-semibold">Daily diesel</h3>
          <p className="mb-2 text-fluid-xs text-muted">Litres logged per day — plotted separately from spend, not on a second axis</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.series} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="fuelLitres" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={LITRES} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={LITRES} stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={axis} tickFormatter={short} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={axis} tickLine={false} axisLine={false} width={44} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [`${v} L`, 'Diesel']} />
                <Area type="monotone" dataKey="litres" stroke={LITRES} strokeWidth={2} fill="url(#fuelLitres)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {data.perWard.length > 0 && (
        <Card className="p-4">
          <h3 className="text-fluid-sm font-semibold">Spend by ward</h3>
          <p className="mb-2 text-fluid-xs text-muted">Total diesel cost over the period</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.perWard.map((w: any) => ({ ...w, name: w.ward.name }))} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={axis} tickLine={false} axisLine={false} interval={0} angle={-18} textAnchor="end" height={54} />
                <YAxis tick={axis} tickLine={false} axisLine={false} width={58} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [rupees(v), 'Spend']} cursor={{ fill: 'rgb(var(--sunken))' }} />
                <Bar dataKey="cost" fill={COST} radius={[4, 4, 0, 0]} maxBarSize={44} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        <div className="border-b border-line bg-sunken/60 px-4 py-3">
          <h3 className="text-fluid-sm font-semibold">Per-vehicle</h3>
          <p className="text-fluid-xs text-muted">Highest spend first</p>
        </div>
        {data.perVehicle.length === 0 ? (
          <EmptyState title="No fuel logged in this period" hint="Drivers log fill-ups from the Fuel tab in their portal." icon={<Fuel className="h-8 w-8" />} />
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[46rem] text-left text-fluid-sm">
              <thead className="border-b border-line text-fluid-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5">Vehicle</th>
                  <th className="px-4 py-2.5">Ward</th>
                  <th className="px-4 py-2.5 text-right">Spend</th>
                  <th className="px-4 py-2.5 text-right">Diesel</th>
                  <th className="px-4 py-2.5 text-right">Distance</th>
                  <th className="px-4 py-2.5 text-right">km/L</th>
                  <th className="px-4 py-2.5 text-right">₹/km</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.perVehicle.map((v: any) => (
                  <tr key={v.vehicleId}>
                    <td className="px-4 py-2.5">
                      <p className="font-mono text-fluid-xs font-semibold">{v.registrationNumber}</p>
                      <p className="truncate text-fluid-xs text-muted">{v.driver?.name ?? 'Unassigned'}</p>
                    </td>
                    <td className="px-4 py-2.5 text-fluid-xs text-muted">{v.ward?.name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{rupees(v.cost)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{v.litres} L</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{v.km} km</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{v.kmPerLitre ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{v.costPerKm != null ? `₹${v.costPerKm}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data.recent.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 text-fluid-sm font-semibold">Latest fill-ups</h3>
          <ul className="divide-y divide-line">
            {data.recent.slice(0, 8).map((l: any) => (
              <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-fluid-xs">
                <span className="font-mono font-semibold">{l.vehicle?.registrationNumber ?? '—'}</span>
                <span className="text-muted">{l.liters} L</span>
                <span className="tabular-nums">{l.cost != null ? rupees(l.cost) : <Badge tone="warn">No cost logged</Badge>}</span>
                <span className="ml-auto text-faint">{new Date(l.loggedAt).toLocaleDateString('en-IN')}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
