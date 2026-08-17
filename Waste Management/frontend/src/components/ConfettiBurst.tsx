import { useEffect, useState } from 'react';

const COLORS = ['#16a34a', '#f59e0b', '#0ea5e9', '#ec4899', '#a855f7', '#ef4444', '#14b8a6'];

type Piece = {
  id: string;
  side: 'left' | 'right';
  delay: number;
  duration: number;
  burstX: number;
  burstY: number;
  endX: number;
  endY: number;
  rot1: number;
  rot2: number;
  color: string;
  size: number;
  round: boolean;
};

/** One cannon's worth of pieces, exploding outward from a top corner then raining down. */
function makeCannon(side: 'left' | 'right', count: number): Piece[] {
  const dir = side === 'left' ? 1 : -1;
  return Array.from({ length: count }, (_, i) => ({
    id: `${side}-${i}`,
    side,
    delay: Math.random() * 0.35,
    duration: 1.8 + Math.random() * 1.1,
    burstX: dir * (90 + Math.random() * 220),
    burstY: -40 - Math.random() * 140,
    endX: dir * (160 + Math.random() * 480),
    endY: window.innerHeight ? window.innerHeight * (0.9 + Math.random() * 0.3) : 900,
    rot1: Math.round(Math.random() * 260 - 130),
    rot2: Math.round(Math.random() * 720 - 360),
    color: COLORS[i % COLORS.length],
    size: 6 + Math.random() * 6,
    round: Math.random() > 0.5,
  }));
}

/** A party-popper confetti blast from both top corners, raining down across the screen. */
export function ConfettiBurst({ onDone }: { onDone: () => void }) {
  const [pieces] = useState(() => [...makeCannon('left', 55), ...makeCannon('right', 55)]);

  useEffect(() => {
    const t = setTimeout(onDone, 2400);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="pointer-events-none fixed inset-0 z-[200] overflow-hidden" aria-hidden role="presentation">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="absolute top-0"
          style={
            {
              [p.side]: 0,
              width: p.size,
              height: p.size,
              background: p.color,
              borderRadius: p.round ? '50%' : '2px',
              animation: `confetti-burst ${p.duration}s ${p.delay}s cubic-bezier(0.2,0.65,0.35,1) forwards`,
              '--burst-x': `${p.burstX}px`,
              '--burst-y': `${p.burstY}px`,
              '--end-x': `${p.endX}px`,
              '--end-y': `${p.endY}px`,
              '--rot1': `${p.rot1}deg`,
              '--rot2': `${p.rot2}deg`,
            } as React.CSSProperties
          }
        />
      ))}
      <style>{`
        @keyframes confetti-burst {
          0%   { transform: translate(0, 0) rotate(0deg); opacity: 1; }
          22%  { transform: translate(var(--burst-x), var(--burst-y)) rotate(var(--rot1)); opacity: 1; }
          100% { transform: translate(var(--end-x), var(--end-y)) rotate(var(--rot2)); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
