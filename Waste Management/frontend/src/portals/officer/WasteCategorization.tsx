import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Building2, ChevronLeft, ChevronRight, Recycle, TriangleAlert } from 'lucide-react';
import { api, assetUrl, errorMessage, isRouteMissing, FEATURE_NOT_DEPLOYED } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, EvidencePhoto, Loading, Meter, SectionTitle, toast } from '../../components/ui';
import {
  SEVERITY_TONE,
  STREAM_COLOR,
  STREAM_LABELS,
  STREAM_TONE,
  formatDuration,
  timeAgo,
} from '../../lib/format';
import { useSocket, SOCKET_EVENTS } from '../../lib/socket';
import { useT } from '../../lib/i18n';
import AssignCompanyModal from './AssignCompanyModal';

const STREAM_IDS = ['BIO', 'NON_BIO', 'HAZARDOUS', 'E_WASTE', 'OTHER'];

/**
 * The ward's open work seen along the processing axis.
 *
 * The Queue answers "what has come in and who is collecting it"; this answers
 * "what kind of waste is it and who may lawfully take it". They are separate
 * pages because they are separate decisions — a report can have a truck
 * assigned and still have nowhere to go.
 */
export default function WasteCategorization() {
  const t = useT();
  const queryClient = useQueryClient();
  const [stream, setStream] = useState<string>('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [assignTarget, setAssignTarget] = useState<any>(null);
  const [connected, setConnected] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['officer', 'waste-categorization', stream, reviewOnly, page],
    queryFn: async () =>
      (
        await api('officer').get('/officer/waste-categorization', {
          params: { stream: stream || undefined, reviewOnly: reviewOnly || undefined, page, pageSize: 25 },
        })
      ).data,
    refetchInterval: connected ? 60_000 : 15_000,
  });

  const wards = useQuery({
    queryKey: ['officer', 'wards'],
    queryFn: async () => (await api('officer').get('/officer/wards')).data,
  });

  const socketConnected = useSocket(
    'officer',
    (wards.data ?? []).map((w: any) => `ward:${w.id}`),
    {
      [SOCKET_EVENTS.COMPLAINT_NEW]: () => queryClient.invalidateQueries({ queryKey: ['officer', 'waste-categorization'] }),
      [SOCKET_EVENTS.COMPLAINT_UPDATE]: () => queryClient.invalidateQueries({ queryKey: ['officer', 'waste-categorization'] }),
      // A colleague handing something over removes it from this list.
      [SOCKET_EVENTS.COMPANY_ASSIGNMENT_CREATED]: () =>
        queryClient.invalidateQueries({ queryKey: ['officer', 'waste-categorization'] }),
      [SOCKET_EVENTS.COMPANY_ASSIGNMENT_UPDATE]: () =>
        queryClient.invalidateQueries({ queryKey: ['officer', 'waste-categorization'] }),
    }
  );
  if (socketConnected !== connected) setConnected(socketConnected);

  const setStreamFilter = (next: string) => {
    setStream((cur) => (cur === next ? '' : next));
    setPage(1);
  };

  const reclassify = useMutation({
    mutationFn: async ({ id, wasteStream }: { id: string; wasteStream: string }) =>
      (await api('officer').patch(`/officer/complaints/${id}/waste-stream`, { wasteStream })).data,
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['officer'] });
      toast.success(`${res.code} set to ${STREAM_LABELS[res.wasteStream] ?? res.wasteStream}`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not change the stream')),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={isRouteMissing(error) ? FEATURE_NOT_DEPLOYED : 'Could not load waste categorization'} onRetry={() => refetch()} />;

  const items = data?.items ?? [];
  const breakdown = data?.breakdown ?? [];
  const chartData = breakdown.map((b: any) => ({ ...b, fill: STREAM_COLOR[b.stream] ?? STREAM_COLOR.OTHER }));
  const axis = { fontSize: 11, fill: 'rgb(var(--muted))' };
  const tooltipStyle = {
    background: 'rgb(var(--elevated))',
    border: '1px solid rgb(var(--line))',
    borderRadius: 12,
    fontSize: 12,
    color: 'rgb(var(--ink))',
  };

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Waste categorization"
        subtitle="Open reports in your wards, by how the waste has to be processed"
      />

      {/* Summary: the chart and the stream chips are the same filter, so
          reading the split and narrowing to one part of it is one gesture. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="p-4">
          <h3 className="mb-3 text-fluid-sm font-semibold">Open reports by stream</h3>
          {!breakdown.length ? (
            <EmptyState title="Nothing open" hint="Every report in your wards is closed." />
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" horizontal={false} />
                  <XAxis type="number" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="label" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={110} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgb(var(--sunken))' }} />
                  <Bar dataKey="count" name="Open reports" radius={[0, 6, 6, 0]}>
                    {chartData.map((d: any, i: number) => (
                      <Cell key={i} fill={d.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <div className="space-y-3">
          <Card className="p-4">
            <p className="text-fluid-xs uppercase tracking-wide text-muted">Needs your confirmation</p>
            <p className="mt-1 text-3xl font-bold tabular-nums">{data?.reviewNeeded ?? 0}</p>
            <p className="mt-1 text-fluid-xs text-muted">
              The classifier was not confident enough to settle the stream on its own.
            </p>
            {(data?.reviewNeeded ?? 0) > 0 && (
              <button
                type="button"
                className={`btn-sm mt-2 w-full ${reviewOnly ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setReviewOnly((v) => !v); setPage(1); }}
              >
                <TriangleAlert className="h-3.5 w-3.5" />
                {reviewOnly ? 'Showing only these' : 'Show only these'}
              </button>
            )}
          </Card>

          <Card className="p-4">
            <p className="text-fluid-xs uppercase tracking-wide text-muted">Out with a company</p>
            <p className="mt-1 text-3xl font-bold tabular-nums">{data?.liveAssignments ?? 0}</p>
            <p className="mt-1 text-fluid-xs text-muted">Handed over and not yet completed.</p>
          </Card>
        </div>
      </div>

      {/* Stream filter chips */}
      <Card className="p-3">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none">
          <button
            type="button"
            onClick={() => { setStream(''); setPage(1); }}
            className={`chip whitespace-nowrap px-3 py-1.5 text-[11px] font-semibold transition ${
              stream === '' ? 'border-brand bg-brand/10 text-brand font-bold' : 'text-muted hover:bg-sunken hover:text-ink'
            }`}
          >
            All streams
          </button>
          {STREAM_IDS.map((id) => {
            const row = breakdown.find((b: any) => b.stream === id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => setStreamFilter(id)}
                className={`chip whitespace-nowrap px-3 py-1.5 text-[11px] font-semibold transition ${
                  stream === id ? 'border-brand bg-brand/10 text-brand font-bold' : 'text-muted hover:bg-sunken hover:text-ink'
                }`}
              >
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: STREAM_COLOR[id] }} />
                {STREAM_LABELS[id]}
                {row ? ` (${row.count})` : ''}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setStreamFilter('UNCLASSIFIED')}
            className={`chip whitespace-nowrap px-3 py-1.5 text-[11px] font-semibold transition ${
              stream === 'UNCLASSIFIED' ? 'border-brand bg-brand/10 text-brand font-bold' : 'text-muted hover:bg-sunken hover:text-ink'
            }`}
          >
            Not yet classified
          </button>
        </div>
      </Card>

      {!items.length ? (
        <EmptyState
          title="Nothing here"
          hint={reviewOnly ? 'No report is waiting on a stream decision.' : 'No open report matches this stream.'}
          icon={<Recycle className="h-6 w-6" />}
        />
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden overflow-hidden p-0 md:block">
            <div className="table-scroll">
              <table className="w-full min-w-[58rem] text-left text-fluid-sm">
                <thead className="border-b border-line bg-sunken/60 text-fluid-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2.5">Photo</th>
                    <th className="px-3 py-2.5">Ticket</th>
                    <th className="px-3 py-2.5">Category</th>
                    <th className="px-3 py-2.5">Waste stream</th>
                    <th className="px-3 py-2.5">AI confidence</th>
                    <th className="px-3 py-2.5">SLA</th>
                    <th className="px-3 py-2.5">Handed to</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {items.map((c: any) => (
                    <tr key={c.id} className={`transition hover:bg-sunken/50 ${c.isEmergency ? 'bg-danger/5' : ''}`}>
                      <td className="px-3 py-2.5">
                        <EvidencePhoto src={assetUrl(c.photoUrl)} alt="Reported" compact className="h-11 w-11 rounded-lg object-cover" />
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="font-mono text-fluid-xs">{c.code}</span>
                        {c.isEmergency && <Badge tone="danger" className="ml-1.5">SOS</Badge>}
                        <p className="max-w-[14rem] truncate text-fluid-xs text-muted">{c.address}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="block truncate">{t(`category.${c.category}`)}</span>
                        <Badge tone={SEVERITY_TONE[c.severity]} className="mt-0.5">{c.severity}</Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        {/*
                          Editable inline. An officer correcting a stream is the
                          commonest action on this page, and sending them into a
                          detail view to change one enum would make the review
                          backlog slower to clear than it is to read.
                        */}
                        <select
                          className="field w-full min-w-[9rem] text-fluid-xs"
                          value={c.wasteStream ?? ''}
                          disabled={reclassify.isPending || !!c.assignment}
                          title={c.assignment ? 'Already handed over — cancel that first to change the stream' : undefined}
                          onChange={(e) => reclassify.mutate({ id: c.id, wasteStream: e.target.value })}
                        >
                          {!c.wasteStream && <option value="">Not classified</option>}
                          {STREAM_IDS.map((id) => (
                            <option key={id} value={id}>{STREAM_LABELS[id]}</option>
                          ))}
                        </select>
                        {c.wasteStreamOverridden && (
                          <span className="mt-1 block text-fluid-xs text-muted">Set by an officer</span>
                        )}
                      </td>
                      <td className="w-36 px-3 py-2.5">
                        <Meter
                          value={(c.wasteStreamConfidence ?? 0) * 100}
                          tone={c.wasteStreamOverridden ? 'ok' : c.wasteStreamReviewNeeded ? 'warn' : 'info'}
                        />
                        {c.wasteStreamReviewNeeded && (
                          <span className="mt-1 block text-fluid-xs font-medium text-warn">Confirm stream</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {c.sla ? (
                          <span className={`text-fluid-xs font-medium ${c.sla.overdue ? 'text-danger' : 'text-muted'}`}>
                            {c.sla.overdue ? `${formatDuration(-c.sla.minutesLeft)} over` : `${formatDuration(c.sla.minutesLeft)} left`}
                          </span>
                        ) : '—'}
                        <p className="text-fluid-xs text-muted">{timeAgo(c.createdAt)}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        {c.assignment ? (
                          <>
                            <span className="block truncate text-fluid-xs font-medium">{c.assignment.company?.name}</span>
                            <Badge tone={c.assignment.status === 'PICKED' ? 'info' : 'warn'} className="mt-0.5">
                              {c.assignment.status === 'PICKED' ? 'Picked up' : 'Awaiting pickup'}
                            </Badge>
                          </>
                        ) : (
                          <span className="text-fluid-xs text-faint">Not sent</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {!c.assignment && (
                          <button type="button" className="btn-primary btn-sm" onClick={() => setAssignTarget(c)}>
                            <Building2 className="h-3.5 w-3.5" /> Send
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile cards — the same rows, stacked. */}
          <div className="space-y-2.5 md:hidden">
            {items.map((c: any) => (
              <Card key={c.id} className="p-3">
                <div className="flex gap-3">
                  <EvidencePhoto src={assetUrl(c.photoUrl)} alt="Reported" compact className="h-14 w-14 shrink-0 rounded-lg object-cover" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-fluid-xs">{c.code}</span>
                      {c.isEmergency && <Badge tone="danger">SOS</Badge>}
                      <Badge tone={STREAM_TONE[c.wasteStream ?? 'UNCLASSIFIED']} className="ml-auto">
                        {STREAM_LABELS[c.wasteStream ?? 'UNCLASSIFIED']}
                      </Badge>
                    </div>
                    <p className="truncate text-fluid-xs text-muted">{c.address}</p>
                    <p className="mt-0.5 text-fluid-xs text-muted">
                      {t(`category.${c.category}`)} · {timeAgo(c.createdAt)}
                    </p>
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <select
                    className="field flex-1 text-fluid-xs"
                    value={c.wasteStream ?? ''}
                    disabled={reclassify.isPending || !!c.assignment}
                    onChange={(e) => reclassify.mutate({ id: c.id, wasteStream: e.target.value })}
                  >
                    {!c.wasteStream && <option value="">Not classified</option>}
                    {STREAM_IDS.map((id) => (
                      <option key={id} value={id}>{STREAM_LABELS[id]}</option>
                    ))}
                  </select>
                  {c.assignment ? (
                    <Badge tone={c.assignment.status === 'PICKED' ? 'info' : 'warn'}>{c.assignment.company?.name}</Badge>
                  ) : (
                    <button type="button" className="btn-primary btn-sm" onClick={() => setAssignTarget(c)}>
                      <Building2 className="h-3.5 w-3.5" /> Send
                    </button>
                  )}
                </div>
              </Card>
            ))}
          </div>

          {(data?.pages ?? 1) > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-fluid-xs text-muted">
                Page {data.page} of {data.pages} · {data.total} report{data.total === 1 ? '' : 's'}
              </p>
              <div className="flex gap-1.5">
                <button type="button" className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </button>
                <button type="button" className="btn-ghost btn-sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <AssignCompanyModal complaint={assignTarget} onClose={() => setAssignTarget(null)} />
    </div>
  );
}
