import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  BadgeCheck,
  Building2,
  ClipboardList,
  Fuel,
  Gauge,
  Loader2,
  LogIn,
  ScrollText,
  Siren,
  Truck,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { api, errorMessage, tokenStore } from '../lib/api';
import { Badge, toast } from './ui';
import { formatDuration, timeAgo } from '../lib/format';

/**
 * Officer and admin actions, reachable from the assistant.
 *
 * One component for both consoles rather than two near-identical ones: they
 * share a shell, a mode machine and an auth gate, and differ only in which
 * modes exist and which API prefix they call.
 *
 * What is deliberately absent on the admin side: re-seed, delete-complaints,
 * photo cleanup. Those wipe or destroy real rows, and a chat panel is the
 * wrong distance from an irreversible city-wide action — one mistaken tap
 * while scrolling should not be able to drop the database. They stay on the
 * console pages where they already live, behind their own confirmations.
 */

type Portal = 'officer' | 'admin';
type Mode =
  | 'menu'
  | 'queue'
  | 'emergencies'
  | 'status'
  | 'crew'
  | 'fleet'
  | 'sla'
  | 'fuel'
  | 'audit';

const TITLES: Record<Mode, string> = {
  menu: 'Assistant actions',
  queue: 'Review queue',
  emergencies: 'Emergencies & SOS',
  status: 'Ward status',
  crew: 'On-duty crew',
  fleet: 'Fleet & live routes',
  sla: 'SLA snapshot',
  fuel: 'Fuel & expenditure',
  audit: 'Recent audit entries',
};

