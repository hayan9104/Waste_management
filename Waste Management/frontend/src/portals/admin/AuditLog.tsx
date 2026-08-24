import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, SectionTitle } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';

/** Immutable audit log (plan §2.4): every privileged action, who/when/what. */
/**
 * Renders a recorded before/after payload.
 *
 * These were being written to the database and never shown, which made the
 * trail answer "who did something" but not "what changed" -- the question an
 * audit log exists for. Destructive entries carry the codes of the rows they
 * destroyed, so this is the only place that evidence is readable.
 */
function Payload({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1 text-fluid-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <pre className="max-h-56 overflow-auto rounded-xl bg-sunken p-2.5 text-[11px] leading-relaxed text-ink">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** Actions that destroy or mass-rewrite rows get flagged so they stand out. */
const DESTRUCTIVE = new Set([
  'demo_data_reseed',
  'complaint_delete_by_code',
  'complaint_cleanup_broken_photos',
  'user_block',
]);

export default function AuditLog() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'audit', action, page],
    queryFn: async () =>
      (await api('admin').get('/admin/audit', { params: { action: action || undefined, page, pageSize: 50 } })).data,
  });

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Audit log"
        subtitle="Append-only record of every privileged action"
        action={
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              className="field pl-9"
              placeholder="Filter by action"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
            />
          </div>
        }
      />

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState message="Could not load the audit log" onRetry={() => refetch()} />
      ) : data.items.length === 0 ? (
        <EmptyState
          title="No audit entries yet"
          hint="Assignments, escalations, role changes and settings edits are recorded here automatically."
          icon={<ShieldCheck className="h-8 w-8" />}
        />
      ) : (
        <>
          <Card className="hidden overflow-hidden p-0 md:block">
            <div className="table-scroll">
              <table className="w-full min-w-[48rem] text-left text-fluid-sm">
                <thead className="border-b border-line bg-sunken/60 text-fluid-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5">When</th>
                    <th className="px-4 py-2.5">Actor</th>
                    <th className="px-4 py-2.5">Action</th>
                    <th className="px-4 py-2.5">Target</th>
                    <th className="px-4 py-2.5">IP</th>
                    <th className="px-4 py-2.5 text-right">Changes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.items.map((entry: any) => (
                    <Fragment key={entry.id}>
                    <tr className="hover:bg-sunken/50">
                      <td className="px-4 py-2.5 text-fluid-xs">
                        <p>{formatDateTime(entry.createdAt)}</p>
                        <p className="text-muted">{timeAgo(entry.createdAt)}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        {entry.actor ? (
                          <>
                            <span className="font-medium">{entry.actor.name}</span>
                            <Badge tone="neutral" className="ml-1.5">{entry.actor.role}</Badge>
                          </>
                        ) : (
                          <span className="text-faint">System</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <code className="rounded bg-sunken px-1.5 py-0.5 text-fluid-xs">{entry.action}</code>
                        {DESTRUCTIVE.has(entry.action) && <Badge tone="danger" className="ml-1.5">Destructive</Badge>}
                      </td>
                      <td className="px-4 py-2.5 text-fluid-xs">
                        <span className="text-muted">{entry.targetTable}</span>
                        {entry.targetId && <span className="ml-1 font-mono text-faint">{entry.targetId.slice(-8)}</span>}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-fluid-xs text-muted">{entry.ip ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right">
                        {entry.before || entry.after ? (
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            aria-expanded={openId === entry.id}
                            onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
                          >
                            {openId === entry.id ? 'Hide' : 'View'}
                          </button>
                        ) : (
                          <span className="text-fluid-xs text-faint">—</span>
                        )}
                      </td>
                    </tr>
                    {openId === entry.id && (entry.before || entry.after) && (
                      <tr>
                        <td colSpan={6} className="bg-sunken/40 px-4 py-3">
                          <div className="flex flex-col gap-3 sm:flex-row">
                            <Payload label="Before" value={entry.before} />
                            <Payload label="After" value={entry.after} />
                          </div>
                          {entry.userAgent && (
                            <p className="mt-2 truncate text-[11px] text-faint">{entry.userAgent}</p>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <ul className="space-y-2 md:hidden">
            {data.items.map((entry: any) => (
              <li key={entry.id}>
                <Card className="p-3.5">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-sunken px-1.5 py-0.5 text-fluid-xs">{entry.action}</code>
                    <span className="ml-auto text-fluid-xs text-muted">{timeAgo(entry.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 text-fluid-sm">
                    {entry.actor ? `${entry.actor.name} (${entry.actor.role})` : 'System'}
                  </p>
                  <p className="text-fluid-xs text-muted">
                    {entry.targetTable}
                    {entry.targetId ? ` · ${entry.targetId.slice(-8)}` : ''}
                  </p>
                  {(entry.before || entry.after) && (
                    <>
                      <button
                        type="button"
                        className="btn-ghost btn-sm mt-2"
                        aria-expanded={openId === entry.id}
                        onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
                      >
                        {openId === entry.id ? 'Hide changes' : 'View changes'}
                      </button>
                      {openId === entry.id && (
                        <div className="mt-2 flex flex-col gap-3">
                          <Payload label="Before" value={entry.before} />
                          <Payload label="After" value={entry.after} />
                        </div>
                      )}
                    </>
                  )}
                </Card>
              </li>
            ))}
          </ul>

          {data.pages > 1 && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-fluid-xs text-muted">Page {data.page} of {data.pages} · {data.total} entries</p>
              <div className="flex gap-2">
                <button type="button" className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
                <button type="button" className="btn-ghost btn-sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
