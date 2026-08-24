import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Camera, Loader2, Siren } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Card, toast } from '../../components/ui';
import { CameraCapture } from '../../components/CameraCapture';
import { BackLink } from '../../components/shells';
import { CITY_CENTER, snapToCity } from '../../components/map/Map';

/**
 * The red button (plan §2.1). These four categories bypass the normal queue and
 * page the ward officer directly with a 30-minute escalation clock — the
 * differentiator against every form-only civic portal.
 */
const EMERGENCIES = [
  { id: 'DEAD_ANIMAL', label: 'Dead animal', hint: 'Carcass on a road, drain or public space' },
  { id: 'MEDICAL_WASTE', label: 'Medical / biomedical waste', hint: 'Syringes, dressings, hospital waste dumped openly' },
  { id: 'BURNING_WASTE', label: 'Waste being burned', hint: 'Open burning producing smoke' },
  { id: 'SEWAGE_OVERFLOW', label: 'Sewage overflow', hint: 'Drain or manhole overflowing' },
];

export default function EmergencyReport() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  function locate() {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const snapped = snapToCity(pos.coords.latitude, pos.coords.longitude);
        if (snapped.moved) toast.warn('You appear to be outside Gandhinagar — the pin was moved to the nearest point inside the city.');
        setPosition({ lat: snapped.lat, lng: snapped.lng });
      },
      () => setPosition({ lat: CITY_CENTER[0], lng: CITY_CENTER[1] }),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  useEffect(() => {
    locate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The photo and the GPS fix should describe the same moment, not "wherever
  // the citizen happened to be when the page first loaded".
  function onCameraCapture(captured: File) {
    setCameraOpen(false);
    locate();
    setFile(captured);
    setPreview(URL.createObjectURL(captured));
  }

  async function submit() {
    if (!category || !position) return;
    setBusy(true);
    try {
      const form = new FormData();
      if (file) form.append('photo', file);
      form.append('category', category);
      form.append('latitude', String(position.lat));
      form.append('longitude', String(position.lng));
      if (description) form.append('description', description);

      const { data } = await api('citizen').post('/citizen/emergency', form);
      await queryClient.invalidateQueries({ queryKey: ['citizen'] });
      /**
       * Say which truck is coming when one actually is. "A truck has been
       * dispatched" when none was would be the worst possible lie to tell
       * someone standing next to medical waste, so the no-truck case is
       * reported as plainly as the success case.
       */
      const truck = data.dispatch?.vehicle?.registrationNumber;
      if (truck) {
        toast.success(`Emergency ${data.complaint.code} raised — truck ${truck} dispatched and the ward officer paged`);
      } else {
        toast.success(`Emergency ${data.complaint.code} raised — the ward officer has been paged`);
      }
      navigate(`/app/complaints/${data.complaint.id}`, { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not raise the emergency'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <BackLink to="/app" />

      <Card className="border-danger/30 bg-danger/5 p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-danger text-white">
            <Siren className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-fluid-lg font-bold text-danger">Emergency report</h1>
            <p className="mt-1 text-fluid-sm text-muted">
              This skips the normal queue: the nearest available truck is dispatched straight away and the ward
              officer is paged, with a 30-minute escalation timer.
            </p>
          </div>
        </div>
      </Card>

      <div>
        <label className="label">What is the emergency?</label>
        <div className="space-y-2">
          {EMERGENCIES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setCategory(item.id)}
              className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition ${
                category === item.id ? 'border-danger bg-danger/10' : 'border-line bg-elevated hover:bg-sunken'
              }`}
            >
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
                  category === item.id ? 'border-danger bg-danger' : 'border-line'
                }`}
              >
                {category === item.id && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
              </span>
              <span className="min-w-0">
                <span className="block text-fluid-sm font-semibold">{item.label}</span>
                <span className="block text-fluid-xs text-muted">{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Photo (strongly recommended)</label>
        <button
          type="button"
          onClick={() => setCameraOpen(true)}
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-line p-3.5 text-left transition hover:border-danger"
        >
          {preview ? (
            <img src={preview} alt="" className="h-14 w-14 rounded-lg object-cover" />
          ) : (
            <span className="grid h-14 w-14 place-items-center rounded-lg bg-sunken text-faint">
              <Camera className="h-5 w-5" />
            </span>
          )}
          <span className="text-fluid-sm font-medium">{preview ? 'Retake photo' : 'Take a photo'}</span>
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="mt-1.5 text-fluid-xs font-semibold text-muted underline decoration-dotted underline-offset-4 hover:text-danger"
        >
          Or choose an existing photo instead
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) {
              locate();
              setFile(selected);
              setPreview(URL.createObjectURL(selected));
            }
          }}
        />
        <CameraCapture open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={onCameraCapture} />
      </div>

      <div>
        <label className="label" htmlFor="desc">Describe it briefly</label>
        <textarea
          id="desc"
          className="field min-h-[80px] resize-y py-2.5"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Where exactly, and how bad is it?"
          maxLength={1000}
        />
      </div>

      {!position && (
        <p className="flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3 text-fluid-xs text-warn">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Waiting for your location — the officer needs it to dispatch a crew.
        </p>
      )}

      <button className="btn-danger w-full" onClick={submit} disabled={busy || !category || !position}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Siren className="h-4 w-4" />}
        Raise emergency alert
      </button>
    </div>
  );
}
