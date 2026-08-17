import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MapPinned, Plus, Trash2, Upload } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Card, ErrorState, Loading, Modal, SectionTitle, toast } from '../../components/ui';
import { BaseMap, WardLayer, FitBounds, Polygon, CircleMarker, useMap } from '../../components/map/Map';

/**
 * Ward boundary editor (plan §2.4). The boundary is built from a list of
 * latitude/longitude points — added by clicking the map or typing them in —
 * rather than a raw GeoJSON blob. It's still saved as a GeoJSON Polygon
 * server-side (bbox and centroid computed there); only the input changed.
 */

type Point = { lat: string; lng: string };

const emptyForm = { id: '', name: '', code: '', zone: '', population: 0, slaMinutes: 1440 };

/** Turns a saved boundary (or an uploaded .geojson file) back into editable points. */
function boundaryToPoints(geo: any): Point[] {
  const boundary =
    geo?.type === 'Polygon'
      ? geo
      : geo?.type === 'Feature'
        ? geo.geometry
        : geo?.type === 'FeatureCollection'
          ? geo.features?.[0]?.geometry
          : null;

  const ring: [number, number][] = boundary?.coordinates?.[0] ?? [];
  const pts = ring.map(([lng, lat]: [number, number]) => ({ lat: String(lat), lng: String(lng) }));

  // The stored ring is closed (first point repeated at the end); drop the
  // repeat since the list is easier to edit without it.
  if (pts.length > 1 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lng === pts[pts.length - 1].lng) {
    pts.pop();
  }
  return pts;
}

/** Clicking the map appends a point instead of dragging a single pin. */
function ClickToAddPoint({ onAdd }: { onAdd: (lat: number, lng: number) => void }) {
  const map = useMap();
  useEffect(() => {
    const handler = (e: L.LeafletMouseEvent) => onAdd(e.latlng.lat, e.latlng.lng);
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, onAdd]);
  return null;
}

/** Keeps every currently-entered point in view — not just the first one. */
function FitToPoints({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length === 0) return;
    if (positions.length === 1) {
      map.setView(positions[0], 15);
    } else {
      map.fitBounds(L.latLngBounds(positions), { padding: [30, 30] });
    }
  }, [map, positions]);
  return null;
}

