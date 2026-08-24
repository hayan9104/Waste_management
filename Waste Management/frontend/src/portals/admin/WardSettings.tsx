import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MapPinned, Plus, RotateCcw, Trash2, TriangleAlert, Upload, UserX } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Badge, Card, ErrorState, Loading, Modal, SectionTitle, toast } from '../../components/ui';
import { BaseMap, WardLayer, FitBounds, Polygon, Polyline, Marker, useMap, WARD_OUTLINE, LINE_CASING, CITY_CENTER } from '../../components/map/Map';

/**
 * Ward boundary editor (plan §2.4).
 *
 * The boundary is a free-form GeoJSON Polygon with as many vertices as the ward
 * actually needs — real ward lines follow rivers, rail and arterial roads, and a
 * bounding rectangle attributed every complaint in the gaps to the wrong ward.
 * Vertices can be dragged, inserted by tapping the map, and deleted; the shape
 * redraws from whatever points exist. Three is the minimum a polygon can have;
 * there is no upper limit.
 *
 * Nothing changes server-side: `pointInPolygon` in lib/geo.js is a ray-casting
 * test over the real ring, and the stored bbox/centroid are derived from it, so
 * a 40-point ward attributes exactly as well as a 4-point one.
 */

type Vertex = { id: string; lat: string; lng: string };

const emptyForm = { id: '', name: '', code: '', zone: '', population: 0, slaMinutes: 1440 };

/** Tangled outline. Red, not amber — amber is too near the normal orange to read as a warning. */
const CROSSING_OUTLINE = '#ef4444';

/**
 * Numbered handle, so a row in the coordinate list is findable on the map.
 *
 * The dot still reads at 22px, but the grab target is a 34px transparent box
 * around it. A 22px target is under half the ~44px a fingertip needs, so on a
 * tablet the drag kept missing the corner and panning the map instead.
 */
const vertexIcon = (n: number) =>
  L.divIcon({
    className: 'ward-vertex',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html:
      `<div style="width:34px;height:34px;display:grid;place-items:center">` +
      `<div style="width:22px;height:22px;border-radius:9999px;background:#fff;border:3px solid ${WARD_OUTLINE};` +
      `box-shadow:0 1px 3px rgba(0,0,0,0.4);display:grid;place-items:center;` +
      `font:700 10px/1 Inter,system-ui,sans-serif;color:#c2410c">${n}</div></div>`,
  });

/**
 * One draggable corner.
 *
 * Split out and memoised because of how react-leaflet reconciles a Marker: it
 * compares `icon` and `position` by identity and, when either differs, calls
 * `setIcon` / `setLatLng` on the live layer. Written inline, `vertexIcon(i + 1)`
 * and `[lat, lng]` are fresh objects on every render, so every render — including
 * the ones the drag itself was causing — tore this handle's DOM node down and
 * rebuilt it underneath the pointer that was dragging it. That, rather than the
 * redraw, is what made a point stick and then jump.
 *
 * With both props memoised on their numbers, a re-render mid-gesture is a
 * no-op and Leaflet keeps ownership of the drag from press to release.
 */
const VertexHandle = memo(function VertexHandle({
  id,
  index,
  lat,
  lng,
  onDrag,
  onDragEnd,
}: {
  id: string;
  index: number;
  lat: number;
  lng: number;
  onDrag: (id: string, lat: number, lng: number) => void;
  onDragEnd: (id: string, lat: number, lng: number) => void;
}) {
  const position = useMemo<[number, number]>(() => [lat, lng], [lat, lng]);
  const icon = useMemo(() => vertexIcon(index), [index]);
  const handlers = useMemo(
    () => ({
      drag: (e: L.LeafletEvent) => {
        const p = (e.target as L.Marker).getLatLng();
        onDrag(id, p.lat, p.lng);
      },
      dragend: (e: L.LeafletEvent) => {
        const p = (e.target as L.Marker).getLatLng();
        onDragEnd(id, p.lat, p.lng);
      },
    }),
    [id, onDrag, onDragEnd]
  );

  return (
    <Marker
      position={position}
      icon={icon}
      draggable
      /* Deliberately no autoPan: the map carries maxBoundsViscosity={1} to keep
         it over Gandhinagar, and a pan that the bounds then snap back is the
         same stutter this change exists to remove. The editor frames the ward
         on open, so a corner is never off-screen to begin with. */
      keyboard={false}
      eventHandlers={handlers}
    />
  );
});

