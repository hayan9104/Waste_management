import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * A scratch-off overlay: drag to erase a canvas layer, revealing whatever
 * sits underneath. Fires `onReveal` once enough of it has been cleared.
 */
export function ScratchCard({ onReveal }: { onReveal: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scratching = useRef(false);
  const revealedRef = useRef(false);
  const [fading, setFading] = useState(false);

  const paintSurface = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const { width, height } = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, width * dpr);
    canvas.height = Math.max(1, height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#d4d9dd');
    gradient.addColorStop(0.5, '#eef1f3');
    gradient.addColorStop(1, '#c3cad0');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = 'rgba(21,128,61,0.9)';
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎁 Scratch to reveal', width / 2, height / 2 - 10);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(21,128,61,0.6)';
    ctx.fillText('drag anywhere on the card', width / 2, height / 2 + 12);
  }, []);

  useEffect(() => {
    paintSurface();
    const onResize = () => !revealedRef.current && paintSurface();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paintSurface]);

  const scratchAt = (x: number, y: number) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.fill();
  };

  const checkRevealed = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || revealedRef.current) return;
    const step = 8;
    let cleared = 0;
    let total = 0;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        total += 1;
        if (data[(y * width + x) * 4 + 3] < 40) cleared += 1;
      }
    }
    if (total > 0 && cleared / total > 0.5) {
      revealedRef.current = true;
      setFading(true);
      onReveal();
    }
  };

  const posFromEvent = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div ref={containerRef} className="absolute inset-0 z-10 overflow-hidden rounded-2xl">
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full touch-none rounded-2xl transition-opacity duration-500 ${
          fading ? 'pointer-events-none opacity-0' : 'cursor-pointer opacity-100'
        }`}
        onPointerDown={(e) => {
          scratching.current = true;
          const { x, y } = posFromEvent(e);
          scratchAt(x, y);
        }}
        onPointerMove={(e) => {
          if (!scratching.current) return;
          const { x, y } = posFromEvent(e);
          scratchAt(x, y);
        }}
        onPointerUp={() => {
          scratching.current = false;
          checkRevealed();
        }}
        onPointerLeave={() => {
          if (scratching.current) checkRevealed();
          scratching.current = false;
        }}
      />
    </div>
  );
}
