import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CircleCheck, TriangleAlert, Timer, Clock } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, Meter, SectionTitle, Stat } from '../../components/ui';
import { formatDuration } from '../../lib/format';

/**
 * SLA resolution analytics.
 *
 * On-time and breached are drawn in blue and red, not green and red: the
 * green/red pair scores ΔE 3.7 under deuteranopia, i.e. the two bars are the
 * same colour to a red-green colourblind reader. Blue/red separates cleanly
 * for every CVD type and against both light and dark surfaces.
 *
 * Compliance is null — not zero — on days when nothing was resolved. Plotting
 * those as 0% draws a cliff to the floor that never happened.
 */

const ON_TIME = '#0ea5e9';
const BREACHED = '#ef4444';

const toneFor = (pct: number | null) =>
  pct == null ? 'neutral' : pct >= 90 ? 'ok' : pct >= 75 ? 'warn' : 'danger';

export default function SlaAnalytics({ scope = 'admin' }: { scope?: 'admin' | 'officer' }) {
  const [days, setDays] = useState(30);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [scope, 'sla', days],
    queryFn: async () => (await api(scope).get(`/${scope}/sla`, { params: { days } })).data,
  });

  if (isLoading) return <Loading label="Loading SLA analytics…" />;
  if (error) return <ErrorState message="Could not load SLA analytics" onRetry={() => refetch()} />;

  const axis = { fontSize: 11, fill: 'rgb(var(--muted))' };
  const tooltipStyle = {
    background: 'rgb(var(--elevated))',
    border: '1px solid rgb(var(--line))',
    borderRadius: 12,
    fontSize: 12,
    color: 'rgb(var(--ink))',
  };
  const t = data.totals;
  const short = (d: string) => d.slice(5);

  return (
    <div className="space-y-5">
      <SectionTitle
        title="SLA resolution analytics"
        subtitle={`How much work was cleared inside its deadline · last ${days} days`}
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
        <Stat
          label="SLA compliance"
          value={t.compliancePct != null ? `${t.compliancePct}%` : '—'}
          hint={`${t.measurable - t.breached} of ${t.measurable} on time`}
          icon={<CircleCheck className="h-4 w-4" />}
          tone={toneFor(t.compliancePct)}
        />
        <Stat label="Breached" value={t.breached} hint="Closed late" icon={<TriangleAlert className="h-4 w-4" />} tone={t.breached ? 'danger' : 'ok'} />
        <Stat
          label="Open breaches"
          value={t.openBreaches}
          hint="Past due, still not closed"
          icon={<Clock className="h-4 w-4" />}
          tone={t.openBreaches ? 'danger' : 'ok'}
        />
        <Stat label="Median resolution" value={formatDuration(t.medianResolutionMinutes)} hint={`Mean ${formatDuration(t.avgResolutionMinutes)}`} icon={<Timer className="h-4 w-4" />} tone="info" />
        <Stat
          label="Emergency compliance"
          value={t.emergencyCompliancePct != null ? `${t.emergencyCompliancePct}%` : '—'}
          hint={t.routineCompliancePct != null ? `Routine ${t.routineCompliancePct}%` : undefined}
          icon={<TriangleAlert className="h-4 w-4" />}
          tone={toneFor(t.emergencyCompliancePct)}
        />
      </div>

      {/* Open breaches are excluded from the rate on purpose — counting them as
          compliant would let a ward that never closes anything score 100%. */}
      {(t.unmeasurable > 0 || t.openBreaches > 0) && (
        <Card className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-info/30 bg-info/5 p-3">
          <TriangleAlert className="h-4 w-4 shrink-0 text-info" />
          <p className="text-fluid-xs text-muted">
            The rate is measured over the <strong className="text-ink">{t.measurable}</strong> resolved reports that carried a
            deadline.
            {t.unmeasurable > 0 && ` ${t.unmeasurable} resolved without one and are excluded.`}
            {t.openBreaches > 0 && ` ${t.openBreaches} reports are already past due and still open — they are not in the rate.`}
          </p>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="text-fluid-sm font-semibold">Compliance trend</h3>
        <p className="mb-2 text-fluid-xs text-muted">Percentage resolved inside deadline. Days with nothing resolved are gaps, not zeros.</p>
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.series} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={axis} tickFormatter={short} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={axis} tickLine={false} axisLine={false} width={40} domain={[0, 100]} unit="%" />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: any) => [v == null ? 'No data' : `${v}%`, 'On time']}
              />
              <Line
                type="monotone"
                dataKey="compliancePct"
                stroke={ON_TIME}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="p-4">
        <h3 className="text-fluid-sm font-semibold">On time vs breached, by day</h3>
        <p className="mb-2 text-fluid-xs text-muted">Volume behind the rate above</p>
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.series} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={axis} tickFormatter={short} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={axis} tickLine={false} axisLine={false} width={36} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgb(var(--sunken))' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="onTime" name="On time" stackId="s" fill={ON_TIME} maxBarSize={26} />
              <Bar dataKey="breached" name="Breached" stackId="s" fill={BREACHED} radius={[4, 4, 0, 0]} maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="overflow-hidden p-0">
          <div className="border-b border-line bg-sunken/60 px-4 py-3">
            <h3 className="text-fluid-sm font-semibold">By category</h3>
            <p className="text-fluid-xs text-muted">Worst compliance first</p>
          </div>
          {data.byCategory.length === 0 ? (
            <EmptyState title="Nothing resolved in this period" icon={<CircleCheck className="h-8 w-8" />} />
          ) : (
            <ul className="divide-y divide-line">
              {data.byCategory.map((c: any) => (
                <li key={c.category} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-fluid-sm font-medium">{c.label}</p>
                    <Badge tone={toneFor(c.compliancePct)}>{c.compliancePct != null ? `${c.compliancePct}%` : 'n/a'}</Badge>
                  </div>
                  <Meter value={c.compliancePct ?? 0} tone={toneFor(c.compliancePct)} />
                  <p className="mt-1 text-fluid-xs text-muted">
                    {c.resolved} resolved · {c.breached} late · avg {formatDuration(c.avgResolutionMinutes)}
                    {c.targetMinutes != null && ` · target ${formatDuration(c.targetMinutes)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-line bg-sunken/60 px-4 py-3">
            <h3 className="text-fluid-sm font-semibold">By ward</h3>
            <p className="text-fluid-xs text-muted">Compliance and outstanding breaches</p>
          </div>
          <div className="table-scroll">
            <table className="w-full min-w-[30rem] text-left text-fluid-sm">
              <thead className="border-b border-line text-fluid-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5">Ward</th>
                  <th className="px-4 py-2.5 text-right">Resolved</th>
                  <th className="px-4 py-2.5 text-right">Late</th>
                  <th className="px-4 py-2.5 text-right">Open breach</th>
                  <th className="px-4 py-2.5 text-right">SLA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.byWard.map((w: any) => (
                  <tr key={w.ward.id}>
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-fluid-xs text-muted">{w.ward.code}</span>{' '}
                      <span className="font-medium">{w.ward.name}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{w.resolved}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{w.breached}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{w.openBreaches}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Badge tone={toneFor(w.compliancePct)}>{w.compliancePct != null ? `${w.compliancePct}%` : 'n/a'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {data.worstOpen.length > 0 && (
        <Card className="p-4">
          <h3 className="text-fluid-sm font-semibold">Longest overdue, still open</h3>
          <p className="mb-2 text-fluid-xs text-muted">These are the breaches that are still getting worse</p>
          <ul className="divide-y divide-line">
            {data.worstOpen.map((c: any) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-fluid-xs">
                <span className="font-mono font-semibold">{c.code}</span>
                <span className="truncate text-muted">{c.category}</span>
                {c.isEmergency && <Badge tone="danger">Emergency</Badge>}
                <span className="ml-auto font-semibold text-danger tabular-nums">
                  {formatDuration(c.minutesOverdue)} over
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