let vertexSeq = 0;
const makeVertex = (lat: number, lng: number): Vertex => ({
  id: `v${(vertexSeq += 1)}`,
  lat: lat.toFixed(6),
  lng: lng.toFixed(6),
});

/** Starting shape for a brand-new ward — a square the officer then reshapes. */
function defaultRing(center: [number, number] = CITY_CENTER, delta = 0.01): Vertex[] {
  const [lat, lng] = center;
  return [
    makeVertex(lat + delta, lng - delta),
    makeVertex(lat + delta, lng + delta),
    makeVertex(lat - delta, lng + delta),
    makeVertex(lat - delta, lng - delta),
  ];
}

/**
 * Reads a saved boundary (or an uploaded .geojson) into editable vertices,
 * keeping every point of the ring. The previous version collapsed the ring to
 * its bounding box, so opening a detailed ward and pressing save silently
 * replaced it with a rectangle.
 */
function boundaryToVertices(geo: any): Vertex[] {
  const geometry =
    geo?.type === 'Polygon'
      ? geo
      : geo?.type === 'Feature'
        ? geo.geometry
        : geo?.type === 'FeatureCollection'
          ? geo.features?.[0]?.geometry
          : null;

  let ring: [number, number][] = geometry?.coordinates?.[0] ?? [];
  if (ring.length < 3) return defaultRing();

  // GeoJSON rings repeat the first point to close; the editor holds it open.
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (ring.length > 3 && fx === lx && fy === ly) ring = ring.slice(0, -1);

  return ring.map(([lng, lat]) => makeVertex(lat, lng));
}

/** Metres-ish scaling so distance and area maths behave at this latitude. */
const KM_PER_LAT = 110.574;
const kmPerLng = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

/** Shoelace area in km², good enough for a city ward at these scales. */
function ringAreaKm2(pts: { lat: number; lng: number }[]): number {
  if (pts.length < 3) return 0;
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const kx = kmPerLng(lat0);
  let twice = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    twice += (pts[j].lng * kx) * (pts[i].lat * KM_PER_LAT) - (pts[i].lng * kx) * (pts[j].lat * KM_PER_LAT);
  }
  return Math.abs(twice) / 2;
}

/** Squared distance from p to segment a-b, in the same flattened plane. */
function distToSegment(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq)) : 0;
  const cx = a[0] + dx * t;
  const cy = a[1] + dy * t;
  return (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
}

