import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Siren, Truck, Phone } from 'lucide-react';
import { api, assetUrl, errorMessage } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, Meter, toast } from '../../components/ui';
import { STATUS_TONE, timeAgo, formatDuration } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useSocket, SOCKET_EVENTS } from '../../lib/socket';

/**
 * Emergency panel (plan §2.3) — unacknowledged emergencies with a live
 * countdown to auto-escalation. The countdown ticks client-side so an officer
 * sees urgency change without refreshing.
 */
export default function Emergencies() {
  const t = useT();
  const queryClient = useQueryClient();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  /*
    GET /officer/emergencies answers { slaBreaches, citizenEmergencies,
    driverSos } — three separate lists, not one array. Treating the envelope as
    an array threw "data.map is not a function" and the error boundary replaced
    the whole route. Driver SOS rides along in the same payload; there is no
    GET /officer/sos (only POST /officer/sos/:id/acknowledge), so the separate
    query that used to fetch it was answering 404 and rendering nothing.
  */
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['officer', 'emergencies'],
    queryFn: async () => (await api('officer').get('/officer/emergencies')).data,
    refetchInterval: 20_000,
  });

  const wards = useQuery({
    queryKey: ['officer', 'wards'],
    queryFn: async () => (await api('officer').get('/officer/wards')).data,
  });

  useSocket('officer', (wards.data ?? []).map((w: any) => `ward:${w.id}`), {
    [SOCKET_EVENTS.EMERGENCY_NEW]: () => {
      void queryClient.invalidateQueries({ queryKey: ['officer', 'emergencies'] });
      toast.error('New emergency reported');
    },
    [SOCKET_EVENTS.SOS_NEW]: () => {
      void queryClient.invalidateQueries({ queryKey: ['officer', 'emergencies'] });
      toast.error('Driver SOS raised');
    },
  });

  const acknowledge = useMutation({
    mutationFn: async (id: string) => (await api('officer').post(`/officer/complaints/${id}/verify`, { decision: 'VERIFIED', note: 'Acknowledged by officer' })).data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['officer'] });
      toast.success('Acknowledged — escalation timer stopped');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const ackSos = useMutation({
    mutationFn: async (id: string) => (await api('officer').post(`/officer/sos/${id}/acknowledge`)).data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['officer', 'emergencies'] });
      toast.success('SOS acknowledged — the driver has been told you are responding');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message="Could not load emergencies" onRetry={() => refetch()} />;

  const driverSos: any[] = data?.driverSos ?? [];
  const emergencies: any[] = data?.citizenEmergencies ?? [];
  /* A critical report that has also blown its clock comes back in both lists —
     show it once, under Emergencies, and leave only the rest here. */
  const emergencyIds = new Set(emergencies.map((c) => c.id));
  const breaches: any[] = (data?.slaBreaches ?? []).filter((c: any) => !emergencyIds.has(c.id));

  /** Shared card for both complaint lists — same clock, same actions. */
  const renderComplaint = (c: any) => {
    const dueMs = c.dueAt ? new Date(c.dueAt).getTime() - now : null;
    const minutesLeft = dueMs != null ? Math.round(dueMs / 60_000) : null;
    const overdue = dueMs != null && dueMs < 0;

    return (
      <li key={c.id}>
        <Card className={`p-4 ${overdue ? 'border-danger/60' : 'border-warn/40'}`}>
          <div className="flex items-start gap-3">
            {c.photoUrl ? (
              <img src={assetUrl(c.photoUrl)} alt="" className="h-20 w-20 shrink-0 rounded-xl object-cover" />
            ) : (
              <span className="grid h-20 w-20 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger">
                <Siren className="h-7 w-7" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="truncate text-fluid-base font-bold">{t(`category.${c.category}`)}</p>
                <Badge tone={STATUS_TONE[c.status]}>{t(`status.${c.status}`)}</Badge>
                {overdue && <Badge tone="danger">Overdue</Badge>}
              </div>
              <p className="mt-0.5 truncate text-fluid-xs text-muted">{c.address}</p>
              <p className="font-mono text-fluid-xs text-faint">
                {c.code} · {c.ward?.name} · {timeAgo(c.createdAt)}
              </p>
            </div>
          </div>

          <div className="mt-3">
            <Meter
              value={c.sla?.pctElapsed ?? 0}
              tone={overdue ? 'danger' : (minutesLeft ?? 60) < 10 ? 'warn' : 'info'}
              label={
                minutesLeft == null
                  ? 'No SLA clock on this report'
                  : overdue
                    ? `Escalated · ${formatDuration(Math.abs(minutesLeft))} over SLA`
                    : `${formatDuration(minutesLeft)} until auto-escalation`
              }
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <a
              href={`https://www.google.com/maps?q=${c.latitude},${c.longitude}`}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost btn-sm"
            >
              <Truck className="h-3.5 w-3.5" /> Locate
            </a>
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={c.status !== 'PENDING' || acknowledge.isPending}
              onClick={() => acknowledge.mutate(c.id)}
            >
              <Check className="h-3.5 w-3.5" />
              {c.status === 'PENDING' ? 'Acknowledge' : 'Acknowledged'}
            </button>
          </div>
        </Card>
      </li>
    );
  };

  return (
    <div className="space-y-5">
      {/* Driver SOS outranks everything else on this screen. */}
      {driverSos.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-fluid-lg font-semibold">
            <Siren className="h-5 w-5 text-danger" /> Driver SOS
            <Badge tone="danger">{driverSos.length}</Badge>
          </h2>
          <ul className="space-y-2.5">
            {driverSos.map((alert: any) => (
              <li key={alert.id}>
                <Card className="border-danger/50 bg-danger/5 p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-danger text-white">
                      <Siren className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-fluid-base font-bold">{alert.driver?.name}</p>
                      <p className="text-fluid-xs text-muted">
                        {alert.vehicle?.registrationNumber} · {timeAgo(alert.createdAt)}
                      </p>
                      {alert.message && <p className="mt-1 text-fluid-sm">{alert.message}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {alert.driver?.phone && (
                        <a href={`tel:${alert.driver.phone}`} className="btn-ghost btn-sm">
                          <Phone className="h-3.5 w-3.5" /> Call
                        </a>
                      )}
                      <a
                        href={`https://www.google.com/maps?q=${alert.latitude},${alert.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-ghost btn-sm"
                      >
                        Locate
                      </a>
                      <button
                        type="button"
                        className="btn-danger btn-sm"
                        disabled={alert.status !== 'OPEN' || ackSos.isPending}
                        onClick={() => ackSos.mutate(alert.id)}
                      >
                        <Check className="h-3.5 w-3.5" />
                        {alert.status === 'OPEN' ? 'Respond' : 'Responding'}
                      </button>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-fluid-lg font-semibold">
          Open emergencies
          {emergencies.length > 0 && <Badge tone="danger">{emergencies.length}</Badge>}
        </h2>
        {emergencies.length === 0 ? (
          <EmptyState
            title="No open emergencies"
            hint="Dead animals, medical waste, burning waste and sewage overflows appear here immediately with a 30-minute clock."
            icon={<Check className="h-8 w-8 text-ok" />}
          />
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">{emergencies.map(renderComplaint)}</ul>
        )}
      </section>

      {/* Ordinary reports past their SLA. Same clock, lower priority than a live
          emergency, so they get their own section rather than being mixed into
          the list above. */}
      {breaches.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-fluid-lg font-semibold">
            <Clock className="h-5 w-5 text-warn" /> Past SLA
            <Badge tone="warn">{breaches.length}</Badge>
          </h2>
          <p className="mb-2 text-fluid-xs text-muted">
            Non-emergency reports that have blown their resolution window and are awaiting reassignment.
          </p>
          <ul className="grid gap-3 lg:grid-cols-2">{breaches.map(renderComplaint)}</ul>
        </section>
      )}
    </div>
  );
}
