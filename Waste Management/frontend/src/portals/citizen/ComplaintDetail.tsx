import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  Check,
  Clock,
  MapPin,
  Sparkles,
  Truck,
  Users,
  ShieldCheck,
  Navigation,
  Calendar,
  Layers,
  ArrowLeft,
} from 'lucide-react';
import { api, assetUrl } from '../../lib/api';
import { Badge, Card, ErrorState, EvidencePhoto, Loading, Meter } from '../../components/ui';
import { BackLink } from '../../components/shells';
import { BaseMap, PinMarker } from '../../components/map/Map';
import { CATEGORY_LABELS, STATUS_LABELS, STATUS_TONE, formatDateTime, timeAgo } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useSocket, SOCKET_EVENTS } from '../../lib/socket';

const FLOW = ['PENDING', 'VERIFIED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED'];

export default function ComplaintDetail() {
  const t = useT();
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['citizen', 'complaint', id],
    queryFn: async () => (await api('citizen').get(`/citizen/complaints/${id}`)).data,
    enabled: Boolean(id),
  });

  // Live status changes without a refresh.
  useSocket('citizen', id ? [`complaint:${id}`] : [], {
    [SOCKET_EVENTS.COMPLAINT_UPDATE]: () => refetch(),
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorState message="Could not load this report" onRetry={() => refetch()} />;

  const currentIndex = FLOW.indexOf(data.status);
  const rejected = data.status === 'REJECTED';

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      {/* Top Breadcrumb & Title */}
      <div className="space-y-2">
        <BackLink to="/app/complaints" label="My reports" />

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-fluid-2xl font-bold tracking-tight text-ink">
                {t(`category.${data.category}`)}
              </h1>
              {data.isEmergency && <Badge tone="danger" className="text-xs font-bold">🚨 Emergency (30m SLA)</Badge>}
              {data.assignmentType === 'AUTO' && (
                <span className="inline-flex items-center gap-1 rounded-full border border-teal-500/30 bg-teal-500/10 px-2.5 py-0.5 text-xs font-semibold text-teal-600 dark:text-teal-400">
                  <Sparkles className="h-3 w-3 text-teal-500" /> Auto-assigned
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-fluid-xs text-muted mt-1 font-mono">
              <span>Ticket #{data.code}</span>
              <span>•</span>
              <span>Reported {formatDateTime(data.createdAt)}</span>
              {data.ward?.name && (
                <>
                  <span>•</span>
                  <span>{data.ward.name}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONE[data.status]} className="text-fluid-xs px-3 py-1 font-bold">
              {t(`status.${data.status}`)}
            </Badge>
          </div>
        </div>
      </div>

      {/* Main 2-Column Responsive Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Visual Resolution Evidence & Map Location (7 cols) */}
        <div className="lg:col-span-7 space-y-5">
          {/* Visual Resolution Evidence Card */}
          {(data.photoUrl || data.resolutionPhotoUrl) && (
            <Card className="overflow-hidden p-0 border border-line shadow-xs rounded-2xl">
              <div className="border-b border-line bg-sunken/80 px-4 py-3 flex items-center justify-between">
                <span className="text-fluid-xs font-bold uppercase tracking-wider text-muted flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-brand" /> Visual Resolution Evidence
                </span>
                <Badge tone={data.status === 'RESOLVED' ? 'ok' : 'brand'} className="text-[11px] font-bold">
                  {data.status === 'RESOLVED' ? 'Cleaned with Proof ✅' : 'Under Investigation'}
                </Badge>
              </div>

              <div className={`grid ${data.resolutionPhotoUrl ? 'grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-line' : 'grid-cols-1'}`}>
                {data.photoUrl && (
                  <div className="relative group overflow-hidden bg-black/5">
                    <EvidencePhoto
                      src={assetUrl(data.photoUrl)}
                      alt="Citizen Reported Issue"
                      className="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-105"
                    />
                    <div className="absolute top-3 left-3 rounded-lg bg-black/75 px-2.5 py-1 text-[11px] font-bold text-white uppercase backdrop-blur-md shadow-sm">
                      1. Citizen Photo
                    </div>
                  </div>
                )}
                {data.resolutionPhotoUrl && (
                  <div className="relative group overflow-hidden bg-black/5">
                    <EvidencePhoto
                      src={assetUrl(data.resolutionPhotoUrl)}
                      alt="Driver Cleaned Proof"
                      className="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-105"
                    />
                    <div className="absolute top-3 left-3 rounded-lg bg-emerald-600/90 px-2.5 py-1 text-[11px] font-bold text-white uppercase backdrop-blur-md shadow-sm flex items-center gap-1">
                      <Check className="h-3 w-3" /> 2. Driver Cleaned Proof
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Location Map Card */}
          <Card className="overflow-hidden p-0 border border-line shadow-xs rounded-2xl space-y-0">
            <div className="border-b border-line bg-sunken/80 px-4 py-3 flex items-center justify-between">
              <span className="text-fluid-xs font-bold uppercase tracking-wider text-muted flex items-center gap-2">
                <MapPin className="h-4 w-4 text-brand" /> Location Pinned on Map
              </span>
              <span className="font-mono text-[11px] text-muted">
                {data.latitude?.toFixed(4)}, {data.longitude?.toFixed(4)}
              </span>
            </div>

            <div className="h-64 sm:h-72 w-full">
              <BaseMap center={[data.latitude, data.longitude]} zoom={16} scrollWheelZoom={false}>
                <PinMarker
                  latitude={data.latitude}
                  longitude={data.longitude}
                  tone={data.isEmergency ? 'danger' : 'brand'}
                  label={data.address || data.code}
                />
              </BaseMap>
            </div>

            <div className="p-4 bg-surface border-t border-line space-y-1">
              <div className="flex items-start gap-2.5">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                <div className="min-w-0 flex-1">
                  <p className="text-fluid-sm font-semibold text-ink leading-snug">
                    {data.address || 'Auto-Detected GPS Location'}
                  </p>
                  <p className="text-fluid-xs text-muted mt-0.5">
                    {data.ward?.name || 'Municipal Ward Area'} · Coordinates auto-verified by device GPS
                  </p>
                </div>
              </div>
            </div>
          </Card>

          {/* Citizen Description Card (if present) */}
          {data.description && (
            <Card className="p-5 border border-line shadow-xs rounded-2xl space-y-2">
              <p className="text-fluid-xs font-bold uppercase tracking-wider text-muted">Citizen's Note / Details</p>
              <p className="text-fluid-sm text-ink leading-relaxed bg-sunken/60 p-3.5 rounded-xl border border-line">
                {data.description}
              </p>
            </Card>
          )}

          {/* Merged Duplicate Reports Notice */}
          {data.alsoReportedBy > 0 && (
            <Card className="flex items-start gap-3.5 p-4 border border-info/30 bg-info/5 rounded-2xl">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-info/15 text-info mt-0.5">
                <Users className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1 text-fluid-xs">
                <p className="font-bold text-ink">
                  Community Confirmed Ticket ({data.alsoReportedBy} other {data.alsoReportedBy === 1 ? 'citizen' : 'citizens'})
                </p>
                <p className="text-muted mt-0.5">
                  Multiple citizens reported this same location. It has been merged to reinforce municipal pickup priority.
                </p>
              </div>
            </Card>
          )}
        </div>

        {/* Right Column: Status Timeline, Assigned Driver, AI & Rewards (5 cols) */}
        <div className="lg:col-span-5 space-y-5">
          {/* Status Stepper Timeline Card */}
          <Card className="p-5 border border-line shadow-xs rounded-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <p className="text-fluid-sm font-bold text-ink">Complaint Lifecycle</p>
                <p className="text-[11px] text-muted">Real-time status updates from field crews</p>
              </div>
              <Badge tone={STATUS_TONE[data.status]} className="font-bold">
                {t(`status.${data.status}`)}
              </Badge>
            </div>

            {rejected ? (
              <div className="rounded-xl border border-danger/30 bg-danger/10 p-3.5 text-fluid-xs text-danger space-y-1">
                <p className="font-bold">Report Rejected / Unverified</p>
                <p className="text-muted leading-relaxed">
                  This report could not be verified by field officers. If you believe this is in error, please report again with a clear photo.
                </p>
              </div>
            ) : (
              <ol className="relative space-y-4 pl-2 pt-1">
                {FLOW.map((status, i) => {
                  const done = i <= currentIndex;
                  const isCurrent = i === currentIndex;
                  const event = data.timeline?.find((t: any) => t.status === status);
                  return (
                    <li key={status} className="relative flex items-start gap-3.5">
                      {/* Vertical line connecting steps */}
                      {i < FLOW.length - 1 && (
                        <span
                          className={`absolute left-3.5 top-7 -ml-[1px] h-full w-[2px] ${
                            i < currentIndex ? 'bg-brand' : 'bg-line'
                          }`}
                        />
                      )}

                      <div className="relative flex items-center justify-center shrink-0">
                        <span
                          className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold transition shadow-xs ${
                            done
                              ? 'bg-brand text-brand-ink ring-4 ring-brand/10'
                              : 'border-2 border-line bg-elevated text-faint'
                          }`}
                        >
                          {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                        </span>
                      </div>

                      <div className="min-w-0 flex-1 pt-0.5">
                        <div className="flex items-center gap-2">
                          <p className={`text-fluid-sm font-bold ${done ? 'text-ink' : 'text-faint'}`}>
                            {t(`status.${status}`)}
                          </p>
                          {isCurrent && (
                            <span className="inline-flex h-2 w-2 rounded-full bg-brand animate-pulse" />
                          )}
                        </div>
                        {event ? (
                          <p className="text-fluid-xs text-muted mt-0.5 leading-snug">
                            {event.note} · <span className="text-faint">{timeAgo(event.at)}</span>
                          </p>
                        ) : (
                          <p className="text-[11px] text-faint mt-0.5">
                            {status === 'IN_PROGRESS' ? 'Driver en route to location' : status === 'RESOLVED' ? 'Site cleanup and closure' : 'Pending step'}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          {/* Live Truck Tracking & Assigned Driver Card */}
          {data.assignedVehicle && (
            <Card className="p-4 border border-brand/30 bg-brand/5 rounded-2xl space-y-3">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-brand-ink shadow-sm">
                  <Truck className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-fluid-xs font-bold uppercase tracking-wider text-brand">Assigned Collection Truck</p>
                  <p className="text-fluid-sm font-bold text-ink truncate">
                    {data.assignedVehicle.driver?.name ? `${data.assignedVehicle.driver.name} · ` : ''}{data.assignedVehicle.registrationNumber}
                  </p>
                </div>
              </div>

              {data.trackRoom && !['RESOLVED', 'REJECTED'].includes(data.status) && (
                <Link to={`/app/track/${data.id}`} className="block">
                  <button
                    type="button"
                    className="btn-primary w-full py-2.5 text-fluid-xs font-bold flex items-center justify-center gap-2 cursor-pointer shadow-md shadow-brand/20"
                  >
                    <Navigation className="h-4 w-4" />
                    <span>Track Collection Truck Live</span>
                  </button>
                </Link>
              )}
            </Card>
          )}

          {/* Officer Rescheduled / Deferred Notice */}
          {data.deferred && (
            <Card className="border border-warn/30 bg-warn/5 p-4 rounded-2xl">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-warn/15 text-warn">
                  <Clock className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-fluid-xs font-bold text-warn uppercase">
                    Rescheduled by Ward Officer {data.deferred.times > 1 && `(${data.deferred.times} times)`}
                  </p>
                  <p className="mt-1 text-fluid-sm text-ink font-medium">{data.deferred.reason}</p>
                  <p className="mt-1 text-fluid-xs text-muted">
                    {data.deferred.newDueAt && <>Expected by {formatDateTime(data.deferred.newDueAt)} · </>}
                    deferred {timeAgo(data.deferred.at)}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* AI Assessment & Green Credits Card */}
          <Card className="p-4 border border-line shadow-xs rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-fluid-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-brand" /> AI Triage Assessment
              </span>
              {data.aiVerified ? <Badge tone="ok">AI Verified</Badge> : <Badge tone="warn">Officer Review</Badge>}
            </div>

            {data.aiCategory && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-fluid-xs">
                  <span className="text-muted">Classified Type:</span>
                  <span className="font-bold text-ink">{t(`category.${data.aiCategory}`)}</span>
                </div>
                <Meter
                  value={(data.aiConfidence ?? 0) * 100}
                  tone={data.aiVerified ? 'ok' : 'warn'}
                  label="Confidence Score"
                />
              </div>
            )}

            {/* Green Credits Reward Banner */}
            <div className="mt-2 rounded-xl border border-brand/20 bg-brand/5 p-3 flex items-center justify-between text-fluid-xs">
              <span className="font-semibold text-brand flex items-center gap-1.5">
                <Sparkles className="h-4 w-4" /> Green Credits Earned
              </span>
              <span className="font-bold font-mono text-brand bg-brand/10 px-2 py-0.5 rounded-md">
                +20 Pts
              </span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