export default function WardSettings() {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [points, setPoints] = useState<Point[]>([]);

  const wards = useQuery({
    queryKey: ['admin', 'wards'],
    queryFn: async () => (await api('admin').get('/admin/wards')).data,
  });

  const numericPoints = useMemo(
    () =>
      points
        .map((p) => ({ lat: parseFloat(p.lat), lng: parseFloat(p.lng) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    [points]
  );
  const polygonPositions = useMemo<[number, number][]>(
    () => numericPoints.map((p) => [p.lat, p.lng]),
    [numericPoints]
  );

  const addPoint = (lat = '', lng = '') => setPoints((prev) => [...prev, { lat: String(lat), lng: String(lng) }]);
  const removePoint = (i: number) => setPoints((prev) => prev.filter((_, idx) => idx !== i));
  const updatePoint = (i: number, field: keyof Point, value: string) =>
    setPoints((prev) => prev.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)));

  const save = useMutation({
    mutationFn: async () => {
      if (numericPoints.length < 3) {
        throw new Error('Add at least 3 coordinate points to form an area');
      }

      const coords: [number, number][] = numericPoints.map((p) => [p.lng, p.lat]);
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);

      const boundary = { type: 'Polygon', coordinates: [coords] };

      return (
        await api('admin').post('/admin/wards', {
          id: form.id || undefined,
          name: form.name,
          code: form.code,
          zone: form.zone || undefined,
          population: Number(form.population) || 0,
          slaMinutes: Number(form.slaMinutes) || 1440,
          boundary,
        })
      ).data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'wards'] });
      toast.success('Ward boundary saved');
      setUploading(false);
      setForm(emptyForm);
      setPoints([]);
    },
    onError: (err: any) => toast.error(err?.message || errorMessage(err)),
  });

  if (wards.isLoading) return <Loading />;
  if (wards.error) return <ErrorState message="Could not load wards" onRetry={() => wards.refetch()} />;

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Ward settings"
        subtitle="Boundaries drive complaint attribution, officer scope and the heatmap"
        action={
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => {
              setForm(emptyForm);
              setPoints([]);
              setUploading(true);
            }}
          >
            <Upload className="h-3.5 w-3.5" /> Add a ward
          </button>
        }
      />

      <Card className="overflow-hidden p-0">
        <div className="h-[46dvh] min-h-[300px] w-full">
          <BaseMap center={[23.2156, 72.6369]} zoom={12}>
            <FitBounds points={wards.data.map((w: any) => [w.center.latitude, w.center.longitude])} />
            <WardLayer wards={wards.data} colorFor={() => '#16a34a'} />
          </BaseMap>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {wards.data.map((w: any) => (
          <Card key={w.id} className="p-4">
            <div className="flex items-start gap-2.5">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
                <MapPinned className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-fluid-sm font-semibold">{w.name}</p>
                <p className="truncate text-fluid-xs text-muted">{w.code} · {w.zone}</p>
              </div>
            </div>
            <dl className="mt-3 space-y-1 text-fluid-xs">
              <div className="flex justify-between"><dt className="text-muted">Population</dt><dd className="tabular-nums">{w.population.toLocaleString('en-IN')}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Open complaints</dt><dd className="tabular-nums">{w.openComplaints}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Vehicles</dt><dd className="tabular-nums">{w.vehicles}</dd></div>
            </dl>
            <button
              type="button"
              className="btn-ghost btn-sm mt-3 w-full"
              onClick={() => {
                setForm({
                  id: w.id,
                  name: w.name,
                  code: w.code,
                  zone: w.zone,
                  population: w.population,
                  slaMinutes: 1440,
                });
                setPoints(boundaryToPoints(w.boundary));
                setUploading(true);
              }}
            >
              Edit boundary
            </button>
          </Card>
        ))}
      </div>

      <Modal
        open={uploading}
        onClose={() => setUploading(false)}
        title={form.id ? `Edit ${form.name}` : 'Add a ward'}
        wide
        footer={
          <button
            className="btn-primary w-full"
            disabled={!form.name || !form.code || numericPoints.length < 3 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Save ward
          </button>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="wname">Ward name</label>
              <input id="wname" className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="wcode">Code</label>
              <input id="wcode" className="field" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="W-09" />
            </div>
            <div>
              <label className="label" htmlFor="wzone">Zone</label>
              <input id="wzone" className="field" value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="wpop">Population</label>
              <input
                id="wpop"
                type="number"
                className="field"
                value={form.population}
                onChange={(e) => setForm({ ...form, population: Number(e.target.value) })}
              />
            </div>
          </div>

          <div>
            <label className="label">Boundary coordinates</label>
            <p className="mb-1.5 text-fluid-xs text-muted">
              Click the map to drop a point, or type latitude/longitude below. At least 3 points are needed to form an area.
            </p>

            <div className="h-[240px] w-full overflow-hidden rounded-xl border border-line">
              <BaseMap center={[23.2156, 72.6369]} zoom={12}>
                <ClickToAddPoint onAdd={(lat, lng) => addPoint(lat.toFixed(6), lng.toFixed(6))} />
                <FitToPoints positions={polygonPositions} />
                {polygonPositions.length >= 3 && (
                  <Polygon positions={polygonPositions} pathOptions={{ color: '#16a34a', weight: 2, fillColor: '#16a34a', fillOpacity: 0.18 }} />
                )}
                {numericPoints.map((p, i) => (
                  <CircleMarker key={i} center={[p.lat, p.lng]} radius={5} pathOptions={{ color: '#16a34a', weight: 2, fillColor: '#fff', fillOpacity: 1 }} />
                ))}
              </BaseMap>
            </div>

            <div className="mt-2 max-h-[220px] space-y-1.5 overflow-y-auto pr-1">
              {points.map((p, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-5 shrink-0 text-center text-fluid-xs text-faint tabular-nums">{i + 1}</span>
                  <input
                    type="number"
                    step="any"
                    className="field flex-1 py-1.5 text-fluid-xs"
                    placeholder="Latitude"
                    value={p.lat}
                    onChange={(e) => updatePoint(i, 'lat', e.target.value)}
                  />
                  <input
                    type="number"
                    step="any"
                    className="field flex-1 py-1.5 text-fluid-xs"
                    placeholder="Longitude"
                    value={p.lng}
                    onChange={(e) => updatePoint(i, 'lng', e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-ghost btn-sm shrink-0 !px-2 text-danger"
                    onClick={() => removePoint(i)}
                    aria-label={`Remove point ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <button type="button" className="btn-ghost btn-sm mt-2 w-full" onClick={() => addPoint()}>
              <Plus className="h-3.5 w-3.5" /> Add point manually
            </button>
          </div>

          <label className="btn-ghost w-full cursor-pointer">
            <Upload className="h-4 w-4" /> Load from a .geojson file
            <input
              type="file"
              accept=".json,.geojson,application/geo+json"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const parsed = JSON.parse(await file.text());
                  const loaded = boundaryToPoints(parsed);
                  if (!loaded.length) throw new Error('empty');
                  setPoints(loaded);
                } catch {
                  toast.error('That file is not a valid GeoJSON Polygon');
                }
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
