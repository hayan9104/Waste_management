import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MapPinned, Upload } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Card, ErrorState, Loading, Modal, SectionTitle, toast } from '../../components/ui';
import { BaseMap, WardLayer, FitBounds, Polygon, Marker, useMap } from '../../components/map/Map';

/** A small draggable dot for each corner of the boundary box. */
const POINT_ICON = L.divIcon({
  className: '',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
  html: '<div style="width:18px;height:18px;border-radius:9999px;background:#fff;border:3px solid #16a34a;box-shadow:0 1px 3px rgba(0,0,0,0.4);cursor:grab"></div>',
});

/**
 * Ward boundary editor (plan §2.4). The boundary is a 4-corner box — drag any
 * corner on the map to resize/reshape the area. It's still saved as a GeoJSON
 * Polygon server-side (bbox and centroid computed there); only the input
 * changed from a raw GeoJSON blob to draggable corners.
 */

type Point = { lat: string; lng: string };
const CORNER_LABELS = ['NW', 'NE', 'SE', 'SW'];

const emptyForm = { id: '', name: '', code: '', zone: '', population: 0, slaMinutes: 1440 };

/** A small default box centred on the given point. */
function defaultBox(center: [number, number] = [23.2156, 72.6369], delta = 0.01): Point[] {
  const [lat, lng] = center;
  return [
    { lat: String(lat + delta), lng: String(lng - delta) }, // NW
    { lat: String(lat + delta), lng: String(lng + delta) }, // NE
    { lat: String(lat - delta), lng: String(lng + delta) }, // SE
    { lat: String(lat - delta), lng: String(lng - delta) }, // SW
  ];
}

/** Reduces any saved boundary (or an uploaded .geojson file) to its bounding box's 4 corners. */
function boundaryToBox(geo: any): Point[] {
  const boundary =
    geo?.type === 'Polygon'
      ? geo
      : geo?.type === 'Feature'
        ? geo.geometry
        : geo?.type === 'FeatureCollection'
          ? geo.features?.[0]?.geometry
          : null;

  const ring: [number, number][] = boundary?.coordinates?.[0] ?? [];
  if (!ring.length) return defaultBox();

  const lats = ring.map(([, lat]) => lat);
  const lngs = ring.map(([lng]) => lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  return [
    { lat: String(maxLat), lng: String(minLng) }, // NW
    { lat: String(maxLat), lng: String(maxLng) }, // NE
    { lat: String(minLat), lng: String(maxLng) }, // SE
    { lat: String(minLat), lng: String(minLng) }, // SW
  ];
}

/** Keeps the whole box in view as its corners move. */
function FitToPoints({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length === 0) return;
    map.fitBounds(L.latLngBounds(positions), { padding: [30, 30] });
  }, [map, positions]);
  return null;
}

export default function WardSettings() {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [points, setPoints] = useState<Point[]>(defaultBox());

  const wards = useQuery({
    queryKey: ['admin', 'wards'],
    queryFn: async () => (await api('admin').get('/admin/wards')).data,
  });

  const numericPoints = useMemo(
    () =>
      points.map((p, idx) => ({ idx, lat: parseFloat(p.lat), lng: parseFloat(p.lng) })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    [points]
  );
  const polygonPositions = useMemo<[number, number][]>(() => numericPoints.map((p) => [p.lat, p.lng]), [numericPoints]);

  const updatePoint = (i: number, field: keyof Point, value: string) =>
    setPoints((prev) => prev.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)));

  const save = useMutation({
    mutationFn: async () => {
      if (numericPoints.length < 4) {
        throw new Error('All 4 corner points need valid coordinates');
      }

      const coords: [number, number][] = numericPoints.map((p) => [p.lng, p.lat]);
      coords.push(coords[0]); // close the ring

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
      setPoints(defaultBox());
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
              setPoints(defaultBox());
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
                setPoints(boundaryToBox(w.boundary));
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
            disabled={!form.name || !form.code || numericPoints.length < 4 || save.isPending}
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
            <label className="label">Boundary area (4 corners)</label>
            <p className="mb-1.5 text-fluid-xs text-muted">
              Drag any corner to resize or reshape the area, or type exact coordinates below.
            </p>

            <div className="h-[260px] w-full overflow-hidden rounded-xl border border-line">
              <BaseMap center={[23.2156, 72.6369]} zoom={12}>
                <FitToPoints positions={polygonPositions} />
                {polygonPositions.length === 4 && (
                  <Polygon positions={polygonPositions} pathOptions={{ color: '#16a34a', weight: 2, fillColor: '#16a34a', fillOpacity: 0.18 }} />
                )}
                {numericPoints.map((p) => (
                  <Marker
                    key={p.idx}
                    position={[p.lat, p.lng]}
                    icon={POINT_ICON}
                    draggable
                    eventHandlers={{
                      dragend: (e) => {
                        const { lat, lng } = e.target.getLatLng();
                        updatePoint(p.idx, 'lat', lat.toFixed(6));
                        updatePoint(p.idx, 'lng', lng.toFixed(6));
                      },
                    }}
                  />
                ))}
              </BaseMap>
            </div>

            <div className="mt-2 space-y-1.5">
              {points.map((p, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-7 shrink-0 text-center text-fluid-xs font-semibold text-faint">{CORNER_LABELS[i]}</span>
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
                </div>
              ))}
            </div>
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
                  setPoints(boundaryToBox(parsed));
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
