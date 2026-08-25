import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, Loader2, MapPin, TriangleAlert } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Badge, EmptyState, ErrorState, Loading, Meter, Modal, toast } from '../../components/ui';
import { QUANTITY_LABELS, STREAM_LABELS, STREAM_TONE, formatKg } from '../../lib/format';

/**
 * Hand one report to the firm that will process it.
 *
 * The server ranks who *may* take it — licensing is a filter, not a preference
 * — and this shows that ranking with the reasoning visible: which company
 * serves the ward, how much of today's intake it has already committed, and
 * how far the load has to travel. The officer can pick any of them; the list
 * is an argument, not a decision.
 */
export default function AssignCompanyModal({
  complaint,
  onClose,
  onAssigned,
}: {
  complaint: { id: string; code: string; wasteStream?: string | null; wasteStreamLabel?: string | null } | null;
  onClose: () => void;
  onAssigned?: () => void;
}) {
  const queryClient = useQueryClient();
  const [companyId, setCompanyId] = useState<string>('');
  const [quantity, setQuantity] = useState('MEDIUM');
  const [note, setNote] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['officer', 'suggested-companies', complaint?.id],
    queryFn: async () =>
      (await api('officer').get(`/officer/complaints/${complaint!.id}/suggested-companies`)).data,
    enabled: !!complaint,
  });

  const assign = useMutation({
    mutationFn: async () =>
      (
        await api('officer').post(`/officer/complaints/${complaint!.id}/assign-company`, {
          companyId,
          estimatedQuantity: quantity,
          note: note.trim() || undefined,
        })
      ).data,
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['officer'] });
      toast.success(`${complaint!.code} sent to ${res.company?.name}`);
      onAssigned?.();
      close();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not hand this over')),
  });

  const close = () => {
    setCompanyId('');
    setQuantity('MEDIUM');
    setNote('');
    onClose();
  };

  const suggestions = data?.suggestions ?? [];
  const stream = data?.wasteStream ?? complaint?.wasteStream ?? 'OTHER';

  return (
    <Modal open={!!complaint} onClose={close} title={`Send ${complaint?.code ?? ''} for processing`}>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState message="Could not load companies" onRetry={() => refetch()} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-sunken/60 p-3">
            <span className="text-fluid-xs text-muted">Processing stream</span>
            <Badge tone={STREAM_TONE[stream] ?? 'neutral'}>{STREAM_LABELS[stream] ?? stream}</Badge>
            {data?.wasteStreamConfidence != null && (
              <span className="text-fluid-xs text-muted">
                AI {Math.round((data.wasteStreamConfidence ?? 0) * 100)}% confident
              </span>
            )}
            {/*
              Only companies licensed for this stream are listed at all — the
              point is worth stating, because an officer who cannot find the
              company they expected should know it was excluded by licence
              rather than missing from the registry.
            */}
            <span className="w-full text-fluid-xs text-muted">
              Only companies licensed for this stream and serving this ward are shown.
            </span>
          </div>

          {!suggestions.length ? (
            <EmptyState
              title="No licensed company available"
              hint={data?.reason ?? 'No active company covers this stream in this ward. Ask an admin to add or reactivate one.'}
              icon={<Building2 className="h-6 w-6" />}
            />
          ) : (
            <>
              <div className="space-y-2">
                {suggestions.map((s: any, i: number) => {
                  const c = s.company;
                  const selected = companyId === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCompanyId(c.id)}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        selected ? 'border-brand bg-brand/5 ring-1 ring-brand/30' : 'border-line hover:bg-sunken/60'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-fluid-sm">{c.name}</span>
                        {i === 0 && <Badge tone="ok">Best match</Badge>}
                        {s.servesWard && <Badge tone="info">Serves this ward</Badge>}
                        {s.atCapacity && (
                          <Badge tone="warn">
                            <TriangleAlert className="mr-1 inline h-3 w-3" />
                            At capacity
                          </Badge>
                        )}
                        {selected && <Check className="ml-auto h-4 w-4 text-brand" />}
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-fluid-xs text-muted">
                        <span className="font-mono">{c.code}</span>
                        {s.km != null && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3" /> {s.km} km
                          </span>
                        )}
                        <span>
                          Today {formatKg(s.committedKgToday)}
                          {s.capacityKgPerDay > 0 ? ` of ${formatKg(s.capacityKgPerDay)}` : ' · no stated limit'}
                        </span>
                      </div>

                      {s.capacityKgPerDay > 0 && (
                        <Meter
                          value={Math.min(100, (s.committedKgToday / s.capacityKgPerDay) * 100)}
                          tone={s.atCapacity ? 'danger' : s.headroomRatio < 0.25 ? 'warn' : 'ok'}
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-fluid-xs font-medium text-muted">Estimated quantity</span>
                  <select className="field w-full text-fluid-sm" value={quantity} onChange={(e) => setQuantity(e.target.value)}>
                    {Object.entries(QUANTITY_LABELS).map(([id, label]) => (
                      <option key={id} value={id}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-fluid-xs font-medium text-muted">Note for the crew (optional)</span>
                  <input
                    className="field w-full text-fluid-sm"
                    placeholder="e.g. access from the service lane"
                    value={note}
                    maxLength={500}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
              </div>

              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost btn-sm" onClick={close}>Cancel</button>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={!companyId || assign.isPending}
                  onClick={() => assign.mutate()}
                >
                  {assign.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Building2 className="h-3.5 w-3.5" />}
                  Hand over
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
