import { useEffect, useState } from 'react';
import { publicApi } from '../lib/api';

/**
 * The front door, on every fresh open of '/'. Gated on real backend
 * readiness (a public stats fetch) rather than a fixed animation length —
 * if the API is slow, the loader stays up; if it's unreachable, a safety
 * net still lets the user through rather than trapping them here.
 */

const MIN_DISPLAY_MS = 900;
const MAX_WAIT_MS = 8000;

export default function Splash({ onDone }: { onDone: () => void }) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const start = performance.now();

    const finish = () => {
      if (cancelled) return;
      const elapsed = performance.now() - start;
      const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);
      setTimeout(() => {
        if (cancelled) return;
        setFading(true);
        setTimeout(onDone, 350);
      }, remaining);
    };

    const safetyNet = setTimeout(finish, MAX_WAIT_MS);

    publicApi
      .get('/stats')
      .catch(() => {
        /* backend being slow/down is not a reason to trap the user here */
      })
      .finally(() => {
        clearTimeout(safetyNet);
        finish();
      });

    return () => {
      cancelled = true;
      clearTimeout(safetyNet);
    };
  }, [onDone]);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-white transition-opacity duration-350 ease-out"
      style={{ opacity: fading ? 0 : 1 }}
      role="status"
      aria-live="polite"
      aria-label="Loading Safaai Sarathi"
    >
      <div className="relative flex h-20 w-20 items-center justify-center [animation:splash-zoom_0.7s_cubic-bezier(0.22,1,0.36,1)_both] motion-reduce:animate-none">
        <span className="absolute inset-0 rounded-3xl bg-brand/10 animate-ping motion-reduce:hidden" />
        <div className="relative grid h-16 w-16 place-items-center rounded-2xl bg-brand shadow-lg shadow-brand/20">
          <img src="/icon.svg" alt="" className="h-9 w-9" />
        </div>
      </div>

      <div className="text-center [animation:splash-zoom_0.7s_cubic-bezier(0.22,1,0.36,1)_0.15s_both] motion-reduce:animate-none">
        <p className="text-2xl font-extrabold tracking-tight text-ink">
          Safaai <span className="text-brand">Sarathi</span>
        </p>
        <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-muted">Civic AI Platform</p>
      </div>

      <div className="h-1 w-40 overflow-hidden rounded-full bg-line [animation:splash-fade_0.5s_ease-out_0.35s_both] motion-reduce:animate-none">
        <div className="h-full w-1/3 animate-[splash-bar_1.1s_ease-in-out_infinite] rounded-full bg-brand" />
      </div>

      <style>{`
        @keyframes splash-zoom {
          0% { transform: scale(2.6); opacity: 0; }
          60% { transform: scale(0.94); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes splash-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes splash-bar {
          0% { transform: translateX(-120%); }
          100% { transform: translateX(340%); }
        }
      `}</style>
    </div>
  );
}