export function StaffAssistantSheet({
  portal,
  open,
  initialMode = 'menu',
  onClose,
  onEvent,
}: {
  portal: Portal;
  open: boolean;
  initialMode?: Mode;
  onClose: () => void;
  onEvent?: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [assigning, setAssigning] = useState<any | null>(null);

  const signedIn = Boolean(tokenStore.get(portal));
  const isOfficer = portal === 'officer';
  const enabled = open && signedIn;

  /**
   * Every call below runs on every render, in the same order — `on` gates the
   * fetch, not the hook. Calling this conditionally would change the hook order
   * between renders and break React's rules of hooks.
   */
  const q = <T,>(key: string, url: string, on: boolean) =>
    useQuery<T>({
      queryKey: [portal, 'assistant', key],
      queryFn: async () => (await api(portal).get(url)).data,
      enabled: enabled && on,
    });

  const status = q<any>('status', isOfficer ? '/officer/dashboard' : '/admin/dashboard', mode === 'status' || mode === 'menu');
  const queue = q<any>('queue', '/officer/queue?reviewNeeded=true&pageSize=20', isOfficer && mode === 'queue');
  const emergencies = q<any>('emergencies', '/officer/emergencies', isOfficer && mode === 'emergencies');
  const fleet = q<any>('fleet', isOfficer ? '/officer/fleet' : '/admin/fleet', mode === 'fleet' || Boolean(assigning));
  const crew = q<any>('crew', isOfficer ? '/officer/shifts' : '/admin/shifts', mode === 'crew');
  const sla = q<any>('sla', isOfficer ? '/officer/sla?days=30' : '/admin/sla?days=30', mode === 'sla');
  const fuel = q<any>('fuel', isOfficer ? '/officer/fuel?days=30' : '/admin/fuel?days=30', mode === 'fuel');
  const audit = q<any>('audit', '/admin/audit?pageSize=15', !isOfficer && mode === 'audit');

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setAssigning(null);
      panelRef.current?.focus();
    }
  }, [open, initialMode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: [portal] }), [queryClient, portal]);

  async function run<T>(fn: () => Promise<T>, failure: string): Promise<T | null> {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      toast.error(errorMessage(err, failure));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function decide(c: any, decision: 'VERIFIED' | 'REJECTED') {
    const res = await run(
      async () => (await api('officer').post(`/officer/complaints/${c.id}/verify`, { decision })).data,
      `Could not ${decision === 'VERIFIED' ? 'verify' : 'reject'} ${c.code}`
    );
    if (!res) return;
    await refresh();
    const msg = `${c.code} ${decision === 'VERIFIED' ? 'verified' : 'rejected'}.`;
    toast.success(msg);
    onEvent?.(msg);
  }

  async function assignTo(vehicle: any) {
    if (!assigning) return;
    const res = await run(
      async () => (await api('officer').post('/officer/assign', { complaintId: assigning.id, vehicleId: vehicle.id })).data,
      'Could not assign that truck'
    );
    if (!res) return;
    await refresh();
    const msg = `${assigning.code} assigned to ${vehicle.registrationNumber}.`;
    toast.success(msg);
    onEvent?.(msg);
    setAssigning(null);
  }

  async function acknowledge(item: any, label: string) {
    const res = await run(
      async () => (await api('officer').post(`/officer/emergencies/${item.id}/ack`)).data,
      'Could not acknowledge that alert'
    );
    if (!res) return;
    await refresh();
    const msg = `Acknowledged ${label}.`;
    toast.success(msg);
    onEvent?.(msg);
  }

  if (!open) return null;

  const kpis = status.data?.kpis ?? status.data;

  return (
    <>
      <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm" onClick={() => !busy && onClose()} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[mode]}
        tabIndex={-1}
        className="fixed inset-0 z-[91] flex flex-col overflow-hidden bg-surface outline-none
                   sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92vh] sm:w-[min(36rem,calc(100vw-2rem))]
                   sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:border sm:border-line sm:shadow-2xl"
      >
        <div
          className={`flex shrink-0 items-center gap-2 border-b border-line px-3 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] text-white sm:pt-3 ${
            isOfficer ? 'bg-brand' : 'bg-orange-600'
          }`}
        >
          {mode !== 'menu' || assigning ? (
            <button
              type="button"
              onClick={() => (assigning ? setAssigning(null) : setMode('menu'))}
              aria-label="Back"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/25 bg-white/15 transition hover:bg-white/30 active:scale-95"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/20">
              {isOfficer ? <ClipboardList className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-fluid-sm font-bold leading-tight">
              {assigning ? `Assign a truck to ${assigning.code}` : TITLES[mode]}
            </h3>
            <p className="truncate text-[11px] opacity-85">{isOfficer ? 'Ward officer console' : 'City command centre'}</p>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Close"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/25 bg-white/15 transition hover:bg-white/30 active:scale-95"
          >
            <X className="h-5 w-5" strokeWidth={2.5} />
          </button>
        </div>

        {!signedIn ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/10 text-brand">
              <LogIn className="h-7 w-7" />
            </span>
            <h4 className="text-fluid-base font-bold">Sign in to continue</h4>
            <p className="max-w-xs text-fluid-xs text-muted">
              These actions are recorded in the audit log against your account, so they need your {portal} login.
            </p>
            <a href={`/${portal}/login`} className="btn-primary btn-sm mt-1">
              <LogIn className="h-3.5 w-3.5" /> Sign in
            </a>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {/* ------------------------------------------ ASSIGN sub-flow -- */}
            {assigning ? (
              <>
                <p className="mb-2 text-fluid-xs text-muted">{assigning.address || 'Reported location'}</p>
                {fleet.isLoading ? (
                  <Loading />
                ) : (
                  <ul className="space-y-2">
                    {(fleet.data ?? []).map((v: any) => (
                      <li key={v.id}>
                        <button
                          type="button"
                          onClick={() => assignTo(v)}
                          disabled={busy || v.maintenanceFlag}
                          className="flex w-full items-center gap-3 rounded-2xl border border-line bg-elevated p-3 text-left transition hover:border-brand/50 disabled:opacity-50"
                        >
                          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
                            <Truck className="h-5 w-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-fluid-xs font-semibold">{v.registrationNumber}</span>
                            <span className="block truncate text-fluid-xs text-muted">{v.driver?.name ?? 'Unassigned'}</span>
                          </span>
                          <Badge tone={v.maintenanceFlag ? 'warn' : v.isOffline ? 'neutral' : 'ok'}>
                            {v.maintenanceFlag ? 'Maintenance' : v.isOffline ? 'Offline' : 'Live'}
                          </Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <>
                {/* --------------------------------------------------- MENU */}
                {mode === 'menu' && (
                  <div className="space-y-3">
                    {isOfficer ? (
                      <>
                        <Item icon={<BadgeCheck className="h-5 w-5" />} title="Review queue" sub={`${kpis?.reviewNeeded ?? 0} awaiting a decision`} onClick={() => setMode('queue')} />
                        <Item icon={<Siren className="h-5 w-5" />} title="Emergencies & SOS" sub={`${kpis?.emergenciesOpen ?? 0} open right now`} tone="danger" onClick={() => setMode('emergencies')} />
                        <Item icon={<Gauge className="h-5 w-5" />} title="Ward status" sub="Open, overdue, trucks on route" onClick={() => setMode('status')} />
                        <Item icon={<Users className="h-5 w-5" />} title="On-duty crew" sub="Who is clocked in today" onClick={() => setMode('crew')} />
                        <Item icon={<Truck className="h-5 w-5" />} title="Fleet" sub="Trucks and their live state" onClick={() => setMode('fleet')} />
                        <Item icon={<ScrollText className="h-5 w-5" />} title="SLA snapshot" sub="Compliance over 30 days" onClick={() => setMode('sla')} />
                        <Item icon={<Fuel className="h-5 w-5" />} title="Fuel & expenditure" sub="Ward spend over 30 days" onClick={() => setMode('fuel')} />
                      </>
                    ) : (
                      <>
                        <Item icon={<Gauge className="h-5 w-5" />} title="City status" sub="Open, overdue, emergencies" onClick={() => setMode('status')} />
                        <Item icon={<Truck className="h-5 w-5" />} title="Fleet & live routes" sub="Every truck, city-wide" onClick={() => setMode('fleet')} />
                        <Item icon={<Users className="h-5 w-5" />} title="On-duty crew" sub="Drivers clocked in now" onClick={() => setMode('crew')} />
                        <Item icon={<ScrollText className="h-5 w-5" />} title="SLA snapshot" sub="Compliance over 30 days" onClick={() => setMode('sla')} />
                        <Item icon={<Fuel className="h-5 w-5" />} title="Fuel & expenditure" sub="City spend over 30 days" onClick={() => setMode('fuel')} />
                        <Item icon={<ScrollText className="h-5 w-5" />} title="Recent audit entries" sub="Who did what, most recent first" onClick={() => setMode('audit')} />
                        <p className="pt-1 text-[11px] leading-relaxed text-muted">
                          Re-seeding and bulk deletion are not offered here on purpose — they destroy real rows, and a
                          chat panel is the wrong distance from an irreversible city-wide action. They stay on the
                          console pages, behind their own confirmations.
                        </p>
                      </>
                    )}
                  </div>
                )}

                {/* -------------------------------------------------- QUEUE */}
                {mode === 'queue' && (
                  queue.isLoading ? <Loading /> : (queue.data?.items ?? []).length === 0 ? (
                    <Empty text="Nothing is waiting for a decision." />
                  ) : (
                    <ul className="space-y-2.5">
                      {queue.data.items.map((c: any) => (
                        <li key={c.id} className="rounded-2xl border border-line bg-elevated p-3.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-fluid-xs font-semibold">{c.code}</span>
                            {c.isEmergency && <Badge tone="danger">Emergency</Badge>}
                            {c.isLowConfidence && <Badge tone="warn">Low AI confidence</Badge>}
                            <span className="ml-auto text-fluid-xs text-muted">{timeAgo(c.createdAt)}</span>
                          </div>
                          <p className="mt-1 truncate text-fluid-xs text-muted">{c.address || 'Reported location'}</p>
                          <div className="mt-2.5 flex flex-wrap gap-2">
                            <button type="button" onClick={() => decide(c, 'VERIFIED')} disabled={busy} className="btn-primary btn-sm flex-1 disabled:opacity-50">
                              <BadgeCheck className="h-3.5 w-3.5" /> Verify
                            </button>
                            <button type="button" onClick={() => decide(c, 'REJECTED')} disabled={busy} className="btn-ghost btn-sm flex-1 disabled:opacity-50">
                              <XCircle className="h-3.5 w-3.5" /> Reject
                            </button>
                            <button type="button" onClick={() => setAssigning(c)} className="btn-ghost btn-sm flex-1">
                              <Truck className="h-3.5 w-3.5" /> Assign
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )
                )}

                {/* --------------------------------------------- EMERGENCIES */}
                {mode === 'emergencies' && (
                  emergencies.isLoading ? <Loading /> : (
                    <div className="space-y-4">
                      <Group title="Citizen emergencies" rows={emergencies.data?.citizenEmergencies ?? []} render={(c: any) => (
                        <li key={c.id} className="rounded-2xl border border-danger/30 bg-danger/5 p-3.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-fluid-xs font-semibold">{c.code}</span>
                            <Badge tone={c.vehicle ? 'ok' : 'warn'}>{c.vehicle ? `Truck ${c.vehicle.registrationNumber}` : 'No truck yet'}</Badge>
                            <span className="ml-auto text-fluid-xs text-muted">{timeAgo(c.createdAt)}</span>
                          </div>
                          <p className="mt-1 truncate text-fluid-xs text-muted">{c.address || 'Reported location'}</p>
                          <div className="mt-2.5 flex gap-2">
                            <button type="button" onClick={() => acknowledge(c, c.code)} disabled={busy || c.status !== 'PENDING'} className="btn-primary btn-sm flex-1 disabled:opacity-50">
                              Acknowledge
                            </button>
                            {!c.vehicle && (
                              <button type="button" onClick={() => setAssigning(c)} className="btn-ghost btn-sm flex-1">
                                <Truck className="h-3.5 w-3.5" /> Assign
                              </button>
                            )}
                          </div>
                        </li>
                      )} />
                      <Group title="Driver SOS" rows={emergencies.data?.driverSos ?? []} render={(s: any) => (
                        <li key={s.id} className="rounded-2xl border border-danger/30 bg-danger/5 p-3.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Siren className="h-4 w-4 text-danger" />
                            <span className="text-fluid-xs font-semibold">{s.driver?.name ?? 'Driver'}</span>
                            <Badge tone={s.status === 'OPEN' ? 'danger' : 'neutral'}>{s.status}</Badge>
                            <span className="ml-auto text-fluid-xs text-muted">{timeAgo(s.createdAt)}</span>
                          </div>
                          <p className="mt-1 truncate text-fluid-xs text-muted">{s.message || s.vehicle?.registrationNumber || '—'}</p>
                          <button type="button" onClick={() => acknowledge(s, `SOS from ${s.driver?.name ?? 'driver'}`)} disabled={busy || s.status !== 'OPEN'} className="btn-primary btn-sm mt-2.5 w-full disabled:opacity-50">
                            Acknowledge
                          </button>
                        </li>
                      )} />
                    </div>
                  )
                )}

                {/* ------------------------------------------------- STATUS */}
                {mode === 'status' && (
                  status.isLoading ? <Loading /> : kpis ? (
                    <div className="grid grid-cols-2 gap-3">
                      <Tile label="Open" value={kpis.openComplaints ?? 0} />
                      <Tile label="Overdue" value={kpis.overdue ?? 0} tone={kpis.overdue ? 'danger' : undefined} />
                      <Tile label="Needs review" value={kpis.reviewNeeded ?? 0} />
                      <Tile label="Emergencies" value={kpis.emergenciesOpen ?? 0} tone={kpis.emergenciesOpen ? 'danger' : undefined} />
                      <Tile label="Unassigned" value={kpis.unassigned ?? 0} />
                      <Tile label="Trucks on route" value={`${kpis.vehiclesOnRoute ?? 0} / ${kpis.vehiclesTotal ?? 0}`} />
                    </div>
                  ) : <Empty text="No status available." />
                )}

                {/* --------------------------------------------------- CREW */}
                {mode === 'crew' && (
                  crew.isLoading ? <Loading /> : crew.data ? (
                    <>
                      <div className="mb-3 grid grid-cols-3 gap-2">
                        <Tile label="On duty" value={crew.data.totals.onDuty} />
                        <Tile label="Worked today" value={crew.data.totals.workedToday} />
                        <Tile label="Hours" value={crew.data.totals.hoursLogged} />
                      </div>
                      {crew.data.onDuty.length === 0 ? <Empty text="Nobody is clocked in right now." /> : (
                        <ul className="space-y-2">
                          {crew.data.onDuty.map((s: any) => (
                            <li key={s.id} className="flex items-center gap-2.5 rounded-2xl border border-line bg-elevated p-3">
                              <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />
                              <span className="min-w-0 flex-1 truncate text-fluid-xs font-medium">{s.driver?.name}</span>
                              <span className="shrink-0 font-mono text-[11px] text-muted">{s.vehicle?.registrationNumber ?? '—'}</span>
                              <span className="w-16 shrink-0 text-right text-[11px] text-muted">{formatDuration(s.minutes ?? 0)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : <Empty text="No shift data." />
                )}

                {/* -------------------------------------------------- FLEET */}
                {mode === 'fleet' && (
                  fleet.isLoading ? <Loading /> : (
                    <ul className="space-y-2">
                      {(fleet.data ?? []).map((v: any) => (
                        <li key={v.id} className="flex items-center gap-2.5 rounded-2xl border border-line bg-elevated p-3">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-fluid-xs font-semibold">{v.registrationNumber}</span>
                            <span className="block truncate text-[11px] text-muted">{v.driver?.name ?? 'Unassigned'}{v.ward?.name ? ` · ${v.ward.name}` : ''}</span>
                          </span>
                          <Badge tone={v.maintenanceFlag ? 'warn' : v.isOffline ? 'neutral' : 'ok'}>
                            {v.maintenanceFlag ? 'Maintenance' : v.isOffline ? 'Offline' : v.status}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )
                )}

                {/* ---------------------------------------------------- SLA */}
                {mode === 'sla' && (
                  sla.isLoading ? <Loading /> : sla.data ? (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <Tile label="Compliance" value={sla.data.totals.compliancePct != null ? `${sla.data.totals.compliancePct}%` : '—'} />
                        <Tile label="Breached" value={sla.data.totals.breached} tone={sla.data.totals.breached ? 'danger' : undefined} />
                        <Tile label="Open breaches" value={sla.data.totals.openBreaches} tone={sla.data.totals.openBreaches ? 'danger' : undefined} />
                        <Tile label="Median close" value={formatDuration(sla.data.totals.medianResolutionMinutes ?? 0)} />
                      </div>
                      <p className="mt-3 text-[11px] text-muted">
                        Measured over the {sla.data.totals.measurable} resolved reports that carried a deadline.
                        {sla.data.totals.openBreaches > 0 && ` ${sla.data.totals.openBreaches} are past due and still open — not counted in the rate.`}
                      </p>
                    </>
                  ) : <Empty text="No SLA data." />
                )}

                {/* --------------------------------------------------- FUEL */}
                {mode === 'fuel' && (
                  fuel.isLoading ? <Loading /> : fuel.data ? (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <Tile label="Spend" value={`₹${Math.round(fuel.data.totals.cost).toLocaleString('en-IN')}`} />
                        <Tile label="Diesel" value={`${fuel.data.totals.litres} L`} />
                        <Tile label="Efficiency" value={fuel.data.totals.kmPerLitre != null ? `${fuel.data.totals.kmPerLitre} km/L` : '—'} />
                        <Tile label="Cost per km" value={fuel.data.totals.costPerKm != null ? `₹${fuel.data.totals.costPerKm}` : '—'} />
                      </div>
                      <p className="mt-3 text-[11px] text-muted">
                        Covers {fuel.data.totals.vehiclesReporting} of {fuel.data.totals.fleetSize} trucks.
                        {fuel.data.coverage.entriesMissingCost > 0 && ` ${fuel.data.coverage.entriesMissingCost} fill-ups logged litres but no cost, so spend is understated.`}
                      </p>
                    </>
                  ) : <Empty text="No fuel data." />
                )}

                {/* -------------------------------------------------- AUDIT */}
                {mode === 'audit' && (
                  audit.isLoading ? <Loading /> : (audit.data?.items ?? []).length === 0 ? (
                    <Empty text="No audit entries yet." />
                  ) : (
                    <ul className="space-y-2">
                      {audit.data.items.map((e: any) => (
                        <li key={e.id} className="rounded-2xl border border-line bg-elevated p-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <code className="rounded bg-sunken px-1.5 py-0.5 text-[11px]">{e.action}</code>
                            <span className="ml-auto text-[11px] text-muted">{timeAgo(e.createdAt)}</span>
                          </div>
                          <p className="mt-1 text-fluid-xs text-muted">
                            {e.actor ? `${e.actor.name} (${e.actor.role})` : 'System'} · {e.targetTable}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

const Loading = () => (
  <p className="flex items-center justify-center gap-2 py-10 text-fluid-xs text-muted">
    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
  </p>
);

const Empty = ({ text }: { text: string }) => (
  <p className="py-10 text-center text-fluid-xs text-muted">{text}</p>
);

function Group({ title, rows, render }: { title: string; rows: any[]; render: (r: any) => React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-fluid-xs font-semibold uppercase tracking-wide text-muted">
        {title} <span className="text-faint">({rows.length})</span>
      </h4>
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-line bg-sunken/40 p-3 text-center text-[11px] text-muted">None open.</p>
      ) : (
        <ul className="space-y-2">{rows.map(render)}</ul>
      )}
    </div>
  );
}

function Item({
  icon,
  title,
  sub,
  onClick,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition ${
        tone === 'danger' ? 'border-danger/40 bg-danger/5 hover:bg-danger/10' : 'border-line bg-elevated hover:border-brand/50 hover:bg-sunken'
      }`}
    >
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-brand/10 text-brand'}`}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-fluid-sm font-semibold">{title}</span>
        <span className="block text-fluid-xs text-muted">{sub}</span>
      </span>
    </button>
  );
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'danger' }) {
  return (
    <div className="rounded-2xl border border-line bg-elevated p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-fluid-base font-bold tabular-nums ${tone === 'danger' ? 'text-danger' : ''}`}>{value}</p>
    </div>
  );
}
