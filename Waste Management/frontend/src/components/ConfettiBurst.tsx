import { useEffect, useState } from 'react';

const COLORS = ['#16a34a', '#f59e0b', '#0ea5e9', '#ec4899', '#a855f7', '#ef4444', '#14b8a6'];

/** A one-shot full-screen confetti burst — no library, just CSS keyframes. */
export function ConfettiBurst({ onDone }: { onDone: () => void }) {
  const [pieces] = useState(() =>
    Array.from({ length: 80 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.25,
      duration: 1.5 + Math.random() * 1,
      rotate: Math.round(Math.random() * 720 - 360),
      drift: Math.round((Math.random() - 0.5) * 240),
      color: COLORS[i % COLORS.length],
      size: 6 + Math.random() * 6,
      round: Math.random() > 0.5,
    }))
  );

  useEffect(() => {
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="pointer-events-none fixed inset-0 z-[200] overflow-hidden" aria-hidden role="presentation">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="absolute top-[-5%]"
          style={
            {
              left: `${p.left}%`,
              width: p.size,
              height: p.size,
              background: p.color,
              borderRadius: p.round ? '50%' : '2px',
              animation: `confetti-fall ${p.duration}s ${p.delay}s cubic-bezier(0.25,0.46,0.45,0.94) forwards`,
              '--confetti-drift': `${p.drift}px`,
              '--confetti-rot': `${p.rotate}deg`,
            } as React.CSSProperties
          }
        />
      ))}
      <style>{`
        @keyframes confetti-fall {
          0% { transform: translate(0, 0) rotate(0deg); opacity: 1; }
          100% { transform: translate(var(--confetti-drift), 110vh) rotate(var(--confetti-rot)); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
