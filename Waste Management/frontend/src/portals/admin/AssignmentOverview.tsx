import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, PackageCheck, Search } from 'lucide-react';
import { api, isRouteMissing, FEATURE_NOT_DEPLOYED } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, SectionTitle } from '../../components/ui';
import {
  ASSIGNMENT_STATUS_LABELS,
  ASSIGNMENT_STATUS_TONE,
  STREAM_LABELS,
  STREAM_TONE,
  formatDateTime,
  formatKg,
  timeAgo,
} from '../../lib/format';
import { useSocket, SOCKET_EVENTS } from '../../lib/socket';

const STREAM_IDS = ['BIO', 'NON_BIO', 'HAZARDOUS', 'E_WASTE', 'OTHER'];
const STATUSES = ['PENDING_PICKUP', 'PICKED', 'COMPLETED', 'CANCELLED'];

/**
 * Who sent what, where, and when — city-wide.
 *
 * The accountability view: an officer, a company, a stream and a quantity on
 * one row, filterable the same way the officer queue is so the two pages are
 * learned once. Withdrawn handoffs are listed rather than hidden, because a
 * cancelled attempt is part of the record the page exists to keep.
 */
export default function AssignmentOverview() {
  const queryClient = useQueryClient();
  const [wardId, setWardId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [stream, setStream] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [connected, setConnected] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'assignments', wardId, companyId, stream, status, search, page],
    queryFn: async () =>
      (
        await api('admin').get('/admin/assignments', {
          params: {
            wardId: wardId || undefined,
            companyId: companyId || undefined,
            stream: stream || undefined,
            status: status || undefined,
            search: search || undefined,
            page,
            pageSize: 25,
          },
        })
      ).data,
    refetchInterval: connected ? 60_000 : 20_000,
  });

  const wards = useQuery({
    queryKey: ['admin', 'wards'],
    queryFn: async () => (await api('admin').get('/admin/wards')).data,
  });

  const companies = useQuery({
    queryKey: ['admin', 'companies', 'picker'],
    queryFn: async () => (await api('admin').get('/admin/companies')).data,
  });

  // The admin socket joins the city room on connect, so a handoff made by any
  // officer in any ward lands here without a refresh.
  const socketConnected = useSocket('admin', ['city'], {
    [SOCKET_EVENTS.COMPANY_ASSIGNMENT_CREATED]: () => queryClient.invalidateQueries({ queryKey: ['admin', 'assignments'] }),
    [SOCKET_EVENTS.COMPANY_ASSIGNMENT_UPDATE]: () => queryClient.invalidateQueries({ queryKey: ['admin', 'assignments'] }),
  });
  if (socketConnected !== connected) setConnected(socketConnected);

  const reset = (fn: () => void) => { fn(); setPage(1); };

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={isRouteMissing(error) ? FEATURE_NOT_DEPLOYED : 'Could not load assignments'} onRetry={() => refetch()} />;

  const items = data?.items ?? [];
  const counts = data?.statusCounts ?? {};

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Assignment overview"
        subtitle="Every handoff from a ward officer to a processing company"
      />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => reset(() => setStatus((cur) => (cur === s ? '' : s)))}
            className={`rounded-xl border p-3 text-left transition ${
              status === s ? 'border-brand bg-brand/5 ring-1 ring-brand/30' : 'border-line hover:bg-sunken/60'
            }`}
          >
            <p className="text-fluid-xs uppercase tracking-wide text-muted">{ASSIGNMENT_STATUS_LABELS[s]}</p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums">{counts[s] ?? 0}</p>
          </button>
        ))}
      </div>

      <Card className="space-y-2.5 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            className="field w-full pl-9 text-fluid-sm min-h-[40px]"
            placeholder="Search by ticket, company or officer"
            value={search}
            onChange={(e) => reset(() => setSearch(e.target.value))}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          <select className="field w-full text-fluid-xs min-h-[40px]" value={wardId} onChange={(e) => reset(() => setWardId(e.target.value))}>
            <option value="">All wards</option>
            {(wards.data ?? []).map((w: any) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>

          <select className="field w-full text-fluid-xs min-h-[40px]" value={companyId} onChange={(e) => reset(() => setCompanyId(e.target.value))}>
            <option value="">All companies</option>
            {(companies.data?.items ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <select className="field w-full text-fluid-xs min-h-[40px]" value={stream} onChange={(e) => reset(() => setStream(e.target.value))}>
            <option value="">All streams</option>
            {STREAM_IDS.map((id) => (
              <option key={id} value={id}>{STREAM_LABELS[id]}</option>
            ))}
          </select>
        </div>
      </Card>

      {!items.length ? (
        <EmptyState title="No handoffs match these filters" hint="Try clearing a filter." icon={<PackageCheck className="h-6 w-6" />} />
      ) : (
        <>
          <Card className="hidden overflow-hidden p-0 lg:block">
            <div className="table-scroll">
              <table className="w-full min-w-[64rem] text-left text-fluid-sm">
                <thead className="border-b border-line bg-sunken/60 text-fluid-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2.5">Ward officer</th>
                    <th className="px-3 py-2.5">Company</th>
                    <th className="px-3 py-2.5">Stream</th>
                    <th className="px-3 py-2.5">Complaint</th>
                    <th className="px-3 py-2.5">Ward</th>
                    <th className="px-3 py-2.5">Quantity</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {items.map((a: any) => (
                    <tr key={a.id} className="transition hover:bg-sunken/50">
                      <td className="px-3 py-2.5">{a.assignedBy?.name ?? <span className="text-faint">Removed account</span>}</td>
                      <td className="px-3 py-2.5">
                        <span className="block truncate">{a.company?.name}</span>
                        <span className="font-mono text-fluid-xs text-muted">{a.company?.code}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={STREAM_TONE[a.wasteStream] ?? 'neutral'}>{STREAM_LABELS[a.wasteStream] ?? a.wasteStream}</Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="font-mono text-fluid-xs">{a.complaint?.code}</span>
                        <p className="max-w-[13rem] truncate text-fluid-xs text-muted">{a.complaint?.address}</p>
                      </td>
                      <td className="px-3 py-2.5 text-fluid-xs">{a.complaint?.ward?.name ?? '—'}</td>
                      <td className="px-3 py-2.5">
                        <span className="tabular-nums">{formatKg(a.quantityKg)}</span>
                        {a.quantityIsEstimate && <p className="text-fluid-xs text-muted">estimated</p>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={ASSIGNMENT_STATUS_TONE[a.status]}>{ASSIGNMENT_STATUS_LABELS[a.status]}</Badge>
                        {a.cancelReason && <p className="mt-0.5 max-w-[12rem] truncate text-fluid-xs text-muted">{a.cancelReason}</p>}
                      </td>
                      <td className="px-3 py-2.5 text-fluid-xs text-muted" title={formatDateTime(a.createdAt)}>
                        {timeAgo(a.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="space-y-2.5 lg:hidden">
            {items.map((a: any) => (
              <Card key={a.id} className="p-3">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-fluid-xs">{a.complaint?.code}</span>
                  <Badge tone={ASSIGNMENT_STATUS_TONE[a.status]} className="ml-auto">{ASSIGNMENT_STATUS_LABELS[a.status]}</Badge>
                </div>
                <p className="mt-1 truncate text-fluid-sm font-medium">{a.company?.name}</p>
                <p className="text-fluid-xs text-muted">
                  by {a.assignedBy?.name ?? 'removed account'} · {a.complaint?.ward?.name ?? '—'}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-fluid-xs">
                  <Badge tone={STREAM_TONE[a.wasteStream] ?? 'neutral'}>{STREAM_LABELS[a.wasteStream] ?? a.wasteStream}</Badge>
                  <span className="tabular-nums text-muted">
                    {formatKg(a.quantityKg)}{a.quantityIsEstimate ? ' (est.)' : ''}
                  </span>
                  <span className="ml-auto text-muted">{timeAgo(a.createdAt)}</span>
                </div>
              </Card>
            ))}
          </div>

          {(data?.pages ?? 1) > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-fluid-xs text-muted">
                Page {data.page} of {data.pages} · {data.total} handoff{data.total === 1 ? '' : 's'}
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
    </div>
  );
}
