import { useEffect, type RefObject } from "react";

type Point = { x: number; y: number; time: number };

/** Restore the preview's continuous light ribbon, sampled from the actual flight.
 * No React state updates per frame. Work stops when hidden, disabled or reading. */
export function useButterflyFlight(
  layerRef: RefObject<HTMLDivElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const layer = layerRef.current;
    const canvas = canvasRef.current;
    if (!layer || !canvas || !active || typeof ResizeObserver === "undefined") return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const flyers = Array.from(layer.querySelectorAll<HTMLElement>(".sky-flight__butterfly"))
      .map((element, index) => ({
        element,
        animation: null as Animation | null,
        x: [.76, .18, .55][index],
        y: [.38, .24, .7][index],
        angle: -20,
        c1: { x: .5, y: .5 },
        c2: { x: .5, y: .5 },
        end: { x: [.76, .18, .55][index], y: [.38, .24, .7][index] },
        targetAngle: -20,
        duration: 8000,
        size: 28,
        history: [] as Point[],
      }));
    let disposed = false;
    let frame = 0;
    let last = 0;
    let width = 0;
    let height = 0;
    const enabled = () => !disposed && !document.hidden && !media.matches;

    function sampleNormalized(flyer: typeof flyers[number]) {
      const elapsed = Number(flyer.animation?.currentTime ?? 0);
      const t = Math.min(1, Math.max(0, elapsed / Math.max(1, flyer.duration)));
      const u = 1 - t;
      const x = u ** 3 * flyer.x + 3 * u * u * t * flyer.c1.x + 3 * u * t * t * flyer.c2.x + t ** 3 * flyer.end.x;
      const y = u ** 3 * flyer.y + 3 * u * u * t * flyer.c1.y + 3 * u * t * t * flyer.c2.y + t ** 3 * flyer.end.y;
      const angle = flyer.angle + (flyer.targetAngle - flyer.angle) * t;
      return { x, y, angle };
    }

    function nextFlight(flyer: typeof flyers[number]) {
      if (disposed) return;
      const end = { x: .06 + Math.random() * .88, y: .08 + Math.random() * .78 };
      const c1 = { x: Math.random(), y: Math.random() };
      const c2 = { x: Math.random(), y: Math.random() };
      const angle = -40 + Math.random() * 75;
      const size = flyer.element.offsetWidth || 28;
      const duration = (6500 + Math.random() * 6500) * Math.min(1.6, Math.max(1, width / 850));
      flyer.c1 = c1;
      flyer.c2 = c2;
      flyer.end = end;
      flyer.targetAngle = angle;
      flyer.duration = duration;
      flyer.size = size;
      const frames = Array.from({ length: 41 }, (_, index) => {
        const t = index / 40, u = 1 - t;
        const x = u ** 3 * flyer.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * end.x;
        const y = u ** 3 * flyer.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * end.y;
        return { transform: `translate(${x * Math.max(0, width - size)}px,${y * Math.max(0, height - size)}px) rotate(${flyer.angle + (angle - flyer.angle) * t}deg)` };
      });
      flyer.animation?.cancel();
      flyer.animation = flyer.element.animate(frames, {
        duration,
        fill: "forwards",
        easing: "linear",
      });
      flyer.animation.onfinish = () => {
        flyer.x = end.x; flyer.y = end.y; flyer.angle = angle;
        nextFlight(flyer);
      };
      if (!enabled()) flyer.animation.pause();
    }

    function clear() {
      flyers.forEach(flyer => { flyer.history.length = 0; });
      context!.clearRect(0, 0, width, height);
    }

    function draw(now: number) {
      frame = 0;
      if (!enabled()) return;
      // A bounded, approximately 30 fps light layer; the wing flight remains 60 fps.
      if (now - last >= 32) {
        last = now;
        context!.clearRect(0, 0, width, height);
        for (const flyer of flyers) {
          const sampled = sampleNormalized(flyer);
          const half = flyer.size / 2;
          const px = sampled.x * Math.max(0, width - flyer.size) + half;
          const py = sampled.y * Math.max(0, height - flyer.size) + half;
          const history = flyer.history;
          history.push({ x: px, y: py, time: now });
          while (history.length && now - history[0].time > 2400) history.shift();
          for (let index = 1; index < history.length; index++) {
            const point = history[index], previous = history[index - 1];
            const life = Math.max(0, 1 - (now - point.time) / 2400);
            context!.beginPath();
            context!.moveTo(previous.x, previous.y);
            context!.lineTo(point.x, point.y);
            context!.lineCap = "round";
            context!.strokeStyle = `rgba(77,192,255,${life * .28})`;
            context!.lineWidth = 8 * life;
            context!.shadowBlur = 12;
            context!.shadowColor = "#5dccff";
            context!.stroke();
            context!.strokeStyle = `rgba(209,251,255,${life * .82})`;
            context!.lineWidth = Math.max(.3, life * 1.8);
            context!.shadowBlur = 4;
            context!.stroke();
            if (index % 5 === 0) {
              const drift = (now - point.time) / 1000;
              context!.beginPath();
              context!.arc(point.x + Math.sin(point.time * .01) * drift * 7,
                point.y + drift * 7, Math.max(.25, life * 1.5), 0, Math.PI * 2);
              context!.fillStyle = `rgba(201,244,255,${life * .8})`;
              context!.fill();
            }
          }
        }
      }
      frame = requestAnimationFrame(draw);
    }

    function sync() {
      for (const flyer of flyers) {
        if (enabled()) flyer.animation?.play();
        else flyer.animation?.pause();
      }
      layer!.dataset.flight = enabled() ? "running" : "paused";
      if (enabled()) { if (!frame) frame = requestAnimationFrame(draw); }
      else { cancelAnimationFrame(frame); frame = 0; clear(); }
    }

    function resize() {
      // Preserve each butterfly's normalized position before changing the canvas.
      for (const flyer of flyers) {
        if (!flyer.animation || !width || !height) continue;
        const sampled = sampleNormalized(flyer);
        flyer.x = sampled.x;
        flyer.y = sampled.y;
        flyer.angle = sampled.angle;
      }
      width = layer!.clientWidth; height = layer!.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(width * ratio); canvas!.height = Math.round(height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      clear(); flyers.forEach(nextFlight); sync();
    }

    const observer = new ResizeObserver(resize);
    observer.observe(layer);
    document.addEventListener("visibilitychange", sync);
    media.addEventListener("change", sync);
    resize();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      media.removeEventListener("change", sync);
      flyers.forEach(flyer => { if (flyer.animation) { flyer.animation.onfinish = null; flyer.animation.cancel(); } });
      clear(); layer.dataset.flight = "paused";
    };
  }, [active, layerRef, canvasRef]);
}