function segmentsCross(a: number[], b: number[], c: number[], d: number[]): boolean {
  const side = (p: number[], q: number[], r: number[]) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const d1 = side(a, b, c);
  const d2 = side(a, b, d);
  const d3 = side(c, d, a);
  const d4 = side(c, d, b);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

/** True when the outline crosses itself — point-in-polygon gets ambiguous there. */
function selfIntersects(pts: { lat: number; lng: number }[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / n;
  const kx = kmPerLng(lat0);
  const xy = pts.map((p) => [p.lng * kx, p.lat * KM_PER_LAT]);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // Skip the pairs that legitimately share an endpoint.
      if (i === j || (i + 1) % n === j || (j + 1) % n === i) continue;
      if (segmentsCross(xy[i], xy[(i + 1) % n], xy[j], xy[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Frames the shape once when the editor opens. It must not re-fit on every
 * edit — that would fight the drag gesture by re-centring the map mid-stretch.
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

/** Tapping the map drops a new vertex into the nearest edge of the outline. */
function AddOnClick({ onAdd }: { onAdd: (lat: number, lng: number) => void }) {
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

export default function WardSettings() {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [points, setPoints] = useState<Vertex[]>(defaultRing());

  const wards = useQuery({
    queryKey: ['admin', 'wards'],
    queryFn: async () => (await api('admin').get('/admin/wards')).data,
  });

  /** Only vertices whose two numbers both parse take part in the geometry. */
  const numeric = useMemo(
    () =>
      points
        .map((p) => ({ id: p.id, lat: parseFloat(p.lat), lng: parseFloat(p.lng) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    [points]
  );
  const ringValid = numeric.length >= 3;
  const positions = useMemo<[number, number][]>(() => numeric.map((p) => [p.lat, p.lng]), [numeric]);
  const areaKm2 = useMemo(() => (ringValid ? ringAreaKm2(numeric) : 0), [numeric, ringValid]);
  /** Where "Reset" drops its starter square — over the ward, not off-screen. */
  const centre = useMemo<[number, number]>(() => {
    if (!numeric.length) return CITY_CENTER;
    const lat = numeric.reduce((s, p) => s + p.lat, 0) / numeric.length;
    const lng = numeric.reduce((s, p) => s + p.lng, 0) / numeric.length;
    return [lat, lng];
  }, [numeric]);
  const crossing = useMemo(() => (ringValid ? selfIntersects(numeric) : false), [numeric, ringValid]);

  const setVertex = (id: string, key: 'lat' | 'lng', value: string) =>
    setPoints((prev) => prev.map((p) => (p.id === id ? { ...p, [key]: value } : p)));

  const removeVertex = (id: string) =>
    setPoints((prev) => (prev.length <= 3 ? prev : prev.filter((p) => p.id !== id)));

  /**
   * Inserts into the edge the click landed nearest to, rather than appending to
   * the end — appending makes the outline jump back across itself whenever the
   * new point isn't next to the last one.
   */
  const addVertexNearestEdge = useRef<(lat: number, lng: number) => void>(() => {});
  addVertexNearestEdge.current = (lat: number, lng: number) => {
    setPoints((prev) => {
      const pts = prev
        .map((p) => ({ lat: parseFloat(p.lat), lng: parseFloat(p.lng) }))
        .map((p, i) => ({ ...p, i }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (pts.length < 3) return [...prev, makeVertex(lat, lng)];

      const kx = kmPerLng(lat);
      const xy = (p: { lat: number; lng: number }) => [p.lng * kx, p.lat * KM_PER_LAT];
      const target = xy({ lat, lng });

      let bestAfter = prev.length - 1;
      let best = Infinity;
      for (let k = 0; k < pts.length; k += 1) {
        const a = pts[k];
        const b = pts[(k + 1) % pts.length];
        const d = distToSegment(target, xy(a), xy(b));
        if (d < best) {
          best = d;
          bestAfter = a.i;
        }
      }

      const next = [...prev];
      next.splice(bestAfter + 1, 0, makeVertex(lat, lng));
      return next;
    });
  };

  /* Stable identity: the map click subscription must not tear down and rebuild
     on every drag frame. */
  const handleMapAdd = useCallback((lat: number, lng: number) => addVertexNearestEdge.current(lat, lng), []);

  /**
   * The outline follows the corner without React in the loop.
   *
   * Committing to state on every drag frame re-rendered this whole component
   * ~60 times a second — every coordinate input row, the area sum and the
   * O(n^2) self-intersection test — to move one point. The ring is the only
   * thing that has to change at that rate, so the drag writes straight to the
   * two Leaflet layers and state is committed once, on release; everything
   * derived from the ring settles on mouseup, which is when it matters.
   */
  const casingRef = useRef<L.Polygon | null>(null);
  const fillRef = useRef<L.Polygon | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);
  const numericRef = useRef(numeric);
  numericRef.current = numeric;

  const handleVertexDrag = useCallback((id: string, lat: number, lng: number) => {
    const live = numericRef.current.map(
      (p) => (p.id === id ? [lat, lng] : [p.lat, p.lng]) as [number, number]
    );
    if (live.length >= 3) {
      casingRef.current?.setLatLngs(live);
      fillRef.current?.setLatLngs(live);
    } else if (live.length === 2) {
      lineRef.current?.setLatLngs(live);
    }
  }, []);

  const handleVertexDragEnd = useCallback((id: string, lat: number, lng: number) => {
    setPoints((prev) =>
      prev.map((v) => (v.id === id ? { ...v, lat: lat.toFixed(6), lng: lng.toFixed(6) } : v))
    );
  }, []);

  /* Memoised so that a background refetch of the ward list cannot restyle or
     re-seat either outline layer in the middle of a gesture. */
  const casingOptions = useMemo(() => ({ ...LINE_CASING, weight: 6 }), []);
  const fillOptions = useMemo(
    () => ({
      color: crossing ? CROSSING_OUTLINE : WARD_OUTLINE,
      weight: 2.5,
      fillColor: crossing ? CROSSING_OUTLINE : WARD_OUTLINE,
      fillOpacity: 0.16,
    }),
    [crossing]
  );
  const lineOptions = useMemo(() => ({ color: WARD_OUTLINE, weight: 2.5, dashArray: '5 5' }), []);

  /** Splits the longest edge — the keyboard/no-map path to the same result. */
  const addVertexOnLongestEdge = () =>
    setPoints((prev) => {
      const pts = prev
        .map((p, i) => ({ lat: parseFloat(p.lat), lng: parseFloat(p.lng), i }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (pts.length < 2) return [...prev, makeVertex(CITY_CENTER[0], CITY_CENTER[1])];

      const kx = kmPerLng(pts[0].lat);
      let bestAfter = pts[pts.length - 1].i;
      let bestLen = -1;
      let mid: [number, number] = [pts[0].lat, pts[0].lng];
      for (let k = 0; k < pts.length; k += 1) {
        const a = pts[k];
        const b = pts[(k + 1) % pts.length];
        const len = ((b.lng - a.lng) * kx) ** 2 + ((b.lat - a.lat) * KM_PER_LAT) ** 2;
        if (len > bestLen) {
          bestLen = len;
          bestAfter = a.i;
          mid = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
        }
      }
      const next = [...prev];
      next.splice(bestAfter + 1, 0, makeVertex(mid[0], mid[1]));
      return next;
    });

  const save = useMutation({
    mutationFn: async () => {
      if (!ringValid) throw new Error('A boundary needs at least 3 valid coordinates');

      const coords: [number, number][] = numeric.map((p) => [p.lng, p.lat]);
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
      setPoints(defaultRing());
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
              setPoints(defaultRing());
              setUploading(true);
            }}
          >
            <Upload className="h-3.5 w-3.5" /> Add a ward
          </button>
        }
      />

      <Card className="overflow-hidden p-0">
        <div className="relative isolate h-[46dvh] min-h-[300px] w-full">
          <BaseMap center={CITY_CENTER} zoom={12}>
            <FitBounds points={wards.data.map((w: any) => [w.center.latitude, w.center.longitude])} />
            <WardLayer wards={wards.data} />
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
              <div className="flex justify-between">
                <dt className="text-muted">Boundary points</dt>
                <dd className="tabular-nums">{Math.max(0, (w.boundary?.coordinates?.[0]?.length ?? 1) - 1)}</dd>
              </div>
            </dl>

            {/* Registered officers. An admin could register one here and never
                see the result, so an unstaffed ward looked identical to a
                staffed one — and a ward that quietly lost its officer looked
                fine too. Called out explicitly when there is nobody. */}
            <div className="mt-3 border-t border-line pt-2.5">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                Ward officers {w.officers?.length ? `(${w.officers.length})` : ''}
              </p>
              {w.officers?.length ? (
                <ul className="space-y-1.5">
                  {w.officers.map((o: any) => (
                    <li key={o.id} className="flex items-center gap-2">
                      <span
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
                        style={{ backgroundColor: o.avatarColor || '#f59e0b' }}
                      >
                        {o.name?.slice(0, 1) ?? '?'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-fluid-xs font-medium">{o.name}</span>
                      {o.isPrimary && <Badge tone="brand">Primary</Badge>}
                      {!o.isActive && <Badge tone="neutral">Blocked</Badge>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-1.5 text-fluid-xs text-warn">
                  <UserX className="h-3.5 w-3.5 shrink-0" /> No officer registered for this ward
                </p>
              )}
            </div>
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
                setPoints(boundaryToVertices(w.boundary));
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
            disabled={!form.name || !form.code || !ringValid || save.isPending}
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
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label className="label mb-0">Boundary area</label>
              <div className="flex items-center gap-1.5">
                <button type="button" className="btn-ghost btn-sm rounded-lg" onClick={addVertexOnLongestEdge}>
                  <Plus className="h-3.5 w-3.5" /> Add point
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm rounded-lg"
                  onClick={() => setPoints(defaultRing(centre))}
                  title="Start again from a simple square"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reset
                </button>
              </div>
            </div>
            <p className="mb-1.5 mt-1 text-fluid-xs text-muted">
              Tap the map to drop a point into the nearest edge, drag any point to move it, and delete points you
              don't need. The outline follows whatever points exist — three minimum, no maximum.
            </p>

            <div className="relative isolate h-[300px] w-full overflow-hidden rounded-xl border border-line">
              <BaseMap center={CITY_CENTER} zoom={12}>
                <FitToPoints positions={positions} />
                <AddOnClick onAdd={handleMapAdd} />
                {/* Three points make a fillable polygon; below that only a line
                    can be drawn, so the shape stays visible while it is built.
                    A dark casing under the outline keeps it readable where the
                    boundary crosses parks and rooftops. */}
                {positions.length >= 3 ? (
                  <>
                    <Polygon ref={casingRef} positions={positions} pathOptions={casingOptions} />
                    <Polygon ref={fillRef} positions={positions} pathOptions={fillOptions} />
                  </>
                ) : positions.length === 2 ? (
                  <Polyline ref={lineRef} positions={positions} pathOptions={lineOptions} />
                ) : null}

                {/* Numbered from the full list, not the filtered one, so a
                    handle on the map always matches its row below even while
                    another row is mid-edit and temporarily unparseable. */}
                {points.map((p, i) => {
                  const lat = parseFloat(p.lat);
                  const lng = parseFloat(p.lng);
                  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                  return (
                    <VertexHandle
                      key={p.id}
                      id={p.id}
                      index={i + 1}
                      lat={lat}
                      lng={lng}
                                      onDrag={handleVertexDrag}
                      onDragEnd={handleVertexDragEnd}
                    />
                  );
                })}
              </BaseMap>
            </div>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-fluid-xs text-muted">
              <span>
                <strong className="text-ink tabular-nums">{points.length}</strong> point{points.length === 1 ? '' : 's'}
                {ringValid && <> · approx. <strong className="text-ink tabular-nums">{areaKm2.toFixed(2)}</strong> km²</>}
              </span>
              {!ringValid && <span className="font-semibold text-danger">Needs at least 3 valid coordinates</span>}
            </div>

            {crossing && (
              <p className="mt-2 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-2.5 text-fluid-xs text-warn">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  The outline crosses itself. It will still save, but complaints inside the crossed part may be
                  attributed to the wrong ward — reorder or move a point to untangle it.
                </span>
              </p>
            )}

            {/* No inner scroll box: the dialog body already scrolls, and nesting
                a second scroller made rows past the first unreachable. */}
            <div className="mt-2 space-y-1.5">
              {points.map((p, i) => (
                <div key={p.id} className="flex items-center gap-1.5">
                  <span className="w-6 shrink-0 text-center text-fluid-xs font-semibold text-faint tabular-nums">
                    {i + 1}
                  </span>
                  <input
                    type="number"
                    step="any"
                    className="field min-w-0 flex-1 py-1.5 text-fluid-xs"
                    placeholder="Latitude"
                    aria-label={`Point ${i + 1} latitude`}
                    value={p.lat}
                    onChange={(e) => setVertex(p.id, 'lat', e.target.value)}
                  />
                  <input
                    type="number"
                    step="any"
                    className="field min-w-0 flex-1 py-1.5 text-fluid-xs"
                    placeholder="Longitude"
                    aria-label={`Point ${i + 1} longitude`}
                    value={p.lng}
                    onChange={(e) => setVertex(p.id, 'lng', e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => removeVertex(p.id)}
                    disabled={points.length <= 3}
                    title={points.length <= 3 ? 'A polygon needs at least 3 points' : `Delete point ${i + 1}`}
                    aria-label={`Delete point ${i + 1}`}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
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
                  const loaded = boundaryToVertices(parsed);
                  setPoints(loaded);
                  toast.success(`Loaded ${loaded.length} boundary points`);
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
