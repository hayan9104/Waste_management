import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Loader2, Pencil, Plus, Power, Search, Trash2 } from 'lucide-react';
import { api, errorMessage, isRouteMissing, FEATURE_NOT_DEPLOYED } from '../../lib/api';
import { Badge, Card, EmptyState, ErrorState, Loading, Modal, SectionTitle, toast } from '../../components/ui';
import { STREAM_LABELS, STREAM_TONE, formatKg } from '../../lib/format';

const STREAM_IDS = ['BIO', 'NON_BIO', 'HAZARDOUS', 'E_WASTE', 'OTHER'];

const EMPTY = {
  name: '',
  code: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
  address: '',
  acceptedStreams: [] as string[],
  capacityKgPerDay: 1000,
  isCityWide: true,
  wardIds: [] as string[],
  status: 'ACTIVE',
};

/**
 * The registry of firms that process what the city collects.
 *
 * The licence list is the load-bearing field: it decides which reports a
 * company can even be offered for, so it is edited as explicit toggles rather
 * than a free-text field, and the server refuses to narrow it while that
 * company still holds live work of the stream being removed.
 */
export default function Companies() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [streamFilter, setStreamFilter] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ ...EMPTY });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'companies', search, streamFilter],
    queryFn: async () =>
      (await api('admin').get('/admin/companies', { params: { search: search || undefined, stream: streamFilter || undefined } })).data,
  });

  const wards = useQuery({
    queryKey: ['admin', 'wards'],
    queryFn: async () => (await api('admin').get('/admin/wards')).data,
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        contactEmail: form.contactEmail.trim() || undefined,
        contactName: form.contactName.trim() || undefined,
        address: form.address.trim() || undefined,
        wardIds: form.isCityWide ? [] : form.wardIds,
      };
      return editing?.id
        ? (await api('admin').patch(`/admin/companies/${editing.id}`, payload)).data
        : (await api('admin').post('/admin/companies', payload)).data;
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'companies'] });
      toast.success(`${res.name} saved`);
      closeForm();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save this company')),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api('admin').delete(`/admin/companies/${id}`)).data,
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'companies'] });
      // Deleting a company with history deactivates it instead — say which
      // happened rather than reporting a delete that did not occur.
      toast.success(res.deleted ? 'Company removed' : res.message);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove this company')),
  });

  const toggleStatus = useMutation({
    mutationFn: async (c: any) =>
      (await api('admin').patch(`/admin/companies/${c.id}`, { status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })).data,
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'companies'] });
      toast.success(`${res.name} is now ${res.status === 'ACTIVE' ? 'active' : 'inactive'}`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not change the status')),
  });

  const openNew = () => { setForm({ ...EMPTY }); setEditing({}); };
  const openEdit = (c: any) => {
    setForm({
      name: c.name,
      code: c.code,
      contactName: c.contactName ?? '',
      contactPhone: c.contactPhone,
      contactEmail: c.contactEmail ?? '',
      address: c.address ?? '',
      acceptedStreams: c.acceptedStreams ?? [],
      capacityKgPerDay: c.capacityKgPerDay ?? 0,
      isCityWide: c.isCityWide,
      wardIds: c.wardIds ?? [],
      status: c.status,
    });
    setEditing(c);
  };
  const closeForm = () => { setEditing(null); setForm({ ...EMPTY }); };

  const toggleStream = (id: string) =>
    setForm((f) => ({
      ...f,
      acceptedStreams: f.acceptedStreams.includes(id)
        ? f.acceptedStreams.filter((s) => s !== id)
        : [...f.acceptedStreams, id],
    }));

  const toggleWard = (id: string) =>
    setForm((f) => ({
      ...f,
      wardIds: f.wardIds.includes(id) ? f.wardIds.filter((w) => w !== id) : [...f.wardIds, id],
    }));

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={isRouteMissing(error) ? FEATURE_NOT_DEPLOYED : 'Could not load companies'} onRetry={() => refetch()} />;

  const items = data?.items ?? [];
  const valid = form.name.trim().length >= 2 && form.code.trim().length >= 2 &&
    form.contactPhone.trim().length >= 6 && form.acceptedStreams.length > 0;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Company management"
        subtitle="Processing firms, what each is licensed to take, and where it operates"
        action={
          <button type="button" className="btn-primary btn-sm" onClick={openNew}>
            <Plus className="h-3.5 w-3.5" /> Add company
          </button>
        }
      />

      <Card className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            className="field w-full pl-9 text-fluid-sm min-h-[40px]"
            placeholder="Search by name or code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="field w-full text-fluid-xs min-h-[40px] sm:w-auto sm:min-w-[11rem]"
          value={streamFilter}
          onChange={(e) => setStreamFilter(e.target.value)}
        >
          <option value="">All licences</option>
          {STREAM_IDS.map((id) => (
            <option key={id} value={id}>{STREAM_LABELS[id]}</option>
          ))}
        </select>
      </Card>

      {!items.length ? (
        <EmptyState title="No companies yet" hint="Add the firms that process the city's waste." icon={<Building2 className="h-6 w-6" />} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((c: any) => (
            <Card key={c.id} className={`p-4 ${c.status === 'INACTIVE' ? 'opacity-70' : ''}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-fluid-sm">{c.name}</p>
                  <p className="font-mono text-fluid-xs text-muted">{c.code}</p>
                </div>
                <Badge tone={c.status === 'ACTIVE' ? 'ok' : 'neutral'}>{c.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge>
              </div>

              <div className="mt-2 flex flex-wrap gap-1">
                {(c.acceptedStreams ?? []).map((s: string) => (
                  <Badge key={s} tone={STREAM_TONE[s] ?? 'neutral'}>{STREAM_LABELS[s] ?? s}</Badge>
                ))}
              </div>

              <dl className="mt-3 space-y-1 text-fluid-xs text-muted">
                <div className="flex justify-between gap-2">
                  <dt>Daily capacity</dt>
                  <dd className="tabular-nums text-ink">{c.capacityKgPerDay > 0 ? formatKg(c.capacityKgPerDay) : 'No stated limit'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Open handoffs</dt>
                  <dd className="tabular-nums text-ink">{c.openAssignments ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Coverage</dt>
                  <dd className="truncate text-ink">
                    {c.isCityWide ? 'City-wide' : `${c.wards?.length ?? 0} ward${c.wards?.length === 1 ? '' : 's'}`}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Contact</dt>
                  <dd className="truncate text-ink">{c.contactPhone}</dd>
                </div>
              </dl>

              <div className="mt-3 flex gap-1.5">
                <button type="button" className="btn-ghost btn-sm flex-1" onClick={() => openEdit(c)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  title={c.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
                  disabled={toggleStatus.isPending}
                  onClick={() => toggleStatus.mutate(c)}
                >
                  <Power className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm text-danger"
                  title="Remove"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(c.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={!!editing} onClose={closeForm} title={editing?.id ? `Edit ${editing.name}` : 'Add a processing company'}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-fluid-xs font-medium text-muted">Name</span>
              <input className="field w-full text-fluid-sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-fluid-xs font-medium text-muted">Code</span>
              <input
                className="field w-full font-mono text-fluid-sm"
                placeholder="GRN-BIO-01"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-fluid-xs font-medium text-muted">Contact person</span>
              <input className="field w-full text-fluid-sm" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-fluid-xs font-medium text-muted">Phone</span>
              <input className="field w-full text-fluid-sm" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-fluid-xs font-medium text-muted">Email (optional)</span>
              <input className="field w-full text-fluid-sm" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-fluid-xs font-medium text-muted">Daily capacity (kg)</span>
              <input
                type="number"
                min={0}
                className="field w-full text-fluid-sm"
                value={form.capacityKgPerDay}
                onChange={(e) => setForm({ ...form, capacityKgPerDay: Number(e.target.value) })}
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-fluid-xs font-medium text-muted">Address (optional)</span>
            <input className="field w-full text-fluid-sm" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </label>

          <div>
            <span className="mb-1.5 block text-fluid-xs font-medium text-muted">
              Licensed streams — a company is only ever offered reports it may lawfully take
            </span>
            <div className="flex flex-wrap gap-1.5">
              {STREAM_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleStream(id)}
                  className={`chip px-3 py-1.5 text-[11px] font-semibold transition ${
                    form.acceptedStreams.includes(id) ? 'border-brand bg-brand/10 text-brand' : 'text-muted hover:bg-sunken'
                  }`}
                >
                  {STREAM_LABELS[id]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-fluid-sm">
              <input type="checkbox" checked={form.isCityWide} onChange={(e) => setForm({ ...form, isCityWide: e.target.checked })} />
              Serves the whole city
            </label>
            {!form.isCityWide && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(wards.data ?? []).map((w: any) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => toggleWard(w.id)}
                    className={`chip px-3 py-1.5 text-[11px] font-semibold transition ${
                      form.wardIds.includes(w.id) ? 'border-brand bg-brand/10 text-brand' : 'text-muted hover:bg-sunken'
                    }`}
                  >
                    {w.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={closeForm}>Cancel</button>
            <button type="button" className="btn-primary btn-sm" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Building2 className="h-3.5 w-3.5" />}
              {editing?.id ? 'Save changes' : 'Add company'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
