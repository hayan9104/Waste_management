import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, RefreshCw, Upload, X } from 'lucide-react';

/**
 * Real camera capture, not the `<input capture>` trick. On a phone that
 * attribute happens to open the native camera app, but on a laptop most
 * browsers just show a plain file picker — no camera prompt, no live
 * preview. This opens getUserMedia directly, so "take a live photo" means
 * the same thing on every device: the browser's own camera-permission
 * prompt, a live preview, and a shutter button here.
 *
 * Falls back to a plain file picker if the camera can't be reached at all
 * (permission denied, no camera hardware, or an older browser) — the
 * citizen can still attach a photo either way.
 */
export function CameraCapture({
  open,
  onClose,
  onCapture,
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<'requesting' | 'live' | 'unavailable'>('requesting');

  useEffect(() => {
    if (!open) return;
    setStatus('requesting');
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStatus('live');
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    }
    void start();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  function shutter() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onCapture(new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.92
    );
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Camera">
      <div className="flex shrink-0 items-center justify-between px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] text-white">
        <span className="text-fluid-sm font-semibold">Take Live Photo</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close camera"
          className="grid h-10 w-10 place-items-center rounded-full bg-white/15 hover:bg-white/25"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden bg-black">
        {status === 'requesting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/80">
            <Loader2 className="h-7 w-7 animate-spin" />
            <p className="text-fluid-xs">Requesting camera access…</p>
          </div>
        )}

        {status === 'unavailable' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center text-white">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white/10">
              <Camera className="h-7 w-7 text-white/70" />
            </span>
            <div>
              <p className="font-semibold">Couldn't reach the camera</p>
              <p className="mt-1 text-fluid-xs text-white/70">
                Permission was denied, or this device/browser has no camera. You can upload a photo instead.
              </p>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="btn-primary flex items-center gap-2 rounded-xl px-4 py-2.5 text-fluid-xs font-bold"
            >
              <Upload className="h-4 w-4" /> Upload a photo
            </button>
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${status === 'live' ? '' : 'invisible'}`}
        />
      </div>

      {status === 'live' && (
        <div className="flex shrink-0 items-center justify-center gap-8 bg-black py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            className="text-fluid-xs font-semibold text-white/70 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={shutter}
            aria-label="Capture photo"
            className="grid h-16 w-16 place-items-center rounded-full border-4 border-white/80 bg-white/20 transition active:scale-95"
          >
            <span className="h-12 w-12 rounded-full bg-white" />
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 text-fluid-xs font-semibold text-white/70 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Upload
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onCapture(f);
        }}
      />
    </div>
  );
}
