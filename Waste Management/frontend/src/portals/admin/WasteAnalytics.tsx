import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, isRouteMissing, FEATURE_NOT_DEPLOYED } from '../../lib/api';
import { Card, EmptyState, ErrorState, Loading, SectionTitle } from '../../components/ui';
import { STREAM_COLOR, STREAM_LABELS, formatKg } from '../../lib/format';

const PALETTE = ['#16a34a', '#0ea5e9', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#f97316', '#6366f1', '#84cc16'];

/**
 * How much waste the city moved, and where it went.
 *
 * Weighed kilograms and officer estimates are charted as separate stacked
 * bands rather than one total. A load that has been handed over but not yet
 * processed has no weighbridge figure, so presenting the two as a single
 * settled number would overstate what is actually known — and the share that
 * is estimated is exactly what tells an admin how much to trust the total.
 */
export default function WasteAnalytics() {
  const [days, setDays] = useState(30);
  const [stream, setStream] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'waste-analytics', days, stream],
    queryFn: async () =>
      (await api('admin').get('/admin/analytics/waste', { params: { days, stream: stream || undefined } })).data,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={isRouteMissing(error) ? FEATURE_NOT_DEPLOYED : 'Could not load waste analytics'} onRetry={() => refetch()} />;

  const axis = { fontSize: 11, fill: 'rgb(var(--muted))' };
  const tooltipStyle = {
    background: 'rgb(var(--elevated))',
    border: '1px solid rgb(var(--line))',
    borderRadius: 12,
    fontSize: 12,
    color: 'rgb(var(--ink))',
  };

  const byStream = (data?.byStream ?? []).map((b: any) => ({
    ...b,
    label: STREAM_LABELS[b.key] ?? b.label,
    fill: STREAM_COLOR[b.key] ?? STREAM_COLOR.OTHER,
  }));
  const openByStream = (data?.openByStream ?? []).map((b: any) => ({
    ...b,
    fill: STREAM_COLOR[b.stream] ?? STREAM_COLOR.UNCLASSIFIED,
  }));

  const hasVolume = (data?.assignments ?? 0) > 0;

  /**
   * Axis ticks in tonnes once the numbers get long.
   *
   * A raw `unit="kg"` suffix pushed "8000kg" past the axis width and the
   * labels rendered clipped to "00kg" — a number that means nothing. Tonnes
   * keep the tick to three characters at any scale the city will reach.
   */
  const kgTick = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}t` : `${v}`);

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Waste analytics"
        subtitle={`Volume handed to processors over the last ${days} days`}
        action={
          <div className="flex flex-wrap gap-1.5">
            <select className="field text-fluid-xs" value={stream} onChange={(e) => setStream(e.target.value)}>
              <option value="">All streams</option>
              {Object.keys(STREAM_COLOR)
                .filter((k) => k !== 'UNCLASSIFIED')
                .map((id) => (
                  <option key={id} value={id}>{STREAM_LABELS[id]}</option>
                ))}
            </select>
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

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-fluid-xs uppercase tracking-wide text-muted">Total volume</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{formatKg(data?.totalKg)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-fluid-xs uppercase tracking-wide text-muted">Weighed</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{formatKg(data?.weighedKg)}</p>
          <p className="mt-0.5 text-fluid-xs text-muted">{data?.weighedShare ?? 0}% of the total</p>
        </Card>
        <Card className="p-4">
          <p className="text-fluid-xs uppercase tracking-wide text-muted">Still estimated</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{formatKg(data?.estimatedKg)}</p>
          <p className="mt-0.5 text-fluid-xs text-muted">Not yet weighed</p>
        </Card>
        <Card className="p-4">
          <p className="text-fluid-xs uppercase tracking-wide text-muted">Handoffs</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{data?.assignments ?? 0}</p>
        </Card>
      </div>

      {!hasVolume ? (
        <EmptyState
          title="No handoffs in this window"
          hint="Once officers start sending reports to companies, the volume charts fill in."
        />
      ) : (
        <>
          <Card className="p-4">
            <h3 className="mb-1 text-fluid-sm font-semibold">Volume over time</h3>
            <p className="mb-3 text-fluid-xs text-muted">
              Weighed and estimated are stacked separately — the pale band is what has not reached a weighbridge yet.
            </p>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.series} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <defs>
                    <linearGradient id="weighed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#16a34a" stopOpacity={0.55} />
                      <stop offset="100%" stopColor="#16a34a" stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="estimated" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#94a3b8" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#94a3b8" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" vertical={false} />
                  <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} minTickGap={28} />
                  <YAxis tick={axis} tickLine={false} axisLine={false} width={52} tickFormatter={kgTick} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => formatKg(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="weighedKg" name="Weighed" stackId="1" stroke="#16a34a" fill="url(#weighed)" strokeWidth={2} />
                  <Area type="monotone" dataKey="estimatedKg" name="Estimated" stackId="1" stroke="#94a3b8" fill="url(#estimated)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <h3 className="mb-3 text-fluid-sm font-semibold">Volume by stream</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={byStream}
                      dataKey="totalKg"
                      nameKey="label"
                      innerRadius="45%"
                      outerRadius="75%"
                      paddingAngle={2}
                    >
                      {byStream.map((d: any, i: number) => (
                        <Cell key={i} fill={d.fill} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => formatKg(Number(v))} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="mb-3 text-fluid-sm font-semibold">Open reports by stream</h3>
              <p className="mb-2 text-fluid-xs text-muted">What is still waiting to be routed, city-wide.</p>
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={openByStream} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" horizontal={false} />
                    <XAxis type="number" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="label" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={110} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgb(var(--sunken))' }} />
                    <Bar dataKey="count" name="Open reports" radius={[0, 6, 6, 0]}>
                      {openByStream.map((d: any, i: number) => (
                        <Cell key={i} fill={d.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <h3 className="mb-3 text-fluid-sm font-semibold">Volume by company</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.byCompany} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" horizontal={false} />
                    <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={kgTick} />
                    <YAxis type="category" dataKey="label" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={130} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => formatKg(Number(v))} />
                    <Bar dataKey="totalKg" name="Volume" radius={[0, 6, 6, 0]}>
                      {(data.byCompany ?? []).map((_: any, i: number) => (
                        <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="mb-3 text-fluid-sm font-semibold">Volume by ward</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.byWard} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" horizontal={false} />
                    <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={kgTick} />
                    <YAxis type="category" dataKey="label" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={130} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => formatKg(Number(v))} />
                    <Bar dataKey="totalKg" name="Volume" radius={[0, 6, 6, 0]}>
                      {(data.byWard ?? []).map((_: any, i: number) => (
                        <Cell key={i} fill={PALETTE[(i + 3) % PALETTE.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
