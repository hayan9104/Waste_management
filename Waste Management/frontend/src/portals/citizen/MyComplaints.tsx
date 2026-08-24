import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Camera, Clock } from 'lucide-react';
import { api, assetUrl } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, EvidencePhoto, Loading } from '../../components/ui';
import { CATEGORY_LABELS, STATUS_LABELS, STATUS_TONE, timeAgo, formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';



export default function MyComplaints() {
  const t = useT();
  const [filter, setFilter] = useState('all');
  /**
   * A page, not a lifetime.
   *
   * Sixty cards on a phone is a scroll nobody finishes, and the reports that
   * need attention are always the newest few. Fifteen covers the visible
   * work; "Show older reports" fetches the rest for the resident who wants
   * their history rather than assuming nobody does.
   */
  const PAGE = 15;
  const [limit, setLimit] = useState(PAGE);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['citizen', 'complaints', limit],
    queryFn: async () => (await api('citizen').get('/citizen/complaints', { params: { limit } })).data,
  });

  const items = (data ?? []).filter((c: any) => {
    if (filter === 'all') return true;
    if (filter === 'open') return !['RESOLVED', 'REJECTED'].includes(c.status);
    return c.status === filter;
  });

  return (
    <div className="space-y-4">
      <h1 className="text-fluid-xl font-bold tracking-tight">{t('citizen.complaints.title')}</h1>

      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {[{ id: 'all', label: t('citizen.complaints.filterAll') }, { id: 'open', label: t('citizen.complaints.filterOpen') }, { id: 'RESOLVED', label: t('citizen.complaints.filterResolved') }].map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`shrink-0 rounded-full border px-4 py-2 text-fluid-xs font-semibold transition ${
              filter === f.id ? 'border-brand bg-brand text-brand-ink' : 'border-line bg-elevated text-muted'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={t('citizen.complaints.loadError')} onRetry={() => refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('citizen.complaints.emptyTitle')}
          hint={t('citizen.complaints.emptyHint')}
          action={
            <Link to="/app/report" className="btn-primary btn-sm">
              {t('citizen.home.reportCta')}
            </Link>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((c: any) => (
            <li key={c.id}>
              <Link to={`/app/complaints/${c.id}`} className="block h-full">
                <Card className="flex h-full flex-col overflow-hidden p-0 transition hover:shadow-lift">
                  <div className="relative aspect-[4/3] w-full shrink-0 bg-sunken">
                    {c.photoUrl ? (
                      <EvidencePhoto src={assetUrl(c.photoUrl)} alt="Reported" className="h-full w-full object-cover" />
                    ) : (
                      <span className="grid h-full w-full place-items-center text-faint">
                        <Camera className="h-6 w-6" />
                      </span>
                    )}
                    {c.resolutionPhotoUrl && (
                      <EvidencePhoto
                        src={assetUrl(c.resolutionPhotoUrl)}
                        alt="Cleaned Proof"
                        className="absolute bottom-2 right-2 h-12 w-12 rounded-lg border-2 border-emerald-500 object-cover shadow-md"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 p-3.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-fluid-sm font-semibold">{t(`category.${c.category}`)}</p>
                      {c.isEmergency && <Badge tone="danger">SOS</Badge>}
                      {c.deferred && (
                        <Badge tone="warn">
                          <Clock className="h-3 w-3" />
                          {c.deferred.times > 1 ? `Rescheduled ×${c.deferred.times}` : 'Rescheduled'}
                        </Badge>
                      )}
                      {c.upvotes > 0 && <Badge tone="info">{t('citizen.complaints.confirmed', { count: c.upvotes })}</Badge>}
                    </div>

                    {/* The officer's own words, not a paraphrase. A resident
                        whose report slipped is owed the reason and the new
                        date, not just a status that quietly stopped moving. */}
                    {c.deferred && (
                      <p className="mt-1 rounded-lg border border-warn/30 bg-warn/5 px-2 py-1 text-fluid-xs text-warn">
                        {c.deferred.reason}
                        {c.deferred.newDueAt && <> · now due {formatDateTime(c.deferred.newDueAt)}</>}
                      </p>
                    )}
                    <p className="mt-0.5 truncate text-fluid-xs text-muted">{c.address || '—'}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <Badge tone={STATUS_TONE[c.status]}>{t(`status.${c.status}`)}</Badge>
                      <span className="font-mono text-fluid-xs text-faint">{c.code}</span>
                      <span className="text-fluid-xs text-faint">{timeAgo(c.createdAt)}</span>
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Offered only when the last page came back full — otherwise this is
          the end of the resident's history and the button would lie. */}
      {(data ?? []).length >= limit && (
        <button type="button" className="btn-ghost btn-sm w-full" onClick={() => setLimit((n) => n + PAGE)}>
          Show older reports
        </button>
      )}
    </div>
  );
}
