import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Camera, Loader2, RefreshCw, Upload, X } from 'lucide-react';

/**
 * Take a photo, on whatever the device is.
 *
 * Two different things have to happen depending on what is holding the page:
 *
 * On a phone or tablet the right answer is the device's own camera app. It
 * opens on the main (rear) lens, it has the tap-to-focus, exposure and flash
 * the user already knows, and the OS hands the photo back to the page when
 * they are done — which is what people mean by "use the camera and come back".
 * `<input type="file" accept="image/*" capture="environment">` is the hand-off,
 * and `environment` is what pins it to the main camera rather than the selfie
 * one.
 *
 * On a laptop there is no camera app to hand off to — `capture` is accepted by
 * the DOM and then quietly ignored, leaving a plain file picker and no way to
 * take a photo at all. So there we open getUserMedia and draw our own preview
 * and shutter.
 *
 * Either way it falls back to a plain file picker if the camera cannot be
 * reached (permission denied, no hardware, older browser) — a citizen must
 * always be able to attach a photo.
 */

/**
 * Is there a camera app to hand off to?
 *
 * Deliberately not a feature test for `capture`. The obvious
 * `'capture' in HTMLInputElement.prototype` is wrong in both directions: it is
 * false on desktop Chrome, and it is *also* false on iOS Safari, which honours
 * the attribute perfectly well without exposing the IDL property. Used as a
 * gate it would have sent every iPhone down the webcam path — the exact
 * devices this exists for.
 *
 * What actually matters is whether this is a phone or tablet, and
 * coarse-pointer-without-hover is the honest test for that. A touchscreen
 * laptop still reports a fine pointer and hover for its primary input, so it
 * correctly keeps the in-page camera. `capture` is simply ignored where it is
 * not understood, so there is nothing to guard against on the way out.
 */
function hasNativeCameraApp() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse) and (hover: none)').matches === true;
}

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
  const nativeInputRef = useRef<HTMLInputElement>(null);
  /** Set once a photo has come back, so the cancel watcher stands down. */
  const settledRef = useRef(false);
  /** Latest onClose, so the cancel watcher never has to re-register to see it. */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const [native] = useState(hasNativeCameraApp);
  const [status, setStatus] = useState<'requesting' | 'live' | 'unavailable'>('requesting');

  const takeFile = useCallback(
    (file: File) => {
      settledRef.current = true;
      onCapture(file);
    },
    [onCapture]
  );

  // ------------------------------------------------------ native hand-off --
  /**
   * Fired from a layout effect rather than a passive one so it still runs in
   * the same task as the tap that opened this sheet: Safari only honours a
   * programmatic `click()` on a file input while it considers a user gesture
   * to be in progress, and an async effect can land outside that window. If it
   * is refused anyway the sheet below has a real button to press.
   */
  useLayoutEffect(() => {
    if (!open || !native) return;
    settledRef.current = false;
    nativeInputRef.current?.click();
  }, [open, native]);

  /**
   * Closing the sheet when the camera app was dismissed without a photo.
   *
   * Cancelling gives no event at all — the page simply regains focus with an
   * empty input — so without this the sheet would sit there over a camera that
   * is no longer open. The delay lets the `change` event, which arrives just
   * after focus returns, settle first.
   */
  useEffect(() => {
    if (!open || !native) return;
    let timer = 0;
    const onFocus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!settledRef.current) closeRef.current();
      }, 1200);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearTimeout(timer);
    };
    // Deliberately not depending on `onClose`: every call site passes an inline
    // arrow, so a dependency on it re-runs this effect on each render, and the
    // cleanup clears the pending timer. Any re-render landing inside the
    // 1.2s window — a background refetch is enough — silently cancelled the
    // cancel detection and left the sheet stuck over a closed camera.
  }, [open, native]);

  // -------------------------------------------------- in-page camera path --
  useEffect(() => {
    if (!open || native) return;
    setStatus('requesting');
    let cancelled = false;

    async function start() {
      // Warm up a high-accuracy fix while the camera prompt is up, so the
      // report does not then wait on GPS from a standing start.
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          () => {},
          () => {},
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable');
        return;
      }
      try {
        /**
         * Ask for the main lens outright before settling for a preference.
         * `ideal` is only a hint: on any device with more than one camera the
         * browser is free to hand back the front-facing one, which is how a
         * "photo of the rubbish" ends up being a photo of the reporter.
         */
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: 'environment' } },
            audio: false,
          });
        } catch {
          // No rear camera on this machine — a laptop webcam is the only one.
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
            audio: false,
          });
        }

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
  }, [open, native]);

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
        takeFile(new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.92
    );
  }

  if (!open) return null;

  /**
   * What sits behind the camera app.
   *
   * Normally invisible — the OS camera is over the top of it from the moment
   * the sheet opens. It matters when the automatic hand-off was refused, which
   * is why the button is a real label the user can press rather than a status
   * message.
   */
  if (native) {
    return (
      <div
        className="fixed inset-0 z-[120] flex flex-col items-center justify-center gap-5 bg-black px-8 text-center text-white"
        role="dialog"
        aria-modal="true"
        aria-label="Camera"
      >
        <Loader2 className="h-7 w-7 animate-spin text-white/70" />
        <p className="text-fluid-sm font-semibold">Opening your camera…</p>

        <label
          htmlFor="ss-native-camera"
          className="btn-primary flex cursor-pointer items-center gap-2 rounded-xl px-4 py-2.5 text-fluid-xs font-bold"
        >
          <Camera className="h-4 w-4" /> Open camera
        </label>

        <button
          type="button"
          onClick={onClose}
          className="text-fluid-xs font-semibold text-white/70 hover:text-white"
        >
          Cancel
        </button>

        <input
          id="ss-native-camera"
          ref={nativeInputRef}
          type="file"
          accept="image/*"
          // The main camera, not the selfie one.
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Let the same photo be retaken if the citizen rejects it upstream.
            e.target.value = '';
            if (f) takeFile(f);
          }}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[120] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Camera">
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
          e.target.value = '';
          if (f) takeFile(f);
        }}
      />
    </div>
  );
}
