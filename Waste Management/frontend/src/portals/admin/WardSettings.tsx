import { useEffect, useMemo, useRef, useState } from 'react';
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
 * Ward boundary editor (plan §2.4). The boundary is a rectangle defined by
 * north/south/east/west bounds — dragging any corner moves that corner's two
 * bounds, so the shape always stays a proper rectangle (never skews into an
 * arbitrary quadrilateral). Still saved as a GeoJSON Polygon server-side.
 */

type Bounds = { north: string; south: string; east: string; west: string };
type LatKey = 'north' | 'south';
type LngKey = 'east' | 'west';

const CORNERS: { label: string; latKey: LatKey; lngKey: LngKey }[] = [
  { label: 'NW', latKey: 'north', lngKey: 'west' },
  { label: 'NE', latKey: 'north', lngKey: 'east' },
  { label: 'SE', latKey: 'south', lngKey: 'east' },
  { label: 'SW', latKey: 'south', lngKey: 'west' },
];

const emptyForm = { id: '', name: '', code: '', zone: '', population: 0, slaMinutes: 1440 };

/** A small default square centred on the given point. */
function defaultBounds(center: [number, number] = [23.0225, 72.5714], delta = 0.01): Bounds {
  const [lat, lng] = center;
  return {
    north: String(lat + delta),
    south: String(lat - delta),
    east: String(lng + delta),
    west: String(lng - delta),
  };
}

/** Reduces any saved boundary (or an uploaded .geojson file) to its bounding box. */
function boundaryToBounds(geo: any): Bounds {
  const boundary =
    geo?.type === 'Polygon'
      ? geo
      : geo?.type === 'Feature'
        ? geo.geometry
        : geo?.type === 'FeatureCollection'
          ? geo.features?.[0]?.geometry
          : null;

  const ring: [number, number][] = boundary?.coordinates?.[0] ?? [];
  if (!ring.length) return defaultBounds();

  const lats = ring.map(([, lat]) => lat);
  const lngs = ring.map(([lng]) => lng);
  return {
    north: String(Math.max(...lats)),
    south: String(Math.min(...lats)),
    east: String(Math.max(...lngs)),
    west: String(Math.min(...lngs)),
  };
}

/**
 * Frames the box once when the editor opens. It must not re-fit on every
 * resize — that would fight the drag gesture by re-centring/zooming the map
 * mid-stretch.
 */
function FitToPoints({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || positions.length === 0) return;
    map.fitBounds(L.latLngBounds(positions), { padding: [30, 30] });
    done.current = true;
  }, [map, positions]);
  return null;
}

export default function WardSettings() {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [bounds, setBounds] = useState<Bounds>(defaultBounds());

  const wards = useQuery({
    queryKey: ['admin', 'wards'],
    queryFn: async () => (await api('admin').get('/admin/wards')).data,
  });

  const numericBounds = useMemo(
    () => ({
      north: parseFloat(bounds.north),
      south: parseFloat(bounds.south),
      east: parseFloat(bounds.east),
      west: parseFloat(bounds.west),
    }),
    [bounds]
  );
  const boundsValid = Object.values(numericBounds).every(Number.isFinite);

  const corners = useMemo(
    () =>
      CORNERS.map((c) => ({
        ...c,
        lat: numericBounds[c.latKey],
        lng: numericBounds[c.lngKey],
      })),
    [numericBounds]
  );
  const polygonPositions = useMemo<[number, number][]>(
    () => (boundsValid ? corners.map((c) => [c.lat, c.lng] as [number, number]) : []),
    [corners, boundsValid]
  );

  const setBound = (key: keyof Bounds, value: string) => setBounds((prev) => ({ ...prev, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      if (!boundsValid) {
        throw new Error('All 4 corners need valid coordinates');
      }

      const coords: [number, number][] = corners.map((c) => [c.lng, c.lat]);
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
      setBounds(defaultBounds());
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
              setBounds(defaultBounds());
              setUploading(true);
            }}
          >
            <Upload className="h-3.5 w-3.5" /> Add a ward
          </button>
        }
      />

      <Card className="overflow-hidden p-0">
        <div className="h-[46dvh] min-h-[300px] w-full">
          <BaseMap center={[23.0225, 72.5714]} zoom={12}>
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
                setBounds(boundaryToBounds(w.boundary));
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
            disabled={!form.name || !form.code || !boundsValid || save.isPending}
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
            <label className="label">Boundary area</label>
            <p className="mb-1.5 text-fluid-xs text-muted">
              Drag any corner to resize — the shape always stays a rectangle. Only these 4 corners are shown below.
            </p>

            <div className="h-[260px] w-full overflow-hidden rounded-xl border border-line">
              <BaseMap center={[23.0225, 72.5714]} zoom={12}>
                <FitToPoints positions={polygonPositions} />
                {polygonPositions.length === 4 && (
                  <Polygon positions={polygonPositions} pathOptions={{ color: '#16a34a', weight: 2, fillColor: '#16a34a', fillOpacity: 0.18 }} />
                )}
                {boundsValid &&
                  corners.map((c) => (
                    <Marker
                      key={c.label}
                      position={[c.lat, c.lng]}
                      icon={POINT_ICON}
                      draggable
                      eventHandlers={{
                        // Live-update on every drag frame, not just on release —
                        // the box visibly stretches as the corner moves.
                        drag: (e) => {
                          const { lat, lng } = e.target.getLatLng();
                          setBounds((prev) => ({ ...prev, [c.latKey]: lat.toFixed(6), [c.lngKey]: lng.toFixed(6) }));
                        },
                      }}
                    />
                  ))}
              </BaseMap>
            </div>

            <div className="mt-2 space-y-1.5">
              {corners.map((c) => (
                <div key={c.label} className="flex items-center gap-1.5">
                  <span className="w-7 shrink-0 text-center text-fluid-xs font-semibold text-faint">{c.label}</span>
                  <input
                    type="number"
                    step="any"
                    className="field flex-1 py-1.5 text-fluid-xs"
                    placeholder="Latitude"
                    value={bounds[c.latKey]}
                    onChange={(e) => setBound(c.latKey, e.target.value)}
                  />
                  <input
                    type="number"
                    step="any"
                    className="field flex-1 py-1.5 text-fluid-xs"
                    placeholder="Longitude"
                    value={bounds[c.lngKey]}
                    onChange={(e) => setBound(c.lngKey, e.target.value)}
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
                  setBounds(boundaryToBounds(parsed));
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
