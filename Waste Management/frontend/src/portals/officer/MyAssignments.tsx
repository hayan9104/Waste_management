import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, PackageCheck, Search, Truck, X } from 'lucide-react';
import { api, errorMessage, isRouteMissing, FEATURE_NOT_DEPLOYED } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, Modal, SectionTitle, toast } from '../../components/ui';
import {
  ASSIGNMENT_STATUS_LABELS,
  ASSIGNMENT_STATUS_TONE,
  STREAM_LABELS,
  STREAM_TONE,
  formatDateTime,
  formatDuration,
  formatKg,
  timeAgo,
} from '../../lib/format';
import { useSocket, SOCKET_EVENTS } from '../../lib/socket';

const STATUSES = ['PENDING_PICKUP', 'PICKED', 'COMPLETED', 'CANCELLED'];

/**
 * What this officer has handed over, and where it has got to.
 *
 * Scoped to the acting officer rather than the ward: a colleague's handoffs
 * would only dilute the answer to "what did I send and is it done". The
 * ward-wide and city-wide view is the admin's Assignment Overview.
 */
export default function MyAssignments() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [completing, setCompleting] = useState<any>(null);
  const [weight, setWeight] = useState('');
  const [cancelling, setCancelling] = useState<any>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [connected, setConnected] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['officer', 'my-assignments', status, search, page],
    queryFn: async () =>
      (
        await api('officer').get('/officer/my-assignments', {
          params: { status: status || undefined, search: search || undefined, page, pageSize: 25 },
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
      [SOCKET_EVENTS.COMPANY_ASSIGNMENT_CREATED]: () =>
        queryClient.invalidateQueries({ queryKey: ['officer', 'my-assignments'] }),
      [SOCKET_EVENTS.COMPANY_ASSIGNMENT_UPDATE]: () =>
        queryClient.invalidateQueries({ queryKey: ['officer', 'my-assignments'] }),
    }
  );
  if (socketConnected !== connected) setConnected(socketConnected);

  const advance = useMutation({
    mutationFn: async (body: { id: string; status: string; actualQuantityKg?: number; cancelReason?: string }) =>
      (await api('officer').patch(`/officer/assignments/${body.id}`, body)).data,
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['officer'] });
      toast.success(`${res.complaint?.code ?? 'Handoff'} — ${ASSIGNMENT_STATUS_LABELS[res.status] ?? res.status}`);
      setCompleting(null);
      setWeight('');
      setCancelling(null);
      setCancelReason('');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not update this handoff')),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={isRouteMissing(error) ? FEATURE_NOT_DEPLOYED : 'Could not load your assignments'} onRetry={() => refetch()} />;

  const items = data?.items ?? [];
  const counts = data?.statusCounts ?? {};

  return (
    <div className="space-y-4">
      <SectionTitle title="My assignments" subtitle="Reports you have handed to a processing company" />

      {/* Status tiles double as the filter, so reading the split and narrowing
          to one part of it is the same gesture. */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setStatus((cur) => (cur === s ? '' : s)); setPage(1); }}
            className={`rounded-xl border p-3 text-left transition ${
              status === s ? 'border-brand bg-brand/5 ring-1 ring-brand/30' : 'border-line hover:bg-sunken/60'
            }`}
          >
            <p className="text-fluid-xs uppercase tracking-wide text-muted">{ASSIGNMENT_STATUS_LABELS[s]}</p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums">{counts[s] ?? 0}</p>
          </button>
        ))}
      </div>

      <Card className="p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            className="field w-full pl-9 text-fluid-sm min-h-[40px]"
            placeholder="Search by ticket or company"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
      </Card>

      {!items.length ? (
        <EmptyState
          title="Nothing handed over yet"
          hint="Send a report to a company from the Waste categorization page and it will appear here."
          icon={<PackageCheck className="h-6 w-6" />}
        />
      ) : (
        <>
          <Card className="hidden overflow-hidden p-0 md:block">
            <div className="table-scroll">
              <table className="w-full min-w-[56rem] text-left text-fluid-sm">
                <thead className="border-b border-line bg-sunken/60 text-fluid-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2.5">Ticket</th>
                    <th className="px-3 py-2.5">Company</th>
                    <th className="px-3 py-2.5">Stream</th>
                    <th className="px-3 py-2.5">Quantity</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Ageing</th>
                    <th className="px-3 py-2.5">Sent</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {items.map((a: any) => (
                    <tr key={a.id} className="transition hover:bg-sunken/50">
                      <td className="px-3 py-2.5">
                        <span className="font-mono text-fluid-xs">{a.complaint?.code}</span>
                        <p className="max-w-[14rem] truncate text-fluid-xs text-muted">{a.complaint?.address}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="block truncate">{a.company?.name}</span>
                        <span className="font-mono text-fluid-xs text-muted">{a.company?.code}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={STREAM_TONE[a.wasteStream] ?? 'neutral'}>{STREAM_LABELS[a.wasteStream] ?? a.wasteStream}</Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="tabular-nums">{formatKg(a.quantityKg)}</span>
                        {/* An estimate and a weighbridge figure must never read
                            the same — the volume reporting depends on knowing
                            which of the two a number is. */}
                        {a.quantityIsEstimate && <p className="text-fluid-xs text-muted">estimated</p>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={ASSIGNMENT_STATUS_TONE[a.status]}>{ASSIGNMENT_STATUS_LABELS[a.status]}</Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        {a.sla ? (
                          <span className={`text-fluid-xs font-medium ${a.sla.overdue ? 'text-danger' : 'text-muted'}`}>
                            {a.sla.overdue ? `${formatDuration(-a.sla.minutesLeft)} over` : `${formatDuration(a.sla.minutesLeft)} left`}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-fluid-xs text-muted">{timeAgo(a.createdAt)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1.5">
                          {a.status === 'PENDING_PICKUP' && (
                            <button
                              type="button"
                              className="btn-ghost btn-sm"
                              disabled={advance.isPending}
                              onClick={() => advance.mutate({ id: a.id, status: 'PICKED' })}
                            >
                              <Truck className="h-3.5 w-3.5" /> Picked up
                            </button>
                          )}
                          {['PENDING_PICKUP', 'PICKED'].includes(a.status) && (
                            <>
                              <button type="button" className="btn-primary btn-sm" onClick={() => setCompleting(a)}>
                                <CheckCircle2 className="h-3.5 w-3.5" /> Complete
                              </button>
                              <button type="button" className="btn-ghost btn-sm" onClick={() => setCancelling(a)}>
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="space-y-2.5 md:hidden">
            {items.map((a: any) => (
              <Card key={a.id} className="p-3">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-fluid-xs">{a.complaint?.code}</span>
                  <Badge tone={ASSIGNMENT_STATUS_TONE[a.status]} className="ml-auto">
                    {ASSIGNMENT_STATUS_LABELS[a.status]}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-fluid-sm font-medium">{a.company?.name}</p>
                <p className="text-fluid-xs text-muted">
                  {STREAM_LABELS[a.wasteStream] ?? a.wasteStream} · {formatKg(a.quantityKg)}
                  {a.quantityIsEstimate ? ' (est.)' : ''} · {timeAgo(a.createdAt)}
                </p>
                {['PENDING_PICKUP', 'PICKED'].includes(a.status) && (
                  <div className="mt-2 flex gap-1.5">
                    {a.status === 'PENDING_PICKUP' && (
                      <button
                        type="button"
                        className="btn-ghost btn-sm flex-1"
                        disabled={advance.isPending}
                        onClick={() => advance.mutate({ id: a.id, status: 'PICKED' })}
                      >
                        <Truck className="h-3.5 w-3.5" /> Picked
                      </button>
                    )}
                    <button type="button" className="btn-primary btn-sm flex-1" onClick={() => setCompleting(a)}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> Complete
                    </button>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setCancelling(a)}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
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

      {/* Complete — the weighed figure is optional, because a load is often
          confirmed done before the weighbridge slip reaches the office. */}
      <Modal open={!!completing} onClose={() => setCompleting(null)} title="Complete this handoff">
        <div className="space-y-3">
          <p className="text-fluid-sm text-muted">
            {completing?.complaint?.code} with {completing?.company?.name}, sent {formatDateTime(completing?.createdAt)}.
          </p>
          <label className="block">
            <span className="mb-1 block text-fluid-xs font-medium text-muted">Weighed quantity in kg (optional)</span>
            <input
              type="number"
              min={0}
              className="field w-full text-fluid-sm"
              placeholder={`Leave blank to keep the estimate of ${formatKg(completing?.quantityKg)}`}
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
            <span className="mt-1 block text-fluid-xs text-muted">
              A weighed figure replaces the estimate in the city's volume reporting.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setCompleting(null)}>Cancel</button>
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={advance.isPending}
              onClick={() =>
                advance.mutate({
                  id: completing.id,
                  status: 'COMPLETED',
                  actualQuantityKg: weight.trim() ? Number(weight) : undefined,
                })
              }
            >
              {advance.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Mark completed
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!cancelling} onClose={() => setCancelling(null)} title="Withdraw this handoff">
        <div className="space-y-3">
          <p className="text-fluid-sm text-muted">
            {cancelling?.complaint?.code} goes back to the categorization list and can be sent to another company.
            The withdrawn handoff stays on the record.
          </p>
          <label className="block">
            <span className="mb-1 block text-fluid-xs font-medium text-muted">Reason</span>
            <input
              className="field w-full text-fluid-sm"
              placeholder="e.g. load refused on arrival"
              value={cancelReason}
              maxLength={300}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setCancelling(null)}>Keep it</button>
            <button
              type="button"
              className="btn-danger btn-sm"
              disabled={advance.isPending}
              onClick={() => advance.mutate({ id: cancelling.id, status: 'CANCELLED', cancelReason: cancelReason.trim() || undefined })}
            >
              {advance.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              Withdraw
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
