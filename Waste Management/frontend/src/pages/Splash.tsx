import { useEffect, useState } from 'react';

/** The front door, on every fresh open of '/'. Fixed 2.5-second duration. */

const DISPLAY_MS = 2500;

export default function Splash({ onDone }: { onDone: () => void }) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const showTimer = setTimeout(() => setFading(true), DISPLAY_MS);
    const doneTimer = setTimeout(onDone, DISPLAY_MS + 350);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(doneTimer);
    };
  }, [onDone]);

  return (
    <div
      className="fixed inset-0 z-[100] overflow-hidden bg-black transition-opacity duration-350 ease-out"
      style={{ opacity: fading ? 0 : 1 }}
      role="status"
      aria-live="polite"
      aria-label="Loading Safaai Sarathi"
    >
      {/* Background photo — slow Ken-Burns zoom, blurred, scaled up so the blur never reveals an edge. */}
      <img
        src="/loading-bg.jpg"
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full scale-110 object-cover blur-[3px] motion-reduce:animate-none"
        style={{ animation: 'splash-kenburns 6s ease-out both' }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/50 to-black/70" />

      {/* Text only — no icon. */}
      <div className="relative flex h-full flex-col items-center justify-center gap-6 px-4 text-center">
        <div className="[animation:splash-zoom_0.8s_cubic-bezier(0.22,1,0.36,1)_both] motion-reduce:animate-none">
          <p className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
            Safaai <span className="text-emerald-400">Sarathi</span>
          </p>
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.3em] text-white/70 sm:text-sm">
            Civic AI Platform
          </p>
        </div>

        <div className="h-1 w-48 overflow-hidden rounded-full bg-white/20 [animation:splash-fade_0.5s_ease-out_0.4s_both] motion-reduce:animate-none">
          <div className="h-full w-1/3 animate-[splash-bar_1.1s_ease-in-out_infinite] rounded-full bg-emerald-400" />
        </div>
      </div>

      <style>{`
        @keyframes splash-kenburns {
          from { transform: scale(1.1); }
          to { transform: scale(1.22); }
        }
        @keyframes splash-zoom {
          0% { transform: scale(2.2); opacity: 0; }
          60% { transform: scale(0.95); opacity: 1; }
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
