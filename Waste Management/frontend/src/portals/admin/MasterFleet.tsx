import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Truck, Wifi, WifiOff, Wrench, MapPin, Filter, Route as RouteIcon, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Badge, Card, ErrorState, Loading, Modal, SectionTitle, toast } from '../../components/ui';
import { BaseMap, TruckMarker, StopDot, FitBounds, RouteLine, Polyline } from '../../components/map/Map';
import { useSocket, SOCKET_EVENTS } from '../../lib/socket';
import { timeAgo, CATEGORY_LABELS } from '../../lib/format';

export default function MasterFleet() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [selectedWard, setSelectedWard] = useState<string>('');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [livePositions, setLivePositions] = useState<Record<string, any>>({});
  const [form, setForm] = useState({
    registrationNumber: '',
    wardId: '',
    driverId: '',
    model: 'Tata Ace',
    capacityKg: 2000,
  });

  const fleet = useQuery({
    queryKey: ['admin', 'fleet', selectedWard],
    queryFn: async () =>
      (await api('admin').get('/admin/fleet', { params: { wardId: selectedWard || undefined } })).data,
    refetchInterval: 45_000,
  });

  const wards = useQuery({
    queryKey: ['admin', 'wards'],
    queryFn: async () => (await api('admin').get('/admin/wards')).data,
  });

  const drivers = useQuery({
    queryKey: ['admin', 'users', 'DRIVER'],
    queryFn: async () => (await api('admin').get('/admin/users', { params: { role: 'DRIVER', pageSize: 100 } })).data,
  });

  const route = useQuery({
    queryKey: ['admin', 'fleet-route', selectedVehicleId],
    queryFn: async () => (await api('admin').get(`/admin/fleet/${selectedVehicleId}/route`)).data,
    enabled: Boolean(selectedVehicleId),
    refetchInterval: 15_000,
  });

  // Subscribe to all ward rooms and city room for live truck telemetry pings
  const wardRooms = (wards.data ?? []).map((w: any) => `ward:${w.id}`);
  useSocket('admin', ['city', ...wardRooms], {
    [SOCKET_EVENTS.TRUCK_UPDATE]: (payload: any) => {
      if (payload?.id && payload?.latitude != null) {
        setLivePositions((prev) => ({ ...prev, [payload.id]: payload }));
      }
    },
  });

  const create = useMutation({
    mutationFn: async () =>
      (
        await api('admin').post('/admin/fleet', {
          registrationNumber: form.registrationNumber,
          wardId: form.wardId || undefined,
          driverId: form.driverId || undefined,
          model: form.model,
          capacityKg: Number(form.capacityKg),
        })
      ).data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'fleet'] });
      toast.success('Vehicle registered');
      setAdding(false);
      setForm({ registrationNumber: '', wardId: '', driverId: '', model: 'Tata Ace', capacityKg: 2000 });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: any }) =>
      (await api('admin').patch(`/admin/fleet/${id}`, patch)).data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'fleet'] });
      toast.success('Vehicle updated');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (fleet.isLoading) return <Loading />;
  if (fleet.error) return <ErrorState message="Could not load the fleet" onRetry={() => fleet.refetch()} />;

  const vehicles = (fleet.data ?? []).map((v: any) => ({
    ...v,
    ...(livePositions[v.id] ?? {}),
  }));

  const mapPoints: Array<[number, number]> = vehicles
    .filter((v: any) => v.latitude != null)
    .map((v: any) => [v.latitude, v.longitude]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-fluid-xl font-bold tracking-tight">City-Wide Fleet Command</h1>
          <p className="text-fluid-xs text-muted">
            Live GPS telemetry, status, and maintenance registry for all {vehicles.length} vehicles
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Ward filter */}
          <div className="flex items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-1.5 shadow-sm">
            <Filter className="h-4 w-4 text-muted" />
            <select
              value={selectedWard}
              onChange={(e) => setSelectedWard(e.target.value)}
              className="bg-transparent text-fluid-xs font-semibold text-ink focus:outline-none"
            >
              <option value="">All Wards (City-Wide)</option>
              {(wards.data ?? []).map((w: any) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.code})
                </option>
              ))}
            </select>
          </div>

          <button type="button" className="btn-primary btn-sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Register Vehicle
          </button>
        </div>
      </div>

      {/* FEATURE 2: Master Live Fleet Map */}
      <Card className="overflow-hidden p-0 shadow-md">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75"></span>
              <span className="relative inline-flex h-3 w-3 rounded-full bg-ok"></span>
            </span>
            <h2 className="text-fluid-sm font-bold">Live Fleet GPS Map</h2>
          </div>
          <span className="text-fluid-xs text-muted">
            {vehicles.filter((v: any) => !v.isOffline && v.latitude != null).length} active on-road
          </span>
        </div>

        <div className="h-[44dvh] min-h-[320px] w-full xl:h-[420px]">
          <BaseMap center={[23.0225, 72.5714]} zoom={12} satellite>
            {mapPoints.length > 0 && <FitBounds points={mapPoints} />}

            {/* The selected vehicle's actual planned route, drawn on the road. */}
            {route.data?.route?.polyline?.length > 1 && (
              <RouteLine polyline={route.data.route.polyline} progressIndex={route.data.stopsDone} />
            )}
            {/* Where the vehicle has actually been today, as GPS recorded it —
                distinct from the planned path above. */}
            {route.data?.trail?.length > 1 && (
              <Polyline
                positions={route.data.trail.map(([lng, lat]: [number, number]) => [lat, lng])}
                pathOptions={{ color: '#2563eb', weight: 3, opacity: 0.7, dashArray: '2 8' }}
              />
            )}
            {/* Every stop, colour-coded by progress: green = done, red = next up, grey = queued. */}
            {(() => {
              let nextMarked = false;
              return route.data?.stops?.map((s: any) => {
                const isDone = s.status === 'DONE';
                const status: 'done' | 'next' | 'queued' = isDone ? 'done' : nextMarked ? 'queued' : 'next';
                if (!isDone) nextMarked = true;
                return (
                  <StopDot
                    key={s.seq}
                    latitude={s.latitude}
                    longitude={s.longitude}
                    seq={s.seq}
                    status={status}
                    label={`${s.seq}. ${s.address} — ${isDone ? 'Completed' : status === 'next' ? 'Next stop' : 'Queued'}`}
                  />
                );
              });
            })()}

            {vehicles
              .filter((v: any) => v.latitude != null)
              .map((v: any) => (
                <TruckMarker
                  key={v.id}
                  latitude={v.latitude}
                  longitude={v.longitude}
                  heading={v.heading ?? 0}
                  active={v.status === 'ON_ROUTE'}
                  variant={v.id === selectedVehicleId ? 'tracker' : 'default'}
                  onClick={() => setSelectedVehicleId(v.id)}
                >
                  <div className="space-y-0.5">
                    <p className="font-semibold">{v.registrationNumber}</p>
                    <p className="text-xs text-muted">{v.driver?.name ?? 'Unassigned'}</p>
                    <p className="text-xs">{v.status}</p>
                  </div>
                </TruckMarker>
              ))}
          </BaseMap>
        </div>
      </Card>

      {/* Selected vehicle's route: path + stop-by-stop status */}
      {selectedVehicleId && (
        <Card className="overflow-hidden p-0 shadow-sm">
          <div className="flex items-center justify-between border-b border-line px-4 py-3 bg-sunken/40">
            <div className="flex items-center gap-2">
              <RouteIcon className="h-4 w-4 text-brand" />
              <h3 className="text-fluid-sm font-bold">
                {route.data?.vehicle?.registrationNumber ?? 'Vehicle'} — today's route
              </h3>
            </div>
            <div className="flex items-center gap-3">
              {route.data?.route && (
                <span className="text-fluid-xs font-semibold text-muted">
                  {route.data.stopsDone} / {route.data.stopsTotal} stops completed
                </span>
              )}
              <button type="button" className="btn-ghost btn-sm !px-2" onClick={() => setSelectedVehicleId(null)} aria-label="Close route view">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {route.data && (
            <div className="flex flex-wrap items-center gap-4 border-b border-line px-4 py-2 text-fluid-xs">
              <span className="flex items-center gap-1.5 text-muted">
                <span className="h-0.5 w-5 rounded bg-[#16a34a]" /> Planned route to destinations
              </span>
              <span className="flex items-center gap-1.5 text-muted">
                <span className="h-0.5 w-5 rounded bg-[#2563eb]" style={{ backgroundImage: 'repeating-linear-gradient(90deg,#2563eb 0 4px,transparent 4px 8px)' }} /> Actual path driven today
                {route.data.trailDistanceKm != null && ` (${route.data.trailDistanceKm} km)`}
              </span>
              <span className="flex items-center gap-1.5 text-muted">
                <span className="h-2.5 w-2.5 rounded-full bg-[#16a34a]" /> Completed
              </span>
              <span className="flex items-center gap-1.5 text-muted">
                <span className="h-2.5 w-2.5 rounded-full bg-[#dc2626]" /> Next stop
              </span>
              <span className="flex items-center gap-1.5 text-muted">
                <span className="h-2.5 w-2.5 rounded-full bg-[#9ca3af]" /> Queued
              </span>
            </div>
          )}

          {route.isLoading ? (
            <div className="p-6"><Loading /></div>
          ) : !route.data?.route ? (
            <p className="p-6 text-center text-fluid-sm text-muted">No route published for this vehicle today.</p>
          ) : (
            <div className="divide-y divide-line max-h-[320px] overflow-y-auto">
              {route.data.stops.map((s: any) => {
                const isDone = s.status === 'DONE';
                return (
                  <div key={s.seq} className="flex items-center justify-between p-3.5">
                    <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                      <span
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-fluid-xs font-bold ${
                          isDone ? 'bg-ok/20 text-ok' : 'bg-sunken text-muted'
                        }`}
                      >
                        {isDone ? '✓' : s.seq}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className={`text-fluid-xs font-semibold truncate ${isDone ? 'line-through text-muted' : 'text-ink'}`}>
                          {s.address}
                        </p>
                        <p className="text-[10px] text-muted">{CATEGORY_LABELS[s.category] ?? s.category}</p>
                      </div>
                    </div>
                    <Badge tone={isDone ? 'ok' : s.isEmergency ? 'danger' : 'neutral'}>
                      {isDone ? 'Completed' : s.status === 'SKIPPED' ? 'Skipped' : 'On the way'}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* Fleet Table */}
      <Card className="overflow-hidden p-0">
        <div className="table-scroll">
          <table className="w-full min-w-[60rem] text-left text-fluid-sm">
            <thead className="border-b border-line bg-sunken/60 text-fluid-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Registration</th>
                <th className="px-4 py-2.5">Driver</th>
                <th className="px-4 py-2.5">Contact</th>
                <th className="px-4 py-2.5">Ward</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">GPS Health</th>
                <th className="px-4 py-2.5">Last Ping</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {vehicles.map((v: any) => (
                <tr key={v.id} className="hover:bg-sunken/50">
                  <td className="px-4 py-2.5">
                    <span className="font-mono font-medium">{v.registrationNumber}</span>
                    <p className="text-fluid-xs text-muted">
                      {v.model} · {v.capacityKg} kg
                    </p>
                  </td>
                  <td className="px-4 py-2.5">{v.driver?.name ?? <span className="text-faint">Unassigned</span>}</td>
                  <td className="px-4 py-2.5">
                    {v.driver?.phone ? (
                      <a href={`tel:${v.driver.phone}`} className="font-mono text-fluid-xs text-brand hover:underline">
                        {v.driver.phone}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2.5">{v.ward?.name ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={v.status === 'ON_ROUTE' ? 'ok' : v.status === 'MAINTENANCE' ? 'warn' : 'neutral'}>
                      {v.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {!v.isOffline ? (
                      <span className="inline-flex items-center gap-1 text-fluid-xs text-ok font-semibold">
                        <Wifi className="h-3.5 w-3.5" /> Live
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-fluid-xs text-faint">
                        <WifiOff className="h-3.5 w-3.5" /> Offline
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-fluid-xs text-muted">{v.lastPingAt ? timeAgo(v.lastPingAt) : '—'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        className={`btn-ghost btn-sm ${selectedVehicleId === v.id ? 'border-brand text-brand' : ''}`}
                        onClick={() => setSelectedVehicleId(v.id)}
                      >
                        <RouteIcon className="h-3.5 w-3.5" /> View route
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => update.mutate({ id: v.id, patch: { maintenanceFlag: !v.maintenanceFlag } })}
                      >
                        <Wrench className="h-3.5 w-3.5" />
                        {v.maintenanceFlag ? 'Clear flag' : 'Flag maintenance'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Modal */}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Register a vehicle"
        footer={
          <button
            className="btn-primary w-full"
            disabled={!form.registrationNumber || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Register
          </button>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="reg">
              Registration number
            </label>
            <input
              id="reg"
              className="field font-mono"
              value={form.registrationNumber}
              onChange={(e) => setForm({ ...form, registrationNumber: e.target.value.toUpperCase() })}
              placeholder="GJ 18 SS 1001"
            />
          </div>
          <div>
            <label className="label" htmlFor="model">
              Model
            </label>
            <input
              id="model"
              className="field"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            />
          </div>
          <div>
            <label className="label" htmlFor="cap">
              Capacity (kg)
            </label>
            <input
              id="cap"
              type="number"
              className="field"
              value={form.capacityKg}
              onChange={(e) => setForm({ ...form, capacityKg: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="label" htmlFor="ward">
              Ward
            </label>
            <select
              id="ward"
              className="field"
              value={form.wardId}
              onChange={(e) => setForm({ ...form, wardId: e.target.value })}
            >
              <option value="">Unassigned</option>
              {(wards.data ?? []).map((w: any) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.code})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="driver">
              Driver
            </label>
            <select
              id="driver"
              className="field"
              value={form.driverId}
              onChange={(e) => setForm({ ...form, driverId: e.target.value })}
            >
              <option value="">Unassigned</option>
              {(drivers.data?.items ?? []).map((d: any) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.phone}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}
