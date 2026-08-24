import { Modal } from './ui';
import { BaseMap, PinMarker } from './map/Map';

/**
 * Shared "Locate" popup for any page that doesn't already carry its own
 * embedded map (driver task cards, officer emergency/SOS rows). Replaces the
 * old pattern of an `<a target="_blank">` straight out to Google Maps — that
 * left the app entirely for a single pin, when the same picture (and the
 * ability to pan/zoom around it) is one Leaflet tile away. Pages that already
 * show a live map (e.g. the driver's route screen) should pan that map
 * instead of opening this — see FlyTo in map/Map.tsx.
 */
export function LocationModal({
  open,
  onClose,
  latitude,
  longitude,
  title,
  subtitle,
}: {
  open: boolean;
  onClose: () => void;
  latitude: number;
  longitude: number;
  title: string;
  subtitle?: string;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-3">
        {subtitle && <p className="text-fluid-xs text-muted">{subtitle}</p>}
        <div className="h-64 w-full overflow-hidden rounded-2xl border border-line">
          <BaseMap center={[latitude, longitude]} zoom={16}>
            <PinMarker latitude={latitude} longitude={longitude} tone="danger" />
          </BaseMap>
        </div>
        <p className="text-center font-mono text-[11px] text-faint">
          {latitude.toFixed(5)}, {longitude.toFixed(5)}
        </p>
      </div>
    </Modal>
  );
}
