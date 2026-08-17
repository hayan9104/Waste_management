import { useEffect, useState } from 'react';
import { publicApi } from '../lib/api';

/**
 * The front door, on every fresh open of '/'. Gated on real backend
 * readiness (a public stats fetch) rather than a fixed animation length —
 * if the API is slow, the loader stays up; if it's unreachable, a safety
 * net still lets the user through rather than trapping them here.
 */

const MIN_DISPLAY_MS = 650;
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
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-[#020e06] transition-opacity duration-350 ease-out"
      style={{ opacity: fading ? 0 : 1 }}
      role="status"
      aria-live="polite"
      aria-label="Loading Safaai Sarathi"
    >
      <div className="relative flex h-20 w-20 items-center justify-center">
        <span className="absolute inset-0 rounded-3xl bg-emerald-500/15 animate-ping" />
        <div className="relative grid h-16 w-16 place-items-center rounded-2xl bg-emerald-600/10 ring-1 ring-emerald-400/20">
          <img src="/icon.svg" alt="" className="h-9 w-9" />
        </div>
      </div>

      <div className="text-center">
        <p className="text-lg font-bold tracking-tight text-white">
          Safaai <span className="text-emerald-400">Sarathi</span>
        </p>
        <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-white/40">Civic AI Platform</p>
      </div>

      <div className="h-1 w-40 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 animate-[splash-bar_1.1s_ease-in-out_infinite] rounded-full bg-emerald-500" />
      </div>
      <style>{`@keyframes splash-bar { 0% { transform: translateX(-120%); } 100% { transform: translateX(340%); } }`}</style>
    </div>
  );
}
